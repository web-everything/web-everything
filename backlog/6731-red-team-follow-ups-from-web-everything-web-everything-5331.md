---
bornAs: xixdxuv
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5331 (head bba248efe)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5331 (reviewed head `bba248efe7e73a7eea99d7733834dd7e6ef9d480`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:403` — (failing-input, degraded) A timeout in an unrelated main job falsely blocks the exhausted retry.
   - Scenario: Give the PR a daemon-soak timeout and a recent failed main run whose integration job timed out while daemon-soak passed. Let subsequent main runs succeed, exhaust the PR's heal budget, and advance main. The signature reader ignores failingCheckName and matches the integration timeout. The recovery gate then waits for a daemon-soak red-to-green transition that never occurred. A probe through both sweeps returned matched:true and zero retries after 25 hours. Unrelated jobs must not establish a matching main failure that vetoes the normal retry triggers.
   - Claude's re-check: defaultReadMainFailureSignature accepts failingCheckName but never uses it. It scans every failed or timed_out job in the recent failed main runs, so an integration-job timeout matches a daemon-soak timeout on the PR. A matched signature makes planExhaustedRetry wait unless mainRecoveredForCheck is true, and that check is keyed to the PR's own check, daemon-soak. That check never went red on main in this scenario, so the veto is effectively permanent. Even the age fallback is blocked when matched is true.

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
