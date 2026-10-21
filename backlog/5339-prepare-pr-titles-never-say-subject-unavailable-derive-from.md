---
bornAs: xe61qoo
kind: story
size: 1
status: open
scope: ["we:scripts/operations/machine-pr-title.mjs", "we:scripts/operations/__tests__/machine-pr-title.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prepare PR titles never say subject unavailable: derive from the card title

The original guard-card prepare-title fallback is already implemented: with no numbered finding it derives “prevention guards owed” and preserves the reviewed PR provenance. Keep publication rejection for genuinely unavailable metadata; do not invent another fallback change.

## Done when

- [A1] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/operations/__tests__/machine-pr-title.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — existing “derives a guard card title without the placeholder” case asserts the exact prepare title for #4410 and publication validation. This verifies existing behavior; no unimplemented red/green case has been found.

## Non-goals

- [N1] No historical PR renaming, blanket removal of the planning sentinel, or weakening of publication validation. No new endpoint; body/rate/CSRF requirements are inapplicable.

## Edge cases this change must handle

1. **Untrusted text** — Preserve control/bidi/markup sanitization of card titles.
2. **Truncated reads** — Keep bounded Unicode titles and provenance suffix; absent metadata still fails publication.
3. **Shared state files** — n/a: title generation is pure and metadata reads target origin/main; no shared write is added.
4. **Fail closed** — Reject subject-unavailable titles at publication rather than silently publishing a generic subject.
5. **Identity scoping** — Retain backlog item identity; cited reviewed PR numbers must not become delivered card IDs.
6. **State over time** — Read current remote card metadata; do not substitute a dirty worktree title.
7. **Who wrote it** — The subject derives from card metadata; the suffix identifies review provenance, not authorship approval.

## Grounding

`we:scripts/operations/machine-pr-title.mjs:50` implements the missing-finding fallback; line 63 rejects unavailable publication subjects. `we:scripts/operations/__tests__/machine-pr-title.test.mjs:36` tests the reported shape and line 20 covers hostile Unicode text.

## Open questions

STALE: should this card be closed as already implemented? The remaining sentinel is explicitly for pre-metadata planning, not the reported guard-card defect. The queued regression attempt was deferred by host load (exit 75).
