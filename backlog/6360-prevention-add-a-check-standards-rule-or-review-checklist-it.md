---
bornAs: x9dyq9s
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/fix-scope-fence-io.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs", "we:scripts/conveyor/__tests__/fix-scope-fence-io.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a check:standards rule or review checklist item that requires each numeric limit named in we:… (from web-everything/web-everything#5461 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-scope-fence-io.mjs:103` — Add a check:standards rule or review checklist item that requires each numeric limit named in we:docs/agent/testing.md to have a test asserting that specific limit's error text.
2. `we:scripts/conveyor/fix-scope-fence-io.mjs:105` — For a limit stated in docs or comments with several numeric bounds (count and seconds), add a lint or review-lens rule that each bound needs a named test, and use a fake clock for time limits.
3. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:28` — Parameterize the incomplete-evidence assertion over every launch path in `scope prompt ownership`, so that adding a path means adding a row.
4. `we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs` — Add a deterministic regression named 'card scope overrides a wider PR diff': declare only we:guard.mjs, include we:outside.mjs in the PR diff, propose an we:outside.mjs repair, and assert stand-down with zero pushes.
5. `we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs` — Add a deterministic clock-controlled regression named 'stands down when the shared history-read deadline expires'; assert decreasing per-call timeouts, terminal evidence refusal below 2,000 reads, and zero pushes.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5461@4752c275333c66228ea55c4b6d65f4038c760d38

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
