export interface SummaryRequest {
  transcript: string;
  episodeTitle: string;
  language: string;
}

export interface SummaryResult {
  /** Short Hebrew prose summary. */
  summary: string;
  /** Hebrew bullet points, ordered as they appear in the episode. */
  keyPoints: string[];
  provider: string;
}

export interface SummarizerAdapter {
  readonly name: string;
  summarize(request: SummaryRequest): Promise<SummaryResult>;
}
