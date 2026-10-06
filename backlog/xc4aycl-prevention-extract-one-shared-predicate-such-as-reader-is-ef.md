---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-clone-lock.mjs", "we:scripts/lib/__tests__/daemon-clone-lock-writer-fairness.test.mjs", "we:scripts/lib/__tests__/daemon-clone-lock.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Extract one shared predicate, such as 'reader is effectively starved before claim', and have both… (from web-everything/web-everything#4056 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-clone-lock.mjs:373` — Extract one shared predicate, such as 'reader is effectively starved before claim', and have both acquireRead and acquireWrite call it. Add a test with a reader starved below the threshold.
2. `we:scripts/lib/__tests__/daemon-clone-lock-writer-fairness.test.mjs:123` — Add deterministic competing-record tests in both age orders, asserting acquisition and yielding outcomes; mutation-check removal or inversion of each timestamp comparison when writable execution is available.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4056@fff1aa111c3cff382815cd16a15eed550db9bd00

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
