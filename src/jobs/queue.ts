import type { PipelineOutcome } from "../pipeline.js";
import { InMemoryJobStore, type Job, type JobPhase, type JobStore } from "./store.js";

export class QueueFullError extends Error {
  constructor(limit: number) {
    super(`Too many jobs are already waiting (limit ${limit})`);
    this.name = "QueueFullError";
  }
}

/** Handed to the work function so it can report which phase it reached. */
export interface ProgressReporter {
  set(phase: JobPhase, done?: number, total?: number): void;
}

export type JobWork = (report: ProgressReporter) => Promise<PipelineOutcome>;

export interface JobQueueOptions {
  /** One user, one episode at a time: transcription is expensive and serial is honest. */
  concurrency?: number;
  /**
   * Maximum jobs *waiting to start*. Running jobs are not counted, so with
   * concurrency 1 and maxQueued 2 there can be three jobs in flight: one
   * running and two queued. Bounded so a stuck or spamming client cannot grow
   * the queue without limit.
   */
  maxQueued?: number;
}

/**
 * Runs jobs outside the request lifecycle.
 *
 * Submitting returns as soon as the job is queued, so a request never waits for
 * a download and transcription that take minutes. Progress is written to the
 * store as each phase begins, which is what the status page reads.
 */
export class JobQueue {
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly waiting: { id: string; work: JobWork }[] = [];
  private running = 0;
  private idle: Promise<void> = Promise.resolve();
  private signalIdle: (() => void) | null = null;

  constructor(
    readonly store: JobStore = new InMemoryJobStore(),
    options: JobQueueOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.maxQueued = Math.max(1, options.maxQueued ?? 8);
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  get runningCount(): number {
    return this.running;
  }

  submit(work: JobWork): Job {
    if (this.waiting.length >= this.maxQueued) throw new QueueFullError(this.maxQueued);

    const job = this.store.create();
    this.waiting.push({ id: job.id, work });
    this.renumber();

    if (this.running === 0 && this.waiting.length === 1) {
      this.idle = new Promise<void>((resolve) => {
        this.signalIdle = resolve;
      });
    }
    // Pump synchronously so a job takes its running slot before submit returns.
    // Deferring this to a microtask made the queue-full check depend on tick
    // boundaries: three submits in one tick all counted as waiting.
    this.pump();
    return this.store.get(job.id) ?? job;
  }

  /** Resolves when nothing is queued or running. Used by tests, not by request handling. */
  async drain(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return;
    await this.idle;
  }

  private renumber(): void {
    this.waiting.forEach((entry, index) => {
      this.store.update(entry.id, { queuePosition: index + 1 });
    });
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) break;
      this.renumber();
      this.running += 1;
      void this.execute(next.id, next.work);
    }
  }

  private async execute(id: string, work: JobWork): Promise<void> {
    const report: ProgressReporter = {
      set: (phase, done = 0, total = 0) => {
        this.store.update(id, { progress: { phase, done, total }, queuePosition: null });
      },
    };
    report.set("resolving");

    try {
      const outcome = await work(report);
      this.store.update(id, {
        outcome,
        progress: {
          phase:
            outcome.status === "done"
              ? "done"
              : outcome.status === "ambiguous"
                ? "awaiting_choice"
                : "failed",
          done: 1,
          total: 1,
        },
        pending:
          outcome.status === "ambiguous"
            ? { feedUrl: outcome.feedUrl, episodes: outcome.candidates.map((c) => c.candidate as never) }
            : null,
        queuePosition: null,
      });
    } catch (error) {
      // An unexpected throw still has to produce a job the UI can render.
      this.store.update(id, {
        outcome: {
          status: "failed",
          reason: "no_match",
          detail: error instanceof Error ? error.message : String(error),
        },
        progress: { phase: "failed", done: 0, total: 0 },
        queuePosition: null,
      });
    } finally {
      this.running -= 1;
      if (this.running === 0 && this.waiting.length === 0) {
        this.signalIdle?.();
        this.signalIdle = null;
      } else {
        this.pump();
      }
    }
  }
}
