---
bornAs: xrwh0az
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/record-red-team-ruling.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5922 (head af38065c7)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5922 (reviewed head `af38065c764277d25a47035069cf57923b75dbad`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/red-team-gate.mjs:703` — (failing-input, degraded) Rejected bot operator-card lines poison card deduplication
   - Scenario: With anyState=true, create a confirmed broken finding #1 and its trusted sent-back record. Append a trusted bot comment naming the same head/result, outcome=card-queued, containing '- 1 finding(s) carded by the operator to 'we:backlog/123-example.md' (#1).' The release reader correctly rejects this operator-only action from a bot and still sends #1 back. However, operatorRulingsOnLiveResult reports carded={1}, so rulableBreaks with ruling='card' and citesCard=false refuses the legitimate operator's new-card ruling. The probe reproduced all three results. The dedup reader should reject this lin
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/record-red-team-ruling.mjs:129` — (edge-case, degraded) An early any-state card ruling does not prevent the ordinary gate from filing the same break again
   - Scenario: Enable anyState and set WE_CARDS_DEDUPE=false. Post a live result with one confirmed degraded finding #1 before its ordinary gate decision. The new eligibility logic allows an automatic operator card ruling. Complete that ruling, leaving its valid human-authored outcome=operator-card record and follow-up-card action for #1. Then run applyRedTeamGate for that unchanged result. The source probe showed that operatorRulingsOnLiveResult recognizes #1 as carded, yet applyRedTeamGate calls fileCard again for #1: its dedup checks only outcome=card-queued. With semantic card dedup disabled, that second
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
