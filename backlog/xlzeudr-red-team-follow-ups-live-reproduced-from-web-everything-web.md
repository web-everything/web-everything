---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/agent-launch.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced] from web-everything/web-everything#7170 (head a65fbbfd0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7170 (reviewed head `a65fbbfd0c0fc3ccdfd27e2697f9099c06b0ecec`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/agent-launch.mjs:37` — (failing-input, degraded) Sparse arrays bypass validation and emit unchecked --add-dir operands.
   - Scenario: Set addDirs = new Array(2), addDirs[1] = '/intended-root', and addDirs['4294967295'] = '/decoration'; pass it in an otherwise valid Codex descriptor. The property-count check passes because the regex accepts 4294967295, which is not an array index. Snapshotting preserves the hole, paths().map skips its validation, and launchAgent reaches spawn with '--add-dir', undefined. Node serializes that operand as the relative string 'undefined', violating the absolute-path grammar. The descriptor should be rejected before resolver or spawn by checking that every index from zero through length minus one
   - Class: live-reproduced (basis: Read-only Node probes observed launchAgent calling the spawn seam with an undefined operand. A separate real Node child confirmed that spawn serializes undefined argv entries as the literal string 'undefined'.)
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
