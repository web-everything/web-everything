---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Remote heavy-test execution on Forge (R150)

MED priority hint. ## (held 2026-10-26 19:12 ET) Remote heavy-test execution on Forge (R150) Add a remote mode to we:scripts/readiness/heavy-admission.mjs. When the Mac load is high (policy-cascade threshold) or by policy, sync the lane working tree (committed and uncommitted changes) to Forge over ssh/rsync into a per-run directory under a dedicated non-runner user, run the same command, and stream back the output and exit code in the same format. Covers verify-lane, test:unit, check:standards and daemon-rebuild smoke tests. Fail closed: if Forge is unreachable, run locally under the normal admission. No AI logins or operator secrets on Forge. Prove it: Mac load drops while worker gates still report identical results.

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
