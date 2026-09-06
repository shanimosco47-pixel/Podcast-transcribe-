import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue, QueueFullError } from "../src/jobs/queue.js";
import { InMemoryJobStore } from "../src/jobs/store.js";
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

/**
 * Submit, then poll the job page until it leaves the progress state.
 *
 * Submitting no longer blocks on the run, so the immediate response is the
 * "working" page; the result appears on a later poll.
 */
async function submit(base: string, url: string): Promise<{ finalUrl: string; html: string }> {
  const response = await fetch(`${base}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url }).toString(),
    redirect: "follow",
  });
  return waitForJob(response.url);
}

async function waitForJob(jobUrl: string): Promise<{ finalUrl: string; html: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = await fetch(jobUrl);
    const html = await page.text();
    if (!html.includes("עובדים על זה")) return { finalUrl: jobUrl, html };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Job at ${jobUrl} never finished`);
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
    const { html: confirmedHtml } = await waitForJob(confirmed.url);
    expect(confirmedHtml).toContain("התמלול המלא");
  });

  it("sets no-store so transcripts are not cached by intermediaries", async () => {
    const base = await start(transcriptionScenario());
    const response = await fetch(base);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("asynchronous job handling", () => {
  it("returns a progress page immediately instead of blocking on the run", async () => {
    const base = await start(transcriptionScenario());
    const response = await fetch(`${base}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: YOAV_EPISODE_URL }).toString(),
      redirect: "follow",
    });

    const html = await response.text();
    // The very first render is the working page, not a finished transcript.
    expect(html).toContain("עובדים על זה");
    expect(html).toContain('http-equiv="refresh"');

    await waitForJob(response.url);
  });

  it("runs one job at a time for a single user", async () => {
    const queue = new JobQueue(new InMemoryJobStore(), { concurrency: 1 });
    let peak = 0;
    let active = 0;

    const work = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: "failed", reason: "no_match", detail: "test" } as const;
    };

    for (let i = 0; i < 5; i += 1) queue.submit(work);
    await queue.drain();

    expect(peak).toBe(1);
  });

  it("refuses new work once the queue is full rather than growing without limit", async () => {
    const queue = new JobQueue(new InMemoryJobStore(), { concurrency: 1, maxQueued: 2 });
    const blocked = () =>
      new Promise<never>(() => {
        /* never resolves: holds the queue */
      });

    // One starts running, two wait. maxQueued bounds the waiting list only.
    queue.submit(blocked);
    queue.submit(blocked);
    queue.submit(blocked);
    expect(queue.runningCount).toBe(1);
    expect(queue.queuedCount).toBe(2);

    expect(() => queue.submit(blocked)).toThrow(QueueFullError);
  });

  it("reports a full queue in Hebrew rather than failing silently", async () => {
    const queue = new JobQueue(new InMemoryJobStore(), { concurrency: 1, maxQueued: 1 });
    queue.submit(() => new Promise<never>(() => {}));
    queue.submit(() => new Promise<never>(() => {}));

    const app = createApp({ deps: transcriptionScenario(), queue });
    server = app;
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const { port } = app.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: YOAV_EPISODE_URL }).toString(),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("יותר מדי בקשות");
  });
});
