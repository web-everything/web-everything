---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-item-tasks.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5934 (head 2e3a24712)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5934 (reviewed head `2e3a2471214bd38c0d27a016015f49cba4a380e7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-item-tasks.mjs:334` — (edge-case, degraded) Nullish probe rejections bypass failure persistence
   - Scenario: With valid facts, plan, budgets and claim ports, supply effects.probe = ({gh}) =&gt; gh.read(() =&gt; { throw null; }). The catch handler dereferences error.outcome and runItemTask rejects with TypeError. The claim is released, but no attempt result is persisted and failureCount remains 0. Reproduced with both null and undefined; an Error rejection correctly persists failed and charges one failure. Nullish probe failures should likewise produce a durable failed outcome and exactly one failure charge.
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
