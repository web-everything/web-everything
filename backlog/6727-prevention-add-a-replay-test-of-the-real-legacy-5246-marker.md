---
bornAs: xij069m
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ruling-resolved-stand-down.mjs", "we:skills-src/conveyor/fix-agent-brief.md", "we:scripts/conveyor/__tests__/ruling-resolved-stand-down.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a replay test of the real legacy #5246 marker with a stated expected outcome. Reword the PR d… (from web-everything/web-everything#5309 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ruling-resolved-stand-down.mjs:36` — Add a replay test of the real legacy #5246 marker with a stated expected outcome. Reword the PR description to match.
2. `we:scripts/conveyor/ruling-resolved-stand-down.mjs:33` — Run the resolver and `pr-status-label` over lapse-annotated comments, or add a lapse-aware variant of `latestUnresolvedStandDown`. Add a test with an older head-bound hold that has lapsed.
3. `we:skills-src/conveyor/fix-agent-brief.md:177` — Give the brief two command blocks (bound and unbound). Make the brief test require `--finding-refs` only in the bound block.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5309@7129c4501ffb44b3fdfbe32e85ea87744782ff49

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
