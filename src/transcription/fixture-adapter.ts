import {
  type TranscriptionAdapter,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "./types.js";

/**
 * Deterministic stand-in for a real transcription provider.
 *
 * Exercises the same boundary the real adapter will: it receives the resolved
 * enclosure URL and an explicit language, and records what it was called with
 * so tests can assert Hebrew was configured rather than inferred.
 */
export class FixtureTranscriptionAdapter implements TranscriptionAdapter {
  readonly name = "fixture";
  readonly calls: TranscriptionRequest[] = [];

  constructor(private readonly transcript: string) {}

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    this.calls.push(request);
    if (request.language !== "he") {
      return Promise.reject(
        new Error(`Expected Hebrew transcription, got language "${request.language}"`),
      );
    }
    return Promise.resolve({ text: this.transcript, provider: this.name });
  }
}
