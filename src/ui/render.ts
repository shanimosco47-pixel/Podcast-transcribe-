import type { Job, JobPhase } from "../jobs/store.js";
import type { PipelineOutcome } from "../pipeline.js";
import type { ScoredCandidate } from "../matching/types.js";
import type { ResolutionEvidence } from "../resolve/resolver.js";
import { failureMessage, HE } from "./strings.js";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Latin text inside Hebrew needs isolation or the BiDi algorithm reorders it. */
function ltr(value: string): string {
  return `<bdi dir="ltr">${escapeHtml(value)}</bdi>`;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} שעות ו-${minutes} דקות`;
  return `${minutes} דקות`;
}

/** Last path segment of an enclosure URL, the one detail that differs between look-alike episodes. */
function audioFileName(enclosureUrl: string | null): string | null {
  if (!enclosureUrl) return null;
  try {
    const segments = new URL(enclosureUrl).pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? null;
  } catch {
    return null;
  }
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "long", timeZone: "UTC" }).format(parsed);
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --surface: #ffffff;
  --ink: #1a1a1a;
  --muted: #5c5c5c;
  --line: #ddd8d0;
  --accent: #1b5e56;
  --accent-ink: #ffffff;
  --warn-bg: #fdf3e2;
  --warn-line: #d9a441;
  --error-bg: #fcefee;
  --error-line: #c0392b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181a; --surface: #1f2225; --ink: #f2f0ed; --muted: #a9a49c;
    --line: #34383c; --accent: #4db6a5; --accent-ink: #10221f;
    --warn-bg: #2e2718; --warn-line: #d9a441;
    --error-bg: #2e1c1a; --error-line: #e07a6d;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: "Segoe UI", "Noto Sans Hebrew", Arial, sans-serif;
  font-size: 17px; line-height: 1.65;
}
.wrap { max-width: 34rem; margin: 0 auto; padding: 1rem 1rem 4rem; }
header h1 { font-size: 1.35rem; margin: 1rem 0 .25rem; }
header p { margin: 0 0 1.5rem; color: var(--muted); }
.card {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 12px; padding: 1rem; margin-bottom: 1rem;
}
label { display: block; font-weight: 600; margin-bottom: .5rem; }
input[type="url"], input[type="text"] {
  width: 100%; padding: .8rem; font-size: 1rem; font-family: inherit;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg); color: var(--ink);
}
button {
  width: 100%; min-height: 48px; margin-top: .75rem;
  font-size: 1rem; font-family: inherit; font-weight: 600;
  background: var(--accent); color: var(--accent-ink);
  border: 1px solid transparent; border-radius: 10px; cursor: pointer;
}
button.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: .35rem .75rem; }
dt { color: var(--muted); }
dd { margin: 0; }
.badge {
  display: inline-block; padding: .2rem .6rem; border-radius: 999px;
  border: 1px solid var(--line); font-size: .85rem; color: var(--muted);
}
h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
ul { margin: 0; padding-inline-start: 1.2rem; }
li { margin-bottom: .4rem; }
.transcript {
  white-space: pre-wrap; word-break: break-word;
  max-height: 22rem; overflow-y: auto;
  border: 1px solid var(--line); border-radius: 10px;
  padding: .75rem; background: var(--bg);
}
.notice { border-inline-start: 4px solid var(--warn-line); background: var(--warn-bg); }
.notice.error { border-inline-start-color: var(--error-line); background: var(--error-bg); }
.choice {
  display: flex; gap: .6rem; align-items: flex-start;
  border: 1px solid var(--line); border-radius: 10px;
  padding: .75rem; margin-bottom: .6rem;
}
.choice input { margin-top: .35rem; width: 20px; height: 20px; flex: none; }
.choice .meta { color: var(--muted); font-size: .9rem; }
details { margin-top: 1rem; color: var(--muted); font-size: .9rem; }
summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
code { font-size: .85rem; }
.bar {
  block-size: 10px; border-radius: 999px; background: var(--line);
  overflow: hidden; margin: .75rem 0;
}
.bar span { display: block; block-size: 100%; background: var(--accent); inline-size: 0; }
.bar.indeterminate span { inline-size: 40%; animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { from { margin-inline-start: -40%; } to { margin-inline-start: 100%; } }
@media (prefers-reduced-motion: reduce) {
  .bar.indeterminate span { animation: none; inline-size: 100%; }
}
p.meta { color: var(--muted); font-size: .9rem; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}
`;

function layout(bodyHtml: string, extraHead = ""): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${extraHead}
<title>${escapeHtml(HE.appTitle)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
<h1>${escapeHtml(HE.appTitle)}</h1>
<p>${escapeHtml(HE.tagline)}</p>
</header>
${bodyHtml}
</div>
</body>
</html>`;
}

function form(value = ""): string {
  return `<form class="card" method="post" action="/transcribe">
<label for="url">${escapeHtml(HE.urlLabel)}</label>
<input id="url" name="url" type="url" inputmode="url" dir="ltr" required
       placeholder="${escapeHtml(HE.urlPlaceholder)}" value="${escapeHtml(value)}">
<button type="submit">${escapeHtml(HE.submit)}</button>
</form>`;
}

export function renderHome(): string {
  return layout(form());
}

function evidenceCard(evidence: ResolutionEvidence, sourceLabel: string): string {
  const published = formatDate(evidence.publishedAt);
  const duration = formatDuration(evidence.durationSeconds);
  const rows = [
    `<dt>${escapeHtml(HE.show)}</dt><dd>${escapeHtml(evidence.showTitle)}</dd>`,
    `<dt>${escapeHtml(HE.episode)}</dt><dd>${escapeHtml(evidence.episodeTitle)}</dd>`,
    published ? `<dt>${escapeHtml(HE.published)}</dt><dd>${escapeHtml(published)}</dd>` : "",
    duration ? `<dt>${escapeHtml(HE.duration)}</dt><dd>${escapeHtml(duration)}</dd>` : "",
    `<dt>${escapeHtml(HE.confidence)}</dt><dd>${Math.round(evidence.confidence * 100)}%</dd>`,
  ].join("");

  const signals = evidence.signals
    .map((entry) => `<li>${escapeHtml(entry.signal)}: ${entry.score.toFixed(2)} — ${ltr(entry.detail)}</li>`)
    .join("");

  return `<section class="card" aria-labelledby="identified">
<h2 id="identified">${escapeHtml(HE.identified)}</h2>
<dl>${rows}</dl>
<p><span class="badge">${escapeHtml(sourceLabel)}</span></p>
<details>
<summary>${escapeHtml(HE.technical)}</summary>
<ul>${signals}</ul>
<p>${ltr(evidence.feedUrl)}</p>
</details>
</section>`;
}

export function renderResult(
  outcome: Extract<PipelineOutcome, { status: "done" }>,
  jobId: string,
): string {
  const sourceLabel =
    outcome.transcript.source === "feed_transcript" ? HE.sourceFeed : HE.sourceTranscribed;

  const points = outcome.summary.keyPoints
    .map((point) => `<li>${escapeHtml(point)}</li>`)
    .join("");

  return layout(`
${evidenceCard(outcome.evidence, sourceLabel)}
<section class="card" aria-labelledby="summary">
<h2 id="summary">${escapeHtml(HE.summary)}</h2>
<p>${escapeHtml(outcome.summary.summary)}</p>
</section>
<section class="card" aria-labelledby="points">
<h2 id="points">${escapeHtml(HE.keyPoints)}</h2>
<ul>${points}</ul>
</section>
<section class="card" aria-labelledby="transcript">
<h2 id="transcript">${escapeHtml(HE.transcript)}</h2>
<div class="transcript" id="transcript-text" tabindex="0">${escapeHtml(outcome.transcript.text)}</div>
<button type="button" id="copy" data-copied="${escapeHtml(HE.copied)}">${escapeHtml(HE.copy)}</button>
<a href="/jobs/${encodeURIComponent(jobId)}/transcript.txt" download><button type="button" class="secondary">${escapeHtml(HE.download)}</button></a>
</section>
<a href="/"><button type="button" class="secondary">${escapeHtml(HE.again)}</button></a>
<form method="post" action="/logout"><button type="submit" class="secondary">${escapeHtml(HE.logout)}</button></form>
<script>
document.getElementById("copy")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const text = document.getElementById("transcript-text")?.textContent ?? "";
  try { await navigator.clipboard.writeText(text); button.textContent = button.dataset.copied; }
  catch { /* clipboard unavailable; the text stays selectable */ }
});
</script>`);
}

export function renderAmbiguous(
  outcome: Extract<PipelineOutcome, { status: "ambiguous" }>,
  jobId: string,
): string {
  const choices = outcome.candidates
    .map((entry: ScoredCandidate, index: number) => {
      const published = formatDate(entry.candidate.publishedAt ?? null);
      const duration = formatDuration(entry.candidate.durationSeconds ?? null);
      const meta = [published, duration].filter(Boolean).join(" · ");
      const id = `choice-${index}`;
      // Candidates reach this screen precisely because title, date and length
      // did not separate them, so show the audio file too. Without it the user
      // is asked to choose between rows they cannot tell apart.
      const file = audioFileName(entry.candidate.enclosureUrl ?? null);
      return `<label class="choice" for="${id}">
<input type="radio" id="${id}" name="episodeId" required
       value="${escapeHtml(entry.candidate.id ?? String(index))}">
<span>
<span>${escapeHtml(entry.candidate.title)}</span>
${meta ? `<span class="meta"><br>${escapeHtml(meta)}</span>` : ""}
${file ? `<span class="meta"><br>${ltr(file)}</span>` : ""}
</span>
</label>`;
    })
    .join("");

  return layout(`
<section class="card notice" aria-labelledby="ambiguous">
<h2 id="ambiguous">${escapeHtml(HE.ambiguousTitle)}</h2>
<p>${escapeHtml(HE.ambiguousBody)}</p>
</section>
<form class="card" method="post" action="/jobs/${encodeURIComponent(jobId)}/confirm">
<fieldset style="border:0;padding:0;margin:0">
<legend class="visually-hidden">${escapeHtml(HE.ambiguousBody)}</legend>
${choices}
</fieldset>
<button type="submit">${escapeHtml(HE.ambiguousConfirm)}</button>
</form>
<a href="/"><button type="button" class="secondary">${escapeHtml(HE.again)}</button></a>`);
}

export function renderError(
  outcome: Extract<PipelineOutcome, { status: "failed" }>,
): string {
  return layout(`
<section class="card notice error" aria-labelledby="error">
<h2 id="error">${escapeHtml(HE.errorTitle)}</h2>
<p>${escapeHtml(failureMessage(outcome.reason))}</p>
<details>
<summary>${escapeHtml(HE.technical)}</summary>
<p><code>${escapeHtml(outcome.reason)}</code>: ${ltr(outcome.detail)}</p>
</details>
</section>
${form()}`);
}

const PHASE_LABEL: Record<JobPhase, string> = {
  queued: HE.phaseQueued,
  resolving: HE.phaseResolving,
  downloading: HE.phaseDownloading,
  transcribing: HE.phaseTranscribing,
  summarizing: HE.phaseSummarizing,
  awaiting_choice: HE.ambiguousTitle,
  done: HE.identified,
  failed: HE.errorTitle,
};

/**
 * Status page for a job still running.
 *
 * Refreshes itself with a meta refresh rather than JavaScript, so progress is
 * visible even if a script fails to run, and re-renders as the result page the
 * moment the job finishes.
 */
export function renderProgress(job: Job): string {
  const { phase, done, total } = job.progress;
  const label = PHASE_LABEL[phase] ?? HE.working;

  const detail =
    phase === "queued" && job.queuePosition !== null
      ? `${escapeHtml(HE.queuePosition)}: ${job.queuePosition}`
      : total > 1
        ? `${escapeHtml(HE.chunkProgress)} ${done + 1} / ${total}`
        : "";

  const percent = total > 0 ? Math.round((done / total) * 100) : null;

  return layout(`
<section class="card" aria-labelledby="working" aria-live="polite">
<h2 id="working">${escapeHtml(HE.working)}</h2>
<p>${escapeHtml(label)}${detail ? ` — ${detail}` : ""}</p>
${
  percent === null
    ? '<div class="bar indeterminate"><span></span></div>'
    : `<div class="bar"><span style="inline-size:${percent}%"></span></div>`
}
<p class="meta">${escapeHtml(HE.workingBody)}</p>
</section>
<noscript><p class="meta">${escapeHtml(HE.workingBody)}</p></noscript>`,
    '<meta http-equiv="refresh" content="2">');
}

/**
 * Login screen.
 *
 * The failure message is identical for every wrong token and says nothing
 * about length, prefix or whether anything exists. When locked out, the form
 * is not rendered at all.
 */
export function renderLogin(failed = false, lockedForSeconds = 0): string {
  if (lockedForSeconds > 0) {
    return layout(`
<section class="card notice error">
<h2>${escapeHtml(HE.loginTitle)}</h2>
<p>${escapeHtml(HE.loginLocked)} ${lockedForSeconds} ${escapeHtml(HE.loginLockedUnit)}</p>
</section>`);
  }

  return layout(`
${failed ? `<section class="card notice error"><p>${escapeHtml(HE.loginFailed)}</p></section>` : ""}
<form class="card" method="post" action="/login">
<h2>${escapeHtml(HE.loginTitle)}</h2>
<p class="meta">${escapeHtml(HE.loginBody)}</p>
<label for="token">${escapeHtml(HE.loginLabel)}</label>
<input id="token" name="token" type="password" autocomplete="current-password" required>
<button type="submit">${escapeHtml(HE.loginSubmit)}</button>
</form>`);
}

/**
 * Configuration screen.
 *
 * Lists variable names only. Values are never rendered, and the page is shown
 * instead of the app rather than alongside it, so an unconfigured deployment
 * cannot be mistaken for a working one.
 */
export function renderSetup(missing: readonly string[]): string {
  const rows = missing.map((name) => `<li>${ltr(name)}</li>`).join("");
  return layout(`
<section class="card notice" aria-labelledby="setup">
<h2 id="setup">${escapeHtml(HE.setupTitle)}</h2>
<p>${escapeHtml(HE.setupBody)}</p>
<ul>${rows}</ul>
<p class="meta">${escapeHtml(HE.setupAuthNote)}</p>
</section>`);
}
