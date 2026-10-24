---
bornAs: xq1jyy9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-comments-complete.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/pr-comments-complete.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a contract test that every readCompletePrComments and provider.readComments call site either… (from web-everything/web-everything#5854 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-comments-complete.mjs:23` — Add a contract test that every `readCompletePrComments` and `provider.readComments` call site either passes a resolved slug or fails loudly. Or resolve a null repo once inside the reader, using the same `localRepoSlug` fallback this diff already adds in merge-ai-prs.
2. `we:scripts/conveyor/pr-comments-complete.mjs:23` — Add a check:standards rule or caller-contract test that enumerates every readCompletePrComments / GH_ARGV.readCommentsTotalCount call site and asserts a repo slug is resolved before the call. Failing that, default to the local repo slug inside the reader instead of throwing.
3. `we:scripts/conveyor/reconcile-core.mjs:1402` — Keep the human-clearance check out of the shared refuseUnreviewable helper and call it only at review emission sites. Alternatively, add a planner test matrix that crosses each refuse helper's call sites with each guard condition.
4. `we:scripts/conveyor/pr-comments-complete.mjs:107` — Extract one shared coverage predicate, retain the existing caller tests, and add a deterministic standards check requiring both consumers to use that predicate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5854@c6eccfeb4feccd428a81729db57ef14e03f00e7a

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
