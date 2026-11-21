---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/pr-land.mjs", "we:scripts/conveyor/__tests__/convert-advisory-dispatch.test.mjs", "we:scripts/__tests__/merge-ai-prs-net-diff-computation.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/pr-land.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a drain test matrix over each netDiffText.reason (no-clone, fetch-failed, ref-unresolved, dif… (from web-everything/web-everything#7235 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:6633` — Add a drain test matrix over each `netDiffText.reason` (no-clone, fetch-failed, ref-unresolved, diff-failed) asserting park or proceed. File it as a backlog card.
2. `we:scripts/pr-land.mjs:1280` — Assert the stderr line in the existing pr-land open-only runCli test.
3. `we:scripts/conveyor/__tests__/convert-advisory-dispatch.test.mjs:136` — A check:standards rule that fails on a raw exec('git', ['diff'|'log'...]) in net-diff-adjacent modules unless it goes through the shared wrapper.
4. `we:scripts/pr-land.mjs:1255` — Add an open-only runCli test with headEvidence=different that asserts reason pr-head-mismatch and no add-label call. Mutation-check each assert call site separately.
5. `we:scripts/pr-land.mjs:1280` — Assert the log in the pr-land.test open-only runCli test, which already captures stderr.
6. `(no file cited)` — Add a deterministic acceptance-evidence check requiring each guarantee to reference a named test or operational check, its observable assertion, and a recorded result.
7. `we:scripts/pr-land.mjs:1280` — Extend the existing scored CLI control with an exact stderr assertion and include removal of the log statement in the mutation checks.
8. `we:scripts/__tests__/merge-ai-prs-net-diff-computation.test.mjs:1043` — Add a deterministic acceptance-evidence check requiring each Acceptance guarantee to reference a named test or named operational check with recorded assertions and results.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7235@a46bac7b915ead2803c4a92482d3f36d51b79063

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
