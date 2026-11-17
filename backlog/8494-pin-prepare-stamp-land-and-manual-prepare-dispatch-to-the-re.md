---
bornAs: xl6b73h
kind: task
status: active
scaffoldedBy: "fix-5366"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/conveyor/prepare-stamp-land.mjs", "we:scripts/operations/dispatch-lane-io.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Pin prepare stamp-land and manual prepare dispatch to the refused prepare PR

Follow-up from PR #5366 round 6. The build daemon now pins a probe-started stamp recovery to the refusing prepare PR (prepareRecoveryPins), but we:scripts/conveyor/prepare-stamp-land.mjs still reads the newest PR of any state (readStatus({num})), so a newer CLOSED duplicate PR next to an older OPEN sectioned one makes the stamp worker fail with 'missing sections' and file a held failure. Pass the PR number from cliStampPrepare (e.g. --pr=) and check it against the source PR. Separately, the manual dispatch-lane --num prepare-item path (we:scripts/operations/dispatch-lane-io.mjs) runs no prepareLaunchRefusal admission, so an operator launch can still duplicate an open prepare PR.

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
