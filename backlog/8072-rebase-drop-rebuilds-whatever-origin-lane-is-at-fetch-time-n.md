---
bornAs: x06uhwz
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/rebase-drop-manifest.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Rebase-drop rebuilds whatever origin/<lane> is at fetch time, not the judged head, then restamps the acceptan…

Flow-sim gap R9c-G4, class K6 (check-then-act race with no pin). Failing input: PR accepted (review:accepted) and judged at head X at pass start (v.headSha/listedHeadSha). It is BEHIND or still carries the manifest (isRebaseDropCandidate / needsManifestStripBeforeMerge). Author pushes Y on top of X after the listing and before the rebuild; the review daemon has not yet re-armed the labels. Drain reaches th… Cited: we:scripts/merge-ai-prs.mjs:5915, we:scripts/lib/rebase-drop-manifest.mjs:160-164, we:scripts/lib/rebase-drop-manifest.mjs:265, we:scripts/merge-ai-prs.mjs:5944-5947, we:scripts/review-set-label.mjs:1380-1382. Soak-break sketch: Fixture: lane ref at X with review:accepted; stub gitRunner so fetch returns X+Y (one extra non-manifest commit) while the verdict carries headSha X. Action: run the rebase-drop loop for the verdict with a spawn stub capturing restampAcceptance argv. Assert (…

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
