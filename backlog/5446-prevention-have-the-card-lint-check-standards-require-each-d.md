---
bornAs: xcf0twe
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5441-permission-change-compare-workflow-permissions-trees-structu.md", "we:backlog/5442-permission-change-detect-sandbox-list-edits-whose-owning-key.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Have the card-lint (check:standards) require each "Done when" Must line to state its outcome as a… (from web-everything/web-everything#4492 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5441-permission-change-compare-workflow-permissions-trees-structu.md:19` — Have the card-lint (`check:standards`) require each "Done when" Must line to state its outcome as an explicit observable (reports `X` / returns null) rather than a bare verb like "holds" or "stays".
2. `we:backlog/5441-permission-change-compare-workflow-permissions-trees-structu.md:20` — Add a card-template lint that requires every 'Must (other input kinds)' line to use an explicit verb (reports/stays free). Add a 'removed or narrowed-to-default' row to the permission-change card checklist.
3. `we:backlog/5442-permission-change-detect-sandbox-list-edits-whose-owning-key.md:30` — Add a check:standards rule for backlog cards: each 'Edge cases' line that states a cap or hold must cite a Done-when item or a named test. Otherwise require `n/a:`.
4. `we:backlog/5441-permission-change-compare-workflow-permissions-trees-structu.md:28` — Add a deterministic backlog-card gate requiring each behavioral constraint to reference a planned test file, case name, and observable assertion, including read-range assertions for bounded reads.
5. `we:backlog/5442-permission-change-detect-sandbox-list-edits-whose-owning-key.md:28` — Use the same deterministic constraint-to-test backlog gate, requiring named cases and observable limit and refusal assertions for each safety requirement.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4492@3d61e34b1c2c14d8e834fc5f927e9d2365b52411

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
