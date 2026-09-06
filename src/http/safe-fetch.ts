import { lookup } from "node:dns/promises";

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

export interface SafeFetchDeps {
  fetch: typeof fetch;
  /** Injectable so tests can simulate a hostname that resolves to a private address. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

const DEFAULT_MAX_REDIRECTS = 5;

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
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = checkOutboundUrl(current, options.allowedHosts);
    if (!check.ok) {
      throw new SafeFetchError(check.reason, `Refused ${redact(current)}: ${check.reason}`);
    }
    await assertHostResolvesPublicly(check.url.hostname, resolveHost);

    const response = await requestWithTimeout(check.url, options, deps);

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      void response.body?.cancel();
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
      void response.body?.cancel();
      throw new SafeFetchError("http_error", `Request failed with status ${response.status}`);
    }

    return {
      url: check.url.toString(),
      status: response.status,
      contentType: response.headers.get("content-type"),
      declaredBytes: parseLength(response.headers.get("content-length")),
      body: iterate(response),
      cancel: async () => {
        await response.body?.cancel().catch(() => undefined);
      },
    };
  }

  throw new SafeFetchError(
    "too_many_redirects",
    `Exceeded ${maxRedirects} redirects starting from ${redact(rawUrl)}`,
  );
}

async function assertHostResolvesPublicly(
  hostname: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<void> {
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
}

async function requestWithTimeout(
  url: URL,
  options: SafeFetchOptions,
  deps: SafeFetchDeps,
): Promise<Response> {
  try {
    const init: RequestInit = {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    };
    if (options.accept) init.headers = { accept: options.accept };
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

async function* iterate(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
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
