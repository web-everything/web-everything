---
bornAs: xgtbrr3
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/nightly-coroner-job.mjs", "we:scripts/operations/coroner-false-findings.mjs", "we:scripts/conveyor/__tests__/nightly-coroner-job.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Nightly coroner calls coroner-false-findings with options it accepts

Live: the 2026-10-17 nightly coroner failed 3/3 with "coroner-false-findings: Unknown option" for `--since/--until`. we:scripts/conveyor/nightly-coroner-job.mjs passes `--since --until --json` but we:scripts/operations/coroner-false-findings.mjs parseArgs accepts only `since` and `json`. Align the job args with the script CLI. [A1] Executable: a test that the argv the job builds parses cleanly through the script parseArgs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/nightly-coroner-job.test.mjs` fails before (argv with --until does not parse via parseArgs) and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the coroner report format.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no free text is parsed beyond existing validated fields.
2. **Truncated reads** — The change reads bounded inputs only; a truncated read counts as unknown, never as clear.
3. **Shared state files** — State files are written atomically through the existing helpers; no new shared file.
4. **Fail closed** — On any error the guard refuses or keeps the prior state, never silently proceeds.
5. **Identity scoping** — n/a: keyed by repo + PR number + head sha, as today.
6. **State over time** — Debounce or cursor state expires on its own and survives a restart.
7. **Who wrote it** — n/a: operator-facing tooling; authorship is not trusted for decisions.
