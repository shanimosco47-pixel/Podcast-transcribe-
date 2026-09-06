import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  FfmpegAudioTool,
  FfmpegTimeoutError,
  type AudioChunk,
  type AudioTool,
} from "../src/media/ffmpeg.js";
import { transcribeAudioFile } from "../src/media/transcribe-audio.js";
import { withWorkspace, Workspace } from "../src/media/workspace.js";
import type { TranscriptionAdapter, TranscriptionRequest } from "../src/transcription/types.js";

const run = promisify(execFile);

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

const ffmpegAvailable = await hasFfmpeg();

/** Transcribes each chunk to its own file name, so ordering is visible in the output. */
class NamingAdapter implements TranscriptionAdapter {
  readonly name = "naming";
  readonly calls: TranscriptionRequest[] = [];
  constructor(private readonly label: (path: string) => string) {}
  transcribe(request: TranscriptionRequest): Promise<{ text: string; provider: string }> {
    this.calls.push(request);
    return Promise.resolve({ text: this.label(request.audioUrl), provider: this.name });
  }
}

describe.skipIf(!ffmpegAvailable)("splitting real audio with ffmpeg", () => {
  it("splits a long file and recombines the chunks in playback order", async () => {
    await withWorkspace(async (workspace) => {
      // 25 seconds of tone, split into 5-second chunks => 5 ordered chunks.
      const source = workspace.path("tone.mp3");
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=25",
        "-acodec", "libmp3lame", source,
      ]);

      const tool = new FfmpegAudioTool();
      const duration = await tool.probeDurationSeconds(source);
      expect(duration).toBeGreaterThan(24);
      expect(duration).toBeLessThan(27);

      const adapter = new NamingAdapter((path) => `part:${path.match(/chunk-(\d+)/)?.[1] ?? "?"}`);
      const result = await transcribeAudioFile(source, workspace, tool, adapter, {
        chunkSeconds: 5,
      });

      expect(result.chunkCount).toBeGreaterThanOrEqual(5);
      expect(result.order).toEqual([...result.order].sort((a, b) => a - b));
      expect(result.order[0]).toBe(0);

      const expected = result.order.map((index) => `part:${String(index).padStart(5, "0")}`);
      expect(result.text.split("\n\n")).toEqual(expected);
    });
  }, 120_000);

  it("does not split an episode shorter than one chunk", async () => {
    await withWorkspace(async (workspace) => {
      const source = workspace.path("short.mp3");
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-acodec", "libmp3lame", source,
      ]);

      const tool = new FfmpegAudioTool();
      const adapter = new NamingAdapter(() => "whole episode");
      const result = await transcribeAudioFile(source, workspace, tool, adapter, {
        chunkSeconds: 600,
      });

      expect(result.chunkCount).toBe(1);
      expect(result.text).toBe("whole episode");
      expect(await readdir(workspace.root)).not.toContain("chunk-00000.mp3");
    });
  }, 120_000);
});

/** Ordering logic must stay verifiable on a machine with no ffmpeg, such as CI before setup. */
describe("chunk ordering without ffmpeg", () => {
  function fakeTool(chunks: AudioChunk[], duration = 1800): AudioTool {
    return {
      probeDurationSeconds: () => Promise.resolve(duration),
      split: () => Promise.resolve(chunks),
    };
  }

  const chunkAt = (index: number): AudioChunk => ({
    index,
    path: `/tmp/chunk-${String(index).padStart(5, "0")}.mp3`,
    startSeconds: index * 600,
  });

  it("joins by chunk index even when split returns them shuffled", async () => {
    const workspace = await Workspace.create();
    try {
      const shuffled = [chunkAt(2), chunkAt(0), chunkAt(1)];
      const adapter = new NamingAdapter((path) => `part:${path.match(/chunk-(\d+)/)?.[1] ?? "?"}`);
      const result = await transcribeAudioFile("/tmp/audio.mp3", workspace, fakeTool(shuffled), adapter);

      expect(result.order).toEqual([0, 1, 2]);
      expect(result.text).toBe("part:00000\n\npart:00001\n\npart:00002");
      // Requests are issued in order too, not just reassembled in order.
      expect(adapter.calls.map((call) => call.audioUrl)).toEqual([
        "/tmp/chunk-00000.mp3",
        "/tmp/chunk-00001.mp3",
        "/tmp/chunk-00002.mp3",
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it("refuses a gap in the chunk sequence rather than joining across it", async () => {
    const workspace = await Workspace.create();
    try {
      const withGap = [chunkAt(0), chunkAt(2)];
      const adapter = new NamingAdapter(() => "x");
      await expect(
        transcribeAudioFile("/tmp/audio.mp3", workspace, fakeTool(withGap), adapter),
      ).rejects.toThrow(/not contiguous/i);
    } finally {
      await workspace.dispose();
    }
  });

  it("keeps every chunk in Hebrew", async () => {
    const workspace = await Workspace.create();
    try {
      const adapter = new NamingAdapter(() => "טקסט");
      await transcribeAudioFile("/tmp/audio.mp3", workspace, fakeTool([chunkAt(0), chunkAt(1)]), adapter);
      expect(adapter.calls.every((call) => call.language === "he")).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });

  it("refuses an episode longer than the duration limit", async () => {
    const workspace = await Workspace.create();
    try {
      const adapter = new NamingAdapter(() => "x");
      await expect(
        transcribeAudioFile("/tmp/audio.mp3", workspace, fakeTool([chunkAt(0)], 5 * 60 * 60), adapter),
      ).rejects.toThrow(/over the/i);
      expect(adapter.calls).toHaveLength(0);
    } finally {
      await workspace.dispose();
    }
  });
});

describe("duration is enforced from the file, not the feed", () => {
  /** Reports a long file regardless of what a feed claimed. */
  function lyingFeedTool(probedSeconds: number): AudioTool {
    return {
      probeDurationSeconds: () => Promise.resolve(probedSeconds),
      split: () => Promise.reject(new Error("split must not be reached")),
    };
  }

  it("refuses a file whose probed duration exceeds the limit even when the feed declared it short", async () => {
    const workspace = await Workspace.create();
    try {
      const adapter = new NamingAdapter(() => "x");
      // The feed said five minutes; the actual media is five hours.
      await expect(
        transcribeAudioFile("/tmp/audio.mp3", workspace, lyingFeedTool(5 * 60 * 60), adapter),
      ).rejects.toThrow(/over the/i);

      // Nothing was sent to the provider.
      expect(adapter.calls).toHaveLength(0);
    } finally {
      await workspace.dispose();
    }
  });

  it("splits according to the probed duration when the feed understated it", async () => {
    const workspace = await Workspace.create();
    let splitCalled = false;
    const tool: AudioTool = {
      // Feed claimed 5 minutes; the file is really 30, so it must be split.
      probeDurationSeconds: () => Promise.resolve(1800),
      split: (_path, ws) => {
        splitCalled = true;
        return Promise.resolve(
          [0, 1, 2].map((index) => ({
            index,
            path: ws.path(`chunk-${String(index).padStart(5, "0")}.mp3`),
            startSeconds: index * 600,
          })),
        );
      },
    };

    try {
      const adapter = new NamingAdapter((path) => `part:${path.match(/chunk-(\d+)/)?.[1] ?? "?"}`);
      const result = await transcribeAudioFile("/tmp/audio.mp3", workspace, tool, adapter);

      expect(splitCalled).toBe(true);
      expect(result.chunkCount).toBe(3);
      expect(result.order).toEqual([0, 1, 2]);
    } finally {
      await workspace.dispose();
    }
  });
});

describe.skipIf(!ffmpegAvailable)("subprocess timeouts", () => {
  it("terminates ffmpeg that outlives its timeout instead of holding the worker", async () => {
    await withWorkspace(async (workspace) => {
      const source = workspace.path("long.mp3");
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=90",
        "-acodec", "libmp3lame", source,
      ]);

      // 1 ms is unreachable for a real encode, so the kill path is what runs.
      const impatient = new FfmpegAudioTool("ffmpeg", "ffprobe", 60_000, 1);
      const started = Date.now();
      await expect(impatient.split(source, workspace, 5)).rejects.toThrow(FfmpegTimeoutError);

      // It returned promptly rather than running to completion.
      expect(Date.now() - started).toBeLessThan(30_000);
    });
  }, 120_000);

  it("terminates ffprobe that outlives its timeout", async () => {
    await withWorkspace(async (workspace) => {
      const source = workspace.path("probe.mp3");
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
        "-acodec", "libmp3lame", source,
      ]);

      const impatient = new FfmpegAudioTool("ffmpeg", "ffprobe", 1, 60_000);
      await expect(impatient.probeDurationSeconds(source)).rejects.toThrow(FfmpegTimeoutError);
    });
  }, 120_000);
});
