---
bornAs: xb3siu1
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5486 (head be5c87d25)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5486 (reviewed head `be5c87d2596c6f0fb8b356cf66cd6d65d20767aa`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1270` — (edge-case, degraded) Batch member failures lose their evidence and receive the wrong retry policy.
   - Scenario: Let lead 7201 succeed and member 7202 fail with 'HTTP 429 Too Many Requests'. The batch records that diagnostic in groupDropReasons, but cliListSettledBuilds drops that field. Furthermore, the member failure passes its diagnostic as evidence.reason, which failPrepare overwrites with 'prepare-unstamped'. A probe through the production settlement reader and daemon captured ledger evidence containing only that generic reason: classification changed from infra-transient to unknown. This spends the unknown-failure retry allowance, files an unnecessary diagnosis, and can park recurring transient fai
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
