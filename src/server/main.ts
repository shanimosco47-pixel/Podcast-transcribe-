import { createApp } from "./app.js";
import { FixtureSummarizer } from "../summary/fixture-summarizer.js";
import { FixtureTranscriptionAdapter } from "../transcription/fixture-adapter.js";

/**
 * Entry point.
 *
 * Real transcription and summarization providers are not wired yet (Gate 2A
 * excludes credentials), so this boots with the deterministic adapters. The app
 * must not be exposed publicly until owner authentication exists.
 */
const port = Number(process.env.PORT ?? 10_000);

const app = createApp({
  deps: {
    fetch,
    transcription: new FixtureTranscriptionAdapter("[transcription provider not configured]"),
    summarizer: new FixtureSummarizer({
      summary: "[summary provider not configured]",
      keyPoints: [],
    }),
  },
});

app.listen(port, () => {
  console.log(`listening on ${port}`);
});
