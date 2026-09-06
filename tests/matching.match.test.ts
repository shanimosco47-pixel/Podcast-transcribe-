import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { feedEpisodes } from "../src/matching/feed.js";
import { matchEpisode } from "../src/matching/match.js";
import type { EpisodeCandidate } from "../src/matching/types.js";

const feedXml = readFileSync(fileURLToPath(new URL("./fixtures/hebrew-feed.xml", import.meta.url)), "utf8");
const episodes = feedEpisodes(feedXml);

describe("matchEpisode — wrong-episode regression", () => {
  it("returns Yoav's episode, the one upstream got wrong", () => {
    const result = matchEpisode(
      {
        episodeTitle: "ריאיון עם יואב על שבבים",
        showTitle: "עושים טכנולוגיה",
        durationSeconds: 2335,
        publishedAt: "2025-06-09T03:00:00Z",
      },
      episodes,
    );

    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.best.candidate.enclosureUrl).toBe("https://cdn.example.com/audio/yoav.mp3");
    expect(result.best.candidate.enclosureUrl).not.toBe("https://cdn.example.com/audio/dana.mp3");
    expect(result.best.confidence).toBeGreaterThanOrEqual(0.86);
  });

  it("matches on title alone when no other signal is available", () => {
    const result = matchEpisode({ episodeTitle: "פרק 12: איך בונים מוצר" }, episodes);
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.best.candidate.enclosureUrl).toBe("https://cdn.example.com/audio/ep12.mp3");
  });

  it("reports per-signal evidence for the accepted match", () => {
    const result = matchEpisode(
      { episodeTitle: "ריאיון עם דנה על בינה מלאכותית", showTitle: "עושים טכנולוגיה", durationSeconds: 2530 },
      episodes,
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;

    const signals = result.best.evidence.map((entry) => entry.signal);
    expect(signals).toContain("episodeTitle");
    expect(signals).toContain("showTitle");
    expect(signals).toContain("duration");
    const totalWeight = result.best.evidence.reduce((sum, entry) => sum + entry.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 10);
  });
});

describe("matchEpisode — refusals", () => {
  const nearIdentical: EpisodeCandidate[] = [
    { id: "a", title: "מהדורת בוקר", showTitle: "חדשות", enclosureUrl: "https://cdn.example.com/a.mp3" },
    { id: "b", title: "מהדורת בוקר", showTitle: "חדשות", enclosureUrl: "https://cdn.example.com/b.mp3" },
  ];

  it("refuses when two candidates tie", () => {
    const result = matchEpisode({ episodeTitle: "מהדורת בוקר", showTitle: "חדשות" }, nearIdentical);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates).toHaveLength(2);
    expect(result.reason).toMatch(/margin/i);
  });

  it("never falls back to the first candidate when nothing is close", () => {
    const result = matchEpisode({ episodeTitle: "נושא אחר לגמרי שלא קיים" }, episodes);
    expect(result.status).toBe("no_match");
  });

  it("refuses a query title that normalizes to nothing", () => {
    const result = matchEpisode({ episodeTitle: "— :: —" }, episodes);
    expect(result.status).toBe("no_match");
    if (result.status !== "no_match") return;
    expect(result.reason).toMatch(/no comparable content/i);
  });

  it("does not match two content-free titles to each other", () => {
    const result = matchEpisode({ episodeTitle: "###" }, [
      { id: "empty", title: "!!!", enclosureUrl: "https://cdn.example.com/empty.mp3" },
    ]);
    expect(result.status).toBe("no_match");
  });

  it("refuses an empty feed", () => {
    const result = matchEpisode({ episodeTitle: "ריאיון עם יואב על שבבים" }, []);
    expect(result.status).toBe("no_match");
  });

  it("refuses a partial title overlap that clears the floor but not the accept threshold", () => {
    const result = matchEpisode({ episodeTitle: "ריאיון עם יואב" }, [
      { id: "a", title: "ריאיון עם יואב על שבבים", enclosureUrl: "https://cdn.example.com/yoav.mp3" },
    ]);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.reason).toMatch(/accept threshold/i);
  });
});

describe("matchEpisode — signal contribution", () => {
  it("uses duration to break a title tie", () => {
    const sameTitle: EpisodeCandidate[] = [
      { id: "short", title: "מהדורת בוקר", durationSeconds: 600, enclosureUrl: "https://cdn.example.com/short.mp3" },
      { id: "long", title: "מהדורת בוקר", durationSeconds: 3600, enclosureUrl: "https://cdn.example.com/long.mp3" },
    ];
    const result = matchEpisode({ episodeTitle: "מהדורת בוקר", durationSeconds: 3598 }, sameTitle);
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.best.candidate.id).toBe("long");
  });

  it("uses publication date to break a title tie", () => {
    const sameTitle: EpisodeCandidate[] = [
      { id: "old", title: "מהדורת בוקר", publishedAt: "Mon, 02 Jun 2025 06:00:00 +0300" },
      { id: "new", title: "מהדורת בוקר", publishedAt: "Mon, 09 Jun 2025 06:00:00 +0300" },
    ];
    const result = matchEpisode(
      { episodeTitle: "מהדורת בוקר", publishedAt: "2025-06-09T03:00:00Z" },
      sameTitle,
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.best.candidate.id).toBe("new");
  });
});
