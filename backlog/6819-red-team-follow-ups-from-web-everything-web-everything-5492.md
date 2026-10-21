---
bornAs: xdb3n0j
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ledger-observation.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5492 (head 31cb7a5d8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5492 (reviewed head `31cb7a5d863708e9523d1b7e278bb8640fd31d15`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/ledger-observation.mjs:87` — (edge-case, degraded) The event observer's ledger fetch has no timeout despite the poll deadline
   - Scenario: Use the git or dual store with a configured board. An allowlisted open-PR event completes its live GitHub read, then the observer reads the ledger while origin is unresponsive. observeLedgerHead calls read(facts.repo) without forwarding its deadline; readObservationLedger consequently starts git fetch with no timeout. This synchronous fetch can block the event poll indefinitely, exceeding maxObservationMsPerPoll=15000 and preventing wake delivery. A probe intercepted the default subprocess path, confirmed timeout was undefined, and simulated a 60-second fetch under a 15-second deadline. The re
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/ledger-observation.mjs:163` — (edge-case, degraded) The drain observation cap can permanently starve later head changes
   - Scenario: Set firstSeenRows=false, headMoveInvalidation=true, and drainObserveMaxPerPass=2. Supply a stable target order of two open PRs without ledger heads, followed by a PR accepted at A whose listed/live head is now B. Every pass spends both observations on the first two PRs, writes nothing because baseline creation is disabled, and caps the third PR. A three-pass Node probe recorded reads [1,2,1,2,1,2], zero writes, and PR 3 capped every time. Thus the enabled head-move invalidation never reaches PR 3; the default cap has the same problem with 20 leading unbaselined PRs. Capped targets need eventua
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
