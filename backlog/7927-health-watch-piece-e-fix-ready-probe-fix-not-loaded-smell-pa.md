---
bornAs: xu30dbs
kind: story
size: 2
status: open
scope: ["we:fix-ready-probe.mjs", "we:fix-not-loaded.mjs", "we:fix-ready.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Health-watch piece E (fix-ready probe + fix-not-loaded smell) PARKED as design

HIGH priority hint. - (HIGH, 11-02 08:59 ET) Health-watch piece E (fix-ready probe + fix-not-loaded smell) PARKED as design: audit findings grew 3→2→4 across rounds. Patches: scratchpad/e2/. Open: we:fix-ready-probe.mjs:54 subdir root passes ancestry via parent repo; we:fix-not-loaded.mjs:64 episode engine closes alert after 2 ticks with missing subject (needs health-watch-core change); we:fix-ready.mjs:72 future --at suppresses alert; we:fix-ready.mjs:27 store read lacks regular-file/size check (FIFO blocks tick). Redesign: treat fix-ready store as untrusted input behind one validated reader (clock-bounded, regular-file, size cap); engine gets an explicit "unknown keeps open" state.

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
