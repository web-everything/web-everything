---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/lane-verify.mjs", "we:scripts/pr-land.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Reinforce CI-green verification source: pin workflow and re-audit

Reinforce later: the CI check-run verification source in we:scripts/lib/lane-verify.mjs trusts the GitHub Actions app id and check name test only. Also pin the workflow path and re-audit after the app-id fix (round 2 was cut at the cap; R903+R907 accepted the residual).

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
