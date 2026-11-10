---
bornAs: x1qz220
kind: story
size: 2
status: open
scope: ["we:scripts/operations/codex-job.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# #5839 codex-job: run tests on a frozen snapshot

MED priority hint. ## (held 2026-10-25 15:22 ET) #5839 codex-job: run tests on a frozen snapshot #5839 parked (R89: new break class). Open P1: a surviving test subprocess can show bytes A to Git and the tests, and bytes B to the pre-test snapshot, audit export and publish export, so B is published. Fix: the tests, the audit and publish all read one frozen, immutable snapshot (e.g. a tree object exported once), and nothing re-reads the working tree after that. Seed: patch a local path (fixes 1+2 closed, 213/213 tests). Scope: we:scripts/operations/codex-job.mjs + tests. Size it as a redesign; prepare it first.

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
