---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/__tests__/measure-base.test.mjs", "we:.github/workflows/test-selection-measure.yml", "we:scripts/ci/measure-base.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — For each fallback the PR description lists (no prior success, not an ancestor, API failure), requ… (from web-everything/web-everything#7299 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/__tests__/measure-base.test.mjs:43` — For each fallback the PR description lists (no prior success, not an ancestor, API failure), require one main()-level test per branch.
2. `we:.github/workflows/test-selection-measure.yml:128` — Doc note: when the PR description names an artifact or file location, check it against the workflow test's assertions.
3. `we:.github/workflows/test-selection-measure.yml:15` — Add a named planned case, 'covers five consecutive pushes when pending runs are replaced', in we:scripts/ci/__tests__/test-selection-measure-workflow.test.mjs, with a deterministic run-history fixture asserting that every pushed SHA belongs to a measured range.
4. `we:.github/workflows/test-selection-measure.yml:15` — Add a deterministic sequence test covering replaced pending pushes, lookup failure, and subsequent recovery, asserting that every intervening commit remains represented in measurement coverage.
5. `we:scripts/ci/measure-base.mjs:65` — Add a deterministic failure-injection test where the injected git log command throws and assert the CLI's observable fallback outputs.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7299@86960d1ccc7e82b3fe625b4fb42244b540dd6d58

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
