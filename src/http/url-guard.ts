import ipaddr from "ipaddr.js";

export type UrlRejection =
  | "not_a_url"
  | "bad_scheme"
  | "credentials_in_url"
  | "blocked_host"
  | "host_not_allowed";

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: UrlRejection };

/**
 * The only address class we will connect to.
 *
 * An allowlist rather than a blocklist: `ipaddr.js` classifies every other
 * range as loopback, private, linkLocal, uniqueLocal, carrierGradeNat,
 * multicast, reserved, unspecified, broadcast, 6to4, teredo and so on, and a
 * range we fail to anticipate should be refused rather than dialled. This
 * replaced hand-written regexes that missed IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`), the IPv6 documentation range (`2001:db8::/32`) and
 * IPv6 multicast.
 */
const ALLOWED_RANGE = "unicast";

/** Names that always mean the local machine, whatever DNS says. */
function isLocalName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

/**
 * True for any address we refuse to connect to.
 *
 * Accepts a hostname or a literal address. A hostname that is not an IP
 * literal is not judged here; `safeFetch` resolves it and applies this same
 * function to every resolved address.
 *
 * Exported so `safeFetch` uses the identical rule; a second implementation
 * would drift from this one.
 */
export function isBlockedAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (isLocalName(host)) return true;

  if (!ipaddr.isValid(host)) return false;

  let parsed = ipaddr.parse(host);
  // `::ffff:127.0.0.1` is loopback wearing an IPv6 costume; judge the address
  // it actually carries.
  if (parsed.kind() === "ipv6") {
    const asV6 = parsed as ipaddr.IPv6;
    if (asV6.isIPv4MappedAddress()) parsed = asV6.toIPv4Address();
  }
  return parsed.range() !== ALLOWED_RANGE;
}

/**
 * Check an outbound URL's shape and any literal address it carries.
 *
 * When `allowedHosts` is given, the host must equal one of them or be a
 * subdomain of one.
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
  if (isBlockedAddress(url.hostname)) return { ok: false, reason: "blocked_host" };

  if (allowedHosts) {
    const host = url.hostname.toLowerCase();
    const allowed = allowedHosts.some(
      (candidate) => host === candidate || host.endsWith(`.${candidate}`),
    );
    if (!allowed) return { ok: false, reason: "host_not_allowed" };
  }

  return { ok: true, url };
}
