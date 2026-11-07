---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Baseline cache keyed by cwd: manifest-tamper baseline is per checkout

Flow-sim gap D-C10, class K12 (identity keyed by location, not content). Failing input: PR with a manifest first sighted by a full pass in checkout X (baseline file we:X/.claude/skills/drain/review-baseline-state.json); PR body manifest then weakened; next sighting is a fast drain run from checkout Y (a different lane clone or daemon clone)' 'tamper happens between the two sightings Cited: we:scripts/merge-ai-prs.mjs:260, we:scripts/merge-ai-prs.mjs:6073, we:scripts/merge-ai-prs.mjs:6575. Soak-break sketch: none

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
