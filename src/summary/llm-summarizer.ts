import type { ProviderConfig } from "../config.js";
import { defaultFetch } from "../http/safe-fetch.js";
import { errorDetail } from "../transcription/openai-adapter.js";
import type { SummarizerAdapter, SummaryRequest, SummaryResult } from "./types.js";

export class SummaryProviderError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Summary provider responded ${status}: ${detail}`);
    this.name = "SummaryProviderError";
  }
}

const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

/** Transcripts can be very long; a bounded slice keeps the request within provider limits. */
const MAX_TRANSCRIPT_CHARS = 48_000;

const SYSTEM_PROMPT = [
  "אתה עוזר שמסכם פרקי פודקאסט בעברית.",
  "החזר JSON בלבד, במבנה:",
  '{"summary": "סיכום קצר בעברית", "keyPoints": ["נקודה", "נקודה"]}',
  "הסיכום עד חמישה משפטים. שלוש עד שבע נקודות עיקריות, לפי סדר הופעתן בפרק.",
  "אל תמציא מידע שאינו בתמלול.",
].join("\n");

/** OpenAI-compatible chat-completions summarizer producing Hebrew output. */
export class LlmSummarizer implements SummarizerAdapter {
  readonly name = "openai-compatible";

  constructor(
    private readonly provider: ProviderConfig,
    private readonly fetchImpl: typeof fetch = defaultFetch,
  ) {}

  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    const transcript = request.transcript.slice(0, MAX_TRANSCRIPT_CHARS);

    const response = await this.fetchImpl(`${this.provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.provider.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `כותרת הפרק: ${request.episodeTitle}\n\nתמלול:\n${transcript}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new SummaryProviderError(response.status, await errorDetail(response));
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new SummaryProviderError(response.status, "response contained no message content");
    }

    const parsed = parseSummaryJson(content);
    if (!parsed) {
      throw new SummaryProviderError(response.status, "model did not return usable JSON");
    }
    return { ...parsed, provider: this.name };
  }
}

/**
 * Parse the model's JSON, tolerating a fenced code block around it.
 *
 * Returns null rather than guessing: a summary the user cannot trust is worse
 * than an honest failure.
 */
export function parseSummaryJson(
  content: string,
): { summary: string; keyPoints: string[] } | null {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();

  let value: unknown;
  try {
    value = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const keyPoints = Array.isArray(record.keyPoints)
    ? record.keyPoints.filter((point): point is string => typeof point === "string" && point.trim().length > 0)
    : [];

  if (!summary) return null;
  return { summary, keyPoints: keyPoints.map((point) => point.trim()) };
}
