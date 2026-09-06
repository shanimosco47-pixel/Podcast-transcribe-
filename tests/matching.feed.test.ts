import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractChannelTitle, feedEpisodes } from "../src/matching/feed.js";

const feedXml = readFileSync(fileURLToPath(new URL("./fixtures/hebrew-feed.xml", import.meta.url)), "utf8");

describe("feedEpisodes", () => {
  it("reads the channel title rather than the first item title", () => {
    expect(extractChannelTitle(feedXml)).toBe("עושים טכנולוגיה");
  });

  it("extracts every episode with its match signals", () => {
    const episodes = feedEpisodes(feedXml);
    expect(episodes).toHaveLength(3);

    const [dana, yoav, ep12] = episodes;
    expect(dana?.title).toBe("ריאיון עם דנה על בינה מלאכותית");
    expect(dana?.enclosureUrl).toBe("https://cdn.example.com/audio/dana.mp3");
    expect(dana?.durationSeconds).toBe(2530);
    expect(dana?.showTitle).toBe("עושים טכנולוגיה");

    expect(yoav?.durationSeconds).toBe(2335);
    expect(Date.parse(yoav?.publishedAt ?? "")).toBeTruthy();

    expect(ep12?.transcript).toEqual({
      url: "https://cdn.example.com/transcripts/ep12.vtt",
      type: "text/vtt",
    });
    expect(dana?.transcript).toBeNull();
  });
});
