import { describe, expect, it } from "vitest";

import { InMemoryJobStore } from "../src/jobs/store.js";
import type { PipelineOutcome } from "../src/pipeline.js";

const DONE: PipelineOutcome = { status: "failed", reason: "no_match", detail: "finished" };

function storeAt(clock: { now: number }, maxJobs = 3, ttlMs = 1_000): InMemoryJobStore {
  let counter = 0;
  return new InMemoryJobStore(
    () => `job-${counter++}`,
    maxJobs,
    ttlMs,
    () => clock.now,
  );
}

describe("job retention", () => {
  it("drops finished jobs once they pass the retention window", () => {
    const clock = { now: 1_000 };
    const store = storeAt(clock);

    const job = store.create();
    store.update(job.id, { outcome: DONE });
    expect(store.get(job.id)).toBeDefined();

    clock.now += 5_000;
    expect(store.get(job.id)).toBeUndefined();
  });

  it("keeps a running job regardless of age, so work in progress is not stranded", () => {
    const clock = { now: 1_000 };
    const store = storeAt(clock);

    const running = store.create(); // outcome stays null while it runs
    clock.now += 60_000;

    expect(store.get(running.id)).toBeDefined();
  });

  it("evicts the oldest finished jobs when over the cap", () => {
    const clock = { now: 1_000 };
    const store = storeAt(clock, 3, 10 * 60_000);

    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const job = store.create();
      store.update(job.id, { outcome: DONE });
      ids.push(job.id);
      clock.now += 10;
    }

    expect(store.size).toBeLessThanOrEqual(3);
    // The newest survive; the oldest are gone.
    expect(store.get(ids[5] ?? "")).toBeDefined();
    expect(store.get(ids[0] ?? "")).toBeUndefined();
  });

  it("does not evict a running job to satisfy the cap", () => {
    const clock = { now: 1_000 };
    const store = storeAt(clock, 2, 10 * 60_000);

    const running = store.create();
    clock.now += 10;
    for (let i = 0; i < 5; i += 1) {
      const job = store.create();
      store.update(job.id, { outcome: DONE });
      clock.now += 10;
    }

    expect(store.get(running.id)).toBeDefined();
  });

  it("holds no filesystem reference, so a job cannot outlive the process", () => {
    const clock = { now: 1_000 };
    const store = storeAt(clock);
    const job = store.create();
    store.update(job.id, {
      outcome: {
        status: "done",
        evidence: {
          showTitle: "ש",
          episodeTitle: "פ",
          publishedAt: null,
          durationSeconds: null,
          feedUrl: "https://feeds.example.com/f.xml",
          enclosureUrl: "https://cdn.example.com/a.mp3",
          transcriptUrl: null,
          confidence: 1,
          coverage: 1,
          signals: [],
        },
        transcript: { text: "תמלול", source: "transcription", provider: "test" },
        summary: { summary: "ס", keyPoints: [], provider: "test" },
      },
    });

    // No local filesystem reference is retained: no temp directory, no chunk
    // path. The remote enclosure URL is evidence of the match and is expected.
    const serialized = JSON.stringify(store.get(job.id));
    expect(serialized).not.toMatch(/\/tmp\/|podcast-[a-z0-9]{6}|chunk-\d+\.mp3|source-audio/);
    expect(serialized).toContain("תמלול");
  });
});
