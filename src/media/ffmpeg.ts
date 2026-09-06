import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import type { Workspace } from "./workspace.js";

const run = promisify(execFile);

export class FfmpegUnavailableError extends Error {
  constructor() {
    super("ffmpeg is not available; long audio cannot be split");
    this.name = "FfmpegUnavailableError";
  }
}

export class AudioTooLongError extends Error {
  constructor(seconds: number, limit: number) {
    super(`Episode is ${Math.round(seconds)}s, over the ${limit}s limit`);
    this.name = "AudioTooLongError";
  }
}

/** Four hours. Longer than any plausible episode, short enough to bound cost. */
export const MAX_AUDIO_SECONDS = 4 * 60 * 60;

/** Chunk length. Small enough for provider request limits, large enough to keep context. */
export const CHUNK_SECONDS = 600;

/**
 * Subprocess wall-clock limits.
 *
 * A malformed or hostile file can make ffmpeg spin or block forever, and with a
 * single worker that wedges the queue until the process restarts. `execFile`
 * sends `killSignal` at the timeout, and SIGKILL is used because a stuck
 * decoder does not always honour SIGTERM.
 */
export const PROBE_TIMEOUT_MS = 60_000;
export const SPLIT_TIMEOUT_MS = 15 * 60 * 1000;

const SUBPROCESS_LIMITS = { killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 } as const;

export class FfmpegTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what} exceeded ${timeoutMs}ms and was terminated`);
    this.name = "FfmpegTimeoutError";
  }
}

/** execFile reports a timeout kill as a signal on the error. */
function wasKilledForTimeout(error: unknown): boolean {
  const killed = (error as { killed?: boolean }).killed === true;
  const signal = (error as { signal?: string }).signal;
  return killed || signal === "SIGKILL" || signal === "SIGTERM";
}

export interface AudioChunk {
  /** Zero-based position. The recombination order is this, never directory order. */
  index: number;
  path: string;
  startSeconds: number;
}

/**
 * The ffmpeg operations this product needs, behind an interface so tests can
 * run without a binary and the real one stays a thin shell wrapper.
 */
export interface AudioTool {
  probeDurationSeconds(path: string): Promise<number>;
  /** Split into `CHUNK_SECONDS` segments, returned in playback order. */
  split(path: string, workspace: Workspace, chunkSeconds: number): Promise<AudioChunk[]>;
}

export class FfmpegAudioTool implements AudioTool {
  constructor(
    private readonly ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
    private readonly ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe",
    private readonly probeTimeoutMs = PROBE_TIMEOUT_MS,
    private readonly splitTimeoutMs = SPLIT_TIMEOUT_MS,
  ) {}

  async probeDurationSeconds(path: string): Promise<number> {
    try {
      const { stdout } = await run(
        this.ffprobePath,
        [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          path,
        ],
        { ...SUBPROCESS_LIMITS, timeout: this.probeTimeoutMs },
      );
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`ffprobe returned an unusable duration: ${stdout.trim()}`);
      }
      return seconds;
    } catch (error) {
      if (isMissingBinary(error)) throw new FfmpegUnavailableError();
      if (wasKilledForTimeout(error)) throw new FfmpegTimeoutError("ffprobe", this.probeTimeoutMs);
      throw error;
    }
  }

  async split(path: string, workspace: Workspace, chunkSeconds = CHUNK_SECONDS): Promise<AudioChunk[]> {
    // %05d keeps names sortable, but order is taken from the parsed index, not
    // from the directory listing, which is not guaranteed to be sorted.
    const pattern = workspace.path("chunk-%05d.mp3");
    try {
      await run(
        this.ffmpegPath,
        [
          "-hide_banner", "-loglevel", "error", "-nostdin",
          "-i", path,
          "-f", "segment",
          "-segment_time", String(chunkSeconds),
          "-reset_timestamps", "1",
          "-vn",
          "-acodec", "libmp3lame",
          pattern,
        ],
        { ...SUBPROCESS_LIMITS, timeout: this.splitTimeoutMs },
      );
    } catch (error) {
      if (isMissingBinary(error)) throw new FfmpegUnavailableError();
      if (wasKilledForTimeout(error)) throw new FfmpegTimeoutError("ffmpeg", this.splitTimeoutMs);
      throw error;
    }

    const names = await readdir(workspace.root);
    return names
      .flatMap((name) => {
        const match = name.match(/^chunk-(\d{5})\.mp3$/);
        if (!match?.[1]) return [];
        const index = Number(match[1]);
        return [{ index, path: workspace.path(name), startSeconds: index * chunkSeconds }];
      })
      .sort((a, b) => a.index - b.index);
  }
}

function isMissingBinary(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

/** True when the episode is short enough to send in one request. */
export function needsSplitting(durationSeconds: number, chunkSeconds = CHUNK_SECONDS): boolean {
  return durationSeconds > chunkSeconds;
}

export function assertDurationWithinLimit(seconds: number, limit = MAX_AUDIO_SECONDS): void {
  if (seconds > limit) throw new AudioTooLongError(seconds, limit);
}
