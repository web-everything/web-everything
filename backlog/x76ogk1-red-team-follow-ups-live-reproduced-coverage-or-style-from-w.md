---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/rerun-failed-once.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7366 (head 248b9b9a2)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7366 (reviewed head `248b9b9a2757887280cb826d6cebe55c1d7ad551`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/rerun-failed-once.mjs:153` — (edge-case, degraded) The retry allowance persists across distinct runs in the same workspace.
   - Scenario: Complete an allowlisted retry for shard 2 in run 123, leaving we:coverage/rerun-used-2.json. Reuse the workspace for run 124 with matching fresh first-run identity and failure report. The script returns 1 with 'retry allowance already used' without launching a retry. A distinct run should receive its own once-only allowance; repeated invocations within that run should remain blocked.
   - Class: live-reproduced (basis: Reproduced through rerunOnce with persistent in-memory IO: run 123 returned 0 and launched once; run 124 returned 1 with the total launch count still one. Requires retaining the coverage directory between runs. The script is currently unwired and disabled by default.)
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
