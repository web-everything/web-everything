---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/__tests__/smoke.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a rebuildClone test with WE_DAEMON_SMOKE_PASS_TTL_MS=0 and an equal-clock repeat tree, assert… (from web-everything/web-everything#4038 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/smoke.mjs:266` — Add a rebuildClone test with WE_DAEMON_SMOKE_PASS_TTL_MS=0 and an equal-clock repeat tree, asserting the smoke runs, and use `age < ttl` or an explicit `ttl > 0` guard.
2. `we:scripts/lib/daemon-rebuild/smoke.mjs:43` — Hash the harness import closure with collectImportClosure instead of one file. Add a test that edits an imported module and asserts the key changes.
3. `we:scripts/lib/daemon-rebuild/smoke.mjs:41` — Add deterministic fault-injection tests for identity-read failures, including distinguishing an absent lockfile from an unreadable existing lockfile, and run them in the normal test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4038@20fa583f4c95793b70579c9e0eee651a19046743

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
