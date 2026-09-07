import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { FormData as UndiciFormData } from "undici";

import type { ProviderConfig } from "../config.js";
import { defaultFetch } from "../http/safe-fetch.js";
import {
  type TranscriptionAdapter,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "./types.js";

export class TranscriptionProviderError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Transcription provider responded ${status}: ${detail}`);
    this.name = "TranscriptionProviderError";
  }
}

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Provider error bodies are quoted back for diagnosis; cap them so nothing large leaks into logs. */
const MAX_ERROR_DETAIL = 300;

/**
 * OpenAI-compatible speech-to-text client.
 *
 * Works against any service exposing `POST /audio/transcriptions`, including a
 * self-hosted model, which is why the base URL is configurable. The language is
 * always sent explicitly as Hebrew rather than left to auto-detection.
 */
export class OpenAiTranscriptionAdapter implements TranscriptionAdapter {
  readonly name = "openai-compatible";

  constructor(
    private readonly provider: ProviderConfig,
    private readonly fetchImpl: typeof fetch = defaultFetch,
  ) {}

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    // Chunks are bounded by CHUNK_SECONDS, so a whole one fits in memory.
    const bytes = await readFile(request.audioUrl);
    // undici's FormData, not the global one. The global belongs to Node's
    // separate internal undici, and this fetch does not recognize it: it
    // stringifies to "[object FormData]" and posts text/plain. Caught by the
    // mock-provider test, which saw a 17-byte body instead of multipart.
    const form = new UndiciFormData();
    form.append("file", new Blob([bytes]), basename(request.audioUrl) || "audio.mp3");
    form.append("model", this.provider.model);
    form.append("language", request.language);
    form.append("response_format", "json");

    const response = await this.fetchImpl(`${this.provider.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.provider.apiKey}` },
      body: form as unknown as BodyInit,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new TranscriptionProviderError(response.status, await errorDetail(response));
    }

    const payload = (await response.json()) as { text?: unknown };
    if (typeof payload.text !== "string") {
      throw new TranscriptionProviderError(response.status, "response contained no text field");
    }
    return { text: payload.text, provider: this.name };
  }
}

/** Read a bounded, non-sensitive slice of an error body. Never includes request headers. */
export async function errorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, MAX_ERROR_DETAIL).replace(/\s+/g, " ").trim() || "(empty body)";
  } catch {
    return "(unreadable body)";
  }
}
