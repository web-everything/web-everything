---
bornAs: xrh7470
kind: task
status: open
dateOpened: "2026-11-25"
scope: ["we:docs/agent/reviewer-expectations.md"]
tags: [testing, review, prevention]
---

# Require error-path, alert-conjunct and complete-list evidence in reviews

Track the prevention owed by the changes-requested review of PR #7470. The local repair adds the repo-specific guards below; the remaining work is to extend the shared review checklist so the same omissions are caught in other readers.

## Repo-specific prevention delivered in the repair

- Settings drift: enumerate prototype-load, pr-sweep, `review.uiFastLane.paths` and `review.autoRoundGrant.cardOnly.repos` separately, require each extraction to be nonempty, and prove both review lists reject unregistered names. No empty-object read defaults.
- Identity: compare canonical registry slugs with every `CONSTELLATION_REPOS` slug. Independently pin name, full slug, tail and alias lookup, including the pre-transfer aliases.
- Fail closed: throw into `readAllHealth` and into the real `fetchFacts` reader, assert unknown for each registry entry, and continue reporting after one failure.
- Alert conjunction: an old PR plus a recent merge and a young PR plus no merge both suppress alerts.
- CLI: pin one formatted line per repo, JSON output and the exit-code decision for unknown evidence.
- Complete reads: page beyond both former limits; use merge-date search; check cursors, partial responses, label completeness, search totals and bounded-read exhaustion. Small repos need two reads; larger repos need at most ten pages per list and report unknown when incomplete.
- Inconsistent evidence: reject invalid clocks, future-created PRs and missing or malformed labels.

Regression files: `we:scripts/lib/__tests__/repo-registry.test.mjs` and `we:scripts/conveyor/__tests__/repo-health.test.mjs`. The launcher's after-repair gate remains required.

## Acceptance

- [A1] **Judgment** — The shared review checklist requires a test that throws into each fail-closed catch, one negative example for each conjunct of an alert condition, and a full-page or pagination-bound example for each list reader. A reviewer can identify all three obligations without reading this card.
- [A2] **Judgment** — Apply the checklist to the PR #7470 reader and record the named tests satisfying each obligation; a pure-helper test alone cannot satisfy a reader or CLI wiring promise.

## Non-goals

- [N1] No daemon integration, registry schema redesign, or replacement of other repository inventories.

## Edge cases this change must handle

1. **Untrusted text** — Checklist examples treat external responses as data; no executable interpolation.
2. **Truncated reads** — Require a tested visible unknown or escalation at the read budget.
3. **Shared state files** — n/a: checklist prose has no shared-state writer.
4. **Fail closed** — Require the thrown-error path, not only a helper called with null.
5. **Identity scoping** — Require every real settings source and canonical repository identity.
6. **State over time** — Include young PRs, recent merges, future times and old-created PRs merged recently.
7. **Who wrote it** — n/a: no authorization or marker acceptance changes.
