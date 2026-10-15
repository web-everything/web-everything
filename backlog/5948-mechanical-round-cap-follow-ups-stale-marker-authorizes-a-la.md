---
bornAs: x8rsopp
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/mechanical-round-cap.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-14"
preparedAgainstSha: "6742d1202f2de0350e0a5a6978cebaa385be8b43"
tags: []
---

# Mechanical-round-cap follow-ups: stale marker authorizes a later round; trust before regex

A trusted mechanical marker must describe the latest round before it can authorize a cap exemption. An older marker currently survives a later ordinary rearm. Reject untrusted verdict comments before scanning their bodies for mechanical attribution, and verify the reconcile IO gate.

## Progress

- Original scope named only the two source files and approximate :346/:88/:1375 locations. Corrected scope adds both existing matching tests.
- Current evidence: we:scripts/conveyor/mechanical-round-cap.mjs:262 grants from the latest mechanical marker without comparing ordinary rearm events; :435 likewise compares mechanical markers only with verdicts despite its “latest round event” contract. The ordinary rearm matcher already exists at :432. The trust check follows body classification and mechanical regex execution at :206.
- The reconcile enrichment gate moved to we:scripts/conveyor/reconcile-pass.mjs:1530: only WE with the resolved count-toward-cap setting false calls enrichment. Preserve that behavior and test it through the injected port.
- Claimed missing git-refusal tests are already present in we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs:530 (failed reads) and :543 (ancestry refusal); retain/run them rather than duplicate them. The remaining stale-round and trust-order defects keep this item open.
- Size remains 2: roughly 35 source lines in the mechanical module, at most 5 integration lines, and 80 test lines across the two suites.

## Design

Use one latest-round eligibility predicate for the cheap prefilter and final grant. A trusted ordinary rearm at or after the mechanical marker invalidates the exemption; a later genuine mechanical marker can establish a new candidate. Ambiguous/missing timestamps on relevant trusted round events must not create permission. Continue requiring current-head git proof, a judged parent, and no already-spent mechanical review allowance.

Check marker authorship first in `isReviewVerdictComment`, before body access/classification and attribution matching. This changes no trusted producer format. Preserve the existing reconcile repo/setting gate and injection seam.

## MVP

Implement the shared round-order check at both authorization sites; reorder trust validation; add pure and reconcile-port regressions. Do not broaden what constitutes a proven mechanical merge.

## Test plan

In we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs, cover mechanical → ordinary with no intervening verdict (both prefilter and final grant refuse), ordinary → mechanical (eligible with valid git/parent evidence), equal timestamps, malformed timestamps, unordered input, and forged later markers. An untrusted comment with a throwing body getter must return false without reading it; trusted producer comments retain existing classification.

In we:scripts/conveyor/__tests__/reconcile-pass.test.mjs, inject enrichment and assert it is called only for WE plus count-toward-cap=false; test true and non-WE paths with a throwing spy. Retain the existing git-read, buffer/timeout and off-base-parent cases. Run both suites through the host heavy-admission queue.

## Proof plan

Replay a synthetic PR with a judged parent, valid mechanical facts, an old conflict marker and a newer ordinary rearm through the prefilter and final grant. Record the old grant and new refusal. Replay the same snapshot through the reconcile port with injected IO and confirm no exemption reaches planning. Positive mechanical-only replay still receives its single allowance; no GitHub writes are needed.

## Acceptance

An ordinary round cannot borrow a historical mechanical exemption; untrusted authors never reach attribution parsing; the documented repo/setting gate is covered and existing git failure refusals remain intact.

## Non-goals

No repair of #5822's unrelated-edit proof issue, no cap policy changes, and no marker producer/schema migration.

## Edge cases

Trusted but incomplete chronology refuses an exemption; untrusted comments never authorize one. No new shared state or endpoint is introduced. Head changes invalidate cached facts. Source, docs, config and data edits all remain subject to the same existing git proof; this change does not loosen it.

## Follow-ups

Keep #5822 and #5837's separate proof concerns on their existing tracks; do not count this chronology fix as resolving them.
