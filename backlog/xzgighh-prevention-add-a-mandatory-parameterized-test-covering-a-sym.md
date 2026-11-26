---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/agent-launch.test.mjs", "we:scripts/lib/agent-launch.mjs", "we:scripts/__tests__/agent-launch-structure.test.mjs", "we:scripts/lib/__tests__/agent-launch.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a mandatory parameterized test covering a symlinked, writable and foreign-owned manifest inde… (from web-everything/web-everything#7508 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/agent-launch.test.mjs:363` — Add a mandatory parameterized test covering a symlinked, writable and foreign-owned manifest independently of guard-file validity.
2. `we:scripts/lib/agent-launch.mjs:347` — Gate on an admission callback that attempts nested mutations and assert the spawn receives the original argv and environment.
3. `we:scripts/__tests__/agent-launch.test.mjs:255` — Add deterministic self-cycle and mutual-cycle cases asserting cyclic-value refusal before any IO seam executes.
4. `we:scripts/__tests__/agent-launch.test.mjs:336` — Add a mandatory account-map state matrix covering missing, unreadable, empty and enforcing maps, asserting refusal before binary resolution or spawn.
5. `we:scripts/__tests__/agent-launch.test.mjs:62` — For every guard refusal in the acceptance list, require one test that asserts the exact refusal message for that guard and fails when that guard is removed. Add a mutation-style lint or checklist item for 'regex alternation over multiple guard messages'.
6. `we:scripts/lib/agent-launch.mjs:287` — Add a launcher test that passes an empty or absent accountMap with a daemon XPC_SERVICE_NAME and asserts refusal. That test stays red until CLAUDE-ACCOUNT-FAILCLOSED lands, so file it with that card.
7. `we:scripts/__tests__/agent-launch-structure.test.mjs:29` — Restrict the exclusions to __tests__ (matching the repo-scan-tests matcher), or add a check:standards rule that production .mjs files must not live under tests/ or fixtures/ directories.
8. `we:scripts/__tests__/agent-launch.test.mjs` — Add a deterministic regression test exercising default manifest loading with symlinked, foreign-owned, and writable manifest fixtures.
9. `we:scripts/__tests__/agent-launch.test.mjs` — Add a deterministic test whose admission callback attempts nested mutations, catches rejection, returns true, and verifies the spawn receives the original arguments and environment.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7508@63d645e1b3bf24cc7e14b92df0b87172e67a5dce

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
