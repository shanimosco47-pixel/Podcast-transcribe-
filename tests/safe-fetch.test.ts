import { describe, expect, it } from "vitest";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createPinnedDispatcher,
  defaultFetch,
  safeFetch,
  SafeFetchError,
  pinnedLookup,
  safeFetchStream,
  safeFetchText,
} from "../src/http/safe-fetch.js";
import { isBlockedAddress } from "../src/http/url-guard.js";

const PUBLIC_DNS = () => Promise.resolve(["93.184.216.34"]);
const BASE = { maxBytes: 1_000_000, timeoutMs: 5_000 };

/** A fetch that returns scripted responses per URL, recording what was requested. */
function scriptedFetch(script: Record<string, Response | (() => Response)>) {
  const requested: string[] = [];
  const impl = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    const entry = script[url];
    if (!entry) return Promise.reject(new Error(`Unscripted request to ${url}`));
    return Promise.resolve(typeof entry === "function" ? entry() : entry);
  }) as typeof fetch;
  return { fetch: impl, requested };
}

function redirectTo(location: string, status = 302): () => Response {
  return () => new Response(null, { status, headers: { location } });
}

describe("safeFetch — redirect chain validation", () => {
  it("refuses a redirect from a public host to a private address", async () => {
    const script = scriptedFetch({
      "https://feeds.example.com/a.xml": redirectTo("http://169.254.169.254/latest/meta-data/"),
    });

    await expect(
      safeFetch("https://feeds.example.com/a.xml", BASE, {
        fetch: script.fetch,
        resolveHost: PUBLIC_DNS,
      }),
    ).rejects.toMatchObject({ reason: "blocked_host" });

    // The private hop must never have been requested.
    expect(script.requested).toEqual(["https://feeds.example.com/a.xml"]);
  });

  it("refuses a redirect to localhost", async () => {
    const script = scriptedFetch({
      "https://feeds.example.com/a.xml": redirectTo("http://localhost:8080/admin"),
    });
    await expect(
      safeFetch("https://feeds.example.com/a.xml", BASE, {
        fetch: script.fetch,
        resolveHost: PUBLIC_DNS,
      }),
    ).rejects.toMatchObject({ reason: "blocked_host" });
    expect(script.requested).toHaveLength(1);
  });

  it("refuses a redirect that switches to a non-HTTP scheme", async () => {
    const script = scriptedFetch({
      "https://feeds.example.com/a.xml": redirectTo("file:///etc/passwd"),
    });
    await expect(
      safeFetch("https://feeds.example.com/a.xml", BASE, {
        fetch: script.fetch,
        resolveHost: PUBLIC_DNS,
      }),
    ).rejects.toMatchObject({ reason: "bad_scheme" });
  });

  it("follows a legitimate public redirect and reports the final URL", async () => {
    const script = scriptedFetch({
      "https://feeds.example.com/a.xml": redirectTo("https://cdn.example.com/final.xml"),
      "https://cdn.example.com/final.xml": () => new Response("<rss/>", { status: 200 }),
    });

    const result = await safeFetchText("https://feeds.example.com/a.xml", BASE, {
      fetch: script.fetch,
      resolveHost: PUBLIC_DNS,
    });
    expect(result.text).toBe("<rss/>");
    expect(result.url).toBe("https://cdn.example.com/final.xml");
  });

  it("resolves a relative redirect against the hop that issued it", async () => {
    const script = scriptedFetch({
      "https://feeds.example.com/a/b.xml": redirectTo("../c.xml"),
      "https://feeds.example.com/c.xml": () => new Response("ok", { status: 200 }),
    });
    const result = await safeFetchText("https://feeds.example.com/a/b.xml", BASE, {
      fetch: script.fetch,
      resolveHost: PUBLIC_DNS,
    });
    expect(result.url).toBe("https://feeds.example.com/c.xml");
  });

  it("stops after the redirect limit instead of looping forever", async () => {
    const script = scriptedFetch({
      "https://feeds.example.com/loop": redirectTo("https://feeds.example.com/loop"),
    });
    await expect(
      safeFetch(
        "https://feeds.example.com/loop",
        { ...BASE, maxRedirects: 3 },
        { fetch: script.fetch, resolveHost: PUBLIC_DNS },
      ),
    ).rejects.toMatchObject({ reason: "too_many_redirects" });
    expect(script.requested).toHaveLength(4);
  });

  it("rejects a redirect with no Location header", async () => {
    const script = scriptedFetch({
      "https://feeds.example.com/a.xml": () => new Response(null, { status: 302 }),
    });
    await expect(
      safeFetch("https://feeds.example.com/a.xml", BASE, {
        fetch: script.fetch,
        resolveHost: PUBLIC_DNS,
      }),
    ).rejects.toMatchObject({ reason: "redirect_without_location" });
  });
});

describe("safeFetch — DNS validation", () => {
  it("refuses a public hostname that resolves to a private address", async () => {
    const script = scriptedFetch({
      "https://internal.example.com/x": () => new Response("secret", { status: 200 }),
    });

    await expect(
      safeFetch("https://internal.example.com/x", BASE, {
        fetch: script.fetch,
        resolveHost: () => Promise.resolve(["10.0.0.5"]),
      }),
    ).rejects.toMatchObject({ reason: "resolves_to_blocked_address" });

    // Nothing was requested: the check happens before connect.
    expect(script.requested).toEqual([]);
  });

  it("refuses when any answer in a multi-address DNS response is private", async () => {
    const script = scriptedFetch({
      "https://split.example.com/x": () => new Response("ok", { status: 200 }),
    });
    await expect(
      safeFetch("https://split.example.com/x", BASE, {
        fetch: script.fetch,
        resolveHost: () => Promise.resolve(["93.184.216.34", "127.0.0.1"]),
      }),
    ).rejects.toMatchObject({ reason: "resolves_to_blocked_address" });
    expect(script.requested).toEqual([]);
  });

  it("refuses an IPv6 link-local answer", async () => {
    const script = scriptedFetch({ "https://v6.example.com/x": () => new Response("ok") });
    await expect(
      safeFetch("https://v6.example.com/x", BASE, {
        fetch: script.fetch,
        resolveHost: () => Promise.resolve(["fe80::1"]),
      }),
    ).rejects.toMatchObject({ reason: "resolves_to_blocked_address" });
  });

  it("reports a DNS failure rather than connecting anyway", async () => {
    const script = scriptedFetch({ "https://nx.example.com/x": () => new Response("ok") });
    await expect(
      safeFetch("https://nx.example.com/x", BASE, {
        fetch: script.fetch,
        resolveHost: () => Promise.reject(new Error("ENOTFOUND")),
      }),
    ).rejects.toMatchObject({ reason: "dns_failure" });
    expect(script.requested).toEqual([]);
  });
});

describe("safeFetch — size and time limits", () => {
  it("aborts a body that exceeds the byte cap", async () => {
    const big = "x".repeat(5000);
    const script = scriptedFetch({
      "https://cdn.example.com/big": () => new Response(big, { status: 200 }),
    });

    await expect(
      safeFetch(
        "https://cdn.example.com/big",
        { ...BASE, maxBytes: 1000 },
        { fetch: script.fetch, resolveHost: PUBLIC_DNS },
      ),
    ).rejects.toMatchObject({ reason: "response_too_large" });
  });

  it("enforces the cap on the streamed body, not a declared content-length", async () => {
    // A server understating its size must not get past the limit.
    const script = scriptedFetch({
      "https://cdn.example.com/liar": () =>
        new Response("y".repeat(5000), { status: 200, headers: { "content-length": "10" } }),
    });

    await expect(
      safeFetch(
        "https://cdn.example.com/liar",
        { ...BASE, maxBytes: 1000 },
        { fetch: script.fetch, resolveHost: PUBLIC_DNS },
      ),
    ).rejects.toMatchObject({ reason: "response_too_large" });
  });

  it("surfaces a timeout as a typed rejection", async () => {
    const impl = (() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      return Promise.reject(error);
    }) as typeof fetch;

    await expect(
      safeFetch("https://slow.example.com/x", { ...BASE, timeoutMs: 5 }, {
        fetch: impl,
        resolveHost: PUBLIC_DNS,
      }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("keeps query strings out of error messages", async () => {
    const script = scriptedFetch({});
    const error = await safeFetch("http://127.0.0.1/x?token=supersecret", BASE, {
      fetch: script.fetch,
      resolveHost: PUBLIC_DNS,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SafeFetchError);
    expect((error as Error).message).not.toContain("supersecret");
  });
});

describe("safeFetch — host allowlist", () => {
  it("rejects a host outside the allowlist", async () => {
    const script = scriptedFetch({ "https://evil.example.com/x": () => new Response("ok") });
    await expect(
      safeFetch(
        "https://evil.example.com/x",
        { ...BASE, allowedHosts: ["itunes.apple.com"] },
        { fetch: script.fetch, resolveHost: PUBLIC_DNS },
      ),
    ).rejects.toMatchObject({ reason: "host_not_allowed" });
  });

  it("applies the allowlist to redirect hops too", async () => {
    const script = scriptedFetch({
      "https://itunes.apple.com/search": redirectTo("https://evil.example.com/x"),
    });
    await expect(
      safeFetch(
        "https://itunes.apple.com/search",
        { ...BASE, allowedHosts: ["itunes.apple.com"] },
        { fetch: script.fetch, resolveHost: PUBLIC_DNS },
      ),
    ).rejects.toMatchObject({ reason: "host_not_allowed" });
  });
});

describe("address classification", () => {
  const blocked = [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    // The three the reviewer identified as missing:
    "::ffff:127.0.0.1",
    "::ffff:10.1.2.3",
    "2001:db8::1",
  ];

  it.each(blocked)("refuses %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "8.8.8.8"])(
    "allows public address %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it("refuses names that always mean this machine", () => {
    expect(isBlockedAddress("localhost")).toBe(true);
    expect(isBlockedAddress("db.local")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });

  it("refuses an IPv4-mapped IPv6 literal in a URL", async () => {
    const script = scriptedFetch({});
    await expect(
      safeFetch("http://[::ffff:127.0.0.1]/x", BASE, {
        fetch: script.fetch,
        resolveHost: PUBLIC_DNS,
      }),
    ).rejects.toMatchObject({ reason: "blocked_host" });
    expect(script.requested).toEqual([]);
  });

  it("refuses a redirect to an IPv4-mapped IPv6 address", async () => {
    const script = scriptedFetch({
      "https://feeds.example.com/a.xml": redirectTo("http://[::ffff:169.254.169.254]/meta"),
    });
    await expect(
      safeFetch("https://feeds.example.com/a.xml", BASE, {
        fetch: script.fetch,
        resolveHost: PUBLIC_DNS,
      }),
    ).rejects.toMatchObject({ reason: "blocked_host" });
    expect(script.requested).toHaveLength(1);
  });
});

describe("connection pinning (DNS rebinding)", () => {
  it("connects using the exact address that was vetted", async () => {
    const pinned: string[] = [];
    const script = scriptedFetch({
      "https://rebind.example.com/x": () => new Response("ok", { status: 200 }),
    });

    await safeFetchText("https://rebind.example.com/x", BASE, {
      fetch: script.fetch,
      resolveHost: () => Promise.resolve(["93.184.216.34"]),
      createDispatcher: (address) => {
        pinned.push(address);
        return undefined as never;
      },
    });

    // The connection is pinned to the vetted answer, not re-resolved by fetch.
    expect(pinned).toEqual(["93.184.216.34"]);
  });

  it("pins each redirect hop to its own vetted address", async () => {
    const pinned: string[] = [];
    const byHost: Record<string, string> = {
      "first.example.com": "93.184.216.34",
      "second.example.com": "8.8.8.8",
    };
    const script = scriptedFetch({
      "https://first.example.com/a": redirectTo("https://second.example.com/b"),
      "https://second.example.com/b": () => new Response("ok", { status: 200 }),
    });

    await safeFetchText("https://first.example.com/a", BASE, {
      fetch: script.fetch,
      resolveHost: (hostname) => Promise.resolve([byHost[hostname] ?? "1.1.1.1"]),
      createDispatcher: (address) => {
        pinned.push(address);
        return undefined as never;
      },
    });

    expect(pinned).toEqual(["93.184.216.34", "8.8.8.8"]);
  });

  it("uses a literal address directly without resolving it", async () => {
    const pinned: string[] = [];
    const script = scriptedFetch({
      "https://93.184.216.34/x": () => new Response("ok", { status: 200 }),
    });

    await safeFetchText("https://93.184.216.34/x", BASE, {
      fetch: script.fetch,
      resolveHost: () => Promise.reject(new Error("DNS must not be consulted for a literal")),
      createDispatcher: (address) => {
        pinned.push(address);
        return undefined as never;
      },
    });

    expect(pinned).toEqual(["93.184.216.34"]);
  });
});

describe("pinnedLookup", () => {
  it("answers with the pinned address whatever hostname is asked for", () => {
    const lookup = pinnedLookup("93.184.216.34");
    let seen: unknown;
    lookup("evil.example.com", {}, (_error, address) => {
      seen = address;
    });
    expect(seen).toBe("93.184.216.34");
  });

  it("answers the all:true form with the same single address", () => {
    const lookup = pinnedLookup("93.184.216.34");
    let seen: unknown;
    lookup("evil.example.com", { all: true }, (_error, address) => {
      seen = address;
    });
    expect(seen).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("reports an error rather than passing through a non-address", () => {
    const lookup = pinnedLookup("not-an-ip");
    let error: Error | null = null;
    lookup("evil.example.com", {}, (caught) => {
      error = caught;
    });
    expect(error).toBeInstanceOf(Error);
  });

  it("builds a usable dispatcher", async () => {
    const dispatcher = createPinnedDispatcher("93.184.216.34");
    expect(dispatcher).toBeDefined();
    await dispatcher.close();
  });
});

describe("pinned connection against a real socket", () => {
  it("connects to the pinned address for a hostname that does not resolve", async () => {
    // Proves the pinned address is what the connection actually uses: DNS could
    // never resolve "pinned.invalid", yet the request reaches the local server.
    const seenHosts: string[] = [];
    const server = createServer((req, res) => {
      seenHosts.push(req.headers.host ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("reached");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const dispatcher = createPinnedDispatcher("127.0.0.1");
    try {
      const response = await defaultFetch(`http://pinned.invalid:${port}/`, {
        dispatcher,
      } as RequestInit);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("reached");
      // The original hostname is still sent, so TLS SNI and Host are unaffected.
      expect(seenHosts[0]).toBe(`pinned.invalid:${port}`);
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("defaultFetch is undici's, which is what accepts the pinning dispatcher", () => {
    // Node's global fetch is a separate internal undici copy and rejects a
    // dispatcher from the undici package; production must not use it here.
    expect(defaultFetch).not.toBe(globalThis.fetch);
  });
});

describe("dispatcher lifecycle", () => {
  /** Stands in for an undici Agent and records how it was released. */
  function dispatcherSpy() {
    const created: { address: string; closed: boolean; destroyed: boolean }[] = [];
    const create = (address: string) => {
      const record = { address, closed: false, destroyed: false };
      created.push(record);
      return {
        close: () => {
          record.closed = true;
          return Promise.resolve();
        },
        destroy: () => {
          record.destroyed = true;
          return Promise.resolve();
        },
      } as never;
    };
    return { created, create };
  }

  const allReleased = (created: { closed: boolean; destroyed: boolean }[]): boolean =>
    created.every((entry) => entry.closed || entry.destroyed);

  it("releases the dispatcher after a buffered response is consumed", async () => {
    const spy = dispatcherSpy();
    const script = scriptedFetch({
      "https://cdn.example.com/x": () => new Response("body", { status: 200 }),
    });

    await safeFetchText("https://cdn.example.com/x", BASE, {
      fetch: script.fetch,
      resolveHost: PUBLIC_DNS,
      createDispatcher: spy.create,
    });

    expect(spy.created).toHaveLength(1);
    expect(allReleased(spy.created)).toBe(true);
  });

  it("releases every hop's dispatcher across a redirect chain", async () => {
    const spy = dispatcherSpy();
    const script = scriptedFetch({
      "https://a.example.com/1": redirectTo("https://b.example.com/2"),
      "https://b.example.com/2": redirectTo("https://c.example.com/3"),
      "https://c.example.com/3": () => new Response("done", { status: 200 }),
    });

    await safeFetchText("https://a.example.com/1", BASE, {
      fetch: script.fetch,
      resolveHost: PUBLIC_DNS,
      createDispatcher: spy.create,
    });

    expect(spy.created).toHaveLength(3);
    expect(allReleased(spy.created)).toBe(true);
  });

  it("releases the dispatcher when the response is an HTTP error", async () => {
    const spy = dispatcherSpy();
    const script = scriptedFetch({
      "https://cdn.example.com/x": () => new Response("nope", { status: 500 }),
    });

    await expect(
      safeFetch("https://cdn.example.com/x", BASE, {
        fetch: script.fetch,
        resolveHost: PUBLIC_DNS,
        createDispatcher: spy.create,
      }),
    ).rejects.toMatchObject({ reason: "http_error" });

    expect(allReleased(spy.created)).toBe(true);
  });

  it("releases the dispatcher when the request itself throws", async () => {
    const spy = dispatcherSpy();
    const impl = (() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      return Promise.reject(error);
    }) as typeof fetch;

    await expect(
      safeFetch("https://cdn.example.com/x", BASE, {
        fetch: impl,
        resolveHost: PUBLIC_DNS,
        createDispatcher: spy.create,
      }),
    ).rejects.toMatchObject({ reason: "timeout" });

    expect(spy.created).toHaveLength(1);
    expect(allReleased(spy.created)).toBe(true);
  });

  it("releases the dispatcher when the body exceeds the byte cap", async () => {
    const spy = dispatcherSpy();
    const script = scriptedFetch({
      "https://cdn.example.com/big": () => new Response("z".repeat(5000), { status: 200 }),
    });

    await expect(
      safeFetch(
        "https://cdn.example.com/big",
        { ...BASE, maxBytes: 100 },
        { fetch: script.fetch, resolveHost: PUBLIC_DNS, createDispatcher: spy.create },
      ),
    ).rejects.toMatchObject({ reason: "response_too_large" });

    expect(allReleased(spy.created)).toBe(true);
  });

  it("releases the dispatcher when the body errors mid-stream", async () => {
    const spy = dispatcherSpy();
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const script = scriptedFetch({
      "https://cdn.example.com/x": () => new Response(failing, { status: 200 }),
    });

    await expect(
      safeFetch("https://cdn.example.com/x", BASE, {
        fetch: script.fetch,
        resolveHost: PUBLIC_DNS,
        createDispatcher: spy.create,
      }),
    ).rejects.toThrow(/connection reset/);

    expect(allReleased(spy.created)).toBe(true);
  });

  it("releases the dispatcher when the caller cancels a stream", async () => {
    const spy = dispatcherSpy();
    const script = scriptedFetch({
      "https://cdn.example.com/x": () => new Response("body", { status: 200 }),
    });

    const stream = await safeFetchStream("https://cdn.example.com/x", BASE, {
      fetch: script.fetch,
      resolveHost: PUBLIC_DNS,
      createDispatcher: spy.create,
    });
    expect(allReleased(spy.created)).toBe(false);

    await stream.cancel();
    expect(allReleased(spy.created)).toBe(true);
  });

  it("does not release the dispatcher before a returned stream finishes", async () => {
    const spy = dispatcherSpy();
    const script = scriptedFetch({
      "https://cdn.example.com/x": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.enqueue(new Uint8Array([4, 5, 6]));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });

    const stream = await safeFetchStream("https://cdn.example.com/x", BASE, {
      fetch: script.fetch,
      resolveHost: PUBLIC_DNS,
      createDispatcher: spy.create,
    });

    let chunks = 0;
    let bytes = 0;
    for await (const chunk of stream.body) {
      chunks += 1;
      bytes += chunk.byteLength;
      // Still open while the caller is mid-body.
      expect(allReleased(spy.created)).toBe(false);
    }

    expect(chunks).toBe(2);
    expect(bytes).toBe(6);
    expect(allReleased(spy.created)).toBe(true);
  });

  it("releases the dispatcher when the consumer abandons the stream early", async () => {
    const spy = dispatcherSpy();
    const script = scriptedFetch({
      "https://cdn.example.com/x": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.enqueue(new Uint8Array([2]));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });

    const stream = await safeFetchStream("https://cdn.example.com/x", BASE, {
      fetch: script.fetch,
      resolveHost: PUBLIC_DNS,
      createDispatcher: spy.create,
    });

    // Abandon after the first chunk.
    for await (const chunk of stream.body) {
      expect(chunk.byteLength).toBeGreaterThan(0);
      break;
    }

    expect(allReleased(spy.created)).toBe(true);
  });

  it("falls back to destroy when a graceful close is refused", async () => {
    const record = { closed: false, destroyed: false };
    const script = scriptedFetch({
      "https://cdn.example.com/x": () => new Response("body", { status: 200 }),
    });

    await safeFetchText("https://cdn.example.com/x", BASE, {
      fetch: script.fetch,
      resolveHost: PUBLIC_DNS,
      createDispatcher: () =>
        ({
          close: () => {
            record.closed = true;
            return Promise.reject(new Error("requests in flight"));
          },
          destroy: () => {
            record.destroyed = true;
            return Promise.resolve();
          },
        }) as never,
    });

    expect(record.closed).toBe(true);
    expect(record.destroyed).toBe(true);
  });
});

describe("IPv6 literals", () => {
  it("treats a bracketed public IPv6 literal as an address, not a hostname", async () => {
    const pinned: string[] = [];
    const address = "2606:2800:220:1:248:1893:25c8:1946";
    const script = scriptedFetch({
      [`https://[${address}]/x`]: () => new Response("ok", { status: 200 }),
    });

    const result = await safeFetchText(`https://[${address}]/x`, BASE, {
      fetch: script.fetch,
      // DNS must not be consulted for a literal; rejecting proves it was not.
      resolveHost: () => Promise.reject(new Error("DNS must not be consulted")),
      createDispatcher: (pinnedAddress) => {
        pinned.push(pinnedAddress);
        return { close: () => Promise.resolve() } as never;
      },
    });

    expect(result.text).toBe("ok");
    // Pinned without brackets, so it is usable as an address.
    expect(pinned).toEqual([address]);
  });
});

describe("oversize abort against a real undici connection", () => {
  /**
   * The spy tests above cannot prove this: they never open a socket, so they
   * cannot show that an endless body is actually cut off rather than left
   * running until the network timeout. This uses a real local server, real
   * undici, and a real pinned dispatcher.
   */
  it("aborts an endless oversized body promptly and closes the connection", async () => {
    let connectionClosed = false;
    let closeObserved: () => void = () => {};
    const sawClose = new Promise<void>((resolve) => {
      closeObserved = resolve;
    });

    let timer: NodeJS.Timeout | undefined;
    const server = createServer((req, res) => {
      req.on("close", () => {
        connectionClosed = true;
        closeObserved();
      });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      // Never ends, and never signals a length: only an abort stops it.
      timer = setInterval(() => {
        res.write("x".repeat(4096));
      }, 5);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const started = Date.now();
    try {
      await expect(
        safeFetch(
          // A name, so the URL guard passes; the dispatcher pins it to loopback.
          `http://pinned.invalid:${port}/endless`,
          // A long deadline: if the abort worked, this is never reached.
          { maxBytes: 8192, timeoutMs: 60_000 },
          {
            fetch: defaultFetch,
            resolveHost: () => Promise.resolve(["93.184.216.34"]),
            createDispatcher: () => createPinnedDispatcher("127.0.0.1"),
          },
        ),
      ).rejects.toMatchObject({ reason: "response_too_large" });

      const elapsed = Date.now() - started;
      // Promptly, meaning the byte cap ended it rather than the 60 s deadline.
      expect(elapsed).toBeLessThan(10_000);

      await Promise.race([
        sawClose,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("server never saw the connection close")), 10_000),
        ),
      ]);
      expect(connectionClosed).toBe(true);
    } finally {
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it("releases the connection when the caller cancels a streamed body mid-read", async () => {
    let connectionClosed = false;
    let closeObserved: () => void = () => {};
    const sawClose = new Promise<void>((resolve) => {
      closeObserved = resolve;
    });

    let timer: NodeJS.Timeout | undefined;
    const server = createServer((req, res) => {
      req.on("close", () => {
        connectionClosed = true;
        closeObserved();
      });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      timer = setInterval(() => {
        res.write("y".repeat(1024));
      }, 5);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const stream = await safeFetchStream(
        `http://pinned.invalid:${port}/endless`,
        { maxBytes: 10_000_000, timeoutMs: 60_000 },
        {
          fetch: defaultFetch,
          resolveHost: () => Promise.resolve(["93.184.216.34"]),
          createDispatcher: () => createPinnedDispatcher("127.0.0.1"),
        },
      );

      // Read one chunk, then walk away while the body is still locked.
      for await (const chunk of stream.body) {
        expect(chunk.byteLength).toBeGreaterThan(0);
        break;
      }

      await Promise.race([
        sawClose,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("server never saw the connection close")), 10_000),
        ),
      ]);
      expect(connectionClosed).toBe(true);
    } finally {
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
