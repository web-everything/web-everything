---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/daemon-status-io.mjs", "we:scripts/operations/coroner-extract.mjs", "we:scripts/operations/__tests__/daemon-status-io.test.mjs", "we:scripts/operations/__tests__/coroner-extract.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a check:standards rule: any regex literal anchored on ^[a-z-]+-daemon: in a non-test file mus… (from web-everything/web-everything#4076 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/daemon-status-io.mjs:242` — Add a check:standards rule: any regex literal anchored on `^[a-z-]+-daemon:` in a non-test file must live in a module that imports `stripLogTimestamp`. Alternatively, route every daemon-log read through one shared `readDaemonLogLines` helper that strips the stamp.
2. `we:scripts/operations/coroner-extract.mjs:272` — Add a deterministic extractMetrics regression test comparing plain, stamped, and mixed fixtures, with explicit nonzero starts and SIGTERM counters.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4076@2ddbb3016ad984546dfe111b527c61b90a0f24e4

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
