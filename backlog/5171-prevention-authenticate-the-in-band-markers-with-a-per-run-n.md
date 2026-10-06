---
bornAs: xiylkxu
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/verify-lane.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Authenticate the in-band markers with a per-run nonce passed via env and echoed in each marker li… (from web-everything/web-everything#4015 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/verify-dispatch.mjs:420` — Authenticate the in-band markers with a per-run nonce passed via env and echoed in each marker line. Failing that, add a test that emits a spoofed anchored marker from simulated gate output and asserts the gate ceiling still fires. A lint or standards rule banning raw-line trust for control markers would be the deterministic gate.
2. `we:scripts/verify-lane.mjs:311` — Add a marker field such as `ranSuites` or a `standardsSkipped` flag, and have the marker consumers (check and push-if-green) refuse or flag a green marker whose requested suites include check:standards while the recorded outcome is skipped. Add a test for that consumer rule.
3. `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs` — Use two execution segments individually below the ceiling but cumulatively above it, with sufficient timing margins; verify that replacing the remaining budget with the full ceiling makes this named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4015@ea4b6e335a0a45c114be935ce018931273f03640

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
