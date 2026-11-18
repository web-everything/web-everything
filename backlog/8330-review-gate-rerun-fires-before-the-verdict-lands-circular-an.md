---
bornAs: x10j12u
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/review-pr-io.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Review-gate rerun fires before the verdict lands (circular) and a failed rerun blocks the head forever via the once-only attempt file

we:scripts/conveyor/review-pr-io.mjs (2026-11-15 05:15 ET, HIGH, B16 S2 regression): review-pr-io re-runs the verdict-dependent review-gate before the verdict lands; the rerun POST fails silently (catch returns error:true) and the once-only attempt file blocks the head. Exempt the verdict-dependent review-gate as before, log rerun errors, retry failed attempts after a backoff, and verify the daemon token has Actions write. Prove on the live case with before/after evidence, not only unit tests.

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
