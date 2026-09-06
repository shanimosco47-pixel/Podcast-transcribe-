import type { AddressInfo } from "node:net";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
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
      await page.fill("#url", YOAV_EPISODE_URL);
      await page.click("button[type=submit]");
      await page.waitForSelector("#transcript-text");

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
      await page.fill("#url", YOAV_EPISODE_URL);
      await page.click("button[type=submit]");
      await page.waitForSelector("input[type=radio]");

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
      await page.fill("#url", "https://example.com/not-spotify");
      await page.click("button[type=submit]");
      await page.waitForSelector(".notice.error");

      expect(await page.textContent(".notice.error")).toContain("ספוטיפיי");
      // The technical reason stays behind a closed disclosure.
      expect(await page.locator("details[open]").count()).toBe(0);

      await assertNoHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/360-error.png`, fullPage: true });
    });
  }, 60_000);
});
