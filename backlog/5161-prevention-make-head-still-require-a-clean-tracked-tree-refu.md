---
bornAs: xzbp748
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-drain.mjs", "we:scripts/__tests__/lane-drain.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Make head still require a clean tracked tree: refuse or fall back to worktree when diff-index rep… (from web-everything/web-everything#4013 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-drain.mjs:774` — Make `head` still require a clean tracked tree: refuse or fall back to worktree when `diff-index` reports a difference. Alternatively, add a test that forces head on a dirty tracked file and asserts that no local content is lost.
2. `we:scripts/lane-drain.mjs:775` — Extend the HEAD/worktree parity test with a deterministic clean/smudge or working-tree-encoding fixture, and gate the optimization on preserving those worktree semantics.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4013@b3bae4f80a34d02be1fba5a98b734ec9ea083e00

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
