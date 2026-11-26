---
kind: task
status: open
scope: ["we:scripts/operations/ruled-weakened-store.mjs", "we:scripts/operations/rewaive-plan.mjs", "we:scripts/operations/__tests__/"]
dateOpened: "2026-11-26"
tags: []
---

# Reinforce R825: prove attribution before ignoring damaged waiver evidence

Residual from PR #7493: the planner conservatively blocks matching bare or refs/heads refs, ref prefixes and withdrawal hints, but arbitrary corruption can erase every recognizable ref or revocation hint. A damaged withdrawal with neither its ref nor a hint can still be classified as unrelated. Replace heuristic attribution with verifiable record framing or another fail-closed attribution rule, retaining the ability to plan when damage is demonstrably unrelated. Explicitly cover the shared readers and the default admission behavior; no malformed evidence may grant a waiver.

## Acceptance

- [A1] **Executable** — Planned `unattributable damaged withdrawal cannot preserve an earlier waiver` in we:scripts/operations/__tests__/rewaive-plan-malformed-line.test.mjs supplies an earlier valid waiver and a withdrawal corrupted to remove both recognizable ref and revocation hints. Run `npm run test:unit -- <malformed-line-test-file>`; the plan must refuse rather than emit audit-needed or request.
- [A2] **Executable** — Planned `verifiably unrelated damage preserves an eligible request` in the same file exercises the chosen framing/attribution format through the real loader and JSON CLI output, asserting state request, the current head's findings, and an operator-visible damage report. Document how that format proves unrelatedness.
- [A3] **Executable** — Parameterize malformed/truncated framing, unsupported historical formats, unreadable evidence, escaped ref spellings and invalid checksums in the same suite. Unknown attribution refuses; existing callers that omit the relaxation remain fail closed.

## Non-goals

- [N1] No new waiver grants, approval-policy changes, or automatic rewriting of historical request logs. Writer source ownership is tracked separately by #xcv3tgn.

## Edge cases this change must handle

1. **Untrusted text** — Treat logs as data; test escaped keys/values, newline splits and non-ASCII corruption. Do not infer trust from a revocation keyword alone.
2. **Truncated reads** — Incomplete or missing attribution refuses and explains recovery; preserve the existing input bound and oversized-log fallback.
3. **Shared state files** — Preserve append-only histories; design any framing with concurrent writers and interrupted appends in mind.
4. **Fail closed** — Unknown, unreadable or unverifiable attribution blocks the plan; it never authorizes a carry. No network endpoint is added.
5. **Identity scoping** — Normalize equivalent ref spellings consistently without conflating distinct branches or repositories.
6. **State over time** — An earlier approval must not survive an uncertain later withdrawal; historical formats need an explicit conservative compatibility rule.
7. **Who wrote it** — Attribution evidence must come from the writer's verifiable record format, not a guess over damaged free text.

## Duplicate admission

#8641 covers audit carry binding and parsed malformed withdrawals; this card covers wholly unparseable withdrawal attribution after arbitrary corruption.
