/** Language passed to the transcription provider. Hebrew is the product default. */
export const TRANSCRIPTION_LANGUAGE = "he" as const;

export interface TranscriptionRequest {
  /** Audio enclosure URL, already checked by the outbound URL guard. */
  audioUrl: string;
  /** BCP-47 language explicitly given to the provider, never left to detection. */
  language: string;
  durationSecondsHint: number | null;
}

export interface TranscriptionResult {
  text: string;
  /** Provider identifier, for the evidence trail. Never a credential. */
  provider: string;
}

export interface TranscriptionAdapter {
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** Thrown when no provider credential is configured at runtime. */
export class TranscriptionNotConfiguredError extends Error {
  constructor(missingEnvVar: string) {
    super(`Transcription provider is not configured (missing ${missingEnvVar})`);
    this.name = "TranscriptionNotConfiguredError";
  }
}
