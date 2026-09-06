/** A candidate episode drawn from an RSS feed or a directory search result. */
export interface EpisodeCandidate {
  /** Episode title as published. */
  title: string;
  /** Show/collection name, when the source provides one. */
  showTitle?: string | null;
  /** Publication date, any format `Date.parse` accepts (RFC 822, ISO 8601). */
  publishedAt?: string | null;
  durationSeconds?: number | null;
  description?: string | null;
  /** Audio enclosure URL, when the source provides one. */
  enclosureUrl?: string | null;
  /** Opaque identifier for logging and de-duplication. */
  id?: string | null;
}

/** What we know about the episode the user asked for, from the Spotify embed. */
export interface EpisodeQuery {
  episodeTitle: string;
  showTitle?: string | null;
  publishedAt?: string | null;
  durationSeconds?: number | null;
  description?: string | null;
}

/** Per-signal contribution to a candidate's score. */
export interface SignalEvidence {
  signal: "episodeTitle" | "showTitle" | "duration" | "publishedAt" | "description";
  /** 0..1 similarity for this signal. Zero when the candidate does not supply it. */
  score: number;
  /** Weight applied, normalized over the signals the *query* carries. */
  weight: number;
  /** False when the query offered this signal but the candidate has no value for it. */
  present: boolean;
  /** Human-readable explanation of what was compared. */
  detail: string;
}

export interface ScoredCandidate {
  candidate: EpisodeCandidate;
  /** Weighted 0..1 confidence, comparable across candidates of the same query. */
  confidence: number;
  /**
   * Fraction of the query's signal weight this candidate actually supplied.
   * A candidate missing metadata has coverage below 1 and can never reach a
   * confidence its evidence does not support.
   */
  coverage: number;
  evidence: SignalEvidence[];
}

export type MatchResult =
  | {
      status: "matched";
      best: ScoredCandidate;
      /** Next-best candidate, when there was one, for margin auditing. */
      runnerUp: ScoredCandidate | null;
      margin: number;
    }
  | {
      status: "ambiguous";
      reason: string;
      /** Top candidates, highest confidence first. Never auto-selected. */
      candidates: ScoredCandidate[];
    }
  | {
      status: "no_match";
      reason: string;
    };

export interface MatchThresholds {
  /** Minimum confidence for the best candidate to be accepted. */
  accept: number;
  /** Minimum gap between best and runner-up to be accepted. */
  margin: number;
  /** Below this, a candidate is not even worth showing as ambiguous. */
  floor: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = {
  accept: 0.86,
  margin: 0.12,
  floor: 0.6,
};
