---
bornAs: xtlm8gj
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-sweep.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5323 (head c7b96a860)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5323 (reviewed head `c7b96a8602cc50ba2147089d5e4d12eee660b9ba`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-sweep.mjs:51` — (failing-input, degraded) Daemon log references in the actual emitted format bind sibling PRs to WE.
   - Scenario: Pass WE #12 and plateau-app #12 to collectOwnerSignals, with no sessions or health memory, and a wev-fix-daemon log containing '2026-10-14T15:59:59.000Z reconcile-fix-dispatch-daemon: reconcile-refused live-process plateauapp/plateau-app PR #12 — a bound session has a LIVE pid'. This matches the daemon's formatRefusalLine format. The probe attached the daemon signal to web-everything/web-everything#12 and attached none to plateauapp/plateau-app#12. The parser recognizes repo#number but not the emitted 'repo PR #number', so it falls back to the log directory's WE default. Explicit repository re
   - Claude's re-check: The 'refs' regex needs an adjacent 'repo#N'. In 'plateauapp/plateau-app PR #12' the '#12' follows 'PR ', so refs is empty. It then falls back to the bare '#12' regex gated on key === log.repo, which defaults to 'we'. WE #12 therefore binds and plateau-app #12 does not.

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
