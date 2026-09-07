import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { SafeFetchError, safeFetchStream, type SafeFetchDeps } from "../http/safe-fetch.js";
import type { Workspace } from "./workspace.js";

/** 300 MB is far above any podcast episode and well below anything that fills a disk. */
export const MAX_AUDIO_BYTES = 300 * 1024 * 1024;
export const AUDIO_TIMEOUT_MS = 10 * 60 * 1000;

export interface DownloadedAudio {
  path: string;
  bytes: number;
  contentType: string | null;
}

export interface DownloadOptions {
  maxBytes?: number;
  timeoutMs?: number;
  fileName?: string;
}

/**
 * Stream an episode enclosure to a file inside the workspace.
 *
 * The size limit is enforced as bytes arrive rather than from `content-length`,
 * and the partial file is removed before the error propagates, so a failed
 * download never leaves anything behind.
 */
export async function downloadAudio(
  url: string,
  workspace: Workspace,
  deps: SafeFetchDeps,
  options: DownloadOptions = {},
): Promise<DownloadedAudio> {
  const maxBytes = options.maxBytes ?? MAX_AUDIO_BYTES;
  const target = workspace.path(options.fileName ?? "source-audio");

  const stream = await safeFetchStream(
    url,
    { maxBytes, timeoutMs: options.timeoutMs ?? AUDIO_TIMEOUT_MS },
    deps,
  );

  // A declared length over the cap is refused before a single byte is written.
  if (stream.declaredBytes !== null && stream.declaredBytes > maxBytes) {
    await stream.cancel();
    throw new SafeFetchError(
      "response_too_large",
      `Episode audio declares ${stream.declaredBytes} bytes, over the ${maxBytes} limit`,
    );
  }

  let bytes = 0;
  const counted = async function* (): AsyncIterable<Uint8Array> {
    for await (const chunk of stream.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new SafeFetchError(
          "response_too_large",
          `Episode audio exceeded the ${maxBytes} byte limit`,
        );
      }
      yield chunk;
    }
  };

  try {
    await pipeline(Readable.from(counted()), createWriteStream(target));
  } catch (error) {
    await stream.cancel();
    await unlink(target).catch(() => undefined);
    throw error;
  }

  return { path: target, bytes, contentType: stream.contentType };
}
