---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-queue-obsolete-runs.mjs", "we:scripts/lib/__tests__/merge-queue-obsolete-runs.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a settings-resolver convention: an invalid value in a kill-switch key resolves to the safe/of… (from web-everything/web-everything#5209 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-queue-obsolete-runs.mjs:44` — Add a settings-resolver convention: an invalid value in a kill-switch key resolves to the safe/off state, or the pass refuses to act. Back it with a test per kill-switch key. A lint over `resolve(...)` calls whose standard is `on` for destructive actions could enforce this.
2. `we:scripts/lib/merge-queue-obsolete-runs.mjs:7` — Add an allowlist setting of workflow names or paths to cancel, defaulting to the required CI workflow. Add a planner test that a non-allowlisted workflow on a deleted ref is kept. If this lands on the backlog, file it as a card.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5209@25d142430e8f8daf8cdb86c75dd814d7d0cf5187

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
