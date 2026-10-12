---
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/"]
dateOpened: "2026-10-12"
tags: []
---

# Drain: confirm a PR is MERGED before recording it as landed

After gh pr merge returns, the drain (we:scripts/merge-ai-prs.mjs, the mergePr write site before merged.push) adds the PR to merged/landedThisPass, posts its landed trace and starts post-land work without checking GitHub actually merged it. Once main has a merge-queue ruleset, a drain-direct pass (a stale drain clone, a lane's /pr or /finish run that reads its own branch's we:scripts/settings/merge-queue.json, a pr-watch fast drain, a manual /drain) gets gh pr merge turned into an enqueue, and the PR is recorded as landed early even if merge-group CI then fails. Fix: re-probe with the existing isPrAlreadyMerged after mergePr; if not MERGED, record it as queued/failed, never landed. Found in the PR #4950 fix round (merge-queue switch runbook); that runbook lists this card as a precondition for the switch. Add a soak break for the live case.

## Acceptance

- [A1] **Executable** — a test in `we:scripts/__tests__/` drives the drain's merge write site with a `gh pr merge` stub that exits 0 while the PR stays OPEN (enqueued): before the fix the PR lands in `merged`/`landedThisPass`; after, it does not, and no landed trace or post-land work runs.
- [A2] A soak break in `we:scripts/conveyor/soak/breaks/` reproduces the live case (drain-direct pass against a queued main) RED before, GREEN after.
- [A3] A PR that really merged (re-probe says MERGED) is still recorded as landed exactly as today.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the `github-merge-queue` strategy path (it already treats an enqueue as not landed), the merge-queue ruleset, or the switch runbook.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the check reads GitHub's PR `state`/`mergedAt` fields, not free text.
2. **Truncated reads** — a failed or empty re-probe counts as NOT merged (never as landed).
3. **Shared state files** — the drain's queue follow-up state (`queueStatePath` in `we:scripts/lib/drain-merge-strategy.mjs`) must not get a landed entry for an unconfirmed merge.
4. **Fail closed** — any re-probe error records the PR as queued/failed, not landed; the next pass re-checks it.
5. **Identity scoping** — the re-probe names the PR's own repo (`--repo`), never the cwd default.
6. **State over time** — GitHub may report MERGED a moment late; a short bounded retry is fine, but on timeout the PR is not landed and the next pass picks it up.
7. **Who wrote it** — applies to every caller of the drain (resident daemon, lane `/pr` and `/finish`, `pr-watch` fast drain, manual `/drain`), since the check sits at the shared write site.
