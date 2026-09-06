import type { FeedEpisode } from "../matching/feed.js";
import type { PipelineOutcome } from "../pipeline.js";

export interface Job {
  id: string;
  outcome: PipelineOutcome;
  /** Candidates kept only while a job waits for the user to disambiguate. */
  pending: { feedUrl: string; episodes: FeedEpisode[] } | null;
}

/**
 * Job storage behind an interface so the in-memory implementation can be
 * swapped for a durable one without touching callers.
 *
 * Transcripts live here only for the life of the process; nothing is written to
 * disk, which keeps the default of not storing transcripts permanently.
 */
export interface JobStore {
  create(job: Omit<Job, "id">): Job;
  get(id: string): Job | undefined;
  replace(id: string, job: Omit<Job, "id">): Job | undefined;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly makeId: () => string = () => crypto.randomUUID()) {}

  create(job: Omit<Job, "id">): Job {
    const created: Job = { ...job, id: this.makeId() };
    this.jobs.set(created.id, created);
    return created;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  replace(id: string, job: Omit<Job, "id">): Job | undefined {
    if (!this.jobs.has(id)) return undefined;
    const updated: Job = { ...job, id };
    this.jobs.set(id, updated);
    return updated;
  }
}
