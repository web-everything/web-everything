---
bornAs: x0ldmxi
kind: story
size: 1
status: active
scaffoldedBy: "fix-6381"
dateScaffolded: "2026-11-05"
scope: ["we:scripts/operations/codex-audit.mjs"]
dateOpened: "2026-11-05"
tags: []
---

# codex-audit findAudit and resolvePriorQuestionHashes trust non-string record fields (Date.parse on an object throws; an array acceptUntil is accepted)

Found by the PR #6381 self-review (same class as its red-team finding 3, outside that PR's files). findAudit in we:scripts/operations/codex-audit.mjs calls Date.parse(record.at) with no typeof guard, so an audit-log record with at={"toString":0} throws TypeError instead of resolving to a strict verdict (we:scripts/operations/prototype-load.mjs has no local catch). resolvePriorQuestionHashes accepts acceptUntil=["2099-12-01"], while validHashes in we:scripts/lib/audit-settings.mjs now requires a string, so the two readers of one settings key disagree. Fix: require typeof string before Date.parse in both, add negative tests.

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
