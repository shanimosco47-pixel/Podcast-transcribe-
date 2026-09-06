import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { ambiguousScenario, transcriptionScenario, YOAV_EPISODE_URL } from "./support/scenarios.js";

let server: Server | null = null;

async function start(deps: Parameters<typeof createApp>[0]["deps"]): Promise<string> {
  const app = createApp({ deps });
  server = app;
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const { port } = app.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

async function submit(base: string, url: string): Promise<{ finalUrl: string; html: string }> {
  const response = await fetch(`${base}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url }).toString(),
    redirect: "follow",
  });
  return { finalUrl: response.url, html: await response.text() };
}

describe("server", () => {
  it("serves an RTL Hebrew document", async () => {
    const base = await start(transcriptionScenario());
    const html = await (await fetch(base)).text();

    expect(html).toContain('<html lang="he" dir="rtl">');
    expect(html).toContain("תמלול פודקאסטים");
  });

  it("renders the transcript, summary, and key points after a successful run", async () => {
    const base = await start(transcriptionScenario());
    const { html } = await submit(base, YOAV_EPISODE_URL);

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("ריאיון עם יואב על שבבים");
    expect(html).toContain("עושים טכנולוגיה");
    expect(html).toContain("סיכום");
    expect(html).toContain("נקודות עיקריות");
    expect(html).toContain("שבבים");
  });

  it("offers the transcript as a download", async () => {
    const base = await start(transcriptionScenario());
    const { finalUrl } = await submit(base, YOAV_EPISODE_URL);

    const download = await fetch(`${finalUrl}/transcript.txt`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toContain("שבבים");
  });

  it("shows a Hebrew explanation and no stack trace for a bad link", async () => {
    const base = await start(transcriptionScenario());
    const { html } = await submit(base, "https://example.com/not-spotify");

    expect(html).toContain("לא הצלחנו להמשיך");
    expect(html).toContain("הדביקו קישור לפרק מתוך ספוטיפיי");
    expect(html).not.toContain("Error:");
    expect(html).not.toContain("at Object");
  });

  it("asks for a choice when the episode is ambiguous, and does not pick one", async () => {
    const base = await start(ambiguousScenario());
    const { html } = await submit(base, YOAV_EPISODE_URL);

    expect(html).toContain("לא הצלחנו לזהות את הפרק בוודאות");
    expect(html).toContain('type="radio"');
    expect(html).not.toContain("התמלול המלא");
  });

  it("completes the run once the user confirms which episode is right", async () => {
    const base = await start(ambiguousScenario());
    const { finalUrl, html } = await submit(base, YOAV_EPISODE_URL);

    const values = [...html.matchAll(/name="episodeId"[\s\S]*?value="([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(values.length).toBeGreaterThan(1);
    const value = values[1] ?? "";

    const confirmed = await fetch(`${finalUrl}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ episodeId: value }).toString(),
      redirect: "follow",
    });
    const confirmedHtml = await confirmed.text();
    expect(confirmedHtml).toContain("התמלול המלא");
  });

  it("sets no-store so transcripts are not cached by intermediaries", async () => {
    const base = await start(transcriptionScenario());
    const response = await fetch(base);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
