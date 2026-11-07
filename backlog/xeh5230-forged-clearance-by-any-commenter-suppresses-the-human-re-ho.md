---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/review-escalation.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/marker-authorship.mjs", "we:scripts/check-standards-rules.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Forged clearance by ANY commenter suppresses the human re-hold for a pass

Flow-sim gap C-G1, class K8 (authority asymmetry). Failing input: PR labels [review:accepted] (no review:human), humanRequired fresh score true, plain trusted accept comment with reviewed-sha A + a recorded reviewed-diff fingerprint, live head B != A, this pass's live diff read FAILED (headReadFailed). An outsider posts a comment starting '✅ review — `review:human` cleared via the sanctioned … Cited: we:scripts/lib/review-escalation.mjs:1953-1966, we:scripts/merge-ai-prs.mjs:784, we:scripts/lib/marker-authorship.mjs:43-46, we:scripts/check-standards-rules.mjs:55, we:scripts/lib/review-escalation.mjs:2044. Soak-break sketch: none found (grep clear-human/cleared-human/clearance in soak/breaks)

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
