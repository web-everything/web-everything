---
bornAs: x8jmwmg
kind: story
size: 2
status: open
scope: ["we:scripts/operations/coroner-false-findings.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5454 (head a79b7c5db)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5454 (reviewed head `a79b7c5db7aa2418749eb3ae99aa2925e51d9fb4`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/coroner-false-findings.mjs:57` — (failing-input, degraded) Failed or missing red-team re-checks are counted as false findings
   - Scenario: When runRecheck throws, we:review-extra-seats.mjs publishes [not confirmed] with 'Re-check: the Claude re-check did not complete'. applyRecheck also uses that tag when checks=[] omits the finding's answer. Feeding either trusted comment into the extraction logic produces falseFindings.count=1, cause=other, and unconfirmed.count=0. Neither finding was disproved. These inconclusive events should be excluded from false-finding totals or reported separately.
   - Claude's re-check: we:review-extra-seats.mjs:1401 and :1079 set confirmedByRecheck=false with 'did not complete' / 'no re-check answer' reasons, rendered as [not confirmed]; the extractor regex at we:scripts/operations/coroner-false-findings.mjs:57 counts every [not confirmed] item as a false finding with no exclusion for inconclusive re-checks.
2. `we:scripts/operations/coroner-false-findings.mjs:102` — (edge-case, degraded) Renames into backlog are incorrectly classified as card-only
   - Scenario: Supply a PR files response containing {filename:'we:backlog/moved.md', status:'renamed', previous_filename:'we:docs/architecture.md'}. The collector ignores previous_filename and reports card-only despite the removal outside backlog. A red-team item whose re-check says 'runtime implementation not in the diff' consequently receives card-only-probe instead of diff-only-recheck. An isolated collector probe reproduced both results with failed=0 and truncated=false. Classification should include both paths of a rename and report this PR as code.
   - Claude's re-check: Line 102 classifies using only f.filename; previous_filename is ignored, so a rename into backlog/ from a non-card path looks card-only. ci-card-only's own CLI uses --no-renames to avoid exactly this.
3. `we:scripts/operations/coroner-false-findings.mjs:109` — (edge-case, degraded) Shadow counts silently lose findings beyond the stored detail cap
   - Scenario: A successful shadow run with 31 unmatched findings produces agyFindingsCount=31, overlap.agyOnly=31, and 31 false entries in agyMatched, but buildShadowRow deliberately stores only 30 agyFindings details. The new collector counts those details and reports unconfirmed.count=30 with reads.truncated=false. A source-isolated writer/collector probe reproduced this. Counts should use the complete stored aggregate or match vector; capped details should serve only as examples.
   - Claude's re-check: buildShadowRow stores only findings.slice(0,30) in agyFindings while agyFindingsCount and overlap.agyOnly carry the full count; collector line 108-109 counts only the stored details, so 31 unmatched yields 30 with no truncation flag.

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
