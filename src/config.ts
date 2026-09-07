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
  /** Names of the variables that are missing. Never their values. */
  missing: {
    auth: string[];
    transcription: string[];
    summary: string[];
  };
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

  const ownerAccessToken = read(env, "OWNER_ACCESS_TOKEN");
  const sessionSecret = read(env, "SESSION_SECRET") ?? ownerAccessToken;

  return {
    config: {
      port: Number(read(env, "PORT") ?? 10_000),
      ownerAccessToken,
      sessionSecret,
      transcription: transcription.provider,
      summary: summary.provider,
    },
    missing: {
      auth: ownerAccessToken ? [] : ["OWNER_ACCESS_TOKEN"],
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
