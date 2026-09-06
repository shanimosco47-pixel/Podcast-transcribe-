import { describe, expect, it } from "vitest";

import { safeFetch, SafeFetchError, safeFetchText } from "../src/http/safe-fetch.js";

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
