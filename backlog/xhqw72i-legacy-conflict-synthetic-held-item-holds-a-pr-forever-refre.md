---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/review-set-label.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Legacy-conflict synthetic held item holds a PR forever; refresh onto main instead of a human override

A legacy 'ran' red-team status with legacyHoldPublished:true and no seal yields a synthetic legacy-conflict held item (file/index null) no ruling can match; label sync skips already-blocked PRs so the PR is held forever (#6777, 15h). A human-ruling override was PARKED after 2 audit rounds (lane/redteam-legacy-clear, auditor rejects any override that does not restore evidence). Replacement: when the ONLY hold is a legacy-conflict synthetic item, the review daemon requests a refresh onto main so a new head gets a fresh red-team. Owed 2026-11-14 10:45 and 16:03 ET.

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
