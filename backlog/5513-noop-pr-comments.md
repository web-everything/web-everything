---
bornAs: xadixye
kind: story
size: 3
status: open
scope: ["we:scripts/lib/pr-comment-policy.mjs", "we:scripts/pr-comments-settings.json", "we:scripts/conveyor/reconcile-note-comment.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Daemons post PR comments only on state change or needed action (prComments.mode)

Operator 2026-10-08: daemon PR comments that say nothing changed are noise. Add setting prComments.mode (on-change-or-action default | all). Suppress status-only reconcile notes (review-label-missing, stacked-awaiting-base), repeats identical to the previous note, and the drain's no-action skip/held-pending notes. Keep send-backs, rulings, merges, failures needing action, fix evidence, and every machine-read marker (fix claims, retry-cap counters).

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/pr-comment-policy.test.mjs we:scripts/conveyor/__tests__/reconcile-note-comment.test.mjs` (paths without the `we:` prefix) fails before (status-only notes post, no `prComments.mode`) and passes after.
2. **Live** — after the fix daemon adopts it, new PRs get no `review-label-missing` note and no repeated `stacked-awaiting-base` note; before/after counts over a comparable window.
3. **Drain (follow-up, file occupied by PR #4453/#4446)** — `we:scripts/merge-ai-prs.mjs` calls `drainReasonCommentSuppressed(kind, reason)` in `postDrainReasonComment` and `upsertHeldParkComment`; comment-writing only, no merge-gate change.

## Edge cases this change must handle

1. **Untrusted text** — the repeat check only reads comments from trusted authors (`isTrustedMarkerAuthor`), so a forged comment cannot silence a note.
2. **Truncated reads** — n/a: a missing comment list means "no prior note", which errs toward posting.
3. **Shared state files** — the setting file is read-only for daemons; no writes.
4. **Fail closed** — a missing or malformed setting, or an unknown mode, falls back to the default; only the listed status-only kinds are ever suppressed.
5. **Identity scoping** — the repeat check compares only the same PR's latest note comment.
6. **State over time** — a note that asks a person to act (every note kind today) is never dropped as a repeat: a state that resolves and comes back posts again, even when its words are identical. Repeat suppression is an explicit per-kind allowlist (`REPEAT_SUPPRESSIBLE_NOTE_KINDS`, empty today). Mode is re-read each tick; an unknown `WE_PR_COMMENTS_MODE` value means the default, not the file.
7. **Who wrote it** — machine-read markers (fix claims, retry-cap counters) are never routed through this policy.
