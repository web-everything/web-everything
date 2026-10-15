---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Accept-carry paths: a pasted acceptance followed by a revocation must not count as the latest accept record

PR #5237 (operator ruling 2026-10-14, red-team break #1) closed this class in the review clearance guard and the same-sha parser via isSanctionedAcceptRecordBody / isMachineNoteBody (we:scripts/lib/review-escalation.mjs). The same class remains in we:scripts/lib/accept-carry-forward.mjs: latestAcceptRecord takes any trusted comment carrying a reviewed-sha marker as the latest accept record (cleared-human read anywhere in the body), and isKnownMachineBody trusts the re-stamp heading off the first line alone. Callers: we:scripts/merge-ai-prs.mjs (carry decision, laterReviewHold), we:scripts/review-set-label.mjs (restamp carry thread), we:scripts/conveyor/accept-carry-sweep.mjs, we:scripts/conveyor/review-hold-reconcile.mjs. A trusted raw paste of an old acceptance followed by REVOKED could be read as the accept to carry. Fix: select the latest record only in the sanctioned shape and route the machine-note check through isMachineNoteBody; red-green each caller with the paste fixture.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs`: a new case where a trusted comment pastes an acceptance (heading + `reviewed-sha` marker) followed by "REVOKED" fails before (it is the latest accept record) and passes after (`latestAcceptRecord` skips it, or returns null).
- [A2] Must: a re-stamp-headed comment with text after its marker block is a possible hold, not a machine note, in every accept-carry caller.
- [A3] Must: every producer-written acceptance (`buildVerdictComment` accepted / clear-human / restamp, `buildCarryRecordBody`) is still the latest accept record.

## Non-goals

- [N1] Revocation text placed between the heading and the closing marker block: producers write free text there, so no shape check can tell it apart.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — a paste, a blockquote, a fence or text after the marker block is not an accept record.
2. **Truncated reads** — n/a: reads the comment list it is given; callers already fail closed on an unreadable thread.
3. **Shared state files** — n/a: pure parsing, no state written.
4. **Fail closed** — a comment that is not in the sanctioned shape ends the carry (a re-review is owed).
5. **Identity scoping** — n/a: no per-session identity involved.
6. **State over time** — renamed headings already listed in `ACCEPT_RECORD_HEADINGS` stay recognised for records on open PRs.
7. **Who wrote it** — only trusted marker authors' records count, unchanged.
