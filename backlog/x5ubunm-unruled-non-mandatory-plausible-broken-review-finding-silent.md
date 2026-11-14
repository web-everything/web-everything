---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Unruled non-mandatory PLAUSIBLE+broken review finding silently parks the unattended accept

requiresMandatoryReferral covers CONFIRMED only, so an unruled PLAUSIBLE+broken finding parks an unattended accept and burns panel runs (6 on #6790). Widen to PLAUSIBLE+broken with severity-aware coverage in the sink dedup (we:scripts/operations/review-pr-io.mjs ~1333) and the round filter (we:scripts/lib/jury-core.mjs ~1565, we:scripts/operations/review-pr.mjs ~2990). WIP branch lane/review-paused-6790-wip (2 audit rounds WEAKENED). Owed 2026-11-14 09:49 ET.

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
