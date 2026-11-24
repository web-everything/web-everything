---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/codex-audit.mjs", "we:scripts/operations/audit-nonconvergence.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7415 (head 94857d262)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7415 (reviewed head `94857d2620bd9914cb8ac833b89bca2ef31d3106`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/codex-audit.mjs:243` — (edge-case, degraded) Equivalent branch spellings split one audit lineage and suppress escalation
   - Scenario: Run three WEAKENED audits on distinct heads with findings 'missing authorization check', 'removed input validation', and 'disabled output escaping' in we:src/a.mjs. Let the first two discover lane/audit, then supply --branch=refs/heads/lane/audit on the third. All runs exit 1, but no design-pass request or diagnostic is emitted because lineage filtering compares the branch strings literally. Both spellings identify the same branch and should share a lineage; normalizing them produces streak 3 and escalate=true.
   - Class: live-reproduced (basis: Reproduced through exported main with injected auditor responses and an in-memory ledger. Observed three persisted records, zero escalation calls, and zero diagnostics; assessing the same records with normalized refs escalated.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/audit-nonconvergence.mjs:32` — (failing-input, degraded) A second source citation makes line movement count as a new finding
   - Scenario: On three distinct heads of lane/audit, return WEAKENED with 'we:src/gate.mjs:10 removed call to validator at we:src/validate.mjs:40', changing only the first line number to 20 and then 30. The location parser rejects multiple citations, so the fallback hashes the complete text, including line numbers. The third audit records streak 3 and requests a design pass despite the unchanged finding. Moving a citation without changing the defect should preserve its identity and leave the new-key streak at zero after the first round.
   - Class: live-reproduced (basis: Reproduced through exported main with injected responses and an in-memory ledger: the third run called escalate and persisted nonconverge.streak=3. A control sequence omitting the second citation produced no escalation.)
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
