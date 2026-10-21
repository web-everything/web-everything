---
kind: story
size: 2
status: active
scaffoldedBy: "fix-5530"
dateScaffolded: "2026-10-21"
scope: ["we:scripts/prune-landed-lanes.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# prune-landed-lanes: fail closed when the open-PR read hits its --limit 200 cap

The prune keeps any lane branch an open PR targets (or heads), but its open-PR read uses gh pr list --limit 200 with no truncation check. With more than 200 open PRs, a branch an open stacked PR targets can be missed and deleted, and GitHub then closes that PR and refuses retarget or reopen (#2578). Slice 4 of the stacked-PR policy (x44bz7l, PR #5530) relies on this protection for a closed base's branch. Fix: treat a read that returns exactly the limit as truncated and withhold every delete that pass (fail closed), with a test.

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
