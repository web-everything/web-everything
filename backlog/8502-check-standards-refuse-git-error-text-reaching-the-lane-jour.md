---
bornAs: xnxfqnx
kind: story
size: 3
status: active
scaffoldedBy: "fix-6319"
dateScaffolded: "2026-11-09"
scope: ["we:scripts/check-standards.mjs", "we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-09"
tags: []
related: ["6319"]
---

# check:standards: refuse git error text reaching the lane journal or JSON output without URL-credential redaction

check:standards: refuse git error text reaching the lane journal or JSON output without URL-credential redaction. Context from the finding: security prevention owed by the PR 6319 advisory review: msgOf(e) reached journalLaneEvent and boundedDetails unredacted; route all such text through redactUrlCredentials and lint for unwrapped error messages.

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

security prevention owed by the PR 6319 advisory review: msgOf(e) reached journalLaneEvent and boundedDetails unredacted; route all such text through redactUrlCredentials and lint for unwrapped error messages
