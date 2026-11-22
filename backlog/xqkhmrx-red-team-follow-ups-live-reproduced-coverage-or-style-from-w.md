---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7296 (head 680a03988)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7296 (reviewed head `680a039880bfba7f1004ff7bc8f47d2ae00552d8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:697` — (edge-case, degraded) Inexact marker prefixes hide actionable feedback from trusted authors
   - Scenario: On an open, green PR labeled review:changes, make the only feedback a chalbert-authored comment: '&lt;!-- operator-park-release --&gt; is ignored: promotion still stays parked.\nFix the release parser.' The park parser correctly treats this as prose because its first line is not an exact marker, but countFindings discards it using startsWith. The ordinary fix path consequently refuses with no-findings. This prose should count as feedback; bookkeeping exclusion should require an exact marker line.
   - Class: live-reproduced (basis: Isolated execution of the production countFindings function body with the actual trust predicate returned zero for this input and one after removing the marker prefix. The production park parser returned false. Full planner execution was unavailable because markdown-it is missing; the no-findings refusal follows directly from its findings-equals-zero guard.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

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
