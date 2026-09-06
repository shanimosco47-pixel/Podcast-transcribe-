import type { AudioTool } from "../../src/media/ffmpeg.js";
import { FixtureSummarizer } from "../../src/summary/fixture-summarizer.js";
import { FixtureTranscriptionAdapter } from "../../src/transcription/fixture-adapter.js";
import { fixture, fixtureFetch } from "./fixture-fetch.js";

/** Built the same way the resolver builds it, so the fixture key cannot drift. */
export function itunesUrl(showTitle: string): string {
  const query = new URLSearchParams({
    term: showTitle,
    media: "podcast",
    entity: "podcast",
    limit: "10",
  });
  return `https://itunes.apple.com/search?${query.toString()}`;
}

export const ITUNES_URL = itunesUrl("עושים טכנולוגיה");
export const FEED_URL = "https://feeds.example.com/osim-technologia.xml";

export const YOAV_EPISODE_URL = "https://open.spotify.com/episode/5Qk8LmN2pRxTvWy7Zb3Cd4";
export const EP12_EPISODE_URL = "https://open.spotify.com/episode/7Ab2CdEf3GhIjKlMnOpQrS";

export const YOAV_ENCLOSURE_URL = "https://cdn.example.com/audio/yoav.mp3";

/**
 * Stands in for ffmpeg. The fixture episode is 38 minutes, so the pipeline
 * genuinely splits it; this returns the chunks ffmpeg would produce, letting the
 * chunked path run in tests without a binary.
 */
export const CHUNK_COUNT = 4;

export const fakeAudioTool: AudioTool = {
  probeDurationSeconds: () => Promise.resolve(2335),
  split: (_path, workspace) =>
    Promise.resolve(
      Array.from({ length: CHUNK_COUNT }, (_unused, index) => ({
        index,
        path: workspace.path(`chunk-${String(index).padStart(5, "0")}.mp3`),
        startSeconds: index * 600,
      })),
    ),
};

export const HEBREW_TRANSCRIPT =
  "שלום וברוכים הבאים לעושים טכנולוגיה. היום נדבר על שבבים, על תהליכי הייצור שלהם, ועל מה שקורה כשהשרשרת נקטעת.";

export const HEBREW_SUMMARY = {
  summary: "בפרק נדונו תהליכי ייצור שבבים והשלכות של הפרעות בשרשרת האספקה.",
  keyPoints: [
    "ייצור שבבים מרוכז במספר קטן של מפעלים",
    "הפרעה באספקה משפיעה על ענפים רבים",
    "פתרונות אפשריים דורשים השקעה ארוכת טווח",
  ],
};

/** The default happy path: an episode with no feed transcript, so audio is transcribed. */
export function transcriptionScenario() {
  const { fetch, requested, resolveHost } = fixtureFetch({
    "https://open.spotify.com/embed/episode/5Qk8LmN2pRxTvWy7Zb3Cd4": {
      body: fixture("spotify-embed-yoav.html"),
      contentType: "text/html; charset=utf-8",
    },
    [ITUNES_URL]: {
      body: fixture("itunes-search.json"),
      contentType: "application/json",
    },
    [FEED_URL]: { body: fixture("hebrew-feed.xml"), contentType: "application/xml" },
    [YOAV_ENCLOSURE_URL]: { body: "fake-mp3-payload", contentType: "audio/mpeg" },
  });

  const transcription = new FixtureTranscriptionAdapter(HEBREW_TRANSCRIPT);
  const summarizer = new FixtureSummarizer(HEBREW_SUMMARY);
  return { fetch, requested, resolveHost, transcription, summarizer, audioTool: fakeAudioTool };
}

/** An episode whose feed publishes a Podcasting 2.0 transcript. */
export function feedTranscriptScenario() {
  const { fetch, requested, resolveHost } = fixtureFetch({
    "https://open.spotify.com/embed/episode/7Ab2CdEf3GhIjKlMnOpQrS": {
      body: fixture("spotify-embed-ep12.html"),
      contentType: "text/html; charset=utf-8",
    },
    [ITUNES_URL]: { body: fixture("itunes-search.json"), contentType: "application/json" },
    [FEED_URL]: { body: fixture("hebrew-feed.xml"), contentType: "application/xml" },
    "https://cdn.example.com/transcripts/ep12.vtt": {
      body: "WEBVTT\n\n00:00.000 --> 00:05.000\nשלום, זהו התמלול הרשמי של הפרק.",
      contentType: "text/vtt",
    },
  });
  return {
    fetch,
    requested,
    resolveHost,
    transcription: new FixtureTranscriptionAdapter("SHOULD NOT BE CALLED"),
    summarizer: new FixtureSummarizer(HEBREW_SUMMARY),
    audioTool: fakeAudioTool,
  };
}

/** A feed with two indistinguishable episodes. */
export function ambiguousScenario() {
  const { fetch, requested, resolveHost } = fixtureFetch({
    "https://open.spotify.com/embed/episode/5Qk8LmN2pRxTvWy7Zb3Cd4": {
      body: fixture("spotify-embed-boker.html"),
      contentType: "text/html; charset=utf-8",
    },
    [ITUNES_URL]: { body: fixture("itunes-search.json"), contentType: "application/json" },
    [FEED_URL]: {
      body: fixture("hebrew-feed-ambiguous.xml"),
      contentType: "application/xml",
    },
    // Either candidate may be confirmed, so both enclosures are recorded.
    "https://cdn.example.com/audio/boker-a.mp3": { body: "fake-a", contentType: "audio/mpeg" },
    "https://cdn.example.com/audio/boker-b.mp3": { body: "fake-b", contentType: "audio/mpeg" },
  });
  return {
    fetch,
    requested,
    resolveHost,
    transcription: new FixtureTranscriptionAdapter(HEBREW_TRANSCRIPT),
    summarizer: new FixtureSummarizer(HEBREW_SUMMARY),
    audioTool: fakeAudioTool,
  };
}

/** The directory returns a show whose name is close but not the same. */
export function showMismatchScenario() {
  const { fetch, requested, resolveHost } = fixtureFetch({
    "https://open.spotify.com/embed/episode/9ZzYyXxWwVvUuTtSsRrQq": {
      body: fixture("spotify-embed-unknown-show.html"),
      contentType: "text/html; charset=utf-8",
    },
    [itunesUrl("תוכנית שלא קיימת בספרייה")]: {
      body: fixture("itunes-search-nomatch.json"),
      contentType: "application/json",
    },
  });
  return {
    fetch,
    requested,
    resolveHost,
    transcription: new FixtureTranscriptionAdapter(HEBREW_TRANSCRIPT),
    summarizer: new FixtureSummarizer(HEBREW_SUMMARY),
    audioTool: fakeAudioTool,
  };
}
