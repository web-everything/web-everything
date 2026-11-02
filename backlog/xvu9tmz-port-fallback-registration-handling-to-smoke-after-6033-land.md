---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/daemon-rebuild/candidate.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Port fallback-registration handling to smoke after #6033 lands

Dropped from the thin split of #6044 because it depends on #6033 registration generations. Source: branch lane/rebuild-parent-reader (#6044), we:scripts/lib/__tests__/daemon-rebuild-fallback-registration.test.mjs and the we:scripts/lib/daemon-rebuild/smoke.mjs, we:scripts/lib/daemon-rebuild/adopt.mjs, we:scripts/lib/daemon-rebuild/candidate.mjs hunks versus lane/overlay-generation-s1-r2. Findings verbatim: Drop the fallback-registration code that depends on #6033 (we:scripts/lib/daemon-rebuild/smoke.mjs:747 path) and file it as a card. Blocked by #6033.

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
