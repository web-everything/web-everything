---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7572 (head ba859ec2a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7572 (reviewed head `ba859ec2ad9e7d5d794c84af3a3d13b9d5c4fd75`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/heavy-admission.mjs:1359` — (edge-case, degraded) The CLI still overrides the new Mesa default with retired host forge.
   - Scenario: Run node we:scripts/readiness/remote-exec.mjs -- npm run test:unit -- we:scripts/readiness/__tests__/remote-target-default-host.test.mjs with canonical preferences containing an empty object, Forge unavailable, and Mesa ready. parseArgs supplies host='forge' despite no --host argument. The new target selection treats this as an override, probes only Forge, and falls back locally. It should select and dispatch Mesa by default, reserving overrides for an explicitly supplied --host.
   - Class: live-reproduced (basis: A read-only Node probe executed parseArgs and main with filesystem mutations stubbed in memory and injected readiness responses of 255 for Forge and 0 for Mesa. It observed only the Forge probe, no remote dispatch, and invocation of the local fallback.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
