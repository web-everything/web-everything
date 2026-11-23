---
kind: story
size: 2
status: open
scope: ["we:scripts/__tests__/real-process-guard.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7112 (head 601bfbc3e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7112 (reviewed head `601bfbc3e3c20868f0935f7fafb5e7b5d12664aa`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/__tests__/real-process-guard.test.mjs:177` — (edge-case, degraded) Conditional returns let mock-only files pass the real-process guard
   - Scenario: List we:scripts/__tests__/mock-only.real.test.mjs in the manifest with this source: import { spawnSync } from 'node:child_process'; describe('suite', () =&gt; { if (true) return; it('unreachable', () =&gt; spawnSync(process.execPath, ['--version'])); }); it('mock-only', () =&gt; {}); The guard returns no problems because suite() checks only direct return/throw statements and treats the unreachable it() as registered. Only the mock-only test actually registers, allowing a file with zero subprocess execution to leave PR CI. The guard should reject this unreachable process claim.
   - Class: live-reproduced (basis: A read-only Node probe executing the unchanged startsRealProcess and realTierProblems functions returned true and an empty problems list. Evaluating the same JavaScript registration callbacks registered only mock-only, which passed with zero subprocess calls.)
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
