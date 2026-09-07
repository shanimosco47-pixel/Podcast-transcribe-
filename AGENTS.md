# Working in this repository

## What this is

A private Hebrew web app: paste a Spotify episode link, get a Hebrew transcript,
summary and key points on a phone. Spotify identifies the episode; audio always
comes from the public RSS enclosure.

## Verification

Run all of these before asking for review. They need no credentials and make no
network calls.

```bash
npm ci
npm run lint        # eslint, zero warnings tolerated
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest, entire suite
npm run build       # tsc to dist/
```

Two suites need binaries. Install them rather than letting the tests skip:

```bash
sudo apt-get install -y ffmpeg          # media.chunking tests
npx playwright install --with-deps chromium   # mobile.360 tests
```

`tests/mobile.360.test.ts` reads `CHROMIUM_EXECUTABLE_PATH` when a sandbox has a
preinstalled browser whose build differs from Playwright's. Leave it unset in CI.

## Rules that are not negotiable

- **Never return an episode the matcher is not confident about.** `matchEpisode`
  returns `matched | ambiguous | no_match`. There is no first-result fallback
  anywhere, and reintroducing one defeats the product. The upstream behaviour it
  replaced is pinned as a regression test.
- **Never truncate a transcript to fit a request.** Long transcripts are
  summarized hierarchically and the synthesis fails closed if it cannot fit.
- **Never let provider-controlled text into an error, a page or a log.** Failures
  carry an HTTP status and a category we derive from it, nothing else.
- **Never fetch a URL that came from a feed without `safeFetch`.** It validates
  every redirect hop, resolves DNS, rejects non-unicast addresses, and pins the
  connection to the address it vetted.
- **Never write outside a `Workspace`.** It is the unit of cleanup and is removed
  on every path out, including failures.
- Secrets are read from the environment only. No value is ever logged, rendered
  or committed; `tests/secrets.test.ts` enforces the last part.

## Two traps this codebase has already hit

Node's global `fetch`, `FormData` and friends come from an internal copy of
undici that does **not** interoperate with the `undici` package. Passing a
package `Agent` to global `fetch` throws `invalid onRequestStart method`, and
passing a global `FormData` to package `fetch` silently posts
`"[object FormData]"` as `text/plain`. Use `defaultFetch` and undici's own
`FormData` from `src/http/safe-fetch.ts` and the adapter. Both defects passed
every fixture test and were only caught against a real socket.

`URL.hostname` keeps the brackets on an IPv6 literal (`"[::1]"`), so `isIP`
returns 0. Strip them before any literal detection.

## Testing conventions

- A regression test must fail against the defect it describes. Revert the fix,
  watch it fail, restore. Several tests in this repo exist because that step
  caught a test that would have passed either way.
- Network is mocked by a fixture map that **rejects** unknown URLs, so no test
  can silently reach the internet.
- Provider behaviour is exercised against `tests/support/mock-provider.ts`, a
  local HTTP server. Prefer it to stubbing the adapter: it catches wire-level
  defects a stub cannot.

## Layout

```
src/matching/      title normalization, scoring, confidence
src/resolve/       Spotify URL parsing, embed and feed resolution
src/http/          safeFetch boundary, URL and address guards
src/media/         download, ffmpeg splitting, workspace cleanup
src/transcription/ adapters (OpenAI-compatible, fixture, not-configured)
src/summary/       hierarchical summarizer and its adapters
src/jobs/          bounded queue and in-memory store
src/server/        HTTP routes, owner auth
src/ui/            Hebrew RTL rendering
src/vendor/        vendored MIT code, with provenance in NOTICE.md
```
