import { SafeFetchError, safeFetchText, type SafeFetchDeps } from "../http/safe-fetch.js";
import { feedEpisodes, type FeedEpisode } from "../matching/feed.js";
import { matchEpisode } from "../matching/match.js";
import { titleSimilarity } from "../matching/similarity.js";
import { DEFAULT_THRESHOLDS, type ScoredCandidate } from "../matching/types.js";
import { extractSpotifyEmbedData, type SpotifyEmbedData } from "../vendor/summarize/spotify-embed.js";
import { parseSpotifyEpisodeUrl, type SpotifyUrlError } from "./spotify-url.js";

/** Hosts the resolver may contact. Everything else is refused before connect. */
export const ALLOWED_METADATA_HOSTS = ["spotify.com", "itunes.apple.com"] as const;

/** Minimum show-title similarity before a feed is accepted as the right podcast. */
const SHOW_MATCH_THRESHOLD = 0.8;

export interface ResolutionEvidence {
  showTitle: string;
  episodeTitle: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  feedUrl: string;
  enclosureUrl: string | null;
  transcriptUrl: string | null;
  confidence: number;
  coverage: number;
  signals: { signal: string; score: number; detail: string }[];
}

export type ResolutionOutcome =
  | { status: "resolved"; evidence: ResolutionEvidence; episode: FeedEpisode }
  | { status: "ambiguous"; reason: string; feedUrl: string; candidates: ScoredCandidate[] }
  | { status: "failed"; reason: ResolutionFailure; detail: string };

export type ResolutionFailure =
  | SpotifyUrlError
  | "embed_unavailable"
  | "embed_unparsable"
  | "feed_not_found"
  | "show_mismatch"
  | "feed_unavailable"
  | "blocked_url"
  | "no_match";

export type ResolverDeps = SafeFetchDeps;

/** Metadata and feed documents are text; these caps are generous but finite. */
const METADATA_LIMITS = { maxBytes: 2 * 1024 * 1024, timeoutMs: 30_000 } as const;
const FEED_LIMITS = { maxBytes: 16 * 1024 * 1024, timeoutMs: 60_000 } as const;

/**
 * Spotify episode URL to a specific RSS episode.
 *
 * Never returns an episode it is not confident about. Where upstream fell back
 * to the first search result and the first feed item, this returns `ambiguous`
 * or `failed` and lets the caller ask the user.
 */
export async function resolveEpisode(
  input: string,
  deps: ResolverDeps,
): Promise<ResolutionOutcome> {
  const parsed = parseSpotifyEpisodeUrl(input);
  if (!parsed.ok) {
    return { status: "failed", reason: parsed.reason, detail: input.slice(0, 200) };
  }

  const embed = await fetchEmbed(parsed.embedUrl, deps);
  if (embed.status !== "ok") return embed.outcome;

  const feed = await resolveFeed(embed.data.showTitle, deps);
  if (feed.status !== "ok") return feed.outcome;

  const episodes = feedEpisodes(feed.xml);
  const result = matchEpisode(
    {
      episodeTitle: embed.data.episodeTitle,
      showTitle: embed.data.showTitle,
      durationSeconds: embed.data.durationSeconds,
      publishedAt: embed.data.releaseDate,
    },
    episodes,
    DEFAULT_THRESHOLDS,
  );

  if (result.status === "no_match") {
    return { status: "failed", reason: "no_match", detail: result.reason };
  }
  if (result.status === "ambiguous") {
    return {
      status: "ambiguous",
      reason: result.reason,
      feedUrl: feed.url,
      candidates: result.candidates,
    };
  }

  const episode = result.best.candidate as FeedEpisode;
  return {
    status: "resolved",
    episode,
    evidence: {
      showTitle: episode.showTitle ?? embed.data.showTitle,
      episodeTitle: episode.title,
      publishedAt: episode.publishedAt ?? null,
      durationSeconds: episode.durationSeconds ?? null,
      feedUrl: feed.url,
      enclosureUrl: episode.enclosureUrl ?? null,
      transcriptUrl: episode.transcript?.url ?? null,
      confidence: result.best.confidence,
      coverage: result.best.coverage,
      signals: result.best.evidence.map((entry) => ({
        signal: entry.signal,
        score: entry.score,
        detail: entry.detail,
      })),
    },
  };
}

type EmbedStep =
  | { status: "ok"; data: SpotifyEmbedData }
  | { status: "error"; outcome: ResolutionOutcome };

async function fetchEmbed(embedUrl: string, deps: ResolverDeps): Promise<EmbedStep> {
  let html: string;
  try {
    const response = await safeFetchText(
      embedUrl,
      { ...METADATA_LIMITS, allowedHosts: ALLOWED_METADATA_HOSTS, accept: "text/html" },
      deps,
    );
    html = response.text;
  } catch (error) {
    return { status: "error", outcome: fetchFailure(error, "embed_unavailable") };
  }

  const data = extractSpotifyEmbedData(html);
  if (!data) {
    return {
      status: "error",
      outcome: {
        status: "failed",
        reason: "embed_unparsable",
        detail: "Spotify embed did not contain usable episode metadata",
      },
    };
  }
  return { status: "ok", data };
}

/** Map a safe-fetch rejection onto the resolution failure the UI explains. */
function fetchFailure(error: unknown, fallback: ResolutionFailure): ResolutionOutcome {
  if (error instanceof SafeFetchError) {
    const blocked =
      error.reason === "blocked_host" ||
      error.reason === "bad_scheme" ||
      error.reason === "host_not_allowed" ||
      error.reason === "credentials_in_url" ||
      error.reason === "resolves_to_blocked_address" ||
      error.reason === "too_many_redirects";
    return {
      status: "failed",
      reason: blocked ? "blocked_url" : fallback,
      detail: error.message,
    };
  }
  return {
    status: "failed",
    reason: fallback,
    detail: error instanceof Error ? error.message : String(error),
  };
}

type FeedStep =
  | { status: "ok"; url: string; xml: string }
  | { status: "error"; outcome: ResolutionOutcome };

/**
 * Find the publisher feed for a show through the iTunes directory.
 *
 * Upstream took `results[0]` when nothing matched by title. Here the best
 * result must clear a similarity threshold against the Spotify show name, or
 * resolution fails rather than binding to some other podcast's feed.
 */
async function resolveFeed(showTitle: string, deps: ResolverDeps): Promise<FeedStep> {
  const query = new URLSearchParams({
    term: showTitle,
    media: "podcast",
    entity: "podcast",
    limit: "10",
  });

  let payload: { results?: unknown };
  try {
    const response = await safeFetchText(
      `https://itunes.apple.com/search?${query.toString()}`,
      { ...METADATA_LIMITS, allowedHosts: ALLOWED_METADATA_HOSTS, accept: "application/json" },
      deps,
    );
    payload = JSON.parse(response.text) as { results?: unknown };
  } catch (error) {
    return { status: "error", outcome: fetchFailure(error, "feed_not_found") };
  }

  const results = Array.isArray(payload.results) ? payload.results : [];
  const ranked = results
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const name = typeof entry.collectionName === "string" ? entry.collectionName : "";
      return {
        feedUrl: typeof entry.feedUrl === "string" ? entry.feedUrl : null,
        name,
        score: titleSimilarity(showTitle, name),
      };
    })
    .filter((entry) => entry.feedUrl !== null)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) {
    return {
      status: "error",
      outcome: {
        status: "failed",
        reason: "feed_not_found",
        detail: `No podcast feed found for "${showTitle}"`,
      },
    };
  }
  if (best.score < SHOW_MATCH_THRESHOLD) {
    return {
      status: "error",
      outcome: {
        status: "failed",
        reason: "show_mismatch",
        detail: `Closest directory result "${best.name}" is not confidently "${showTitle}"`,
      },
    };
  }

  try {
    // The feed URL comes from a third-party directory, so it gets the full guard
    // with no host allowlist: any public host is legitimate, private ones are not.
    const feed = await safeFetchText(best.feedUrl ?? "", { ...FEED_LIMITS, accept: "application/rss+xml, application/xml, text/xml" }, deps);
    return { status: "ok", url: feed.url, xml: feed.text };
  } catch (error) {
    return { status: "error", outcome: fetchFailure(error, "feed_unavailable") };
  }
}
