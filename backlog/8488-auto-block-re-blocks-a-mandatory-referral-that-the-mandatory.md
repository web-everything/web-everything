---
bornAs: xjnor1j
kind: story
size: 3
status: active
scaffoldedBy: "fix-4847"
dateScaffolded: "2026-10-11"
scope: ["we:scripts/conveyor/referral-auto-block.mjs", "we:scripts/lib/ruling-ledger.mjs", "we:scripts/lib/__tests__/ruling-ledger.test.mjs", "we:scripts/conveyor/__tests__/referral-auto-block.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Auto-block re-blocks a mandatory referral that the mandatory reviewer already ruled not-real on the same head

Live PR #4847 (card 5762), head 062493d0d: at 04:01:32Z the mandatory correctness reviewer recorded a finding-specific not-real ruling for the judgeCorrectnessAdvisory finding at line 85 of card 5762 'Add explicit planned tests for supervised children with missing or malformed scheduler tokens' (the Test plan already names those tests). At 04:01:39Z the advisory still listed it as 'Awaiting a ruling', and at 04:04:20Z review.referralDefault=auto-block ruled it block and sent the PR back to a fixer (round 5). The same finding had been 'raised again' in rounds 1-4 and each fixer re-edited the card, so the loop never converges. Expected: a not-real (or card) ruling on the current head for the same finding key satisfies rulingNeeded/mandatoryReferralState, so planAutoBlock skips it; and a finding re-raised N rounds should reach the dispute ladder (operator) instead of another auto-block. Fix in the ruling ledger and the auto-block pass with a regression test that replays the #4847 comment sequence; prove on #4847 (auto-block dry-run plans nothing for that key).

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
