---
bornAs: xncxpqi
kind: story
size: 3
status: active
scaffoldedBy: "fix-6381"
dateScaffolded: "2026-11-06"
scope: ["we:scripts/lib/audit-settings.mjs", "we:scripts/operations/audit-verdict.mjs", "we:scripts/operations/codex-audit.mjs"]
dateOpened: "2026-11-06"
tags: []
---

# Audit rubric hardening left from PR #6381: pin direct imports of every audit-floor family, add a catch-all and finding-count cap to computeVerdict, make findAudit tolerate non-text record fields

PR #6381 self-review: only the review-authorization family's direct imports are pinned (about 328 direct imports of the other floor families are not); computeVerdict throws on a deeply nested hunkHash (RangeError) and has no finding-count cap (about 19-80 ms per finding); findAudit in we:scripts/operations/codex-audit.mjs throws TypeError on a record whose at field is an object that cannot become text; the floor-settings scan misses JSON names built by template or looked up by key; separators outside the path token class (U+2215) are not folded; a report naming no floor file with a leading space or fullwidth scheme ships as debt (same as before the PR #6381 repair).

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
