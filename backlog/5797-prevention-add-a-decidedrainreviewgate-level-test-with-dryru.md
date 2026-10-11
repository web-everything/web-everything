---
bornAs: xbf9d6w
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/human-clearance-carry.mjs", "we:scripts/lib/__tests__/human-clearance-carry.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a decideDrainReviewGate-level test with dryRun:true that asserts no gh pr comment exec call.… (from web-everything/web-everything#4784 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:701` — Add a decideDrainReviewGate-level test with `dryRun:true` that asserts no `gh pr comment` exec call. More generally, add a check that every IO-writing helper reached from runCli has a dryRun-propagation test.
2. `we:scripts/lib/human-clearance-carry.mjs:205` — Only post the record when `permissionChange || deviation` is set, or when a dry gate evaluation without the carry would park. Add a test that a non-permission-change PR gets no record.
3. `we:scripts/merge-ai-prs.mjs:673` — Read the diff using an immutable commit SHA and add a deterministic test named 'ref changes during diff read cannot carry clearance' that supplies an old matching diff while the mutable ref advances and asserts no carry record is posted.
4. `we:scripts/lib/__tests__/human-clearance-carry.test.mjs:81` — Add a deterministic 'environment overrides conflicting settings file' test covering both boolean directions and asserting both the effective value and source.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4784@076be0bb7f620ce3077cb41506e7448bd7ccbb95

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
