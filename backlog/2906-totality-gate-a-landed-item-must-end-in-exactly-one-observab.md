---
bornAs: xtvn00y
kind: task
status: open
dateOpened: "2026-08-03"
tags: [merge-gate, review-integrity, check-standards, silent-failure]
relatedTo: ["2899", "2900", "2874"]
scope:
  - we:scripts/check-standards-rules.mjs
  - we:scripts/__tests__/check-standards-rules.test.mjs
---

# Totality gate: a step that withholds work from a merge decision must report what it withheld

A merge-gate step that filters items out of a set must account for every item it was given. Today a step can
`continue` past one and return a shorter list, and nothing notices: the item reaches no bucket, no log line, no
`--json` key, and the run reports complete success. **A silent withhold is indistinguishable from having had no
work to do.**

## Where this came from

Found by an advisory jury on PR #1017 (#2899) — and it is the same shape three times over, in one diff:

- `resolveIdsForLandedPass` dropped a couple whose sibling half was still open. Its comment claimed the item
  would "defer to a later pass"; it does not, because `landedThisPass` is only populated when a carrier merges
  *in* that pass. So the deferral was permanent **and** invisible — the fix for a silent-stranding bug had
  re-created a silent stranding.
- `resolveLandedItem` returned `flipped: true` even when its commit failed, so a failed flip printed
  `✓ resolved on land … + pushed to main` while the card was untouched on main.
- The per-item `catch {}` swallowed every error with no stderr line.

#2899's fix now emits four buckets — `resolved` / `alreadyResolved` / `deferred` / `failed` — each on stderr
**and** in `--json`. This item makes that shape enforceable instead of remembered.

## Why a gate and not a convention

The defect survives review because the code *looks* right. `if (blocked) continue;` is the correct safety
decision; only the absence of a report makes it a bug. A reviewer checks that a filter filters — nobody checks
that the filtered-out items are still accounted for.

Recall is demonstrably not the mechanism: the reviewer of PR #1012 raised "no silent caps" as a finding and then
shipped a silently-capped sweep in #1017 a few hours later, in the same session.

## Definition of done

- **A1 — the rule.** A `check:standards` rule over the merge-gate modules
  ([we:scripts/merge-ai-prs.mjs](scripts/merge-ai-prs.mjs), [we:scripts/lane-drain.mjs](scripts/lane-drain.mjs),
  [we:scripts/lane-stack.mjs](scripts/lane-stack.mjs)): a function whose name matches `plan*` / `*ForLandedPass`
  and which iterates an input collection must either return every input key across its returned partitions, or
  carry an explicit `@partial <reason>` marker. Decidable by AST over the return shape — **no taint analysis**,
  which is the trap that made `2993` unbuildable as first written.
- **A2 — the caller half.** A returned `deferred` / `failed` / `skipped` array that is never read is itself the
  defect. Flag a call site that destructures only the positive bucket.
- **A3 — a real corpus.** The three shapes above, each asserted to be caught by the rule *before* #2899's fix and
  to pass *after* it — pinned against real regressions, not synthetic ones.
- **A4 — do not over-reach.** A pure predicate, a formatter, or anything outside the merge-gate set is out of
  scope. This is about decisions that gate a write to `main`, not about `Array.filter`.

## Boundary

Not a change to any gate's decision — every current defer/skip stays exactly as it is. This is purely the
accounting around them. Adjacent to but distinct from #2837, which extends a totality gate over *verdict* class
bodies; this one is about *work items* in a land pass.
