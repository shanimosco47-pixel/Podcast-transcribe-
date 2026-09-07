export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AppConfig {
  port: number;
  ownerAccessToken: string | null;
  sessionSecret: string | null;
  transcription: ProviderConfig | null;
  summary: ProviderConfig | null;
}

export interface ConfigReport {
  config: AppConfig;
  /** Why the owner token was rejected, when it was. Never contains the token. */
  tokenProblem: TokenProblem | null;
  /** Why an explicitly supplied session secret was rejected. Never contains it. */
  secretProblem: TokenProblem | null;
  /** Names of the variables that are missing. Never their values. */
  missing: {
    auth: string[];
    transcription: string[];
    summary: string[];
  };
}

/** Minimum owner token length. Short tokens are guessable once the app is reachable. */
export const MIN_OWNER_TOKEN_LENGTH = 24;

/**
 * Tokens that must never protect a deployment.
 *
 * These are the values people actually leave in place: placeholders copied
 * from documentation and the usual defaults. Rejecting them at configuration
 * time means a guessable deployment refuses to start rather than starting and
 * looking fine.
 */
const FORBIDDEN_TOKENS = new Set([
  "changeme",
  "change-me",
  "password",
  "secret",
  "token",
  "admin",
  "owner",
  "test",
  "example",
  "your-token-here",
  "owner_access_token",
]);

export type TokenProblem = "missing" | "too_short" | "forbidden" | "low_variety";

/**
 * Judge a secret's strength without ever echoing it.
 *
 * Length and character variety are crude proxies for entropy, but they reject
 * the values that actually get used ("aaaaaaaa...", "password123") while
 * accepting anything from a password manager or `openssl rand`.
 */
export function checkSecretStrength(value: string): TokenProblem | null {
  if (FORBIDDEN_TOKENS.has(value.toLowerCase())) return "forbidden";
  if (value.length < MIN_OWNER_TOKEN_LENGTH) return "too_short";
  if (new Set(value).size < 8) return "low_variety";
  return null;
}

export function checkOwnerToken(token: string | null): TokenProblem | null {
  if (!token) return "missing";
  return checkSecretStrength(token);
}

const DEFAULT_TRANSCRIPTION_BASE = "https://api.openai.com/v1";
const DEFAULT_SUMMARY_BASE = "https://api.openai.com/v1";

function read(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/**
 * A provider base URL comes from the operator's own environment, not from a
 * podcast feed, so the SSRF rule that governs `safeFetch` does not apply: a
 * self-hosted model on a private address is a legitimate configuration.
 * Scheme and embedded credentials are still checked, since neither has a
 * legitimate use here.
 */
function validProviderUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

function readProvider(
  env: NodeJS.ProcessEnv,
  keyVar: string,
  baseVar: string,
  modelVar: string,
  defaultBase: string,
  defaultModel: string,
): { provider: ProviderConfig | null; missing: string[] } {
  const apiKey = read(env, keyVar);
  const baseUrl = read(env, baseVar) ?? defaultBase;
  const model = read(env, modelVar) ?? defaultModel;

  const missing: string[] = [];
  if (!apiKey) missing.push(keyVar);
  if (!validProviderUrl(baseUrl)) missing.push(baseVar);

  if (missing.length > 0 || !apiKey) return { provider: null, missing };
  return { provider: { apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), model }, missing: [] };
}

/**
 * Read configuration from the environment.
 *
 * Always returns a config: a missing provider is a reported state, not a crash,
 * so the app boots and explains itself instead of failing at startup.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const transcription = readProvider(
    env,
    "TRANSCRIPTION_API_KEY",
    "TRANSCRIPTION_BASE_URL",
    "TRANSCRIPTION_MODEL",
    DEFAULT_TRANSCRIPTION_BASE,
    "whisper-1",
  );
  const summary = readProvider(
    env,
    "SUMMARY_API_KEY",
    "SUMMARY_BASE_URL",
    "SUMMARY_MODEL",
    DEFAULT_SUMMARY_BASE,
    "gpt-4o-mini",
  );

  const rawToken = read(env, "OWNER_ACCESS_TOKEN");
  const tokenProblem = checkOwnerToken(rawToken);
  // A token that fails the check is treated as absent, so the app refuses to
  // serve rather than running with protection that would not hold.
  const ownerAccessToken = tokenProblem === null ? rawToken : null;

  // The session secret signs the cookie that stands in for the token after
  // login, so a weak secret makes signatures forgeable and defeats the token
  // check entirely. An explicitly supplied secret is held to the same standard.
  // When absent it falls back to the owner token, which was already validated.
  const rawSecret = read(env, "SESSION_SECRET");
  const secretProblem = rawSecret === null ? null : checkSecretStrength(rawSecret);
  const sessionSecret =
    secretProblem === null ? (rawSecret ?? ownerAccessToken) : null;

  return {
    config: {
      port: Number(read(env, "PORT") ?? 10_000),
      ownerAccessToken,
      sessionSecret,
      transcription: transcription.provider,
      summary: summary.provider,
    },
    tokenProblem,
    secretProblem,
    missing: {
      auth: [
        ...(ownerAccessToken ? [] : ["OWNER_ACCESS_TOKEN"]),
        // Named on its own, so a strong token with a weak secret points at the
        // variable that actually needs changing.
        ...(secretProblem === null ? [] : ["SESSION_SECRET"]),
      ],
      transcription: transcription.missing,
      summary: summary.missing,
    },
  };
}

/** True when nothing is missing and the app can do real work. */
export function isFullyConfigured(report: ConfigReport): boolean {
  return (
    report.missing.auth.length === 0 &&
    report.missing.transcription.length === 0 &&
    report.missing.summary.length === 0
  );
}

/** Every missing variable name, for the Hebrew configuration screen. */
export function missingNames(report: ConfigReport): string[] {
  return [...report.missing.auth, ...report.missing.transcription, ...report.missing.summary];
}
