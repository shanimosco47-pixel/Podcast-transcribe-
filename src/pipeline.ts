import { SafeFetchError, safeFetchText } from "./http/safe-fetch.js";
import { SummaryNotReducibleError, SummaryProviderError } from "./summary/llm-summarizer.js";
import { TranscriptionProviderError } from "./transcription/openai-adapter.js";
import { TranscriptionNotConfiguredError } from "./transcription/types.js";
import { downloadAudio } from "./media/download.js";
import { FfmpegAudioTool, type AudioTool } from "./media/ffmpeg.js";
import { transcribeAudioFile } from "./media/transcribe-audio.js";
import { withWorkspace } from "./media/workspace.js";
import type { ScoredCandidate } from "./matching/types.js";
import { resolveEpisode, type ResolutionEvidence, type ResolutionFailure, type ResolverDeps } from "./resolve/resolver.js";
import type { FeedEpisode } from "./matching/feed.js";
import type { SummarizerAdapter, SummaryResult } from "./summary/types.js";
import { TRANSCRIPTION_LANGUAGE, type TranscriptionAdapter } from "./transcription/types.js";

export interface PipelineDeps extends ResolverDeps {
  transcription: TranscriptionAdapter;
  summarizer: SummarizerAdapter;
  /** Injectable so tests run without a binary; defaults to the real ffmpeg. */
  audioTool?: AudioTool;
  /** Phase callback for the job queue. No-op when running synchronously. */
  onPhase?: (phase: "downloading" | "transcribing" | "summarizing", done?: number, total?: number) => void;
}

const TRANSCRIPT_LIMITS = { maxBytes: 8 * 1024 * 1024, timeoutMs: 60_000 } as const;

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
  | { status: "failed"; reason:
        | ResolutionFailure
        | "no_audio"
        | "transcript_unavailable"
        | "queue_full"
        | "not_configured"
        | "provider_failed"; detail: string };

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

  deps.onPhase?.("summarizing");
  let summary;
  try {
    summary = await deps.summarizer.summarize({
      transcript: transcript.text,
      episodeTitle: evidence.episodeTitle,
      language: TRANSCRIPTION_LANGUAGE,
    });
  } catch (error) {
    return providerFailure(error);
  }

  return { status: "done", evidence, transcript, summary };
}

/**
 * Map a provider problem onto a user-facing failure.
 *
 * The detail keeps the HTTP status and a category we derive from it. The
 * provider's response body is never read, so nothing it controls can reach the
 * page or a log: not the API key, the transcript, or the enclosure URL.
 */
function providerFailure(error: unknown): Extract<PipelineOutcome, { status: "failed" }> {
  if (error instanceof TranscriptionNotConfiguredError) {
    return { status: "failed", reason: "not_configured", detail: error.message };
  }
  if (
    error instanceof TranscriptionProviderError ||
    error instanceof SummaryProviderError ||
    error instanceof SummaryNotReducibleError
  ) {
    return { status: "failed", reason: "provider_failed", detail: error.message };
  }
  return {
    status: "failed",
    reason: "provider_failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

async function obtainTranscript(
  evidence: ResolutionEvidence,
  transcriptUrl: string | null,
  deps: PipelineDeps,
): Promise<TranscriptOutcome | { failure: Extract<PipelineOutcome, { status: "failed" }> }> {
  if (transcriptUrl) {
    try {
      const response = await safeFetchText(transcriptUrl, TRANSCRIPT_LIMITS, deps);
      return { text: response.text, source: "feed_transcript", provider: "rss" };
    } catch (error) {
      return { failure: transcriptFailure(error) };
    }
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

  // The workspace owns the downloaded file and every chunk, and is removed on
  // both paths out of this block.
  try {
    const enclosureUrl = evidence.enclosureUrl;
    const result = await withWorkspace(async (workspace) => {
      deps.onPhase?.("downloading");
      const audio = await downloadAudio(enclosureUrl, workspace, deps);

      deps.onPhase?.("transcribing");
      const tool = deps.audioTool ?? new FfmpegAudioTool();
      // No declared duration is passed: length enforcement and chunking are
      // decided from the probed file, never from feed metadata.
      return transcribeAudioFile(audio.path, workspace, tool, deps.transcription, {
        onProgress: (done, total) => deps.onPhase?.("transcribing", done, total),
      });
    });
    return { text: result.text, source: "transcription", provider: result.provider };
  } catch (error) {
    return { failure: transcriptFailure(error) };
  }
}

function transcriptFailure(error: unknown): Extract<PipelineOutcome, { status: "failed" }> {
  if (
    error instanceof TranscriptionNotConfiguredError ||
    error instanceof TranscriptionProviderError ||
    error instanceof SummaryProviderError
  ) {
    return providerFailure(error);
  }
  if (error instanceof SafeFetchError) {
    const blocked =
      error.reason === "blocked_host" ||
      error.reason === "bad_scheme" ||
      error.reason === "credentials_in_url" ||
      error.reason === "resolves_to_blocked_address";
    return {
      status: "failed",
      reason: blocked ? "blocked_url" : "transcript_unavailable",
      detail: error.message,
    };
  }
  return {
    status: "failed",
    reason: "transcript_unavailable",
    detail: error instanceof Error ? error.message : String(error),
  };
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

  try {
    const summary = await deps.summarizer.summarize({
      transcript: transcript.text,
      episodeTitle: evidence.episodeTitle,
      language: TRANSCRIPTION_LANGUAGE,
    });
    return { status: "done", evidence, transcript, summary };
  } catch (error) {
    return providerFailure(error);
  }
}
