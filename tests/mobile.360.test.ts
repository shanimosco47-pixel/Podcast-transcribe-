import type { AddressInfo } from "node:net";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { OwnerAuth } from "../src/server/auth.js";
import { ambiguousScenario, transcriptionScenario, YOAV_EPISODE_URL } from "./support/scenarios.js";

/** The narrow Android viewport the product targets. */
const VIEWPORT = { width: 360, height: 800 };
const SHOTS = "docs/screenshots";

let browser: Browser;

beforeAll(async () => {
  // CHROMIUM_EXECUTABLE_PATH lets a sandbox with a preinstalled browser run
  // these without downloading one. CI leaves it unset and uses Playwright's own.
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch(executablePath ? { executablePath } : {});
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function withPage<T>(
  deps: Parameters<typeof createApp>[0]["deps"],
  run: (page: Page, base: string) => Promise<T>,
): Promise<T> {
  const app = createApp({ deps });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const { port } = app.address() as AddressInfo;
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: "he-IL",
  });
  const page = await context.newPage();
  try {
    return await run(page, `http://127.0.0.1:${port}`);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
}

/** Submitting is asynchronous now: the working page appears first. */
async function submitAndWait(page: Page, url: string, settled: string): Promise<void> {
  await page.fill("#url", url);
  await page.click("button[type=submit]");
  await page.waitForSelector(settled, { timeout: 30_000 });
}

/** Nothing may overflow the viewport horizontally on a 360 px phone. */
async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

describe("Hebrew RTL mobile UI at 360 px", () => {
  it("renders the entry form right-to-left with no horizontal scroll", async () => {
    await withPage(transcriptionScenario(), async (page, base) => {
      await page.goto(base);

      expect(await page.getAttribute("html", "dir")).toBe("rtl");
      expect(await page.getAttribute("html", "lang")).toBe("he");
      const direction = await page.evaluate(() => getComputedStyle(document.body).direction);
      expect(direction).toBe("rtl");

      await assertNoHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/360-home.png`, fullPage: true });
    });
  }, 60_000);

  it("shows the identified episode, summary and transcript on one narrow screen", async () => {
    await withPage(transcriptionScenario(), async (page, base) => {
      await page.goto(base);
      await submitAndWait(page, YOAV_EPISODE_URL, "#transcript-text");

      await expect(page.getByText("ריאיון עם יואב על שבבים")).toBeTruthy();
      expect(await page.textContent("#transcript-text")).toContain("שבבים");

      // Tap targets must stay comfortable on a phone.
      const submitBox = await page.locator("#copy").boundingBox();
      expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      await assertNoHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/360-success.png`, fullPage: true });
    });
  }, 60_000);

  it("presents the ambiguity choice without preselecting a transcript", async () => {
    await withPage(ambiguousScenario(), async (page, base) => {
      await page.goto(base);
      await submitAndWait(page, YOAV_EPISODE_URL, "input[type=radio]");

      expect(await page.locator("input[type=radio]").count()).toBeGreaterThan(1);
      expect(await page.locator("#transcript-text").count()).toBe(0);

      await assertNoHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/360-ambiguous.png`, fullPage: true });
    });
  }, 60_000);

  it("explains a failure in Hebrew without leaking technical detail into the main flow", async () => {
    await withPage(transcriptionScenario(), async (page, base) => {
      await page.goto(base);
      await page.evaluate(() => document.querySelector("form")?.setAttribute("novalidate", "true"));
      await submitAndWait(page, "https://example.com/not-spotify", ".notice.error");

      expect(await page.textContent(".notice.error")).toContain("ספוטיפיי");
      // The technical reason stays behind a closed disclosure.
      expect(await page.locator("details[open]").count()).toBe(0);

      await assertNoHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/360-error.png`, fullPage: true });
    });
  }, 60_000);
});

describe("progress state at 360 px", () => {
  it("shows a Hebrew working page while the job runs, then the result", async () => {
    // A job that stays running long enough for the working page to be captured.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const scenario = transcriptionScenario();
    const slow = {
      ...scenario,
      summarizer: {
        name: "slow",
        calls: [],
        async summarize(request: { transcript: string; episodeTitle: string; language: string }) {
          await held;
          return scenario.summarizer.summarize(request);
        },
      },
    };

    await withPage(slow as unknown as Parameters<typeof createApp>[0]["deps"], async (page, base) => {
      await page.goto(base);
      await page.fill("#url", YOAV_EPISODE_URL);
      await page.click("button[type=submit]");

      await page.waitForSelector(".bar", { timeout: 15_000 });
      expect(await page.textContent("body")).toContain("עובדים על זה");
      await assertNoHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/360-progress.png`, fullPage: true });

      release();
      await page.waitForSelector("#transcript-text", { timeout: 30_000 });
    });
  }, 90_000);
});

describe("result actions at 360 px", () => {
  it("copies the transcript to the clipboard when the button is tapped", async () => {
    const app = createApp({ deps: transcriptionScenario() });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const { port } = app.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const context = await browser.newContext({
      viewport: VIEWPORT,
      locale: "he-IL",
      permissions: ["clipboard-read", "clipboard-write"],
      origin: base,
    } as Parameters<typeof browser.newContext>[0]);
    const page = await context.newPage();

    try {
      await page.goto(base);
      await submitAndWait(page, YOAV_EPISODE_URL, "#transcript-text");

      const shown = (await page.textContent("#transcript-text")) ?? "";
      expect(shown.length).toBeGreaterThan(0);

      await page.click("#copy");
      // The button confirms in Hebrew only after the write resolves.
      await page.waitForFunction(
        () => document.querySelector("#copy")?.textContent?.trim() === "הועתק",
        undefined,
        { timeout: 10_000 },
      );

      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toBe(shown);
    } finally {
      await context.close();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }
  }, 60_000);

  it("downloads the transcript as a text file", async () => {
    await withPage(transcriptionScenario(), async (page, base) => {
      await page.goto(base);
      await submitAndWait(page, YOAV_EPISODE_URL, "#transcript-text");

      const shown = (await page.textContent("#transcript-text")) ?? "";
      const href = await page.getAttribute("a[download]", "href");
      expect(href).toMatch(/^\/jobs\/.+\/transcript\.txt$/);

      // Fetch it the way the browser would, and check what actually arrives.
      const response = await page.request.get(`${base}${href ?? ""}`);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-disposition"]).toContain("attachment");
      expect(response.headers()["content-type"]).toContain("charset=utf-8");
      expect(await response.text()).toBe(shown);
    });
  }, 60_000);
});

describe("gate screens at 360 px", () => {
  it("renders the login screen right-to-left", async () => {
    const app = createApp({
      deps: transcriptionScenario(),
      auth: new OwnerAuth("token-for-screenshot", "secret"),
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const { port } = app.address() as AddressInfo;

    const context = await browser.newContext({ viewport: VIEWPORT, locale: "he-IL" });
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/login`);
      expect(await page.getAttribute("html", "dir")).toBe("rtl");
      await assertNoHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/360-login.png`, fullPage: true });
    } finally {
      await context.close();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }
  }, 60_000);

  it("renders the missing-configuration screen with names only", async () => {
    const app = createApp({
      deps: transcriptionScenario(),
      auth: null,
      missingConfig: ["OWNER_ACCESS_TOKEN", "TRANSCRIPTION_API_KEY", "SUMMARY_API_KEY"],
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const { port } = app.address() as AddressInfo;

    const context = await browser.newContext({ viewport: VIEWPORT, locale: "he-IL" });
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      expect(await page.textContent("body")).toContain("TRANSCRIPTION_API_KEY");
      await assertNoHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/360-setup.png`, fullPage: true });
    } finally {
      await context.close();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }
  }, 60_000);
});
