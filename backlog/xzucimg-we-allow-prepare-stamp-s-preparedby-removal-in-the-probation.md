---
kind: task
status: active
scaffoldedBy: "fix-5242"
dateScaffolded: "2026-10-14"
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# we: allow prepare-stamp's preparedBy removal in the probation prepare tamper check

PR #5242 makes prepare-stamp remove the operator filing marker `preparedBy` (it used to remove `operatorTask`). The probation prepare runner (we:scripts/operations/probation-build-run.mjs, the frontmatterTamperedBeyondClaim calls with PREPARE_OWNED_FRONTMATTER_KEYS) compares the card before and after prepare-stamp, and neither PREPARE_OWNED_FRONTMATTER_KEYS nor CLAIM_OWNED_FRONTMATTER_KEYS lists `preparedBy`. So a probation prepare of an operator card that was stamped at filing (re-prepared when stale, or held while build.operatorTask.enabled=false) is likely flagged as frontmatter tamper and escalated. Fix: add `preparedBy` to the keys prepare-stamp is allowed to change (removal only), with a test that runs prepare-stamp on a card carrying preparedBy: "operator-filing" and shows the tamper check passes. Found by the fix agent on PR #5242; outside that fix's scope.

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
