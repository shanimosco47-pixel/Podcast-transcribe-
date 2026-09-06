/**
 * Spotify episode URL validation and normalization.
 *
 * Built on `extractSpotifyEpisodeId` from steipete/summarize, tightened for
 * this product: only episode URLs on Spotify hosts are accepted, and the
 * result is a canonical form so the same episode pasted in different shapes
 * (share links with tracking parameters, locale prefixes, the URI scheme)
 * resolves to one identity.
 */

const SPOTIFY_HOSTS = new Set(["open.spotify.com", "play.spotify.com", "spotify.com"]);

/** Spotify base-62 IDs are 22 characters, but the length is not contractual. */
const EPISODE_ID_PATTERN = /^[A-Za-z0-9]{16,40}$/;

export type SpotifyUrlResult =
  | { ok: true; episodeId: string; canonicalUrl: string; embedUrl: string }
  | { ok: false; reason: SpotifyUrlError };

export type SpotifyUrlError =
  | "empty"
  | "not_a_url"
  | "not_spotify"
  | "not_an_episode"
  | "malformed_episode_id";

export function parseSpotifyEpisodeUrl(input: string): SpotifyUrlResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // spotify:episode:<id> is what the desktop app copies.
  const uriMatch = trimmed.match(/^spotify:episode:([A-Za-z0-9]+)$/i);
  if (uriMatch?.[1]) return finish(uriMatch[1]);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "not_a_url" };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!SPOTIFY_HOSTS.has(host)) return { ok: false, reason: "not_spotify" };

  // Locale-prefixed share links look like /intl-he/episode/<id>.
  const segments = parsed.pathname.split("/").filter(Boolean);
  const index = segments.indexOf("episode");
  if (index < 0) return { ok: false, reason: "not_an_episode" };

  const id = segments[index + 1];
  if (!id) return { ok: false, reason: "not_an_episode" };
  return finish(id);
}

function finish(rawId: string): SpotifyUrlResult {
  if (!EPISODE_ID_PATTERN.test(rawId)) return { ok: false, reason: "malformed_episode_id" };
  return {
    ok: true,
    episodeId: rawId,
    canonicalUrl: `https://open.spotify.com/episode/${rawId}`,
    embedUrl: `https://open.spotify.com/embed/episode/${rawId}`,
  };
}
