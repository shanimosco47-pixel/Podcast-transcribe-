/**
 * Outbound URL guard for server-side fetching (SSRF protection).
 *
 * The server follows URLs that come from Spotify pages and third-party RSS
 * feeds, so every one is untrusted input. This refuses non-HTTP schemes,
 * credentials in the URL, and hosts that resolve to private or reserved
 * address space by literal.
 *
 * Literal-address blocking does not stop a hostname that resolves to a private
 * address; that requires resolving before connect, which belongs with the real
 * fetch implementation in a later gate. Recorded here rather than implied.
 */

export type UrlRejection =
  | "not_a_url"
  | "bad_scheme"
  | "credentials_in_url"
  | "blocked_host"
  | "host_not_allowed";

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: UrlRejection };

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/** Private, loopback, link-local, CGNAT, documentation, and multicast ranges. */
function isBlockedIpv4(host: string): boolean {
  const octets = parseIpv4(host);
  if (!octets) return false;
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "::") return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  return isBlockedIpv4(host);
}

/**
 * Check an outbound URL. When `allowedHosts` is given, the host must match one
 * of them exactly or be a subdomain of one.
 */
export function checkOutboundUrl(raw: string, allowedHosts?: readonly string[]): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "bad_scheme" };
  }
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  if (isBlockedHostname(url.hostname)) return { ok: false, reason: "blocked_host" };

  if (allowedHosts) {
    const host = url.hostname.toLowerCase();
    const allowed = allowedHosts.some(
      (candidate) => host === candidate || host.endsWith(`.${candidate}`),
    );
    if (!allowed) return { ok: false, reason: "host_not_allowed" };
  }

  return { ok: true, url };
}
