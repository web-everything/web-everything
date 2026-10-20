---
bornAs: x9diisp
kind: story
size: 3
status: resolved
dateOpened: "2026-10-18"
dateResolved: "2026-10-20"
tags: []
---

# Prototype refs stay mergeable with main automatically

Live case: prototype overlay lane/proto-daemon-resources was dropped by the daemon rebuild after main moved (health-watch at 79154ed61) because it conflicted with main in we:scripts/lib/drain-merge-strategy.mjs, we:scripts/merge-ai-prs.mjs and we:scripts/settings/drain-queue-safety.json. Fix: a pass that merges origin/main into each registered lane/proto-* overlay daily or on main moves, with Codex resolving conflicts (keep main behaviour and prototype changes; stricter guard wins), tests run for conflicted and prototype-touched files through heavy-admission, a fast-forward push, and an alert on failure. Never force-push; never load a daemon.

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

## 2026-10-19 attempt (parked)

- The work is on `lane/build-x9diisp-wip` (f1742d48e).
- `lane/build-x9diisp` (087e37339) fails verify and must NOT be merged.
- Two audit findings are still open:
  - (a) An adopted overlay A can be dropped without a hold when its moved tip conflicts with an established overlay B (`we:scripts/lib/daemon-rebuild/prepare.mjs:266`).
  - (b) An unsmoked baseline (`baselineOnly`) can be overwritten into a verified adoption (`we:scripts/lib/daemon-rebuild/prepare.mjs:422`).
- Redesign suggestion: the hold uses the union of established-by-adoption, established-by-pin and established-by-tip. Planner ordering uses the tip. Bootstrap state stays separate and never counts as verified.
- Build this as designed work via the builder, not as a hotfix.
