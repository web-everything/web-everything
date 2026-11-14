---
kind: story
size: 3
status: active
scaffoldedBy: "ai-routing-pr1"
dateScaffolded: "2026-11-14"
dateOpened: "2026-11-14"
tags: []
---

# ai-routing PR1: close three open audit findings (final-policy validation, fix-chain safety, operator override precedence)

Parked ai-routing PR1 (lane-20 commit 769002e6aa) was judged WEAKENED twice by the canonical audit. Rule: an overlay may only narrow, never remove an existing guard. Close three findings, each with a red probe test first. (1) we:scripts/lib/ai-routing.mjs:200 inherited routes skip final policy validation; probe: `fix` returned Codex with gateClosed:true and available:['claude']. (2) we:scripts/lib/ai-routing.mjs:159 role overlays overwrite fix-chain safety decisions; probe: critical takeover and routing.builder=claude both flipped to Codex after a role override. (3) we:scripts/lib/ai-routing.mjs:189 task-scoped role entries outrank operator overrides; probe: `build` task type bugfix changed from operator Claude Opus to role Codex Astra, reporting source platform.

Redesign note: overlays must be inputs to the existing resolvers (applyRoutingOverrides/resolveOperationRoute/fix-chain), never post-hoc edits of their output; inherited routes must also pass final policy validation.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/ai-routing.test.mjs` contains one probe per finding above that fails on the parked commit and passes after the fix.

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

## Duplicate admission

new findings from canonical audit of ai-routing PR1; no existing card
