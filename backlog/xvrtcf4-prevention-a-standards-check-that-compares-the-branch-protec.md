---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/pr-status.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/operations/__tests__/pr-status.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — A standards check that compares the branch-protection required set with each workflow's on.pull_request… (from chalbert/web-everything#3432 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/pr-status.mjs:179` — A standards check that compares the branch-protection required set with each workflow's `on.pull_request.branches` filter and flags names that cannot run for non-main bases. Add a reconcile test with a stacked-base PR that lacks `soak-replay-gate`.
2. `we:scripts/conveyor/reconcile-pass.mjs:1022` — Apply `known` only when `result.error` is set. For `incomplete`, merge or prefer the REST rows. Add a test where the snapshot has a CANCELLED check and the REST rows hold its later success.
3. `we:scripts/conveyor/reconcile-pass.mjs:1112` — Append the hydration refusals after `plan.refusals`, or have `reconcileRowFor` prefer REFUSAL_KINDS entries. Add a test with a PR that has both refusals.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3432@8b48b47dd23a68927ea5dbe900c6ae256eb8afaf

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
