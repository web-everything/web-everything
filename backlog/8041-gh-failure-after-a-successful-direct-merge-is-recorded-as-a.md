---
bornAs: xippm6f
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# gh failure after a successful direct merge is recorded as a failed merge and its follow-up is lost

Flow-sim gap D-C7, class K5 (transient read failure becomes a permanent decision). Failing input: non-local repo PR passes all gates; gh pr merge succeeded server-side but the CLI call throws (network drop / throttle after the response) ' 'the post-throw re-probe isPrAlreadyMerged also hits a gh miss Cited: we:scripts/merge-ai-prs.mjs:7287, we:scripts/merge-ai-prs.mjs:7351, we:scripts/merge-ai-prs.mjs:5110-5117, we:scripts/merge-ai-prs.mjs:7384, we:scripts/merge-ai-prs.mjs:7148. Soak-break sketch: none

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
