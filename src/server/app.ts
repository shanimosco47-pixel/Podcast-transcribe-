import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { InMemoryJobStore, type JobStore } from "../jobs/store.js";
import type { FeedEpisode } from "../matching/feed.js";
import { completeChosenEpisode, runPipeline, type PipelineDeps } from "../pipeline.js";
import { renderAmbiguous, renderError, renderHome, renderResult } from "../ui/render.js";

export interface AppOptions {
  deps: PipelineDeps;
  store?: JobStore;
}

const MAX_BODY_BYTES = 8 * 1024;

export function createApp({ deps, store = new InMemoryJobStore() }: AppOptions): Server {
  return createServer((req, res) => {
    handle(req, res, deps, store).catch(() => {
      send(res, 500, renderError({ status: "failed", reason: "no_match", detail: "internal" }));
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PipelineDeps,
  store: JobStore,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/") return send(res, 200, renderHome());

  if (req.method === "POST" && path === "/transcribe") {
    const form = await readForm(req);
    const outcome = await runPipeline(form.get("url") ?? "", deps);
    const job = store.create({ outcome, pending: pendingFrom(outcome) });
    return redirect(res, `/jobs/${encodeURIComponent(job.id)}`);
  }

  const jobMatch = path.match(/^\/jobs\/([^/]+)(\/confirm|\/transcript\.txt)?$/);
  if (jobMatch) {
    const job = store.get(decodeURIComponent(jobMatch[1] ?? ""));
    if (!job) return send(res, 404, renderHome());
    const suffix = jobMatch[2];

    if (req.method === "GET" && !suffix) return renderJob(res, job.id, job.outcome);

    if (req.method === "GET" && suffix === "/transcript.txt") {
      if (job.outcome.status !== "done") return redirect(res, `/jobs/${job.id}`);
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="transcript.txt"',
      });
      res.end(job.outcome.transcript.text);
      return;
    }

    if (req.method === "POST" && suffix === "/confirm") {
      const form = await readForm(req);
      const chosenId = form.get("episodeId");
      const episode = job.pending?.episodes.find((entry) => entry.id === chosenId);
      if (!episode || !job.pending) return redirect(res, `/jobs/${job.id}`);

      const outcome = await completeChosenEpisode(episode, job.pending.feedUrl, deps);
      store.replace(job.id, { outcome, pending: null });
      return redirect(res, `/jobs/${job.id}`);
    }
  }

  send(res, 404, renderHome());
}

function renderJob(res: ServerResponse, jobId: string, outcome: PipelineOutcomeLike): void {
  if (outcome.status === "done") return send(res, 200, renderResult(outcome, jobId));
  if (outcome.status === "ambiguous") return send(res, 200, renderAmbiguous(outcome, jobId));
  send(res, 200, renderError(outcome));
}

type PipelineOutcomeLike = Awaited<ReturnType<typeof runPipeline>>;

function pendingFrom(outcome: PipelineOutcomeLike): { feedUrl: string; episodes: FeedEpisode[] } | null {
  if (outcome.status !== "ambiguous") return null;
  return {
    feedUrl: outcome.feedUrl,
    episodes: outcome.candidates.map((entry) => entry.candidate as FeedEpisode),
  };
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}

/** Read a form body, bounded so a large POST cannot exhaust memory. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) break;
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
