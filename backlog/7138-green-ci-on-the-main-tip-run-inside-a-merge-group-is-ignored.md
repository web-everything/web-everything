---
bornAs: x8gzw9v
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Green CI on the main tip, run inside a merge group, is ignored as proof that main's red was a flake

[held entry 303] (coroner-redmain 2026-10-14, held) Green CI on the main tip, run inside a merge group, is ignored as proof that main's red was a flake. During red main 62da75ed3, 12 merge groups were built on base 28a7885f1 (the main tip). Two of them ran the full we:ci.yml green: pr-5257 at 02:25 ET and run 38546745241 at 06:18 ET. Main stayed red until the manual re-run went green at 06:43 ET (~4h18m after the first green proof). Fix idea: main-ci-red reads we:ci.yml runs on merge_group/PR refs whose base is the current main tip. A fully green run that includes the failed jobs is a flake-evidence signal. It triggers #5271's once-only re-run of main right away. It never marks main green by itself; main's own run decides. Evidence: gh run list --event merge_group 2026-10-14 05:53Z–10:50Z (headBranch gh-readonly-queue/main/pr-*-28a7885f1…). Scope: we:scripts/conveyor/main-ci-red-core.mjs, we:main-ci-red-io.mjs (after #5271). Size 2.

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
