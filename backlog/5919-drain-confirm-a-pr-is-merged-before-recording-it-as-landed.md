---
bornAs: xsvxy4v
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs", "we:scripts/conveyor/soak/breaks/", "we:scripts/__tests__/"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "32312de6d83da16e187842d4f713705a0238f1b0"
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

## Progress

- Premise check (2026-10-13, against `main` 32312de6d): still true. The plain merge path in `we:scripts/merge-ai-prs.mjs` calls `mergePr(...)` inside `withLandWriteLock` (~line 6522) and returns `{ merged: true }`; the caller then runs `merged.push(...)`, `postMergeTrace()` and `landedThisPass.add(...)` (~lines 6549–6557) with no state check. `git log` for `5919`/`xsvxy4v` shows only the filing and JIT-number commits; nothing delivers the fix. Card citations are accurate; `isPrAlreadyMerged` is at ~line 4653 (reads `state,mergedAt`, returns false on any gh miss).
- Scope unchanged (`we:scripts/merge-ai-prs.mjs` + tests). The soak break (A2) also needs a small opt-in fake-gh knob (`handlePrMerge` in `we:scripts/conveyor/__tests__/helpers/fake-gh-shim.mjs` has no enqueue mode), so that helper is touched too. Size 3 stands.

## Design

1. **Confirm helper.** Add an exported, injectable `confirmMergedAfterWrite({ probe, attempts, delayMs, sleep })` in `we:scripts/lib/drain-merge-strategy.mjs`, beside `collectQueueMerged`. It calls `probe()` up to `attempts` times and returns `true` only when a probe returns true; a thrown probe, or false every time, returns `false` (fail closed). The land callback is synchronous (`readGh` is sync), so `sleep` is a synchronous sleep (`Atomics.wait`). To avoid holding the serial-writer mutex, the callback does ONE probe inside the lock; if that is false, the bounded retry (3 probes, ~1s apart, ≤ 3s) runs AFTER the lock is released, since the merge write is already done.
2. **Call site.** In `we:scripts/merge-ai-prs.mjs`, right after `mergePr(...)` (~line 6522), return `{ merged: true }` only when the in-lock probe `isPrAlreadyMerged(c.repo, c.num)` is true, else `{ merged: false, unconfirmed: true }`; after the lock, an `unconfirmed` result gets the bounded retry and, if it now reads MERGED, flows into the existing merged path. `isPrAlreadyMerged` already passes `--repo` via `repoFlag(repo)`.
3. **Unconfirmed branch (placed before the `mergeStrategy.enqueues` skip line ~6552).** For a result still unconfirmed after the retry: set `decision = 'skip'` (keeps it blocking its dependents), report it on stderr/JSON as `queued` (not `failed`, not `merged`), and `continue`. No `merged.push`, no `postMergeTrace()`, no `landedThisPass.add`. **Durable follow-up (Must — review round 1):** a merged PR drops off every later pass's open-PR listing, so "the next pass sees it" loses its numbering/resolve/regen forever. So add a strategy method `recordPendingFollowUp(c, headSha)` beside `enqueue()` that adds the PR to the existing pending list (via the existing `mutateState`, same entry shape `enqueue()` writes); `collectQueueMerged` (~line 6649) then runs the post-land follow-up exactly once when GitHub reports MERGED, and drops it if CLOSED. A pending entry is not a landed entry, so edge case 3 holds. The method must work in drain-direct mode (state file absent → created); an unreadable state file refuses the write and logs it, never overwrites.
4. **Fake gh knob.** `handlePrMerge` gets an opt-in store flag `mergeQueue: true` that exits 0 and records an `enqueued` event but leaves the PR `OPEN`. Default behavior is unchanged.

## MVP

Musts only:
- `confirmMergedAfterWrite` + the single call-site change + the unconfirmed branch + `recordPendingFollowUp` (so the later GitHub merge still gets its follow-up).
- The test file (A1/A3) and the soak break (A2) below.
- One stderr line per queued PR: `queued (gh pr merge returned 0 but PR is not MERGED)`.

Out of scope (see Follow-ups): a poller that lands an enqueued PR's post-land work before the next pass; any change to the `github-merge-queue` strategy path (N1).

## Test plan

`we:scripts/__tests__/merge-ai-prs-confirm-merged-before-landed.test.mjs`:
1. **Enqueued PR is not landed (A1)** — a `runCli` run against the fake gh shim with `mergeQueue: true` leaves the PR OPEN; asserts `merged` is empty, no id in `landedThisPass`, no merge-trace comment, no follow-up input. RED before the fix: `{ merged: true }` is returned unconditionally.
2. **Really merged still lands (A3)** — a normal fake-gh merge lands as today (merged entry, trace posted once, follow-up runs); helper returns true on the first probe.
3. **Late MERGED** — probe false, false, true → true within the bound (injected `sleep`, no real wait).
4. **Probe throws / garbage** — returns false, never throws (fail closed).
5. **Retry bound** — probe never true → exactly `attempts` calls, total injected sleep ≤ the cap.
6. **Repo scoping** — the probe's gh argv carries the PR's own `--repo` (read from the fake shim's call log), not the cwd default.
7. **Queued, follow-up runs once when GitHub merges it** — test 1 also asserts the follow-up state file gained a `pending` entry (and no `followedUp`/landed entry); then the fake store flips the PR to MERGED AND removes it from the open listing, and the next pass's `collectQueueMerged` records it and runs its follow-up exactly once (a second pass does not repeat it).
8. **Unreadable state file** — `recordPendingFollowUp` leaves it untouched and reports it; the PR is still not landed.
9. **Existing source-shape test** — re-run `we:scripts/__tests__/merge-ai-prs-merge-trace-post-confirm.test.mjs` (it slices the source at `const landLock = withLandWriteLock(` and asserts marker order) and adjust it if the new branch moves its anchors.

Harness notes: the fake-gh `mergeQueue` knob lands first, so test 1 is RED for the right reason (PR recorded landed), not an import error; `runCli` tests use the same fake-gh harness as `we:scripts/__tests__/merge-ai-prs-ci-lifecycle-and-land-effects.test.mjs`. Test 6 asserts `--repo` on the post-merge `pr view` argv, which only exists once the probe runs after the merge. Tests 3–5 are pure unit cases.

Soak: `we:scripts/conveyor/soak/breaks/drain-records-enqueued-pr-as-landed.mjs` plus its soak test, modelled on `we:scripts/conveyor/soak/breaks/couple-split-by-unrelated-merge.mjs` (`daemons: ['drain']`): fake gh `mergeQueue: true`, a green `ready-to-merge` PR; the judge reports a violation if the PR is recorded landed (merge-trace comment, or its item resolved) while still OPEN.

## Proof plan

- The real before/after is the soak break: fill the break's `fixedBy.sha` after the fix commit, then run the red/green runner `we:scripts/conveyor/soak/red-green.mjs` with `--break=drain-records-enqueued-pr-as-landed` (RED with the fix reverted, GREEN with it); both outputs go in the PR body. The break also needs its soak-test sibling file, as the other breaks have.
- Regression smoke only (not proof of A2): a `--dry-run --json` pass of `we:scripts/merge-ai-prs.mjs` on the lane shows normal output is unchanged while `we:scripts/settings/merge-queue.json` has the queue off.

## Follow-ups

- Run queued PRs' post-land work between passes (from `pr-watch`) rather than at the next full pass.
- Show the `queued` bucket in the daemon status line and `/queue` table.
- Drop this card from the merge-queue switch runbook's precondition list once it lands.
