---
bornAs: x7bohwa
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Test every alternative of a signature that gates a skip, for example a table-driven test over eac… (from web-everything/web-everything#3902 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-live-smoke.mjs:184` — Test every alternative of a signature that gates a skip, for example a table-driven test over each regex branch with an idle-host context. A lint on a regex used as a gate would be too heavy; filing a backlog item for the test is enough.
2. `we:scripts/lib/daemon-live-smoke.mjs:211` — Add a smoke-gate test that asserts every BUSY_POOL_SIGNATURES entry still requires the independent hostBusy evidence. Better still, track the consecutive skip count per probe and fail after N skips.
3. `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:89` — Add a deterministic test for each implementation that injects a non-ENOTDIR readdirSync error and asserts that the original error propagates; a catch-all-return mutation should fail these tests.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3902@8d0ccb4b51356f760172fb0e79ccc6000a0812a1

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
