---
bornAs: xkwh72c
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Fixers re-design what a ruling or card already settled

[held entry 291] (coroner 2026-10-13, held) Fixers re-design what a ruling or card already settled. #5025: operator ruled F1 "card xztd0mv" (21:16Z 10-12) but fixers saw "auto-blocked" and the takeover built the carve-out inside the PR; a ci-heal Codex commit (89a4be6ca) reversed the card's core rule. Each new hold state spawned new findings (fix-introduced 7 of ~25), open findings 2->3 after takeover; ~11h fix/review loop. Fix idea: the fix brief carries the PR's carve-out list + rulings (incl. branch-only cards) as binding; a fix diff touching a ruled/carved region is refused with a pointer; ci-heal route may only commit test/env repairs (semantic diff -> refuse); a takeover is scored on its own head. #5216 covers only the auto-policy override. Evidence: PR #5025 comments 6130011708, 6149123404; scratchpad pr5025/phase-timeline.txt. Scope: we:scripts/conveyor fix brief, fix-run, ci-heal launcher. Size 5.

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
