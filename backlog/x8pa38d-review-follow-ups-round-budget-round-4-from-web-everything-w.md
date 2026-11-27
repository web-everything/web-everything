---
kind: story
size: 2
status: open
scope: ["we:scripts/guard-bash.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Review follow-ups (round-budget, round 4) from web-everything/web-everything#7586

Filed mechanically by the unattended review loop: web-everything/web-everything#7586's review (reviewed head `c045bba8f08da6cad6d67155445845589817b6f7`) (finding set `2aab7490e0413ff4`) was accepted because round 4 is past the round budget K=3 and no finding is broken (card 5471). Each finding below was deferred to this card instead of another fix round:

1. `we:scripts/guard-bash.mjs:4560` — correctness, CONFIRMED degraded: In rawPrCreation's 'gh api' loop, 'else if (hidden(k)) return 'dynamic'' fires for any positional arg containing an unquoted '?', '*' or '[', because 'argvWordShape(raw, true)' now flags patterns at any offset. Read-only calls are therefore denied with a 'raw PR creation' message.

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
