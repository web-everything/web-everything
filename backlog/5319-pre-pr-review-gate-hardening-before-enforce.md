---
bornAs: xsjn0uf
kind: story
size: 5
status: open
scope: ["we:scripts/lib/pre-pr-review.mjs", "we:scripts/converge-cli.mjs", "we:scripts/operations/open-pr-io.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Pre-PR review gate hardening before enforce

Harden the pre-PR review gate (PR #4271 landed in advise mode; the switch of we:scripts/pre-pr-review-settings.json to enforce happens ONLY after this card lands). Open findings: (1) an unknown WE_CONVEYOR_WORKER marker (e.g. true, 0) fails closed in we:scripts/lib/pre-pr-review.mjs but has no test; add a table-driven test over every classifySession role. (2) The audit record is written before the PR-body note (we:scripts/lib/pre-pr-review.mjs recordBypass vs withBypassInBody in we:scripts/operations/open-pr-io.mjs), so a refused open leaves a stray bypass record; record immediately before spawning pr-land and test that a refusal writes no row. (3) The receipt does not bind the submitted review material to the certified tree in we:scripts/converge-cli.mjs; generate and hash the material in the CLI and reject stale or truncated material, with a test. Operator-ruled 'block' findings the review daemon reports came back after 5 misses (ruling-dispute): (4) we:scripts/operations/open-pr-io.mjs:93 in enforce mode any exception in the gate check is swallowed into action pass (fail-open), and the settings loader falls back to advise on a missing or corrupt file; (5) we:scripts/operations/open-pr-io.mjs exceptions in the pre-PR check silently turn enforcement into permission to proceed; (6) we:scripts/converge-cli.mjs:498 receipt and the reviewed tree binding cannot succeed when the state file is inside the lane, where the brief tells agents to put it.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
