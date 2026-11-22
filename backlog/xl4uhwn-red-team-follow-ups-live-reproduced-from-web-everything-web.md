---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/agent-launch.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced] from web-everything/web-everything#7170 (head 79790bedd)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7170 (reviewed head `79790bedd7f703ce0fc34f234a2d7b6f8cc9b89d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/agent-launch.mjs:38` — (edge-case, degraded) Sparse-array validation admits holes disguised by non-index numeric properties
   - Scenario: Set const dirs = ['/safe-a', , '/safe-b']; dirs['4294967295'] = '/decorator'; then supply dirs as addDirs in an otherwise valid Codex descriptor. The property-count check passes because its numeric-key regex accepts 4294967295, which is not an array index. The hole survives snapshotting, paths().map skips its validation, and launchAgent reaches spawn with undefined after --add-dir. A real Node subprocess serialized that value as the relative path 'undefined'. Using the same array as writable_roots emits a null entry. Both inputs should be rejected before binary resolution or spawn.
   - Class: live-reproduced (basis: Read-only probes confirmed ordinary sparse arrays are rejected, while this decorated sparse array passes production binary resolution and reaches an injected spawn. A real Node child confirmed undefined becomes the literal argv token 'undefined'.)
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
