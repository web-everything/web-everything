---
bornAs: xkgkyxp
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/fix-scope-policy.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5087 (head 3c5f7b5d3)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5087 (reviewed head `3c5f7b5d319deec73a06755f926277422f0541ab`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/fix-scope-policy.mjs:125` — (edge-case, degraded) Region comparisons use different coordinate systems when PRs have different merge bases.
   - Scenario: Start with a 300-line we:x.js. Holder A branches from O and edits line 100. Main M then inserts 100 lines at the beginning. Candidate B branches from M and edits original line 110, now line 210. hunksFor(A) diffs O→A and returns [100,100], while hunksFor(B) diffs M→B and returns [210,210]. The gate compares these coordinates directly and admits B as disjoint despite the edits being only 10 lines apart, within the configured 20-line margins. A read-only probe generated these patches from the concrete contents, verified a clean git merge-file preserving both edits, and reproduced admission through
   - Claude's re-check: hunksFor diffs merge-base(origin/main tip, head)→head, so each PR's old-side line numbers are in its own base's coordinates. regionOverlapDecision then calls rangesIntersect on those numbers directly. A trial merge only detects textual conflicts, not margin proximity. A branched from an older base and B branched from a newer base with a shifted file will be compared in mismatched coordinates, and disjoint ranges can be admitted despite being within the margin.

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
