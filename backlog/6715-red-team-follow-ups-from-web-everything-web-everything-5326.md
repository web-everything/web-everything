---
bornAs: xdzq928
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle-holders.mjs", "we:scripts/lib/gh-argv.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5326 (head c6d5632b0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5326 (reviewed head `c6d5632b088945471a3d1f59cade4ef2a92722d7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/gh-throttle-holders.mjs:153` — (edge-case, degraded) Concurrent admissions can exceed perCallerMax and occupy all six slots.
   - Scenario: With cap=6 and perCallerMax=4, start with three live holders belonging to caller worker. Three additional worker processes each snapshot those three holders before any acquires. All pass capped(), then atomically acquire different free slots. A deterministic in-memory interleaving of the unchanged acquisition function returned three successful acquisitions and sameCallerHeld=6. The caller limit should admit only one additional holder, preserving capacity for other callers.
   - Claude's re-check: acquireGhHolderSlot evaluates capped() on a read-only snapshot and then calls trySlot without re-checking. Concurrent processes that each saw 3 same-caller holders can all pass the check and acquire different free slots, exceeding perCallerMax.
2. `we:scripts/lib/gh-argv.mjs:53` — (failing-input, degraded) Valid short flags with equals misclassify GET requests as writes.
   - Scenario: Pass ['api','-X=GET','user']. The parser retains the equals sign, producing method '=GET', so classifyGhWrite returns true. A local gh probe with a synthetic token and GH_HOST=127.0.0.1 showed gh itself constructing GET /api/v3/user; the connection was blocked and no GitHub quota was spent. These reads incorrectly consume the write budget and can wait behind exhausted mutation capacity. The parser should recognize -X=GET as GET and classify this invocation as a read.
   - Claude's re-check: In parseGhApiArgs, '-X=GET' yields rest='=GET', so the pushed method is '=GET'. classifyGhWrite then returns true because '=GET' is neither GET nor HEAD. pflag treats '-X=GET' as value GET, and the diff's own pflagLongValue handles the '-x=value' form, so this is a real misclassification.

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
