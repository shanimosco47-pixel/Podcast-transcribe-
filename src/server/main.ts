import { isFullyConfigured, loadConfig, missingNames } from "../config.js";
import { defaultFetch } from "../http/safe-fetch.js";
import { LlmSummarizer } from "../summary/llm-summarizer.js";
import { NotConfiguredSummarizer } from "../summary/not-configured.js";
import { NotConfiguredTranscriptionAdapter } from "../transcription/not-configured.js";
import { OpenAiTranscriptionAdapter } from "../transcription/openai-adapter.js";
import { createApp } from "./app.js";
import { OwnerAuth } from "./auth.js";

const report = loadConfig();
const { config } = report;
const missing = missingNames(report);

const app = createApp({
  deps: {
    // Not the global fetch: address pinning requires undici's own. See defaultFetch.
    fetch: defaultFetch,
    transcription: config.transcription
      ? new OpenAiTranscriptionAdapter(config.transcription)
      : new NotConfiguredTranscriptionAdapter(report.missing.transcription),
    summarizer: config.summary
      ? new LlmSummarizer(config.summary)
      : new NotConfiguredSummarizer(report.missing.summary),
  },
  auth:
    config.ownerAccessToken && config.sessionSecret
      ? new OwnerAuth(config.ownerAccessToken, config.sessionSecret)
      : null,
  missingConfig: missing,
  // Render and similar platforms terminate TLS in front of the app.
  secureCookies: process.env.TRUST_PROXY_TLS === "1",
});

app.listen(config.port, () => {
  // Names only: no values are ever printed.
  if (isFullyConfigured(report)) {
    console.log(`listening on ${config.port}`);
  } else {
    console.log(
      `listening on ${config.port} — not configured, missing: ${missing.join(", ")}`,
    );
  }
});
