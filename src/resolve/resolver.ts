import { checkOutboundUrl } from "../http/url-guard.js";
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

export interface ResolverDeps {
  /** Injected so tests drive recorded fixtures and production drives the network. */
  fetch: typeof fetch;
}

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
  const guard = checkOutboundUrl(embedUrl, ALLOWED_METADATA_HOSTS);
  if (!guard.ok) {
    return {
      status: "error",
      outcome: { status: "failed", reason: "blocked_url", detail: guard.reason },
    };
  }

  const response = await deps.fetch(embedUrl, { redirect: "follow" });
  if (!response.ok) {
    return {
      status: "error",
      outcome: {
        status: "failed",
        reason: "embed_unavailable",
        detail: `Spotify embed responded ${response.status}`,
      },
    };
  }

  const data = extractSpotifyEmbedData(await response.text());
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
  const searchUrl = `https://itunes.apple.com/search?${query.toString()}`;
  const guard = checkOutboundUrl(searchUrl, ALLOWED_METADATA_HOSTS);
  if (!guard.ok) {
    return {
      status: "error",
      outcome: { status: "failed", reason: "blocked_url", detail: guard.reason },
    };
  }

  const response = await deps.fetch(searchUrl, { redirect: "follow" });
  if (!response.ok) {
    return {
      status: "error",
      outcome: {
        status: "failed",
        reason: "feed_not_found",
        detail: `Podcast directory responded ${response.status}`,
      },
    };
  }

  const payload = (await response.json()) as { results?: unknown };
  const results = Array.isArray(payload.results) ? payload.results : [];

  const ranked = results
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      feedUrl: typeof entry.feedUrl === "string" ? entry.feedUrl : null,
      name: typeof entry.collectionName === "string" ? entry.collectionName : "",
      score: titleSimilarity(showTitle, typeof entry.collectionName === "string" ? entry.collectionName : ""),
    }))
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

  const feedGuard = checkOutboundUrl(best.feedUrl ?? "");
  if (!feedGuard.ok) {
    return {
      status: "error",
      outcome: { status: "failed", reason: "blocked_url", detail: feedGuard.reason },
    };
  }

  const feedResponse = await deps.fetch(feedGuard.url.toString(), { redirect: "follow" });
  if (!feedResponse.ok) {
    return {
      status: "error",
      outcome: {
        status: "failed",
        reason: "feed_unavailable",
        detail: `Feed responded ${feedResponse.status}`,
      },
    };
  }
  return { status: "ok", url: feedGuard.url.toString(), xml: await feedResponse.text() };
}
