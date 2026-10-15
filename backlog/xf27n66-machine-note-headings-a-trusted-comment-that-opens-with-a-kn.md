---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Machine-note headings: a trusted comment that opens with a known machine heading and then revokes must not read as a note

PR #5237 round 10 closed this class for the re-arm comment (isRearmNote, exact producer shape) and the approval-time prevention notice (isApprovalPreventionNoteBody) in the review clearance guard and the same-sha clearance parser. The same class remains in we:scripts/lib/accept-carry-forward.mjs#isKnownMachineBody: every other machine shape (fix-begin / fix-end claims, CI-heal notes, conveyor fix/restack evidence, '🔔 conveyor —' notes, drain reason comments, recovery / queue notes, a non-changes advisory note) is matched on its leading line alone, from any author. A comment that opens with one of those headings and then says 'I revoke my approval' is read as a machine note, so it is not a hold for restoration (review-clearance-guard holdsClearance), for the same-sha human-clearance carry (review-escalation parseLatestHumanClearedSha) or for the accept carry (merge-ai-prs, accept-carry-sweep, review-hold-reconcile). Fix: match each machine shape against its producer's exact rendering (every line whole, free parts constrained), with a producer round-trip test per shape; a shape that drifts fails closed (a re-review is owed).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs`: a new case per machine heading, where a comment opens with the heading and then says "I revoke my approval", fails before (`isKnownMachineBody` is true) and passes after (false).
- [A2] Must: every real producer's rendering of each machine shape is still a machine note (one round-trip test per producer).
- [A3] Must: an unrecognised or drifted shape is a possible hold (the carry is refused, a re-review is owed), never a note.

## Non-goals

- [N1] The re-arm comment and the prevention notice: PR #5237 already matches both in their exact producer shape.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — a heading followed by any text the producer does not write, an edited line, or text in a blank line is not a note.
2. **Truncated reads** — n/a: pure parsing of the comment list it is given; callers already fail closed on an unreadable thread.
3. **Shared state files** — n/a: no state written.
4. **Fail closed** — a comment that matches no producer shape exactly is a possible hold.
5. **Identity scoping** — n/a: no per-session identity involved.
6. **State over time** — older producer renderings still on open PRs either stay listed or fail closed (a re-review, never an approval).
7. **Who wrote it** — free text cannot be classified by author (the conveyor posts under the operator's login), so the shape alone decides.
