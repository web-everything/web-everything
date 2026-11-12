---
bornAs: x5zeuoi
kind: story
size: 3
status: open
dateOpened: "2026-11-11"
tags: []
related: ["6535"]
---

# Red-team verdict: a trusted newer result with no/ malformed findings supersedes a confirmed break (reinforce the fold)

`deriveRedTeamVerdict` folds red-team evidence through `readRedTeamDisposition`, which is latest-result-wins per head. A trusted, same-PR, same-head result posted AFTER a confirmed break replaces it, including a malformed one (a header that claims a break with no parseable finding lines) and a carried empty result from the break's head. The verdict then reads `clear` and the break is gone. This item reinforces the fold so a superseding result must be complete (a real re-run that covers the earlier break) before it can release a recorded break. Today's behaviour is pinned by characterization tests in `we:scripts/lib/__tests__/red-team-verdict.test.mjs`.

## Acceptance

- [A1] **Executable** — `npm run test:unit` on the test file `we:scripts/lib/__tests__/red-team-verdict.test.mjs` fails before this item lands and passes after. The `known weakness (#8156)` block currently pins the weakness (the malformed-result and carry-hop tests expect `clear`); landing this item flips those assertions to `held`, so the file is red until they are updated deliberately.
- [A2] **Executable** — the same test file gains a test that a newer trusted same-head result whose header claims a break but carries no parsed finding lines is `held`, never `clear`, when an earlier confirmed break exists on that head.
- [A3] **Executable** — the same test file gains a test that a trusted carry of an empty result onto the live head does not release a break recorded on the carried-from head.

"Complete" means: a superseding result may release an earlier break only if its header and its parsed finding lines agree (a header claiming N findings parses to N lines). A well-formed clean result (header says no break found) after a fix is the intended release path and stays `clear`; the first characterization test records today's behaviour for that case and is not a defect.

## Non-goals

- [N1] Changing who is trusted, the round-cap rule or the operator-ruling release path: those stay in `we:scripts/lib/red-team-gate.mjs`.
- [N2] Changing the drain hold wording (`redTeamVerdictHoldReason` in `we:scripts/lib/red-team-verdict.mjs` stays byte-identical).

## Edge cases this change must handle

1. **Untrusted text** — a result comment is model-written text; completeness is judged from parsed finding lines only, never from free text in the body.
2. **Truncated reads** — a truncated thread already holds in `deriveRedTeamVerdictDetail`; a truncated superseding result must not count as complete.
3. **Shared state files** — n/a: the verdict is a pure fold over PR comments, no state file.
4. **Fail closed** — a superseding result that cannot be shown complete leaves the earlier break holding.
5. **Identity scoping** — only a result for the same PR and the same head can supersede; another PR on the same head never does (pinned by a control test).
6. **State over time** — a break stays held until a complete newer result or an operator ruling releases it; ordering uses the thread order the gate already uses.
7. **Who wrote it** — only trusted authors count; an untrusted newer clean result never supersedes (pinned by a control test).

## Duplicate admission

slice 1 audit finding on deriveRedTeamVerdict; inherited from readRedTeamDisposition latest-result-wins

new: completeness check on superseding results
