---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-clone-lock.mjs", "we:scripts/lib/__tests__/daemon-clone-lock-fairness.test.mjs", "we:scripts/lib/__tests__/daemon-clone-lock.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a rebuild/smoke test that holds a starved claim during a failing smoke and asserts the reject… (from web-everything/web-everything#4039 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-clone-lock.mjs:380` — Add a rebuild/smoke test that holds a starved claim during a failing smoke and asserts the rejection is still recorded. Alternatively, give `acquireWrite` an opt-out such as `yieldToReaders:false` for the outcome-recording and lease-release callers.
2. `we:scripts/lib/__tests__/daemon-clone-lock-fairness.test.mjs:143` — When a test title names two disjoint conditions with 'or', require one assertion per condition. A review-lens checklist item is enough. A deterministic lint isn't practical here.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4039@92a8285f23070ef783ea07d9a687f26ea48895a2

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
