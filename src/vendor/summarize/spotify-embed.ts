/**
 * Spotify embed metadata extraction, vendored from steipete/summarize (MIT).
 * See NOTICE.md. The embed page carries stable `__NEXT_DATA__` even when the
 * public episode page is behind bot protection, which is why it is the source.
 */

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function getString(value: unknown, path: readonly string[]): string | null {
  const found = getPath(value, path);
  return typeof found === "string" ? found : null;
}

function getNumber(value: unknown, path: readonly string[]): number | null {
  const found = getPath(value, path);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

export interface SpotifyEmbedData {
  showTitle: string;
  episodeTitle: string;
  durationSeconds: number | null;
  releaseDate: string | null;
  drmFormat: string | null;
}

export function extractSpotifyEmbedData(html: string): SpotifyEmbedData | null {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;

  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const entity = ["props", "pageProps", "state", "data", "entity"] as const;
  const showTitle = (getString(json, [...entity, "subtitle"]) ?? "").trim();
  const episodeTitle = (getString(json, [...entity, "title"]) ?? "").trim();
  if (!showTitle || !episodeTitle) return null;

  const durationMs = getNumber(json, [...entity, "duration"]);
  return {
    showTitle,
    episodeTitle,
    durationSeconds: durationMs === null ? null : durationMs / 1000,
    releaseDate: getString(json, [...entity, "releaseDate"]),
    drmFormat: getString(json, ["props", "pageProps", "state", "data", "defaultAudioFileObject", "format"]),
  };
}
