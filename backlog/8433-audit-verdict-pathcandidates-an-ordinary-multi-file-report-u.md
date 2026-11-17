---
bornAs: x3v4gvg
kind: story
size: 2
status: active
scaffoldedBy: "fix-6381"
dateScaffolded: "2026-11-09"
scope: ["we:scripts/operations/audit-verdict.mjs", "we:scripts/operations/__tests__/audit-verdict.test.mjs"]
dateOpened: "2026-11-09"
tags: []
related: ["6381"]
---

# audit-verdict pathCandidates: an ordinary multi-file report under an anchored folder (four comma-joined line:col entries) or under a wildcard-first caller glob still passes the 32-candidate bound and fails closed into recheck

audit-verdict pathCandidates: an ordinary multi-file report under an anchored folder (four comma-joined line:col entries) or under a wildcard-first caller glob still passes the 32-candidate bound and fails closed into recheck. Context from the finding: fail-closed over-block left after the PR 6381 fix-6381 self-review cap.

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

## Duplicate admission

fail-closed over-block left after the PR 6381 fix-6381 self-review cap
