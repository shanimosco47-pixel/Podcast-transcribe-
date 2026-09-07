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
    readonly category: ProviderErrorCategory,
  ) {
    super(`Transcription provider responded ${status} (${category})`);
    this.name = "TranscriptionProviderError";
  }
}

export type ProviderErrorCategory =
  | "authentication"
  | "rate_limited"
  | "bad_request"
  | "server_error"
  | "malformed_response";

/**
 * Classify a provider failure from its status alone.
 *
 * The response *body* is never carried anywhere a user or a log can see it: a
 * provider or a proxy in front of it can echo back the Authorization header,
 * the request URL, or the transcript we just sent. A status code is a small
 * fixed set and is safe to surface, so diagnosis keeps the status and loses
 * only prose we could not vouch for.
 */
export function categorize(status: number): ProviderErrorCategory {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "bad_request";
}

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

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
      // The body is deliberately not read: nothing provider-controlled is
      // allowed into an error that reaches the UI or a log.
      await response.body?.cancel().catch(() => undefined);
      throw new TranscriptionProviderError(response.status, categorize(response.status));
    }

    const payload = (await response.json()) as { text?: unknown };
    if (typeof payload.text !== "string") {
      throw new TranscriptionProviderError(response.status, "malformed_response");
    }
    return { text: payload.text, provider: this.name };
  }
}
