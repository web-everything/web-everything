---
kind: task
status: active
scaffoldedBy: "fix-4631"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/accept-carry-forward.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Derived acceptance fingerprint: check that no later objection superseded the acceptance before deriving coverage

Card suggestion from PR #4631 review round 7 (codex-correctness, advisory, we:scripts/merge-ai-prs.mjs#readDrainAcceptance). When an accept carries only reviewed-sha (no diff marker), readDrainAcceptance re-derives the accepted commit's net diff from git so coverage can carry on a byte-identical diff. That derivation does not ask whether a later objection (a changes verdict, a free-text hold, a formal CHANGES_REQUESTED review) superseded the acceptance it derives from; the restamp path does (we:scripts/lib/accept-carry-forward.mjs#latestAcceptRecord). Route the drain's derived-fingerprint coverage through the same later-objection rule, or prove the plain coverage gate already refuses in that case and pin it with a test.

## Acceptance

- [A1] **Executable** — a test in `we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs` where a marker-less accept is followed by a later changes verdict fails before this lands (`acceptanceCoversHead` covers the moved head) and passes after (it does not).

## Non-goals

- [N1] Does not change coverage for an accept that already carries its own reviewed-diff marker.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only trusted-author comments count as an acceptance; any later comment may count as an objection (the existing `latestAcceptRecord` rule).
2. **Truncated reads** — a full 100-comment page is re-read in full before deciding, as the restamp path does.
3. **Shared state files** — n/a: reads the PR thread only.
4. **Fail closed** — an unreadable thread or review list derives no fingerprint (SHA identity, the stricter path).
5. **Identity scoping** — the objection must be on this PR and after this acceptance.
6. **State over time** — an objection posted before the acceptance is superseded by it and does not block.
7. **Who wrote it** — a trusted marker author writes the acceptance; anyone can raise an objection.
