---
bornAs: xayvwbh
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/lib/__tests__/pr-facts-merge-gate-isolation.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Wire the drain-speed modules into merge-ai-prs: merge-queue skip kinds + webhook-store facts source

Follow-up of the drain-pass-speed PRs (operator go 2026-10-09 16:35 ET). Held: we:scripts/merge-ai-prs.mjs and we:scripts/lib/drain-skip-reasons.mjs are occupied by #4624 (review:changes/human) and #4631. When free: (1) we:scripts/lib/drain-skip-reasons.mjs classifySkipReason calls classifyMergeQueueSkip (we:scripts/lib/merge-queue-hook.mjs) first and adds its kinds to SKIP_KINDS, so merge-queue refresh/wait/refuse skips stop logging unrecognized-reason; (2) we:scripts/merge-ai-prs.mjs reads readPassFacts once per pass (we:scripts/lib/drain-facts-source.mjs), routes resolveChecks through resolveRequiredCheckViaStore and listing rows through overlayListingRow, and writes formatFactsSourceLine to stderr each pass; keep fetchFreshPrForRevalidation and the merge-queue hook reads live; update the comment in we:scripts/lib/__tests__/pr-facts-merge-gate-isolation.test.mjs to say the store may feed classification reads via drain-facts-source only; (3) give the drain daemon WE_PR_EVENTS_URL + WE_PR_EVENTS_TOKEN_FILE (com.plateau.drain-daemon.plist has neither, so the store reads as not configured). Proof: three live passes show the facts-source line with source store, fewer GitHub check reads, and lower listing/classifyGateReads times.

## Acceptance

- [A1] **Executable** — the unit test we:scripts/lib/__tests__/drain-skip-reasons.test.mjs has a case where `merge-queue: refresh (base-behind-main) → rebased` classifies as `merge-queue-refresh` (fails today: `unrecognized-reason`).
- [A2] **Must** — on a store error, a stale feed or a head mismatch, every read falls back to GitHub; the pre-merge live re-read and the merge-queue hook's live check-run read are unchanged.
- [A3] **Must** — the drain log shows one `merge-ai-prs · facts-source:` line per pass naming the source per repo.

## Non-goals

- [N1] Does not serve mergeability, files or bodies from the store (the store has none of them).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads structured store facts (head SHA, labels, check conclusions), never free text.
2. **Truncated reads** — the store answers only with a complete bootstrap baseline; otherwise GitHub (pr-facts judgeMirror).
3. **Shared state files** — the pr-facts mirror is single-flight under its own lock; this wiring only reads it.
4. **Fail closed** — no store answer, or a different head, means the existing GitHub read; absence of a check is never green.
5. **Identity scoping** — facts keyed by repo slug + PR number + head SHA; a cwd-resolved repo (no slug) always reads GitHub.
6. **State over time** — the store is served only within its TTL (120 s) and while the webhook feed is healthy.
7. **Who wrote it** — n/a: the webhook Worker is the only writer of the store; the drain stays the only merge writer.
