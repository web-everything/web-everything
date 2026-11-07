---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-rebuild/state.mjs", "we:scripts/lib/pr-state-io.mjs", "we:scripts/lib/pr-state-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# /state N has no repo argument: asking about a Frontier UI or plateau-app PR number reads the web-everything P…

Flow-sim gap R8b-G4, class K12 (identity keyed by location, not content). Failing input: plateau-app PR #412 exists and is held; web-everything PR #412 also exists (or not).' 'Operator (or the /state skill) runs `node we:scripts/state.mjs 412`. Cited: we:scripts/lib/daemon-rebuild/state.mjs:33, we:scripts/lib/pr-state-io.mjs:85, we:scripts/lib/daemon-rebuild/state.mjs:35, we:scripts/lib/pr-state-core.mjs:44. Soak-break sketch: Fixture: gh stub answering only repos/web-everything/web-everything for PR 412 (state OPEN, label review:human). Action: main(['412']) - there is no way to pass a plateau-app repo. Assert a --repo (or repo-qualified arg) is accepted and the output names the r…

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
