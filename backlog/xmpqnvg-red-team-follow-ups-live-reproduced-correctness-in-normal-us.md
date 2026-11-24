---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7427 (head 721dd431c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7427 (reviewed head `721dd431cd0840556d6ecbeb7779a23388c480d7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/heavy-admission.mjs:1329` — (failing-input, degraded) Explicit --host is silently overridden by the configured host list
   - Scenario: Configure hosts as Mesa then Forge and invoke we:remote-exec.mjs --host=forge -- npm run test:unit -- we:scripts/readiness/__tests__/remote-target.test.mjs. When Mesa's probe succeeds, discovery replaces the explicit Forge destination with Mesa, which is subsequently passed to execution. The explicit host should select Forge, or conflicting settings should produce a clear error.
   - Class: live-reproduced (basis: A read-only probe parsed --host=forge and passed it into runWithRemoteDecision with the configured list. The injected successful transport recorded only a Mesa probe, and the selection log reported selected=mesa-01. Execution was stopped through onDecision before filesystem writes.)
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
