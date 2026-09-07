import type { ProviderConfig } from "../config.js";
import { defaultFetch } from "../http/safe-fetch.js";
import { categorize, type ProviderErrorCategory } from "../transcription/openai-adapter.js";
import type { SummarizerAdapter, SummaryRequest, SummaryResult } from "./types.js";

export class SummaryProviderError extends Error {
  constructor(
    readonly status: number,
    readonly category: ProviderErrorCategory,
  ) {
    super(`Summary provider responded ${status} (${category})`);
    this.name = "SummaryProviderError";
  }
}

const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Characters sent to the model in one request.
 *
 * A bound is unavoidable, but truncating the transcript to it is not: a long
 * episode would be summarized from its opening alone while the UI still called
 * the result the episode summary. Instead the transcript is split at this size,
 * each part summarized, and the parts synthesized.
 */
const SEGMENT_CHARS = 24_000;

/** Guards against a pathological transcript folding forever. */
const MAX_FOLD_ROUNDS = 4;

const FINAL_PROMPT = [
  "אתה עוזר שמסכם פרקי פודקאסט בעברית.",
  "החזר JSON בלבד, במבנה:",
  '{"summary": "סיכום קצר בעברית", "keyPoints": ["נקודה", "נקודה"]}',
  "הסיכום עד חמישה משפטים. שלוש עד שבע נקודות עיקריות, לפי סדר הופעתן בפרק.",
  "אל תמציא מידע שאינו בטקסט שקיבלת.",
].join("\n");

const PARTIAL_PROMPT = [
  "אתה מסכם קטע אחד מתוך פרק פודקאסט בעברית.",
  "החזר JSON בלבד, במבנה:",
  '{"summary": "סיכום הקטע בעברית", "keyPoints": ["נקודה"]}',
  "כלול את כל הנושאים, השמות והעובדות המשמעותיים שמופיעים בקטע הזה,",
  "כי הקטעים המאוחרים יסוכמו בנפרד ואסור שמידע מהם יאבד.",
  "אל תמציא מידע שאינו בקטע.",
].join("\n");

/**
 * OpenAI-compatible summarizer producing Hebrew output.
 *
 * Short transcripts take one request. Longer ones are summarized
 * hierarchically: ordered segments first, then a synthesis over those partial
 * summaries, folding again if the partials themselves are too long. Every
 * request stays inside `SEGMENT_CHARS`, and no part of the episode is dropped.
 */
export class LlmSummarizer implements SummarizerAdapter {
  readonly name = "openai-compatible";

  constructor(
    private readonly provider: ProviderConfig,
    private readonly fetchImpl: typeof fetch = defaultFetch,
    private readonly segmentChars: number = SEGMENT_CHARS,
  ) {}

  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    const segments = splitTranscript(request.transcript, this.segmentChars);

    if (segments.length <= 1) {
      const result = await this.ask(FINAL_PROMPT, this.finalUser(request.episodeTitle, request.transcript));
      return { ...result, provider: this.name };
    }

    // Summarize each segment in order, so the tail is represented as fully as
    // the opening.
    let partials: string[] = [];
    for (const [index, segment] of segments.entries()) {
      const partial = await this.ask(
        PARTIAL_PROMPT,
        `כותרת הפרק: ${request.episodeTitle}\nקטע ${index + 1} מתוך ${segments.length}:\n\n${segment}`,
      );
      partials.push(renderPartial(index, partial));
    }

    // Fold until the combined partials fit one request.
    for (let round = 0; round < MAX_FOLD_ROUNDS && joined(partials).length > this.segmentChars; round += 1) {
      const groups = splitTranscript(joined(partials), this.segmentChars);
      const folded: string[] = [];
      for (const [index, group] of groups.entries()) {
        const partial = await this.ask(
          PARTIAL_PROMPT,
          `כותרת הפרק: ${request.episodeTitle}\nסיכומי ביניים ${index + 1} מתוך ${groups.length}:\n\n${group}`,
        );
        folded.push(renderPartial(index, partial));
      }
      partials = folded;
    }

    const result = await this.ask(
      FINAL_PROMPT,
      this.finalUser(request.episodeTitle, joined(partials), true),
    );
    return { ...result, provider: this.name };
  }

  private finalUser(episodeTitle: string, body: string, fromPartials = false): string {
    const label = fromPartials
      ? "סיכומי הקטעים של הפרק, לפי סדרם"
      : "תמלול";
    return `כותרת הפרק: ${episodeTitle}\n\n${label}:\n${body}`;
  }

  private async ask(
    system: string,
    user: string,
  ): Promise<{ summary: string; keyPoints: string[] }> {
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
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Body deliberately unread: see `categorize`.
      await response.body?.cancel().catch(() => undefined);
      throw new SummaryProviderError(response.status, categorize(response.status));
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new SummaryProviderError(response.status, "malformed_response");
    }

    const parsed = parseSummaryJson(content);
    if (!parsed) throw new SummaryProviderError(response.status, "malformed_response");
    return parsed;
  }
}

function joined(partials: readonly string[]): string {
  return partials.join("\n\n");
}

function renderPartial(index: number, partial: { summary: string; keyPoints: string[] }): string {
  const points = partial.keyPoints.map((point) => `- ${point}`).join("\n");
  return `קטע ${index + 1}:\n${partial.summary}${points ? `\n${points}` : ""}`;
}

/**
 * Split a transcript into ordered pieces no larger than `limit`.
 *
 * Prefers paragraph boundaries, which the chunked transcript already provides,
 * and hard-splits only a single paragraph that is itself too long. Never drops
 * content: concatenating the result reproduces every character of the input
 * apart from the separators it split on.
 */
export function splitTranscript(transcript: string, limit: number): string[] {
  const text = transcript.trim();
  if (text.length <= limit) return text ? [text] : [];

  const pieces: string[] = [];
  let current = "";

  for (const paragraph of text.split(/\n\s*\n/)) {
    if (paragraph.length > limit) {
      if (current) {
        pieces.push(current);
        current = "";
      }
      for (let start = 0; start < paragraph.length; start += limit) {
        pieces.push(paragraph.slice(start, start + limit));
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > limit) {
      pieces.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
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
    ? record.keyPoints.filter(
        (point): point is string => typeof point === "string" && point.trim().length > 0,
      )
    : [];

  if (!summary) return null;
  return { summary, keyPoints: keyPoints.map((point) => point.trim()) };
}
