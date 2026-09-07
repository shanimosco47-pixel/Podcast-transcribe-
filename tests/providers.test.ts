import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { defaultFetch } from "../src/http/safe-fetch.js";
import { runPipeline } from "../src/pipeline.js";
import { LlmSummarizer, parseSummaryJson } from "../src/summary/llm-summarizer.js";
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
      // The key must never appear in a message that reaches a log or a page.
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
