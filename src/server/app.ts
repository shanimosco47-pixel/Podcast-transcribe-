import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { JobQueue, QueueFullError } from "../jobs/queue.js";
import type { Job } from "../jobs/store.js";
import { completeChosenEpisode, runPipeline, type PipelineDeps } from "../pipeline.js";
import {
  renderAmbiguous,
  renderError,
  renderHome,
  renderLogin,
  renderProgress,
  renderResult,
  renderSetup,
} from "../ui/render.js";
import { clearedCookie, OwnerAuth, readCookie, SESSION_COOKIE, sessionCookie } from "./auth.js";

export interface AppOptions {
  deps: PipelineDeps;
  queue?: JobQueue;
  /** Omit to run without authentication; only tests and local checks do that. */
  auth?: OwnerAuth | null;
  /** Variable names still missing. Non-empty means the setup screen replaces the app. */
  missingConfig?: readonly string[];
  /** Set when served over HTTPS so the session cookie is marked Secure. */
  secureCookies?: boolean;
}

const MAX_BODY_BYTES = 8 * 1024;

export function createApp({
  deps,
  queue = new JobQueue(),
  auth = null,
  missingConfig = [],
  secureCookies = false,
}: AppOptions): Server {
  const context: RequestContext = { deps, queue, auth, missingConfig, secureCookies };
  return createServer((req, res) => {
    handle(req, res, context).catch(() => {
      send(res, 500, renderError({ status: "failed", reason: "no_match", detail: "internal" }));
    });
  });
}

interface RequestContext {
  deps: PipelineDeps;
  queue: JobQueue;
  auth: OwnerAuth | null;
  missingConfig: readonly string[];
  secureCookies: boolean;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
): Promise<void> {
  const { deps, queue, auth } = context;
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  // An unconfigured deployment shows the setup screen instead of the app, so it
  // can never be mistaken for a working one.
  if (context.missingConfig.length > 0) {
    return send(res, 503, renderSetup(context.missingConfig));
  }

  if (auth) {
    if (req.method === "GET" && path === "/login") return send(res, 200, renderLogin());

    if (req.method === "POST" && path === "/login") {
      const form = await readForm(req);
      if (!auth.verifyToken(form.get("token") ?? "")) {
        return send(res, 401, renderLogin(true));
      }
      res.writeHead(303, {
        location: "/",
        "set-cookie": sessionCookie(auth.issueSession(), context.secureCookies),
      });
      res.end();
      return;
    }

    if (req.method === "POST" && path === "/logout") {
      res.writeHead(303, { location: "/login", "set-cookie": clearedCookie(context.secureCookies) });
      res.end();
      return;
    }

    if (!auth.verifySession(readCookie(req.headers.cookie, SESSION_COOKIE))) {
      // 401 rather than a silent redirect, so an unauthorized request is
      // unambiguous to a client and to the tests.
      res.writeHead(401, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(renderLogin());
      return;
    }
  }

  if (req.method === "GET" && path === "/") return send(res, 200, renderHome());

  if (req.method === "POST" && path === "/transcribe") {
    const form = await readForm(req);
    const input = form.get("url") ?? "";
    try {
      // Returns as soon as the job is queued: the request never waits for a
      // download and transcription that can take minutes.
      const job = queue.submit((report) =>
        runPipeline(input, {
          ...deps,
          onPhase: (phase, done, total) => report.set(phase, done, total),
        }),
      );
      return redirect(res, `/jobs/${encodeURIComponent(job.id)}`);
    } catch (error) {
      if (error instanceof QueueFullError) {
        return send(res, 503, renderError({ status: "failed", reason: "queue_full", detail: error.message }));
      }
      throw error;
    }
  }

  const jobMatch = path.match(/^\/jobs\/([^/]+)(\/confirm|\/transcript\.txt)?$/);
  if (jobMatch) {
    const job = queue.store.get(decodeURIComponent(jobMatch[1] ?? ""));
    if (!job) return send(res, 404, renderHome());
    const suffix = jobMatch[2];

    if (req.method === "GET" && !suffix) return renderJob(res, job);

    if (req.method === "GET" && suffix === "/transcript.txt") {
      if (job.outcome?.status !== "done") return redirect(res, `/jobs/${job.id}`);
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="transcript.txt"',
        "cache-control": "no-store",
      });
      res.end(job.outcome.transcript.text);
      return;
    }

    if (req.method === "POST" && suffix === "/confirm") {
      const form = await readForm(req);
      const chosenId = form.get("episodeId");
      const pending = job.pending;
      const episode = pending?.episodes.find((entry) => entry.id === chosenId);
      if (!episode || !pending) return redirect(res, `/jobs/${job.id}`);

      // The confirmed run goes through the queue too, so a long transcription
      // after a user choice does not block the request either.
      const resumed = queue.submit((report) =>
        completeChosenEpisode(episode, pending.feedUrl, {
          ...deps,
          onPhase: (phase, done, total) => report.set(phase, done, total),
        }),
      );
      return redirect(res, `/jobs/${encodeURIComponent(resumed.id)}`);
    }
  }

  send(res, 404, renderHome());
}

function renderJob(res: ServerResponse, job: Job): void {
  if (!job.outcome) return send(res, 200, renderProgress(job));
  if (job.outcome.status === "done") return send(res, 200, renderResult(job.outcome, job.id));
  if (job.outcome.status === "ambiguous") return send(res, 200, renderAmbiguous(job.outcome, job.id));
  send(res, 200, renderError(job.outcome));
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
