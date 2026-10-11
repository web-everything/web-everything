---
kind: task
status: active
scaffoldedBy: "fix-4631"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Drain test-gaming scan: read the diff at the head the merge is pinned to, not at the branch name

Found by the PR #4631 round 7 self-review (same class as security/toctou-head-binding, pre-existing on main). The drain's batch net-diff read (we:scripts/merge-ai-prs.mjs runCli, computeNetDiffSignals at v.headRef) feeds the escalation score, the manifest baseline and scanTestTampering, while the merge is pinned to v.listedHeadSha. A force-push A (tampered, listed) -> B (clean, during the fetch) -> A lets the scan see B and the pinned merge take A. Binding the read to listedHeadSha is not a one-line swap: if the listed commit is not fetchable the read goes unscored, and an unscored scan is today a no-op (fail open), so the fix must also make an unscored scan on a listed head park rather than pass. PR #4631 bound the carry step (we:scripts/merge-ai-prs.mjs#readNetDiffAtHead); this card binds the gate itself.

## Acceptance

- [A1] **Executable** — a test where the branch name resolves to a clean commit but the listed (pinned) head carries a test-tampering diff fails before this lands (no park) and passes after (the drain parks `review:human`).

## Non-goals

- [N1] Does not change what the scan looks for; only which commit's diff it reads.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the diff is the PR author's; only which commit is read changes.
2. **Truncated reads** — n/a: the diff read is unchanged in size handling.
3. **Shared state files** — a concurrent fetch in the shared clone cannot change an immutable commit's diff.
4. **Fail closed** — a listed head whose commit cannot be read parks instead of passing the scan.
5. **Identity scoping** — the diff is of the listed head of this PR only.
6. **State over time** — a head that moved since listing is refused by the existing merge pin; the next pass re-judges.
7. **Who wrote it** — the PR author controls the branch, which is exactly why the branch name is not trusted.
