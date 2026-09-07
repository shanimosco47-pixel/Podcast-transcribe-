import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, isFullyConfigured, missingNames } from "../src/config.js";
import { createApp } from "../src/server/app.js";
import { LoginLimiter, OwnerAuth, readCookie, SESSION_COOKIE } from "../src/server/auth.js";
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
      // A realistic token: the weak-token check now rejects short ones.
      OWNER_ACCESS_TOKEN: "Xk7-pQ2rL9vT4mB8nZ1cW6yH",
      TRANSCRIPTION_API_KEY: "a",
      SUMMARY_API_KEY: "b",
    } as NodeJS.ProcessEnv);

    expect(isFullyConfigured(report)).toBe(true);
    expect(report.config.transcription?.model).toBe("whisper-1");
    expect(report.config.summary?.model).toBe("gpt-4o-mini");
  });

  it("allows a private provider base URL, since a self-hosted model is legitimate", () => {
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: "Xk7-pQ2rL9vT4mB8nZ1cW6yH",
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

describe("health endpoint", () => {
  it("answers without authentication and reveals nothing", async () => {
    const base = await start();
    const response = await fetch(`${base}/healthz`);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "ok" });
    // No configuration state, no version, no variable names, no token.
    expect(body).not.toMatch(/TRANSCRIPTION|OWNER|SUMMARY|version|configured/i);
    expect(body.length).toBeLessThan(60);
  });

  it("answers even when the app is unconfigured, so a platform can probe it", async () => {
    const base = await start({ auth: null, missingConfig: ["OWNER_ACCESS_TOKEN"] });

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    // ...while the app itself still refuses.
    expect((await fetch(base)).status).toBe(503);
  });

  it("does not disclose readiness, which would leak configuration state", async () => {
    const configured = await fetch(`${await start()}/healthz`);
    const configuredBody = await configured.text();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;

    const unconfigured = await fetch(
      `${await start({ auth: null, missingConfig: ["TRANSCRIPTION_API_KEY"] })}/healthz`,
    );
    // Identical responses: an unauthenticated caller cannot tell them apart.
    expect(await unconfigured.text()).toBe(configuredBody);
  });
});

describe("weak owner tokens are refused at configuration time", () => {
  it.each([
    ["short", "abc123"],
    ["a known placeholder", "changeme"],
    ["another placeholder", "your-token-here"],
    ["low variety", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ])("rejects %s", (_label, token) => {
    const report = loadConfig({ OWNER_ACCESS_TOKEN: token } as NodeJS.ProcessEnv);
    expect(report.config.ownerAccessToken).toBeNull();
    expect(report.missing.auth).toContain("OWNER_ACCESS_TOKEN");
    expect(report.tokenProblem).not.toBeNull();
  });

  it("accepts a token that looks like it came from a password manager", () => {
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: "Xk7-pQ2rL9vT4mB8nZ1cW6yH",
    } as NodeJS.ProcessEnv);
    expect(report.tokenProblem).toBeNull();
    expect(report.missing.auth).toEqual([]);
  });

  it("never echoes the rejected token", () => {
    const token = "changeme";
    const report = loadConfig({ OWNER_ACCESS_TOKEN: token } as NodeJS.ProcessEnv);
    expect(JSON.stringify(report.missing) + String(report.tokenProblem)).not.toContain(token);
  });

  it("refuses to serve rather than running with a weak token", async () => {
    const report = loadConfig({ OWNER_ACCESS_TOKEN: "changeme" } as NodeJS.ProcessEnv);
    const base = await start({ auth: null, missingConfig: missingNames(report) });

    const response = await fetch(base);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("OWNER_ACCESS_TOKEN");
  });
});

describe("bounded login attempts", () => {
  it("locks out after repeated failures and recovers after the window", async () => {
    const limiter = new LoginLimiter(3, 60_000);
    const base = await start({ loginLimiter: limiter });

    const attempt = (token: string): Promise<Response> =>
      fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        redirect: "manual",
      });

    expect((await attempt("wrong-1")).status).toBe(401);
    expect((await attempt("wrong-2")).status).toBe(401);
    expect((await attempt("wrong-3")).status).toBe(401);

    // Locked, and the correct token is refused too while the window holds.
    const locked = await attempt(TOKEN);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("set-cookie")).toBeNull();
    expect(await locked.text()).toContain("יותר מדי ניסיונות");

    // The lockout message must not reveal whether the token was right.
    const lockedWrong = await attempt("wrong-4");
    expect(await lockedWrong.text()).toBe(await (await attempt(TOKEN)).text());
  });

  it("frees up once the window passes", () => {
    const limiter = new LoginLimiter(2, 1_000);
    const start = Date.now();
    limiter.recordFailure(start);
    limiter.recordFailure(start);
    expect(limiter.isLocked(start)).toBe(true);

    // After the window, attempts are allowed again.
    expect(limiter.isLocked(start + 1_500)).toBe(false);
  });

  it("clears the record on a successful login", () => {
    const limiter = new LoginLimiter(2, 60_000);
    limiter.recordFailure();
    limiter.recordSuccess();
    limiter.recordFailure();
    expect(limiter.isLocked()).toBe(false);
  });

  it("still admits the owner after a few failures inside the limit", async () => {
    const limiter = new LoginLimiter(5, 60_000);
    const base = await start({ loginLimiter: limiter });

    for (const wrong of ["a", "b"]) {
      await fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: wrong }).toString(),
        redirect: "manual",
      });
    }

    const response = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN }).toString(),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
});

describe("session secret strength", () => {
  const STRONG_TOKEN = "Xk7-pQ2rL9vT4mB8nZ1cW6yH";

  it.each([
    ["a one-character secret", "x"],
    ["a short secret", "abc123"],
    ["a known placeholder", "changeme"],
    ["low variety", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ])("rejects %s even when the owner token is strong", (_label, secret) => {
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: STRONG_TOKEN,
      SESSION_SECRET: secret,
      TRANSCRIPTION_API_KEY: "a",
      SUMMARY_API_KEY: "b",
    } as NodeJS.ProcessEnv);

    // A forgeable cookie signature would bypass the token check entirely.
    expect(report.secretProblem).not.toBeNull();
    expect(report.config.sessionSecret).toBeNull();
    expect(isFullyConfigured(report)).toBe(false);

    // Only the variable that actually needs changing is named.
    expect(report.missing.auth).toEqual(["SESSION_SECRET"]);
  });

  it("accepts a strong explicit secret", () => {
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: STRONG_TOKEN,
      SESSION_SECRET: "hK4$wR8-mV2pL6zQ9xB3nT7c",
      TRANSCRIPTION_API_KEY: "a",
      SUMMARY_API_KEY: "b",
    } as NodeJS.ProcessEnv);

    expect(report.secretProblem).toBeNull();
    expect(report.config.sessionSecret).toBe("hK4$wR8-mV2pL6zQ9xB3nT7c");
    expect(isFullyConfigured(report)).toBe(true);
  });

  it("falls back to the already-validated owner token when the variable is absent", () => {
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: STRONG_TOKEN,
      TRANSCRIPTION_API_KEY: "a",
      SUMMARY_API_KEY: "b",
    } as NodeJS.ProcessEnv);

    expect(report.secretProblem).toBeNull();
    expect(report.config.sessionSecret).toBe(STRONG_TOKEN);
    expect(report.missing.auth).toEqual([]);
  });

  it("never echoes a rejected secret", () => {
    const secret = "changeme";
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: STRONG_TOKEN,
      SESSION_SECRET: secret,
    } as NodeJS.ProcessEnv);

    expect(JSON.stringify(report) ).not.toContain(secret);
  });

  it("refuses to serve when only the secret is weak", async () => {
    const report = loadConfig({
      OWNER_ACCESS_TOKEN: STRONG_TOKEN,
      SESSION_SECRET: "x",
      TRANSCRIPTION_API_KEY: "a",
      SUMMARY_API_KEY: "b",
    } as NodeJS.ProcessEnv);

    const base = await start({ auth: null, missingConfig: missingNames(report) });
    const response = await fetch(base);

    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("SESSION_SECRET");
    expect(html).not.toContain("OWNER_ACCESS_TOKEN");
  });
});
