---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/backlog-placement-trial.mjs", "we:scripts/__tests__/backlog-placement-trial.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a lint rule or shared helper (isMainModule(import.meta.url)) that uses pathToFileURL, and req… (from web-everything/web-everything#7269 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/backlog-placement-trial.mjs:103` — Add a lint rule or shared helper (`isMainModule(import.meta.url)`) that uses `pathToFileURL`, and require the CLI test to run from a spaced path.
2. `we:scripts/__tests__/backlog-placement-trial.test.mjs:21` — Use a table-driven `it.each` over Placement values (plateau, we, everstandards, everstandards/settled, unmatched) and add a coverage threshold on the script.
3. `we:scripts/backlog-placement-trial.mjs:110` — Add the deterministic path-swap regression to CI and require a mutation that writes by pathname to fail; the guard remains to be filed.
4. `we:scripts/backlog-placement-trial.mjs:101` — Use pathToFileURL for the entrypoint comparison and gate it with a CLI regression using a script location containing spaces.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7269@e33f0e3ca5c1d4f205b884fd16cf066a22d9ac16

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
