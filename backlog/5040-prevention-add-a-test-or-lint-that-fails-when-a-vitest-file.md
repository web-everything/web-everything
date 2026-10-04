---
bornAs: xw69pxs
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/__tests__/ci-card-only.test.mjs", "we:scripts/ci-card-only.mjs", "we:.github/workflows/review-gate.yml"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a test or lint that fails when a vitest file reads the real backlog/ directory without being… (from web-everything/web-everything#3849 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/ci.yml:89` — Add a test or lint that fails when a vitest file reads the real `backlog/` directory without being listed in a light-path allowlist or run in the light `test` job. A cheaper alternative is to run those named test files in the light `test` job.
2. `we:scripts/__tests__/ci-card-only.test.mjs:1` — Add a workflow-lint test that parses we:.github/workflows/ci.yml and asserts that `test` and `smoke` each reference `needs.changes.result` and exit non-zero when it is not success, and that `test-shard` is conditioned on `light`. Put it in the same test file, next to the hold-list parity check.
3. `we:scripts/ci-card-only.mjs:46` — Add deterministic CLI tests covering git failure and moves both into and out of backlog, asserting light=false.
4. `we:.github/workflows/review-gate.yml:82` — Add a deterministic test executing the workflow's shell verdict for every hold label, unrelated labels, and an empty label list, asserting exit status.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3849@ee7ae91132bf1116d11428db469b39a088235415

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
