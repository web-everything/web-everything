---
bornAs: xay2ja5
kind: task
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# rebuild smoke must not blame an overlay for a transient GitHub error (5xx/truncated JSON)

Live 2026-10-10 23:36Z (wev-fix-daemon): the overlay build failed dispatch-dry-run on a GitHub 504 / truncated JSON from gh pr list, plain main happened not to hit it, and the rebuild dropped we:lane/gh-json-retry (#4851) and #4792 as suspects. Classify a failure whose detail is a transient GitHub error (HTTP 502/503/504, 'unexpected end of JSON input', GraphQL timeout) as env-transient in we:scripts/lib/daemon-live-smoke.mjs and we:scripts/lib/daemon-rebuild/smoke.mjs: retry or hold, never drop an overlay as a suspect.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
