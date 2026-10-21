---
bornAs: xrvvda3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/run.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/lib/health-watch-lane-scan.mjs", "we:scripts/operations/__tests__/run.test.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/lib/__tests__/health-watch-lane-scan.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Prevention — Review lens (or test-plan check): every prose guarantee in the PR description must map to a named… (from web-everything/web-everything#5759 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/run.mjs:330` — Review lens (or test-plan check): every prose guarantee in the PR description must map to a named test; for env-gated wiring, require a test of the unset-env default.
2. `we:scripts/conveyor/health-watch.mjs:1303` — Extract the laneScanDir decision into a small pure helper with table-driven tests (state-root, fixture flags, dry-run, none).
3. `we:scripts/operations/run.mjs:330` — Add a we:scripts/operations/run.mjs operation-wiring test that asserts the env-gated `laneScan` option. A standards check that every env-gated behaviour names a test would catch this class.
4. `we:scripts/conveyor/health-watch.mjs:1303` — Add a `tick` test with a spy `collectGh` that asserts the cache arguments for the dry-run, fixture and state-root cases.
5. `we:scripts/lib/health-watch-lane-scan.mjs:96` — Add a `check:standards` rule that fails when a destructive lane-pool call site lacks a `guardLaneAction` reference. File it as a backlog card.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5759@e7d770a7274520373df0446b83d3b23fa9612fd4

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
