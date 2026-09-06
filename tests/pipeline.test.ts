import { describe, expect, it } from "vitest";

import { runPipeline } from "../src/pipeline.js";
import {
  ambiguousScenario,
  CHUNK_COUNT,
  EP12_EPISODE_URL,
  feedTranscriptScenario,
  showMismatchScenario,
  HEBREW_TRANSCRIPT,
  transcriptionScenario,
  YOAV_ENCLOSURE_URL,
  YOAV_EPISODE_URL,
} from "./support/scenarios.js";

describe("runPipeline — end to end over recorded fixtures", () => {
  it("resolves a Spotify URL to the right episode and transcribes it in Hebrew", async () => {
    const scenario = transcriptionScenario();
    const outcome = await runPipeline(YOAV_EPISODE_URL, scenario);

    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;

    expect(outcome.evidence.showTitle).toBe("עושים טכנולוגיה");
    expect(outcome.evidence.episodeTitle).toBe("ריאיון עם יואב על שבבים");
    expect(outcome.evidence.enclosureUrl).toBe("https://cdn.example.com/audio/yoav.mp3");
    expect(outcome.evidence.feedUrl).toBe("https://feeds.example.com/osim-technologia.xml");
    expect(outcome.evidence.durationSeconds).toBe(2335);
    expect(outcome.evidence.publishedAt).toBeTruthy();

    expect(outcome.transcript.source).toBe("transcription");
    expect(outcome.transcript.text).toContain(HEBREW_TRANSCRIPT);
    expect(outcome.summary.keyPoints.length).toBeGreaterThan(0);
  });

  it("passes Hebrew explicitly to the transcription provider", async () => {
    const scenario = transcriptionScenario();
    await runPipeline(YOAV_EPISODE_URL, scenario);

    expect(scenario.transcription.calls).toHaveLength(CHUNK_COUNT);
    expect(scenario.transcription.calls.every((call) => call.language === "he")).toBe(true);
  });

  it("transcribes chunks in playback order", async () => {
    const scenario = transcriptionScenario();
    await runPipeline(YOAV_EPISODE_URL, scenario);

    const order = scenario.transcription.calls.map(
      (call) => Number(call.audioUrl.match(/chunk-(\d+)/)?.[1] ?? -1),
    );
    expect(order).toEqual([...Array(CHUNK_COUNT).keys()]);
  });

  it("downloads the enclosure and hands the provider a local file, not the URL", async () => {
    const scenario = transcriptionScenario();
    await runPipeline(YOAV_EPISODE_URL, scenario);

    // The audio is fetched from the public feed CDN...
    expect(scenario.requested).toContain(YOAV_ENCLOSURE_URL);
    // ...and the provider receives a local path, so no remote URL is forwarded.
    const audioUrl = scenario.transcription.calls[0]?.audioUrl ?? "";
    expect(audioUrl).not.toMatch(/^https?:/);
    expect(audioUrl).toContain("chunk-");
  });

  it("prefers a transcript published in the feed over transcribing audio", async () => {
    const scenario = feedTranscriptScenario();
    const outcome = await runPipeline(EP12_EPISODE_URL, scenario);

    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;
    expect(outcome.transcript.source).toBe("feed_transcript");
    expect(outcome.transcript.text).toContain("התמלול הרשמי");
    expect(scenario.transcription.calls).toHaveLength(0);
    expect(scenario.requested).toContain("https://cdn.example.com/transcripts/ep12.vtt");
  });

  it("never downloads audio from Spotify", async () => {
    const scenario = transcriptionScenario();
    await runPipeline(YOAV_EPISODE_URL, scenario);

    const audioFromSpotify = [
      ...scenario.requested,
      ...scenario.transcription.calls.map((call) => call.audioUrl),
    ].filter((url) => /spotify\.com|scdn\.co/i.test(url) && !/\/embed\//.test(url));
    expect(audioFromSpotify).toEqual([]);
  });

  it("asks the user to choose when episodes are indistinguishable", async () => {
    const outcome = await runPipeline(YOAV_EPISODE_URL, ambiguousScenario());

    expect(outcome.status).toBe("ambiguous");
    if (outcome.status !== "ambiguous") return;
    expect(outcome.candidates.length).toBeGreaterThan(1);
  });

  it("does not transcribe anything when the match is ambiguous", async () => {
    const scenario = ambiguousScenario();
    await runPipeline(YOAV_EPISODE_URL, scenario);
    expect(scenario.transcription.calls).toHaveLength(0);
    expect(scenario.summarizer.calls).toHaveLength(0);
  });

  it("rejects a non-Spotify URL before any network call", async () => {
    const scenario = transcriptionScenario();
    const outcome = await runPipeline("https://example.com/episode/1", scenario);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toBe("not_spotify");
    expect(scenario.requested).toEqual([]);
  });

  it("refuses when the directory has no confidently matching show", async () => {
    const scenario = showMismatchScenario();
    const outcome = await runPipeline(
      "https://open.spotify.com/episode/9ZzYyXxWwVvUuTtSsRrQq",
      scenario,
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toBe("show_mismatch");
    expect(scenario.transcription.calls).toHaveLength(0);
  });
});
