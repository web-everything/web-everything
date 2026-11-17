---
bornAs: x92ewnx
kind: story
size: 3
status: active
scaffoldedBy: "fix-5806"
dateScaffolded: "2026-10-23"
scope: ["we:scripts/lib/lane-repair.mjs", "we:scripts/lib/lane-hold-io.mjs", "we:scripts/lib/lane-history.mjs", "we:scripts/lib/lane-salvage.mjs", "we:scripts/lib/lane-litter.mjs", "we:scripts/operations/fix-run.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Scrub inherited git location env (GIT_DIR, GIT_REFERENCE_BACKEND, ...) in the remaining lane git helpers: lane-repair, lane-hold-io, lane-history, lane-salvage, lane-litter, fix-run (PR 5806 follow-up)

Scrub inherited git location env (GIT_DIR, GIT_REFERENCE_BACKEND, ...) in the remaining lane git helpers: lane-repair, lane-hold-io, lane-history, lane-salvage, lane-litter, fix-run (PR 5806 follow-up). Filed from a fix or review daemon run that found this gap and left it unlanded.

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
