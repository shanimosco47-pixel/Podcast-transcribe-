import type { SummarizerAdapter, SummaryRequest, SummaryResult } from "./types.js";

/** Deterministic Hebrew summary, so the slice is provable without a model. */
export class FixtureSummarizer implements SummarizerAdapter {
  readonly name = "fixture";
  readonly calls: SummaryRequest[] = [];

  constructor(
    private readonly result: Pick<SummaryResult, "summary" | "keyPoints">,
  ) {}

  summarize(request: SummaryRequest): Promise<SummaryResult> {
    this.calls.push(request);
    return Promise.resolve({ ...this.result, provider: this.name });
  }
}
