import { TranscriptionNotConfiguredError } from "../transcription/types.js";
import type { SummarizerAdapter } from "./types.js";

/** Same contract as the transcription placeholder: fail loudly, never fabricate. */
export class NotConfiguredSummarizer implements SummarizerAdapter {
  readonly name = "not-configured";

  constructor(private readonly missing: readonly string[]) {}

  summarize(): Promise<never> {
    return Promise.reject(
      new TranscriptionNotConfiguredError(this.missing.join(", ") || "SUMMARY_API_KEY"),
    );
  }
}
