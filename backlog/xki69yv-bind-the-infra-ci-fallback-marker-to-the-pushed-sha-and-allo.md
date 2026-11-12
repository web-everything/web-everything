---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/operations/prototype-load.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# Bind the infra CI-fallback marker to the pushed sha, and allow per-base ruled-weakened entries in prototype-load

Two follow-ups from the await-verify CI-green fallback (R895+R903 residuals). (1) we:scripts/conveyor/await-verify-pass.mjs infraCiGreenFallback must require marker.sha and marker.treeHash to equal record.sha and the lane treeHash, in both the first check and the re-read after the CI reads. (2) we:scripts/operations/prototype-load.mjs ruled-weakened matching uses one findings list per sha, but audits are per base: re-auditing against a moved main makes the ruling unmatchable; allow per-base ruled entries.

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
