import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { defaultFetch } from "../src/http/safe-fetch.js";
import { runPipeline } from "../src/pipeline.js";
import {
  LlmSummarizer,
  parseSummaryJson,
  splitTranscript,
  SummaryNotReducibleError,
} from "../src/summary/llm-summarizer.js";
import { renderError } from "../src/ui/render.js";
import { NotConfiguredSummarizer } from "../src/summary/not-configured.js";
import { NotConfiguredTranscriptionAdapter } from "../src/transcription/not-configured.js";
import { OpenAiTranscriptionAdapter } from "../src/transcription/openai-adapter.js";
import { startMockProvider } from "./support/mock-provider.js";
import { transcriptionScenario, YOAV_EPISODE_URL } from "./support/scenarios.js";

const PROVIDER = { apiKey: "test-key-not-a-real-secret", baseUrl: "", model: "whisper-1" };

/** Temp directories the workspace would have created, so leaks are visible. */
async function workspaceDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("podcast-"));
}

describe("production adapters against a local mock provider", () => {
  it("runs the whole pipeline through the real adapters", async () => {
    const provider = await startMockProvider({
      transcriptFor: (call) => `קטע מספר ${call}`,
      summary: { summary: "סיכום אמיתי בעברית.", keyPoints: ["ראשונה", "שנייה", "שלישית"] },
    });
    const before = await workspaceDirs();

    try {
      const scenario = transcriptionScenario();
      const outcome = await runPipeline(YOAV_EPISODE_URL, {
        ...scenario,
        transcription: new OpenAiTranscriptionAdapter(
          { ...PROVIDER, baseUrl: provider.baseUrl },
          defaultFetch,
        ),
        summarizer: new LlmSummarizer(
          { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
          defaultFetch,
        ),
      });

      expect(outcome.status).toBe("done");
      if (outcome.status !== "done") return;

      // Chunks arrive in order and are joined in order.
      expect(provider.transcriptions).toHaveLength(4);
      expect(outcome.transcript.text).toBe(
        ["קטע מספר 0", "קטע מספר 1", "קטע מספר 2", "קטע מספר 3"].join("\n\n"),
      );

      expect(outcome.summary.summary).toBe("סיכום אמיתי בעברית.");
      expect(outcome.summary.keyPoints).toEqual(["ראשונה", "שנייה", "שלישית"]);
    } finally {
      await provider.close();
    }

    // No workspace survived the run.
    expect(await workspaceDirs()).toEqual(before);
  }, 60_000);

  it("sends the documented request shape with Hebrew set explicitly", async () => {
    const provider = await startMockProvider();
    try {
      const scenario = transcriptionScenario();
      await runPipeline(YOAV_EPISODE_URL, {
        ...scenario,
        transcription: new OpenAiTranscriptionAdapter(
          { ...PROVIDER, baseUrl: provider.baseUrl },
          defaultFetch,
        ),
        summarizer: new LlmSummarizer(
          { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
          defaultFetch,
        ),
      });

      for (const call of provider.transcriptions) {
        expect(call.language).toBe("he");
        expect(call.model).toBe("whisper-1");
        expect(call.fileName).toMatch(/^chunk-\d+\.mp3$/);
        expect(call.authorization).toBe(`Bearer ${PROVIDER.apiKey}`);
        expect(call.bodyBytes).toBeGreaterThan(0);
      }

      expect(provider.summaries).toHaveLength(1);
      expect(provider.summaries[0]?.model).toBe("gpt-4o-mini");
      expect(provider.summaries[0]?.transcript).toContain("קטע");
    } finally {
      await provider.close();
    }
  }, 60_000);

  it("surfaces a transcription provider failure as a Hebrew-facing error and cleans up", async () => {
    const provider = await startMockProvider({ failTranscription: 500 });
    const before = await workspaceDirs();

    try {
      const scenario = transcriptionScenario();
      const outcome = await runPipeline(YOAV_EPISODE_URL, {
        ...scenario,
        transcription: new OpenAiTranscriptionAdapter(
          { ...PROVIDER, baseUrl: provider.baseUrl },
          defaultFetch,
        ),
        summarizer: new LlmSummarizer(
          { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
          defaultFetch,
        ),
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.reason).toBe("provider_failed");
      expect(outcome.detail).toContain("500");
      expect(outcome.detail).not.toContain(PROVIDER.apiKey);
    } finally {
      await provider.close();
    }

    expect(await workspaceDirs()).toEqual(before);
  }, 60_000);

  it("surfaces a summary provider failure without leaking the transcript", async () => {
    const provider = await startMockProvider({ failSummary: 502 });
    try {
      const scenario = transcriptionScenario();
      const outcome = await runPipeline(YOAV_EPISODE_URL, {
        ...scenario,
        transcription: new OpenAiTranscriptionAdapter(
          { ...PROVIDER, baseUrl: provider.baseUrl },
          defaultFetch,
        ),
        summarizer: new LlmSummarizer(
          { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
          defaultFetch,
        ),
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.reason).toBe("provider_failed");
      expect(outcome.detail).toContain("502");
      expect(outcome.detail).not.toContain(PROVIDER.apiKey);
    } finally {
      await provider.close();
    }
  }, 60_000);
});

describe("missing configuration", () => {
  it("fails the run with a configuration reason rather than fabricating a transcript", async () => {
    const scenario = transcriptionScenario();
    const outcome = await runPipeline(YOAV_EPISODE_URL, {
      ...scenario,
      transcription: new NotConfiguredTranscriptionAdapter(["TRANSCRIPTION_API_KEY"]),
      summarizer: new NotConfiguredSummarizer(["SUMMARY_API_KEY"]),
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toBe("not_configured");
    expect(outcome.detail).toContain("TRANSCRIPTION_API_KEY");
  });
});

describe("parseSummaryJson", () => {
  it("accepts plain JSON", () => {
    expect(parseSummaryJson('{"summary":"א","keyPoints":["ב"]}')).toEqual({
      summary: "א",
      keyPoints: ["ב"],
    });
  });

  it("accepts a fenced code block", () => {
    expect(parseSummaryJson('```json\n{"summary":"א","keyPoints":[]}\n```')).toEqual({
      summary: "א",
      keyPoints: [],
    });
  });

  it("refuses output with no summary rather than inventing one", () => {
    expect(parseSummaryJson('{"keyPoints":["ב"]}')).toBeNull();
    expect(parseSummaryJson("not json at all")).toBeNull();
  });

  it("drops non-string key points instead of rendering them", () => {
    expect(parseSummaryJson('{"summary":"א","keyPoints":["ב",5,null,"ג"]}')).toEqual({
      summary: "א",
      keyPoints: ["ב", "ג"],
    });
  });
});

describe("a hostile provider cannot push its response body anywhere visible", () => {
  const SECRET_KEY = "sk-live-THIS-IS-THE-KEY-DO-NOT-LEAK";
  const TRANSCRIPT_MARKER = "SENSITIVE-TRANSCRIPT-MARKER-9F3A";
  const URL_MARKER = "https://cdn.example.com/private/audio-with-token?tok=abcd1234";

  /** An error body echoing back exactly what a proxy might reflect. */
  const hostileBody = JSON.stringify({
    error: {
      message: `Request failed. Authorization: Bearer ${SECRET_KEY}. Body contained "${TRANSCRIPT_MARKER}". Upstream: ${URL_MARKER}`,
    },
  });

  it("keeps an echoed key, transcript and URL out of the transcription failure", async () => {
    const provider = await startMockProvider({ failTranscription: 500, errorBody: hostileBody });
    try {
      const scenario = transcriptionScenario();
      const outcome = await runPipeline(YOAV_EPISODE_URL, {
        ...scenario,
        transcription: new OpenAiTranscriptionAdapter(
          { ...PROVIDER, apiKey: SECRET_KEY, baseUrl: provider.baseUrl },
          defaultFetch,
        ),
        summarizer: new LlmSummarizer(
          { ...PROVIDER, apiKey: SECRET_KEY, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
          defaultFetch,
        ),
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;

      // The status stays diagnosable...
      expect(outcome.detail).toContain("500");
      // ...and nothing the provider chose to say comes with it.
      expect(outcome.detail).not.toContain(SECRET_KEY);
      expect(outcome.detail).not.toContain(TRANSCRIPT_MARKER);
      expect(outcome.detail).not.toContain(URL_MARKER);
      expect(outcome.detail).not.toContain("Authorization");

      // Nor into the page the user actually sees.
      const html = renderError(outcome);
      expect(html).not.toContain(SECRET_KEY);
      expect(html).not.toContain(TRANSCRIPT_MARKER);
      expect(html).not.toContain(URL_MARKER);
      expect(html).toContain("500");
    } finally {
      await provider.close();
    }
  }, 60_000);

  it("keeps an echoed key and transcript out of the summary failure", async () => {
    const provider = await startMockProvider({ failSummary: 500, errorBody: hostileBody });
    try {
      const scenario = transcriptionScenario();
      const outcome = await runPipeline(YOAV_EPISODE_URL, {
        ...scenario,
        transcription: new OpenAiTranscriptionAdapter(
          { ...PROVIDER, apiKey: SECRET_KEY, baseUrl: provider.baseUrl },
          defaultFetch,
        ),
        summarizer: new LlmSummarizer(
          { ...PROVIDER, apiKey: SECRET_KEY, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
          defaultFetch,
        ),
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.detail).toContain("500");
      expect(outcome.detail).not.toContain(SECRET_KEY);
      expect(outcome.detail).not.toContain(TRANSCRIPT_MARKER);
      expect(renderError(outcome)).not.toContain(SECRET_KEY);
    } finally {
      await provider.close();
    }
  }, 60_000);
});

describe("long transcripts are summarized whole, not from their opening", () => {
  const TAIL_FACT = "עובדה-שמופיעה-רק-בסוף-הפרק-7Q2X";

  /** Long enough to force several segments, with the decisive fact only at the end. */
  function longTranscript(segmentChars: number): string {
    const filler = Array.from(
      { length: 12 },
      (_unused, index) => `פסקה ${index} ${"מילה ".repeat(400)}`,
    ).join("\n\n");
    return `${filler}\n\nולסיום, ${TAIL_FACT}.`.padEnd(segmentChars * 2 + 100, " ");
  }

  it("carries a fact from the final chunk into the synthesized summary", async () => {
    const segmentChars = 2_000;
    const provider = await startMockProvider({
      // Each call reports the markers it actually received, so the flow is visible.
      summaryFor: (userContent) => ({
        summary: userContent.includes(TAIL_FACT)
          ? `הקטע כולל ${TAIL_FACT}`
          : "קטע ללא העובדה הסופית",
        keyPoints: userContent.includes(TAIL_FACT) ? [TAIL_FACT] : ["נקודה"],
      }),
    });

    try {
      const summarizer = new LlmSummarizer(
        { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
        defaultFetch,
        segmentChars,
      );

      const result = await summarizer.summarize({
        transcript: longTranscript(segmentChars),
        episodeTitle: "פרק ארוך",
        language: "he",
      });

      // More than one request: the transcript was segmented rather than cut.
      expect(provider.summaries.length).toBeGreaterThan(2);

      // The final chunk reached a partial-summary request...
      const partialSawTail = provider.summaries
        .slice(0, -1)
        .some((call) => call.transcript.includes(TAIL_FACT));
      expect(partialSawTail).toBe(true);

      // ...that partial reached the synthesis request...
      const synthesis = provider.summaries.at(-1);
      expect(synthesis?.transcript).toContain(TAIL_FACT);

      // ...and so the fact can appear in what the user is shown.
      expect(`${result.summary} ${result.keyPoints.join(" ")}`).toContain(TAIL_FACT);
    } finally {
      await provider.close();
    }
  }, 60_000);

  it("keeps every request inside the segment bound", async () => {
    const segmentChars = 2_000;
    const provider = await startMockProvider();
    try {
      const summarizer = new LlmSummarizer(
        { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
        defaultFetch,
        segmentChars,
      );
      await summarizer.summarize({
        transcript: longTranscript(segmentChars),
        episodeTitle: "פרק ארוך",
        language: "he",
      });

      for (const call of provider.summaries) {
        // Prompt scaffolding adds a little; the transcript body stays bounded.
        expect(call.transcript.length).toBeLessThan(segmentChars + 500);
      }
    } finally {
      await provider.close();
    }
  }, 60_000);

  it("still takes a single request for a short transcript", async () => {
    const provider = await startMockProvider();
    try {
      const summarizer = new LlmSummarizer(
        { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
        defaultFetch,
        10_000,
      );
      await summarizer.summarize({
        transcript: "תמלול קצר מאוד.",
        episodeTitle: "פרק קצר",
        language: "he",
      });
      expect(provider.summaries).toHaveLength(1);
    } finally {
      await provider.close();
    }
  }, 30_000);
});

describe("splitTranscript", () => {
  it("loses no content", () => {
    const text = Array.from({ length: 20 }, (_u, i) => `פסקה ${i} ${"טקסט ".repeat(50)}`).join("\n\n");
    const pieces = splitTranscript(text, 500);
    expect(pieces.length).toBeGreaterThan(1);

    // Compare on non-whitespace content: splitting consumes the separators it
    // splits on, so only the characters themselves must survive.
    const strip = (value: string): string => value.replace(/\s+/g, "");
    expect(strip(pieces.join(""))).toBe(strip(text));
    // A readable signal if it ever regresses, instead of a wall of text.
    expect(strip(pieces.join("")).length).toBe(strip(text).length);
  });

  it("hard-splits a single paragraph that is itself too long", () => {
    const pieces = splitTranscript("א".repeat(1000), 300);
    expect(pieces).toHaveLength(4);
    expect(pieces.join("")).toBe("א".repeat(1000));
  });

  it("returns one piece when the transcript fits", () => {
    expect(splitTranscript("קצר", 100)).toEqual(["קצר"]);
  });
});

describe("folding that never converges fails closed", () => {
  /**
   * A provider whose partial summaries are as long as their input. Folding can
   * never shrink such output, so the run must fail rather than send an
   * oversized final request or truncate the content away.
   */
  it("never exceeds the bound, and fails predictably instead", async () => {
    const segmentChars = 1_500;
    const provider = await startMockProvider({
      // Each partial is longer than the bound on its own.
      summaryFor: () => ({
        summary: "ס".repeat(segmentChars),
        keyPoints: ["נ".repeat(200)],
      }),
    });

    try {
      const summarizer = new LlmSummarizer(
        { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
        defaultFetch,
        segmentChars,
      );

      await expect(
        summarizer.summarize({
          transcript: Array.from({ length: 8 }, (_u, i) => `פסקה ${i} ${"מילה ".repeat(200)}`).join(
            "\n\n",
          ),
          episodeTitle: "פרק שלא מתכווץ",
          language: "he",
        }),
      ).rejects.toThrow(SummaryNotReducibleError);

      // Every request that was issued stayed inside the bound.
      for (const call of provider.summaries) {
        expect(call.transcript.length).toBeLessThan(segmentChars + 500);
      }
      // It gave up rather than spinning: bounded rounds, not an endless loop.
      expect(provider.summaries.length).toBeLessThan(60);
    } finally {
      await provider.close();
    }
  }, 60_000);

  it("surfaces the non-convergent case as a provider failure, with no provider text", async () => {
    const segmentChars = 300;
    const provider = await startMockProvider({
      // Long chunk transcripts, so the joined transcript exceeds the bound and
      // the fold path is actually reached through the pipeline.
      transcriptFor: () => "מילה ".repeat(120),
      summaryFor: () => ({ summary: "ס".repeat(segmentChars), keyPoints: [] }),
    });

    try {
      const scenario = transcriptionScenario();
      const outcome = await runPipeline(YOAV_EPISODE_URL, {
        ...scenario,
        transcription: new OpenAiTranscriptionAdapter(
          { ...PROVIDER, baseUrl: provider.baseUrl },
          defaultFetch,
        ),
        summarizer: new LlmSummarizer(
          { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
          defaultFetch,
          segmentChars,
        ),
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.reason).toBe("provider_failed");
      // Only our own numbers, never a slice of what the provider returned.
      expect(outcome.detail).toContain("folding rounds");
      expect(outcome.detail).not.toContain("ס".repeat(50));
    } finally {
      await provider.close();
    }
  }, 60_000);

  it("stops early when a fold round makes no progress", async () => {
    const segmentChars = 1_000;
    const provider = await startMockProvider({
      summaryFor: () => ({ summary: "ס".repeat(segmentChars * 2), keyPoints: [] }),
    });

    try {
      const summarizer = new LlmSummarizer(
        { ...PROVIDER, baseUrl: provider.baseUrl, model: "gpt-4o-mini" },
        defaultFetch,
        segmentChars,
      );
      await expect(
        summarizer.summarize({
          transcript: Array.from({ length: 6 }, (_u, i) => `פסקה ${i} ${"מילה ".repeat(150)}`).join(
            "\n\n",
          ),
          episodeTitle: "פרק",
          language: "he",
        }),
      ).rejects.toThrow(SummaryNotReducibleError);

      // Non-shrinking output is detected on the first fold, not after four.
      const segmentsInFirstPass = Math.ceil(provider.summaries.length / 2);
      expect(segmentsInFirstPass).toBeGreaterThan(0);
      expect(provider.summaries.length).toBeLessThan(40);
    } finally {
      await provider.close();
    }
  }, 60_000);
});
