# Claude Code instructions

## Source of truth

The active product specification and decisions are in GitHub issue #1:

https://github.com/shanimosco47-pixel/Podcast-transcribe-/issues/1

Read the issue body and every current comment before planning or changing code. Later comments override earlier instructions when they conflict.

## Current assignment

Start with Gate 1, the capability proof described in issue #1. Do not continue to the full MVP until the gate evidence has been reviewed.

Use steipete/summarize as the primary technical foundation. Reuse its relevant capabilities and focus new work on the missing Hebrew mobile web product layer.

## Supervision workflow

A separate Codex reviewer supervises this project through GitHub.

- Post the implementation plan in issue #1 before coding.
- Work on a feature branch and open a draft pull request.
- Link the pull request to issue #1.
- Put evidence, commands, test results, limitations, and gate status in the pull request.
- Respond to reviewer comments in GitHub and push focused corrections.
- At each gate, stop and wait for reviewer approval before expanding scope.
- Do not merge the pull request. The repository owner makes the merge decision.
- Ask the owner only when a decision changes product behavior, cost, credentials, privacy, deployment, or irreversible scope.

## Decision discipline

Optimize for useful learning and a working vertical slice.

Classify imperfections as:

1. Block now: prevents the gate, risks the wrong episode, creates a material security or privacy issue, or makes the architecture expensive to change later.
2. Fix now if cheap: clear value exceeds implementation and verification effort.
3. Defer: acceptable at this stage and inexpensive to change later.

For deferred work, state the consequence of leaving it unchanged for the current stage. Do not polish merely for completeness.

## Working style

- Keep GitHub updates concise.
- Avoid repeating unchanged analysis.
- Inspect targeted files first.
- Run focused tests during development and the full verification suite before requesting review.
- Never place credentials or secrets in the repository.
