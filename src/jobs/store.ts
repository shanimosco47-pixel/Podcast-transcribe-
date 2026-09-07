import type { FeedEpisode } from "../matching/feed.js";
import type { PipelineOutcome } from "../pipeline.js";

export type JobPhase =
  | "queued"
  | "resolving"
  | "downloading"
  | "transcribing"
  | "summarizing"
  | "awaiting_choice"
  | "done"
  | "failed";

export interface JobProgress {
  phase: JobPhase;
  /** Completed units of the current phase, and how many there are. */
  done: number;
  total: number;
}

export interface Job {
  id: string;
  progress: JobProgress;
  /** Present once the run finishes, either way. */
  outcome: PipelineOutcome | null;
  /** Candidates kept only while a job waits for the user to disambiguate. */
  pending: { feedUrl: string; episodes: FeedEpisode[] } | null;
  /** Position in the queue while waiting, otherwise null. */
  queuePosition: number | null;
}

/**
 * Job storage behind an interface so the in-memory implementation can be
 * swapped for a durable one without touching callers.
 *
 * Storage is in memory by choice, not by omission. Issue #1 asks for a
 * lightweight store with a replaceable interface and for transcripts not to be
 * kept permanently; holding them for the life of the process satisfies both and
 * needs no paid disk. The consequence is stated rather than hidden: **a restart
 * loses every job and transcript**, so a run in progress must be started again
 * and a finished transcript must be downloaded before the service restarts.
 * Swapping in a durable store means implementing this interface alone.
 */
export interface JobStore {
  create(): Job;
  get(id: string): Job | undefined;
  update(id: string, patch: Partial<Omit<Job, "id">>): Job | undefined;
}

/** Keeps memory bounded without evicting anything a user is still looking at. */
export const DEFAULT_MAX_JOBS = 50;
export const DEFAULT_JOB_TTL_MS = 6 * 60 * 60 * 1000;

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly makeId: () => string = () => crypto.randomUUID(),
    private readonly maxJobs = DEFAULT_MAX_JOBS,
    private readonly ttlMs = DEFAULT_JOB_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  create(): Job {
    const job: Job = {
      id: this.makeId(),
      progress: { phase: "queued", done: 0, total: 0 },
      outcome: null,
      pending: null,
      queuePosition: null,
    };
    this.jobs.set(job.id, job);
    this.touched.set(job.id, this.now());
    this.evict();
    return job;
  }

  get(id: string): Job | undefined {
    this.evict();
    return this.jobs.get(id);
  }

  update(id: string, patch: Partial<Omit<Job, "id">>): Job | undefined {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;
    const updated: Job = { ...existing, ...patch };
    this.jobs.set(id, updated);
    this.touched.set(id, this.now());
    return updated;
  }

  /** Visible for tests and for the operational notes. */
  get size(): number {
    return this.jobs.size;
  }

  /**
   * Drop jobs past the retention window, then the oldest if still over the cap.
   *
   * A running job is never evicted by age: losing the record of work in
   * progress would strand the user on a page that suddenly 404s.
   */
  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, at] of this.touched) {
      if (at > cutoff) continue;
      if (this.jobs.get(id)?.outcome === null) continue;
      this.jobs.delete(id);
      this.touched.delete(id);
    }

    if (this.jobs.size <= this.maxJobs) return;
    const byAge = [...this.touched.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of byAge) {
      if (this.jobs.size <= this.maxJobs) break;
      if (this.jobs.get(id)?.outcome === null) continue;
      this.jobs.delete(id);
      this.touched.delete(id);
    }
  }
}
