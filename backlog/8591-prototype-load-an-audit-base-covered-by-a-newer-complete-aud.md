---
bornAs: xvg6yzy
kind: story
size: 3
status: open
dateOpened: "2026-11-19"
tags: []
---

# prototype-load: an audit base covered by a newer complete audited base for the same head must stop vetoing (security-semantics, red-team required)

`canonicalAuditEvidence` (we:scripts/operations/prototype-load.mjs) vetoes a load when ANY base's latest audit row for the head is WEAKENED and not ruled. A head audited twice, first against an older main and then against a newer main, therefore carries two rows. The older base is an ancestor of the newer one, so its diff is a subset of what the newer audit already judged, yet its stale WEAKENED row keeps blocking, and one waiver cannot match two differently worded rows (seen live on lane/rebuild-on-main-move@838725f4: bases 781dec0e and 280c9f8d). Change: an audit base that is an ancestor of a newer audited base for the same head stops vetoing, but only when the newer base's row is complete (same question hash, parseable time, findings readable, itself verdict-decisive, base covered by main). Security-semantics: this loosens a refusal, so it needs a red-team note before merge.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/prototype-load.test.mjs` includes a case with two WEAKENED rows for one head (older base an ancestor of the newer base, differently worded findings) where only the newer row is ruled: it loads after the change and refuses before it.
- [A2] **Must (error)** — if the newer row is incomplete (foreign question hash, unparsable time, unreadable or contradictory findings, uncovered base, or itself unruled WEAKENED), the older base keeps vetoing exactly as today.
- [A3] **Must (inputs)** — ancestry is proven from git against origin/main, never from the record text; a failed or timed-out git read means no loosening. Rows whose base is not an ancestor of the newer base (a different line of history) keep vetoing.
- [A4] **Red-team note** — the PR description records the red-team result for forged bases, reordered ledger rows, rebase-rewritten bases, and a newer row that is a pass for a narrower diff.

## Non-goals

- [N1] n/a: this does not change waiver matching, fix-ready records, or the audit prompt.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — finding text and base fields are data only; never evaluated.
2. **Truncated reads** — a truncated or partial audits.jsonl line is an incomplete row, so it cannot supersede anything.
3. **Shared state files** — the ledger is append-only and shared; row order is time order and ties keep today's rule.
4. **Fail closed** — any doubt (git error, incomplete newer row) keeps the veto.
5. **Identity scoping** — the supersede applies per head and ref only, never across branches.
6. **State over time** — a base that stops being an ancestor after a force-push or rewrite stops being superseded.
7. **Who wrote it** — only canonical-audit rows count; hand-written rows are already refused by the ledger writer.

## Duplicate admission

distinct from earlier prototype-load cards: this changes which audit bases veto a load
