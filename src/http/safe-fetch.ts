import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import { checkOutboundUrl, isBlockedAddress, type UrlRejection } from "./url-guard.js";

export type SafeFetchRejection =
  | UrlRejection
  | "too_many_redirects"
  | "redirect_without_location"
  | "resolves_to_blocked_address"
  | "dns_failure"
  | "response_too_large"
  | "timeout"
  | "http_error";

export class SafeFetchError extends Error {
  constructor(
    readonly reason: SafeFetchRejection,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  /** When set, every hop must be on one of these hosts. */
  allowedHosts?: readonly string[];
  /** Hard cap on the response body. Enforced while streaming, not from headers. */
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  accept?: string;
}

/**
 * The fetch implementation production must use.
 *
 * Address pinning passes a `dispatcher` built from the `undici` package, and
 * Node's *global* fetch is a different, internal copy of undici that rejects it
 * with "invalid onRequestStart method" — verified, not assumed. Both must come
 * from the same undici, so the app fetches through this rather than the global.
 */
export const defaultFetch = undiciFetch as unknown as typeof fetch;

export interface SafeFetchDeps {
  fetch: typeof fetch;
  /** Injectable so tests can simulate a hostname that resolves to a private address. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /**
   * Builds the dispatcher that pins a connection to an already-vetted address.
   * Injectable so tests can observe which address the connection would use.
   */
  createDispatcher?: (address: string) => Dispatcher;
}

/**
 * A dispatcher whose DNS lookup always answers with `address`.
 *
 * Without this, `safeFetch` validates the name and then hands the *name* to
 * fetch, which resolves it a second time. Between those two resolutions the
 * answer can change, so a host that passed validation as a public address can
 * be connected to as `127.0.0.1` — classic DNS rebinding, and a plain
 * time-of-check/time-of-use gap. Pinning the vetted address closes it. The URL
 * still carries the hostname, so SNI, certificate validation and the Host
 * header are unaffected.
 */
export function createPinnedDispatcher(address: string): Dispatcher {
  return new Agent({ connect: { lookup: pinnedLookup(address) } });
}

type LookupCallback = (error: Error | null, address: never, family?: never) => void;

/**
 * A `dns.lookup`-shaped function that ignores the hostname and always answers
 * with `address`. Exported so the pinning behaviour is directly testable.
 */
export function pinnedLookup(
  address: string,
): (hostname: string, options: { all?: boolean | undefined }, callback: LookupCallback) => void {
  return (_hostname, options, callback) => {
    const family = isIP(address);
    if (family === 0) {
      callback(new Error(`Pinned address is not an IP: ${address}`), "" as never);
      return;
    }
    if (options.all === true) {
      callback(null, [{ address, family }] as never);
      return;
    }
    callback(null, address as never, family as never);
  };
}

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * `URL.hostname` keeps the brackets on an IPv6 literal ("[::1]"), so `isIP`
 * reports 0 and the literal would be sent to DNS as a name. Strip them before
 * any literal detection or pinning.
 */
function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/**
 * Owns one dispatcher for one hop.
 *
 * Every dispatcher `safeFetch` creates carries a connection pool, so one must
 * be released on every exit path: redirect, HTTP error, abort, oversize, body
 * error, and normal completion. Without this, repeated jobs accumulate pools
 * and file descriptors until the process degrades. Closing is idempotent
 * because several paths can race to release the same hop.
 */
interface DispatcherHandle {
  dispatcher: Dispatcher;
  /** Graceful. Only for a response that was fully consumed. */
  close(): Promise<void>;
  /** Immediate. For every abnormal end: oversize, cancel, abandon, body error. */
  destroy(): Promise<void>;
  readonly released: boolean;
}

function ownDispatcher(dispatcher: Dispatcher): DispatcherHandle {
  let released = false;
  const release = async (hard: boolean): Promise<void> => {
    if (released) return;
    released = true;
    if (hard) {
      try {
        await dispatcher?.destroy?.();
      } catch {
        /* nothing further to do */
      }
      return;
    }
    try {
      await dispatcher?.close?.();
    } catch {
      // A pool with in-flight work refuses a graceful close; drop it hard
      // rather than leak it.
      try {
        await dispatcher?.destroy?.();
      } catch {
        /* nothing further to do */
      }
    }
  };

  return {
    dispatcher,
    get released() {
      return released;
    },
    close: () => release(false),
    destroy: () => release(true),
  };
}

/**
 * Release a response body we are not handing to the caller.
 *
 * Only safe while nothing holds the reader lock: `body.cancel()` rejects with
 * "ReadableStream is locked" once a reader exists, and swallowing that would
 * leave the request running. A locked body is cancelled by whoever owns the
 * reader instead.
 */
async function discard(response: Response): Promise<void> {
  if (!response.body || response.body.locked) return;
  try {
    await response.body.cancel();
  } catch {
    /* already released */
  }
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Fetch a URL that came from untrusted content, checking the whole redirect chain.
 *
 * `redirect: "follow"` is never used: the browser-style follow applies any guard
 * to the first URL only, so a public host can redirect to `169.254.169.254` and
 * the check is bypassed. Here each hop is re-validated, its hostname resolved,
 * and every resolved address tested against private and reserved ranges before
 * the request is made.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions,
  deps: SafeFetchDeps,
): Promise<{ url: string; status: number; body: Uint8Array; contentType: string | null }> {
  const stream = await safeFetchStream(rawUrl, options, deps);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream.body) {
    total += chunk.byteLength;
    if (total > options.maxBytes) {
      await stream.cancel();
      throw new SafeFetchError(
        "response_too_large",
        `Response exceeded ${options.maxBytes} bytes`,
      );
    }
    chunks.push(chunk);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { url: stream.url, status: stream.status, body, contentType: stream.contentType };
}

/** Convenience wrapper for text resources. */
export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions,
  deps: SafeFetchDeps,
): Promise<{ url: string; text: string }> {
  const result = await safeFetch(rawUrl, options, deps);
  return { url: result.url, text: new TextDecoder("utf-8").decode(result.body) };
}

export interface SafeStream {
  url: string;
  status: number;
  contentType: string | null;
  /** Declared length, when the server sent one. Advisory only. */
  declaredBytes: number | null;
  body: AsyncIterable<Uint8Array>;
  cancel: () => Promise<void>;
}

/**
 * Same validation as `safeFetch`, but hands back the stream so large bodies can
 * go straight to disk instead of through memory.
 */
export async function safeFetchStream(
  rawUrl: string,
  options: SafeFetchOptions,
  deps: SafeFetchDeps,
): Promise<SafeStream> {
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const makeDispatcher = deps.createDispatcher ?? createPinnedDispatcher;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = checkOutboundUrl(current, options.allowedHosts);
    if (!check.ok) {
      throw new SafeFetchError(check.reason, `Refused ${redact(current)}: ${check.reason}`);
    }
    const vettedAddress = await assertHostResolvesPublicly(bareHostname(check.url), resolveHost);

    const handle = ownDispatcher(makeDispatcher(vettedAddress));
    // Cancelling an in-flight streamed body has to abort the request itself.
    // Closing the pool gracefully would wait for that request instead of
    // ending it, which is the opposite of what a byte-cap abort needs.
    const aborter = new AbortController();

    let response: Response;
    try {
      response = await requestWithTimeout(check.url, handle.dispatcher, aborter, options, deps);
    } catch (error) {
      await handle.destroy();
      throw error;
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      await discard(response);
      await handle.close();
      aborter.abort();
      if (!location) {
        throw new SafeFetchError(
          "redirect_without_location",
          `Redirect ${response.status} without a Location header`,
        );
      }
      // Relative redirects resolve against the hop that issued them.
      current = new URL(location, check.url).toString();
      continue;
    }

    if (!response.ok) {
      await discard(response);
      await handle.close();
      aborter.abort();
      throw new SafeFetchError("http_error", `Request failed with status ${response.status}`);
    }

    // From here the caller owns the body, so the dispatcher outlives this
    // function and is released when the body ends or the caller cancels.
    return {
      url: check.url.toString(),
      status: response.status,
      contentType: response.headers.get("content-type"),
      declaredBytes: parseLength(response.headers.get("content-length")),
      body: iterate(response, handle, aborter),
      cancel: async () => {
        // Abort first: the socket must stop delivering bytes even when a
        // reader holds the body lock and `discard` cannot touch it.
        aborter.abort();
        await discard(response);
        await handle.destroy();
      },
    };
  }

  throw new SafeFetchError(
    "too_many_redirects",
    `Exceeded ${maxRedirects} redirects starting from ${redact(rawUrl)}`,
  );
}

/** Validates every resolved address and returns the one the connection must use. */
async function assertHostResolvesPublicly(
  hostname: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<string> {
  // A literal address needs no resolution; checkOutboundUrl already judged it.
  if (isIP(hostname) !== 0) return hostname;

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new SafeFetchError("dns_failure", `Could not resolve ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new SafeFetchError("dns_failure", `No addresses for ${hostname}`);
  }
  // Every answer must be public: one private address in the set is enough to
  // reach an internal service, since which one is used is not ours to choose.
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SafeFetchError(
        "resolves_to_blocked_address",
        `${hostname} resolves to a private or reserved address`,
      );
    }
  }
  // The first vetted answer is the one pinned for the connection, so the
  // address used is always one this function actually checked.
  return addresses[0] as string;
}

async function requestWithTimeout(
  url: URL,
  dispatcher: Dispatcher,
  aborter: AbortController,
  options: SafeFetchOptions,
  deps: SafeFetchDeps,
): Promise<Response> {
  try {
    const init: RequestInit & { dispatcher?: Dispatcher } = {
      redirect: "manual",
      // Either the deadline or an explicit cancellation ends the request.
      signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs), aborter.signal]),
    };
    if (options.accept) init.headers = { accept: options.accept };
    init.dispatcher = dispatcher;

    return await deps.fetch(url.toString(), init);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new SafeFetchError("timeout", `Request timed out after ${options.timeoutMs}ms`);
    }
    throw error;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Yield the body, then release the hop's dispatcher.
 *
 * The `finally` runs on normal completion, on a read error, and when the
 * consumer abandons the loop early (a `break` or a throw inside `for await`),
 * so the dispatcher is released on every way out of the stream.
 */
async function* iterate(
  response: Response,
  handle: DispatcherHandle,
  aborter: AbortController,
): AsyncIterable<Uint8Array> {
  if (!response.body) {
    await handle.close();
    return;
  }

  const reader = response.body.getReader();
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return;
      }
      if (value) yield value;
    }
  } finally {
    if (completed) {
      reader.releaseLock();
      await handle.close();
    } else {
      // Abnormal end: oversize, a consumer that stopped early, or a read
      // error. Cancel through the reader we own, since an outside
      // `body.cancel()` would reject on the lock, then abort the request and
      // drop the pool rather than waiting for it.
      try {
        await reader.cancel();
      } catch {
        /* already errored */
      }
      reader.releaseLock();
      aborter.abort();
      await handle.destroy();
    }
  }
}

/** Query strings can carry tokens; keep them out of messages and logs. */
function redact(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<malformed url>";
  }
}
