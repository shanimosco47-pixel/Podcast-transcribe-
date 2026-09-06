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
 * Transcripts live here only for the life of the process; nothing is written to
 * disk, which keeps the default of not storing transcripts permanently.
 */
export interface JobStore {
  create(): Job;
  get(id: string): Job | undefined;
  update(id: string, patch: Partial<Omit<Job, "id">>): Job | undefined;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly makeId: () => string = () => crypto.randomUUID()) {}

  create(): Job {
    const job: Job = {
      id: this.makeId(),
      progress: { phase: "queued", done: 0, total: 0 },
      outcome: null,
      pending: null,
      queuePosition: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  update(id: string, patch: Partial<Omit<Job, "id">>): Job | undefined {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;
    const updated: Job = { ...existing, ...patch };
    this.jobs.set(id, updated);
    return updated;
  }
}
