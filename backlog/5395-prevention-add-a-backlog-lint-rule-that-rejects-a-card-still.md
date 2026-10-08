---
bornAs: xmvg96n
kind: story
size: 3
status: open
scope: ["we:backlog/5400-clone-repair-run-re-clone-before-the-safety-gates-for-a-clon.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a backlog-lint rule that rejects a card still carrying TODO placeholders in the Done-when or… (from web-everything/web-everything#4455 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4455's review (reviewed head `79aab2c2210f1bbdbf57b61f068ada386dc9f44c`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:backlog/5400-clone-repair-run-re-clone-before-the-safety-gates-for-a-clon.md:14` — Add a backlog-lint rule that rejects a card still carrying TODO placeholders in the Done-when or Edge-cases sections when it moves, loosens, or reorders a safety gate. Alternatively, require a Must line stating what remains protected (unpushed commits, stashes, dirty files).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
