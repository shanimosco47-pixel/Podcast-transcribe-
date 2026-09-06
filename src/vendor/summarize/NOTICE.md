# Vendored from steipete/summarize

Source: https://github.com/steipete/summarize
Commit: `8f5314a4827bcf5049972849122476a3c6e44dcc` (v0.21.12)
License: MIT — Copyright (c) 2026 Peter Steinberger (see `LICENSE` in that repository)

## Why vendored rather than depended upon

The podcast provider lives at
`packages/core/src/content/transcript/providers/podcast/` and is **not** part of
the `@steipete/summarize-core` export map, which exposes only `./content`,
`./content/url`, `./content/network-safety`, `./content/youtube`, `./prompts`
and similar. The podcast RSS parsing therefore cannot be imported from the
published package and is copied here instead.

## What was taken, and what was deliberately not

Taken verbatim (feed parsing): `extractFeedItems`, `extractItemTitle`,
`extractEnclosureUrlFromItem`, `extractItemDurationSeconds`, `decodeXmlEntities`,
`looksLikeRssOrAtomFeed`.

**Not taken:** `normalizeLooseTitle` and `extractEnclosureForEpisode`. Upstream's
normalizer ends with `[^a-z0-9]+ -> " "`, which deletes every Hebrew character
and collapses all Hebrew titles to the empty string; `extractEnclosureForEpisode`
then treats two empty strings as an exact title match and returns the first feed
item carrying an enclosure. For a Hebrew podcast that is a confident wrong-episode
match. Replaced by `src/matching/`. The failure is pinned as a regression test in
`tests/matching.normalize.test.ts`.
