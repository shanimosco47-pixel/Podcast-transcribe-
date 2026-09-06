import { checkOutboundUrl } from "./http/url-guard.js";
import type { ScoredCandidate } from "./matching/types.js";
import { resolveEpisode, type ResolutionEvidence, type ResolutionFailure, type ResolverDeps } from "./resolve/resolver.js";
import type { FeedEpisode } from "./matching/feed.js";
import type { SummarizerAdapter, SummaryResult } from "./summary/types.js";
import { TRANSCRIPTION_LANGUAGE, type TranscriptionAdapter } from "./transcription/types.js";

export interface PipelineDeps extends ResolverDeps {
  transcription: TranscriptionAdapter;
  summarizer: SummarizerAdapter;
}

export interface TranscriptOutcome {
  text: string;
  /** Where the words came from, so the UI never implies audio was transcribed when it was not. */
  source: "feed_transcript" | "transcription";
  provider: string;
}

export type PipelineOutcome =
  | {
      status: "done";
      evidence: ResolutionEvidence;
      transcript: TranscriptOutcome;
      summary: SummaryResult;
    }
  | { status: "ambiguous"; reason: string; feedUrl: string; candidates: ScoredCandidate[] }
  | { status: "failed"; reason: ResolutionFailure | "no_audio" | "transcript_unavailable"; detail: string };

/**
 * Spotify URL to Hebrew transcript and summary.
 *
 * A transcript published in the feed is preferred over transcribing audio: it
 * is free, exact, and avoids sending audio to a third party. The transcription
 * adapter is reached only when the feed publishes none.
 */
export async function runPipeline(input: string, deps: PipelineDeps): Promise<PipelineOutcome> {
  const resolution = await resolveEpisode(input, deps);
  if (resolution.status !== "resolved") return resolution;

  const { evidence, episode } = resolution;

  const transcript = await obtainTranscript(evidence, episode.transcript?.url ?? null, deps);
  if ("failure" in transcript) return transcript.failure;

  const summary = await deps.summarizer.summarize({
    transcript: transcript.text,
    episodeTitle: evidence.episodeTitle,
    language: TRANSCRIPTION_LANGUAGE,
  });

  return { status: "done", evidence, transcript, summary };
}

async function obtainTranscript(
  evidence: ResolutionEvidence,
  transcriptUrl: string | null,
  deps: PipelineDeps,
): Promise<TranscriptOutcome | { failure: Extract<PipelineOutcome, { status: "failed" }> }> {
  if (transcriptUrl) {
    const guard = checkOutboundUrl(transcriptUrl);
    if (!guard.ok) {
      return { failure: { status: "failed", reason: "blocked_url", detail: guard.reason } };
    }
    const response = await deps.fetch(guard.url.toString(), { redirect: "follow" });
    if (!response.ok) {
      return {
        failure: {
          status: "failed",
          reason: "transcript_unavailable",
          detail: `Feed transcript responded ${response.status}`,
        },
      };
    }
    return { text: await response.text(), source: "feed_transcript", provider: "rss" };
  }

  if (!evidence.enclosureUrl) {
    return {
      failure: {
        status: "failed",
        reason: "no_audio",
        detail: "Episode has neither a published transcript nor an audio enclosure",
      },
    };
  }

  const guard = checkOutboundUrl(evidence.enclosureUrl);
  if (!guard.ok) {
    return { failure: { status: "failed", reason: "blocked_url", detail: guard.reason } };
  }

  const result = await deps.transcription.transcribe({
    audioUrl: guard.url.toString(),
    language: TRANSCRIPTION_LANGUAGE,
    durationSecondsHint: evidence.durationSeconds,
  });
  return { text: result.text, source: "transcription", provider: result.provider };
}

/**
 * Finish the run for an episode the user picked from an ambiguous list.
 *
 * The user's choice replaces the matcher's judgement, so confidence is recorded
 * as fully corroborated and the evidence records that a person selected it.
 */
export async function completeChosenEpisode(
  episode: FeedEpisode,
  feedUrl: string,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const evidence: ResolutionEvidence = {
    showTitle: episode.showTitle ?? "",
    episodeTitle: episode.title,
    publishedAt: episode.publishedAt ?? null,
    durationSeconds: episode.durationSeconds ?? null,
    feedUrl,
    enclosureUrl: episode.enclosureUrl ?? null,
    transcriptUrl: episode.transcript?.url ?? null,
    confidence: 1,
    coverage: 1,
    signals: [{ signal: "userChoice", score: 1, detail: "נבחר ידנית על ידי המשתמש" }],
  };

  const transcript = await obtainTranscript(evidence, evidence.transcriptUrl, deps);
  if ("failure" in transcript) return transcript.failure;

  const summary = await deps.summarizer.summarize({
    transcript: transcript.text,
    episodeTitle: evidence.episodeTitle,
    language: TRANSCRIPTION_LANGUAGE,
  });
  return { status: "done", evidence, transcript, summary };
}
