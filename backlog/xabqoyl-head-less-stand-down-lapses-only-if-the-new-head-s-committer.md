---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/pr-comments-complete.mjs", "we:scripts/operations/pr-sweep-io.mjs", "we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/operator-queue.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Head-less stand-down lapses only if the NEW head's committer date is later than the comment, so a pushed olde…

Flow-sim gap R5b-G1, class K16 (mixed clock domains). Failing input: PR with a head-less stand-down (no `head=` trailer — the `--reason=conflict` stand-down the fixer brief posts has no --head, we:reconcile-fix-dispatch.mjs:772; CLI only records head when --head is passed, we:stand-down.mjs:792; builder we:stand-down.mjs:736,740). Stand-down comment createdAt 12:00. No fix claim. At 12:30 a pers… Cited: we:scripts/conveyor/pr-comments-complete.mjs:95-110, we:scripts/operations/pr-sweep-io.mjs:103, we:scripts/conveyor/stand-down.mjs:209-212, we:scripts/conveyor/stand-down.mjs:235-239, we:scripts/conveyor/reconcile-core.mjs:2589-2599. Soak-break sketch: Fixture: comments=[trusted STAND_DOWN comment, no head trailer, createdAt 12:00], headRefOid=B, commits=[{oid:B, committedDate:'11:45'}]. Action: annotateLapsedStandDowns(pr,{lapseOnNewHead:'on'}) then countUnresolvedStandDowns(pr.comments). Assert count===0 …

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
