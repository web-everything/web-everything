---
bornAs: xb3cg5p
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-rebuild.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# daemon-rebuild blames an overlay for a GitHub rate-limit smoke failure and never retries it

Live 2026-10-08 21:17Z (wev-control, PR #4512 overlay): the live smoke failed only on gh-api-repo + dispatch-dry-run with 'API rate limit exceeded' (infra-transient). daemon-rebuild then fell back to plain main, which passed after the backoff, and DROPPED the overlay as the suspect (overlay-dropped-smoke-failed). Re-adding it gives 'still-rejected' with retryAt null: the target sha is remembered as rejected and is not retried until main moves. A smoke failure whose every failed check is a GitHub rate-limit / gh-throttle backoff must be classified transient: no suspect is blamed, the overlay is kept, and the same target is retried after the backoff.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
