import { isDegenerateTitle } from "./normalize.js";
import { dateSimilarity, durationSimilarity, titleSimilarity } from "./similarity.js";
import {
  DEFAULT_THRESHOLDS,
  type EpisodeCandidate,
  type EpisodeQuery,
  type MatchResult,
  type MatchThresholds,
  type ScoredCandidate,
  type SignalEvidence,
} from "./types.js";

/**
 * Relative importance of each signal, renormalized over the signals actually present.
 *
 * Duration and publication date are weighted high enough to break a tie between
 * two identical titles on their own, which daily shows produce constantly
 * ("מהדורת בוקר" every weekday). Below roughly 0.12 each, they could never
 * clear the acceptance margin and would be decorative.
 */
const SIGNAL_WEIGHTS = {
  episodeTitle: 0.55,
  showTitle: 0.18,
  duration: 0.14,
  publishedAt: 0.13,
} as const;

/**
 * Score one candidate against the query, recording why.
 *
 * The denominator is the weight of the signals the **query** carries, not the
 * signals this candidate happens to have. Normalizing per candidate would let a
 * sparse candidate concentrate all weight onto the fields it does have: an
 * episode with a matching title and no duration or date would score 1.00 and
 * beat a fully corroborated candidate whose title merely varies. Missing
 * evidence therefore scores zero and lowers `coverage`; it never raises
 * confidence.
 */
export function scoreCandidate(query: EpisodeQuery, candidate: EpisodeCandidate): ScoredCandidate {
  const raw: Array<Omit<SignalEvidence, "weight"> & { rawWeight: number }> = [];

  raw.push({
    signal: "episodeTitle",
    score: titleSimilarity(query.episodeTitle, candidate.title),
    rawWeight: SIGNAL_WEIGHTS.episodeTitle,
    present: true,
    detail: `"${query.episodeTitle}" vs "${candidate.title}"`,
  });

  if (query.showTitle) {
    const present = Boolean(candidate.showTitle);
    raw.push({
      signal: "showTitle",
      score: present ? titleSimilarity(query.showTitle, candidate.showTitle ?? "") : 0,
      rawWeight: SIGNAL_WEIGHTS.showTitle,
      present,
      detail: present
        ? `"${query.showTitle}" vs "${candidate.showTitle ?? ""}"`
        : "candidate provides no show title",
    });
  }

  if (typeof query.durationSeconds === "number") {
    const present = typeof candidate.durationSeconds === "number";
    raw.push({
      signal: "duration",
      score: present ? durationSimilarity(query.durationSeconds, candidate.durationSeconds ?? 0) : 0,
      rawWeight: SIGNAL_WEIGHTS.duration,
      present,
      detail: present
        ? `${Math.round(query.durationSeconds)}s vs ${Math.round(candidate.durationSeconds ?? 0)}s`
        : "candidate provides no duration",
    });
  }

  if (query.publishedAt) {
    const present = Boolean(candidate.publishedAt);
    raw.push({
      signal: "publishedAt",
      score: present ? dateSimilarity(query.publishedAt, candidate.publishedAt ?? "") : 0,
      rawWeight: SIGNAL_WEIGHTS.publishedAt,
      present,
      detail: present
        ? `${query.publishedAt} vs ${candidate.publishedAt ?? ""}`
        : "candidate provides no publication date",
    });
  }

  const totalWeight = raw.reduce((sum, entry) => sum + entry.rawWeight, 0);
  const evidence: SignalEvidence[] = raw.map(({ rawWeight, ...entry }) => ({
    ...entry,
    weight: rawWeight / totalWeight,
  }));
  const confidence = evidence.reduce((sum, entry) => sum + entry.score * entry.weight, 0);
  const coverage = evidence.reduce((sum, entry) => sum + (entry.present ? entry.weight : 0), 0);

  return { candidate, confidence, coverage, evidence };
}

/**
 * Pick the episode the query refers to, or refuse.
 *
 * Never falls back to "the first candidate" or "the newest candidate". A result
 * is `matched` only when the best candidate clears the accept threshold *and*
 * leads the runner-up by the margin, so a feed of near-identical titles yields
 * `ambiguous` rather than a confident guess.
 */
export function matchEpisode(
  query: EpisodeQuery,
  candidates: readonly EpisodeCandidate[],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchResult {
  if (isDegenerateTitle(query.episodeTitle)) {
    return {
      status: "no_match",
      reason: "Query episode title has no comparable content after normalization",
    };
  }
  if (candidates.length === 0) {
    return { status: "no_match", reason: "Feed produced no candidate episodes" };
  }

  const scored = candidates
    .map((candidate) => scoreCandidate(query, candidate))
    .sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  if (!best || best.confidence < thresholds.floor) {
    return {
      status: "no_match",
      reason: `Best candidate scored ${formatConfidence(best?.confidence ?? 0)}, below the ${formatConfidence(thresholds.floor)} floor`,
    };
  }

  const runnerUp = scored[1] ?? null;
  const margin = best.confidence - (runnerUp?.confidence ?? 0);

  if (best.confidence < thresholds.accept) {
    return {
      status: "ambiguous",
      reason: `Best candidate scored ${formatConfidence(best.confidence)}, below the ${formatConfidence(thresholds.accept)} accept threshold`,
      candidates: scored.filter((entry) => entry.confidence >= thresholds.floor),
    };
  }
  if (margin < thresholds.margin) {
    return {
      status: "ambiguous",
      reason: `Top two candidates are ${formatConfidence(margin)} apart, below the ${formatConfidence(thresholds.margin)} margin`,
      candidates: scored.filter((entry) => entry.confidence >= thresholds.floor),
    };
  }

  return { status: "matched", best, runnerUp, margin };
}

function formatConfidence(value: number): string {
  return value.toFixed(2);
}
