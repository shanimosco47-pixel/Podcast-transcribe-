import type { TranscriptionAdapter } from "../transcription/types.js";
import { TRANSCRIPTION_LANGUAGE } from "../transcription/types.js";
import {
  assertDurationWithinLimit,
  needsSplitting,
  type AudioChunk,
  type AudioTool,
} from "./ffmpeg.js";
import type { Workspace } from "./workspace.js";

export interface ChunkedTranscript {
  text: string;
  provider: string;
  chunkCount: number;
  /** Chunk indices in the order their text was concatenated. */
  order: number[];
}

export interface TranscribeAudioOptions {
  chunkSeconds?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Transcribe a local audio file, splitting it when it is long.
 *
 * The duration is always probed from the downloaded file. The feed's declared
 * duration is publisher-controlled input: a feed claiming five minutes for a
 * three-hour file would otherwise slip past the length limit and skip the
 * chunking that keeps requests within provider limits. Feed duration stays
 * evidence for matching and display only.
 *
 * Chunks are transcribed sequentially and joined by chunk index. Order is taken
 * from the index parsed out of each chunk's name, never from directory listing
 * order or from completion order, so recombination cannot silently scramble an
 * episode. A chunk that transcribes to nothing is still an ordering position,
 * so a dropped chunk shows up as a gap rather than shifting later text earlier.
 */
export async function transcribeAudioFile(
  audioPath: string,
  workspace: Workspace,
  tool: AudioTool,
  adapter: TranscriptionAdapter,
  options: TranscribeAudioOptions = {},
): Promise<ChunkedTranscript> {
  const duration = await tool.probeDurationSeconds(audioPath);
  assertDurationWithinLimit(duration);

  if (!needsSplitting(duration, options.chunkSeconds)) {
    options.onProgress?.(0, 1);
    const result = await adapter.transcribe({
      audioUrl: audioPath,
      language: TRANSCRIPTION_LANGUAGE,
      durationSecondsHint: duration,
    });
    options.onProgress?.(1, 1);
    return { text: result.text.trim(), provider: result.provider, chunkCount: 1, order: [0] };
  }

  const chunks = await tool.split(audioPath, workspace, options.chunkSeconds ?? 600);
  if (chunks.length === 0) throw new Error("Audio splitting produced no chunks");

  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  assertContiguous(ordered);

  const pieces: { index: number; text: string }[] = [];
  let provider = adapter.name;

  for (const [position, chunk] of ordered.entries()) {
    options.onProgress?.(position, ordered.length);
    const result = await adapter.transcribe({
      audioUrl: chunk.path,
      language: TRANSCRIPTION_LANGUAGE,
      durationSecondsHint: options.chunkSeconds ?? 600,
    });
    provider = result.provider;
    pieces.push({ index: chunk.index, text: result.text.trim() });
  }
  options.onProgress?.(ordered.length, ordered.length);

  // Sort again by index: completion order is not assumed to match issue order.
  pieces.sort((a, b) => a.index - b.index);

  return {
    text: pieces
      .map((piece) => piece.text)
      .filter((text) => text.length > 0)
      .join("\n\n"),
    provider,
    chunkCount: pieces.length,
    order: pieces.map((piece) => piece.index),
  };
}

/** A missing index means ffmpeg produced a gap; joining anyway would lose audio silently. */
function assertContiguous(chunks: readonly AudioChunk[]): void {
  for (const [position, chunk] of chunks.entries()) {
    if (chunk.index !== position) {
      throw new Error(
        `Chunk sequence is not contiguous: expected index ${position}, found ${chunk.index}`,
      );
    }
  }
}
