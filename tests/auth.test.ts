import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, isFullyConfigured, missingNames } from "../src/config.js";
import { createApp } from "../src/server/app.js";
import { OwnerAuth, readCookie, SESSION_COOKIE } from "../src/server/auth.js";
import { transcriptionScenario, YOAV_EPISODE_URL } from "./support/scenarios.js";

const TOKEN = "correct-horse-battery-staple";
let server: Server | null = null;

async function start(options: Partial<Parameters<typeof createApp>[0]> = {}): Promise<string> {
  const app = createApp({
    deps: transcriptionScenario(),
    auth: new OwnerAuth(TOKEN, "session-secret"),
    ...options,
  });
  server = app;
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const { port } = app.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

async function login(base: string, token: string): Promise<string | null> {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    redirect: "manual",
  });
  return response.headers.get("set-cookie");
}

describe("owner-only access", () => {
  it("refuses the app to an unauthenticated visitor", async () => {
    const base = await start();
    const response = await fetch(base);

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("קוד גישה");
  });

  it("refuses a job page to an unauthenticated visitor", async () => {
    const base = await start();
    const response = await fetch(`${base}/jobs/anything`);
    expect(response.status).toBe(401);
  });

  it("refuses to start work for an unauthenticated visitor", async () => {
    const base = await start();
    const response = await fetch(`${base}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: YOAV_EPISODE_URL }).toString(),
      redirect: "manual",
    });
    expect(response.status).toBe(401);
  });

  it("rejects the wrong token without revealing anything about it", async () => {
    const base = await start();
    const response = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "wrong" }).toString(),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    const html = await response.text();
    expect(html).toContain("קוד הגישה שגוי");
    expect(html).not.toContain(TOKEN);
  });

  it("issues a hardened session cookie for the right token", async () => {
    const base = await start();
    const cookie = await login(base, TOKEN);

    expect(cookie).toBeTruthy();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // The token itself is never placed in the cookie.
    expect(cookie).not.toContain(TOKEN);
  });

  it("marks the cookie Secure only when served over HTTPS", async () => {
    const insecure = await start();
    expect(await login(insecure, TOKEN)).not.toContain("Secure");
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;

    const secure = await start({ secureCookies: true });
    expect(await login(secure, TOKEN)).toContain("Secure");
  });

  it("admits a visitor holding a valid session", async () => {
    const base = await start();
    const cookie = await login(base, TOKEN);
    const value = readCookie(cookie ?? undefined, SESSION_COOKIE) ?? "";

    const response = await fetch(base, { headers: { cookie: `${SESSION_COOKIE}=${value}` } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("תמלול פודקאסטים");
  });

  it("refuses a tampered session", async () => {
    const base = await start();
    const cookie = await login(base, TOKEN);
    const value = readCookie(cookie ?? undefined, SESSION_COOKIE) ?? "";
    const [id, expiry] = value.split(".");

    const forged = `${id}.${expiry}.${"0".repeat(64)}`;
    const response = await fetch(base, { headers: { cookie: `${SESSION_COOKIE}=${forged}` } });
    expect(response.status).toBe(401);
  });

  it("refuses a session whose expiry was extended", async () => {
    const auth = new OwnerAuth(TOKEN, "session-secret");
    const value = auth.issueSession();
    const [id, expiry, signature] = value.split(".") as [string, string, string];

    // Same signature, later expiry: the signature covers the expiry, so this fails.
    const extended = `${id}.${Number(expiry) + 10_000_000}.${signature}`;
    expect(auth.verifySession(extended)).toBe(false);
  });

  it("refuses an expired session", () => {
    const auth = new OwnerAuth(TOKEN, "session-secret");
    const value = auth.issueSession(Date.now() - 40 * 24 * 60 * 60 * 1000);
    expect(auth.verifySession(value)).toBe(false);
  });

  it("refuses a session signed with a different secret", () => {
    const issuer = new OwnerAuth(TOKEN, "secret-one");
    const verifier = new OwnerAuth(TOKEN, "secret-two");
    expect(verifier.verifySession(issuer.issueSession())).toBe(false);
  });

  it("logs out by clearing the cookie", async () => {
    const base = await start();
    const cookie = await login(base, TOKEN);
    const value = readCookie(cookie ?? undefined, SESSION_COOKIE) ?? "";

    const response = await fetch(`${base}/logout`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${value}` },
      redirect: "manual",
    });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("missing configuration state", () => {
  it("replaces the whole app with the setup screen and names the variables", async () => {
    const base = await start({
      auth: null,
      missingConfig: ["OWNER_ACCESS_TOKEN", "TRANSCRIPTION_API_KEY"],
    });

    const response = await fetch(base);
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("האפליקציה אינה מוגדרת");
    expect(html).toContain("TRANSCRIPTION_API_KEY");
    // The entry form must not be reachable in this state.
    expect(html).not.toContain('name="url"');
  });

  it("keeps the setup screen in front of every route", async () => {
    const base = await start({ auth: null, missingConfig: ["TRANSCRIPTION_API_KEY"] });
    for (const path of ["/", "/login", "/jobs/x", "/transcribe"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(503);
    }
  });
});

describe("loadConfig", () => {
  it("reports every missing variable by name", () => {
    const report = loadConfig({} as NodeJS.ProcessEnv);
    expect(isFullyConfigured(report)).toBe(false);
    expect(missingNames(report)).toContain("OWNER_ACCESS_TOKEN");
    expect(missingNames(report)).toContain("TRANSCRIPTION_API_KEY");
    expect(missingNames(report)).toContain("SUMMARY_API_KEY");
  });

  it("is fully configured once the keys are present", () => {
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: "t",
      TRANSCRIPTION_API_KEY: "a",
      SUMMARY_API_KEY: "b",
    } as NodeJS.ProcessEnv);

    expect(isFullyConfigured(report)).toBe(true);
    expect(report.config.transcription?.model).toBe("whisper-1");
    expect(report.config.summary?.model).toBe("gpt-4o-mini");
  });

  it("allows a private provider base URL, since a self-hosted model is legitimate", () => {
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: "t",
      TRANSCRIPTION_API_KEY: "a",
      TRANSCRIPTION_BASE_URL: "http://127.0.0.1:9000/v1",
      SUMMARY_API_KEY: "b",
    } as NodeJS.ProcessEnv);

    expect(report.missing.transcription).toEqual([]);
    expect(report.config.transcription?.baseUrl).toBe("http://127.0.0.1:9000/v1");
  });

  it("rejects a provider URL with embedded credentials or a bad scheme", () => {
    const bad = loadConfig({
      TRANSCRIPTION_API_KEY: "a",
      TRANSCRIPTION_BASE_URL: "https://user:pass@example.com/v1",
    } as NodeJS.ProcessEnv);
    expect(bad.missing.transcription).toContain("TRANSCRIPTION_BASE_URL");

    const worse = loadConfig({
      TRANSCRIPTION_API_KEY: "a",
      TRANSCRIPTION_BASE_URL: "file:///etc/passwd",
    } as NodeJS.ProcessEnv);
    expect(worse.missing.transcription).toContain("TRANSCRIPTION_BASE_URL");
  });

  it("never exposes a secret value through the report", () => {
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: "super-secret-token",
      TRANSCRIPTION_API_KEY: "sk-not-a-real-key",
    } as NodeJS.ProcessEnv);

    const asText = JSON.stringify(report.missing);
    expect(asText).not.toContain("super-secret-token");
    expect(asText).not.toContain("sk-not-a-real-key");
  });
});
