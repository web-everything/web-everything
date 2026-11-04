---
bornAs: xnhgwb1
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/settings/prepare.json"]
dateOpened: "2026-11-02"
tags: []
---

# prepare has launched 0 times since ≥2026-10-30 08:13Z

HIGH priority hint. - (2026-11-01 00:07 ET) HIGH: prepare has launched 0 times since ≥2026-10-30 08:13Z. build-dispatch-daemon (we:wev-control/skills-src/conveyor/build-dispatch-daemon.mjs) spends the per-tick PR-listing budget (maxPrListingCallsPerTick 128, we:scripts/settings/prepare.json) on re-checking ~41 parked prepare-unstamped cards (2–4 gh pr list --search each, via createPrepareStatusReader :2198 / primePrepareStatus :403), so refusePrepareLaunch (:1337–1364) always finds it exhausted → 'prepare PR listing unavailable' (107× in build-dispatch-daemon.log.1). Fix (pick): cross-tick TTL listing cache for parked cards with no claim/worker + a reserved launch share of the budget as backstop. Also: nightly report miscounts these refusals as 'launch failures'.

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
