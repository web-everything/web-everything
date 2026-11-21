---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/progress-board.test.mjs", "we:scripts/__tests__/lane-pool-git-diet.test.mjs", "we:scripts/ci/test-timings.json"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add one explicit test that spawns the real CLI for a render and for a failing verb. It should ass… (from web-everything/web-everything#7266 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/progress-board.test.mjs:90` — Add one explicit test that spawns the real CLI for a render and for a failing verb. It should assert the exit code and stdout bytes, so the entry-point contract is pinned independent of `cli()` internals.
2. `we:scripts/__tests__/lane-pool-git-diet.test.mjs:367` — Also hook `spawnSync` and `spawn` in the preload, or assert the destructive-command absence through reflog and ref state. A lint that flags traced-call negative assertions without a seam-completeness check would be a heavier option.
3. `(cited file withheld: not a plain path)` — Add a deterministic acceptance-evidence check requiring a named check and its result for every guarantee, including timing and mutation evidence.
4. `we:scripts/ci/test-timings.json` — Add a named CI timing check, such as progress-board-runtime-budget, comparing measured duration with the accepted baseline under comparable conditions.
5. `(no file cited)` — Add a named assertion-preservation check comparing the original and revised test assertions, with explicit handling for intentional replacements.
6. `(no file cited)` — Capture a deterministic mutation report listing each changed guard and its failing test names; required cases should explicitly cover release bypass, stale-ops containment, and unreadable board state.
7. `(no file cited)` — Add a named CI timing-evidence check requiring run identifiers and comparable before/after file and slowest-shard durations.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7266@9da67f127176be207bd50b4b2f24eaee29402da1

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
