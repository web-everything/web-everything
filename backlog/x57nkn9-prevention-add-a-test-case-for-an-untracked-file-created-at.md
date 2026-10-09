---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-acquirable-scan-speed.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a test case for an untracked file created at depth 2 (sub/deep/new.txt). Either assert it is… (from web-everything/web-everything#4652 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:3105` — Add a test case for an untracked file created at depth 2 (sub/deep/new.txt). Either assert it is bounded by the window, or extend the signature to stat second-level directories. Correct the design comment to name new deep files as undetected.
2. `we:scripts/__tests__/lane-pool-acquirable-scan-speed.test.mjs:1` — Add a lane-pool test that makes a cached `list` report a deep-edited lane clean, then runs `acquire` auto-pick and asserts the lane is skipped and its file is intact. Also add an assertion that acquire's scan options never set partialOnOverrun.
3. `we:scripts/__tests__/lane-pool-acquirable-scan-speed.test.mjs:146` — Add the proposed real-CLI regression test to the automated suite and verify that bypassing acquire's fresh dirty check makes it fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4652@a5cab2fcf41152bb97647f85c2708a9dd216b456

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
