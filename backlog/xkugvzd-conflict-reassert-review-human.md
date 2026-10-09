---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/conveyor/conflict-reassert-rule.mjs", "we:scripts/conveyor/conflict-reassert-settings.json"]
dateOpened: "2026-10-09"
tags: []
---

# Conflict watch never re-routes a still-conflicting review:human PR after its finding is rearmed

A review:human PR that stays conflicting after a fixer rearmed its conflict finding for another round is skipped forever by the parked-PR conflict watch (we:scripts/conveyor/parked-pr-conflict-watch.mjs): the idle conflict-bounce path excludes review:human, and the review:human recheck only acts on the watch's own stand-down marker. Live: WE PR #4481 (review:human + merge-status:conflicting, no review:changes, 6h+). Fix: a pure rule (we:scripts/conveyor/conflict-reassert-rule.mjs) plus a declared setting (we:scripts/conveyor/conflict-reassert-settings.json, env WE_CONFLICT_REASSERT_REVIEW_HUMAN) re-assert the idle conflict finding through the same #2793 path (same round cap, once-per-round guard, the finding keeps review:human).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/conflict-reassert-rule.test.mjs we:scripts/conveyor/soak/breaks/review-human-conflict-idle.soak.test.mjs` (paths without the `we:` prefix) fails before this item lands (the #4481 replay is skipped by the sweep) and passes after (the sweep re-asserts the conflict finding, `review:human` untouched).
- [A2] **Must refuse on error** — a missing, unreadable or malformed settings file, or an unknown env value, means `off`: exactly the behaviour before this card.
- [A3] **Must keep the guards** — the re-assert binds on the same conflict-fix round cap (`CONFLICT_FIX_ROUND_CAP`) and the same once-per-round finding guard as the #2793 idle path; a PR with a live (unsuperseded) watcher stand-down marker keeps the statute recheck path unchanged.

## Non-goals

- [N1] Does not change `we:scripts/conveyor/reconcile-core.mjs` (it already routes a `review:changes` + conflict PR to a conflict fix), and never clears or downgrades `review:human`.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only trusted-author markers count (the existing `isTrustedMarkerAuthor` readers are reused, not re-derived).
2. **Truncated reads** — a failed comment read yields `[]`, which can only post at most one finding per retry window, never a label change.
3. **Shared state files** — n/a: the settings file is read-only at run time; no new state is written.
4. **Fail closed** — any settings problem resolves to `off` (today's behaviour).
5. **Identity scoping** — only PRs the sweep already lists as parked + conflicting + `review:human` + conflict label + no `review:changes`.
6. **State over time** — the once-per-round guard and the round cap bound repeats; past the cap the existing cap-exhausted note fires once.
7. **Who wrote it** — the watcher stand-down marker is matched by its fixed actor string, same as today.
