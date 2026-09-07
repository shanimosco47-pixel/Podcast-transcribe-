import { TranscriptionNotConfiguredError, type TranscriptionAdapter } from "./types.js";

/**
 * Stands in when no provider is configured.
 *
 * Throws rather than returning placeholder text: a run that quietly produces
 * fake output is worse than one that fails, because the user cannot tell.
 */
export class NotConfiguredTranscriptionAdapter implements TranscriptionAdapter {
  readonly name = "not-configured";

  constructor(private readonly missing: readonly string[]) {}

  transcribe(): Promise<never> {
    return Promise.reject(
      new TranscriptionNotConfiguredError(this.missing.join(", ") || "TRANSCRIPTION_API_KEY"),
    );
  }
}
