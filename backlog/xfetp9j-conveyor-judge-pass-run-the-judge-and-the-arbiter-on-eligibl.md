---
kind: story
size: 3
parent: "xaojq81"
status: open
blockedBy: ["xq3kn88", "xfbj1fa", "x6prrg3"]
scope: ["we:scripts/conveyor/judge-pass.mjs", "we:skills-src/conveyor/runner.mjs", "we:scripts/conveyor/__tests__/judge-pass.test.mjs", "we:skills-src/conveyor/__tests__/runner.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "e1f0523e0881357fc863f3e88da72e0164eb7091"
tags: []
---

# Conveyor judge pass: run the judge and the arbiter on eligible PRs each tick, and the digest once a day

A conveyor pass finds open review:human PRs that only wait on the human gate and stood-down PRs awaiting a ruling, runs the judge seat runner or the arbiter on each (bounded per tick, held by the kill switch), and sends the daily judge digest once per local day.

Makes the ruling at `we:docs/agent/platform-decisions.md#independent-judge-clears-review-human-outside-protected-list` run unattended. Blocked on the runner (`xq3kn88`), the ledger and digest (`xfbj1fa`) and the arbiter (`x6prrg3`), so nothing clears unattended before every clearance is recorded and the arbiter limits exist.

## Design

**Pass** `we:scripts/conveyor/judge-pass.mjs sweep [--repo=…] [--dry-run]`:

1. Read the switches first. Judge OFF → log "judge off", **skip steps 2–3 (no `gh` calls, no judge or arbiter spawn), but still run step 4**: the daily digest is sent while the judge is off, and says so. A switched-off day must not look like a broken pass, and a clearance made earlier in the day before the switch was turned off still needs its line. The digest is told the switch state (`judgeEnabled`, plus `by`, `at` and `reason` from the store, and `parseError` when the store was unreadable) and prints a line such as "judge OFF since <time> (<reason>)" at the top; with no clearances in the window it still prints the "no judge clearances today" line. Exit 0.
2. List open PRs (`gh pr list --json number,labels,headRefOid`). Candidates:
   - **clear candidates** — `review:human` plus `advisory:accepted` (the cheap label pre-filter; the runner re-checks everything);
   - **arbitrate candidates** — PRs carrying the stood-down label `review-status:stood-down` (`STAND_DOWN_LABEL` in `we:scripts/conveyor/stand-down.mjs`), called as `we:scripts/operations/judge-arbitrate.mjs --pr=<n>`; and PRs with no stand-down whose same finding was bounced twice (`bouncedRounds` from `we:scripts/lib/finding-bounce.mjs`, built in `x6prrg3`, returns two or more entries for one finding id, one per separate automation-authored `changes` verdict comment on the PR from `gh pr view --json comments` — neither the verdict ledger, which holds no finding ids, nor the clone-local jury log, whose round is the in-run round, can answer that), called as `we:scripts/operations/judge-arbitrate.mjs --pr=<n> --finding=<id>`. The arbiter (`x6prrg3`) accepts both shapes. A PR that has both is a stand-down candidate only. **A PR whose latest arbiter recommendation marker already matches its current finding id and head is not a candidate** (the arbiter posted a recommendation-only outcome there and a new head or finding is needed to change it), so a protected-path or security-finding PR does not respawn the judge every tick.
3. Call the matching runner for each, in a child process, up to a per-tick cap (default 2 judge spawns per tick, `WE_JUDGE_PASS_MAX`), oldest first. Only a call that actually spawned a judge counts against the cap; a refusal decided before any spawn does not. **Which refusals are remembered is an allow-list, not a deny-list.** The pass keeps one named constant, `PERMANENT_REFUSALS`, holding only the refusals that depend on nothing but the head, the labels and the configured judge seat: `protected-list` (only when its detail is a real path match, never `changed-paths-incomplete`), `secret-in-diff` and `same-provider`. A PR the runner refused with one of those on the current head is not retried until its head, its labels or the seat change (a small state file in the coordination root, keyed by PR, head, a hash of the label set and the seat identity — provider and model — the runner printed; when the cross-provider seat of `xud2hha` arrives or the seat config changes, the key changes and the PR is judged again), so a protected PR does not burn a call every tick. **Every other refusal is retried on the next tick and never written to that file**, because each can flip with neither the head nor the labels moving: `wait-not-elapsed` (the deadline passes; also `parked-time-unknown`), `reviewers-not-accepted` (red or pending CI goes green on a rerun), `independence-unknown` (a dispatch record appears or is repaired), `same-actor` (it reads reviewer markers in PR comments, which the key does not cover), `protected-list` with `changed-paths-incomplete` (a transient git fetch failure), `kill-switch` and `not-human-gated` (switch or label state), and `error`. All of these are decided before any spawn, so each costs one cheap runner call, not a judge call, and does not use the spawn cap. A refusal that is in neither set is treated as retry (fail toward trying again), and a table-driven test over `JUDGE_REFUSALS` (see the test plan) fails when a refusal has no explicit classification, so adding one forces the decision.
4. Once per local day (America/New_York) call the digest (`we:scripts/conveyor/judge-digest.mjs`).
5. Every failure is printed with the PR number; the pass never throws out of the tick.

**Runner registration** in `we:skills-src/conveyor/runner.mjs`: add `judge-pass` to `MECHANICAL_PASS_NAMES` and run it after `advisory-label-sweep` (so advisory labels are fresh), skippable with `--skip-pass=judge-pass` like every other pass. `we:scripts/conveyor/tick-core.mjs` is not touched: dispatch planning has no part in this.

## MVP

1. Must run no judge or arbiter call at all while the kill switch is off, yet must still send the daily digest, which states that the judge was off.
2. Must cap judge spawns per tick and not re-judge a permanently refused PR (`PERMANENT_REFUSALS` only) until its head or labels change; every other refusal — `wait-not-elapsed` once its deadline passes, `reviewers-not-accepted` once CI turns green, `independence-unknown`, `changed-paths-incomplete`, `error` — must be retried next tick even though the head and labels are unchanged.
3. Must send the digest at most once per local day.
4. Must be skippable by name like the other mechanical passes, and an unknown skip name still refuses the runner start.
5. Must never throw out of the tick; failures are printed with the PR number.

## Done when

1. **Executable — Musts 1–3, 5:** a Vitest run of `we:scripts/conveyor/__tests__/judge-pass.test.mjs` passes (new file).
2. **Executable — Must 4:** a Vitest run of `we:skills-src/conveyor/__tests__/runner.test.mjs` passes with `judge-pass` in the pass list.
3. **Observable — live:** one `sweep --dry-run` against the real repo lists the candidates and what it would run; then one real tick with the judge on shows the runner outcome per candidate. Output pasted in the PR.

## Test plan

New `we:scripts/conveyor/__tests__/judge-pass.test.mjs` (matching source: `we:scripts/conveyor/judge-pass.mjs`), with injected `gh`, runners, switches and clock:

- **The kill switch blocks:** switches OFF → zero `gh` calls, zero runner calls. Red today: the judge pass does not exist.
- **The digest still runs while the judge is off:** switches OFF, first tick of the day → the digest is called once, with the switch state `judgeEnabled: false` and its `reason`, and its text carries the "judge OFF" line; the second tick of the same day does not call it again. An unreadable switch store (which reads as OFF) → the digest is still called and the text names the parse error. Red today: the judge pass does not exist.
- **The wait switch off → immediate:** with `waitHours: 0`, a PR that became a clear candidate this tick is handed to the runner this tick. Red today: the judge pass does not exist.
- Five clear candidates, cap 2 → the two oldest are run. Red today: the judge pass does not exist.
- A PR permanently refused on head A (for example `same-provider`) is skipped on the next tick; after its head moves to B it is run again. Red today: the judge pass does not exist.
- **A wait that expires is retried:** with `waitHours: 4`, a PR parked one hour ago → the runner refuses `wait-not-elapsed`; a second tick two hours later (fake clock) → the runner is called again and still refuses; a third tick five hours after the park, head and labels unchanged → the runner is called and the PR is handed on to the judge. The refusal file holds no entry for the PR at any point. A `wait-not-elapsed` with detail `parked-time-unknown` is likewise retried the next tick. Red today: the judge pass does not exist (and the rule as first written, "not retried until head or labels change", would skip the PR forever).
- **CI that flips is retried:** a PR with `advisory:accepted` on head A whose runner returns `reviewers-not-accepted` (CI pending) on tick 1; CI goes green with head and labels unchanged → on tick 2 the runner is called again and the PR is handed to the judge. Red today: the judge pass does not exist (and a cache that kept every refusal until head or labels change would skip it forever).
- **A new seat re-judges a same-provider refusal:** a PR refused `same-provider` on head A under seat `anthropic/opus` is skipped on the next tick; after the seat config changes to a `codex` seat (head and labels unchanged) the runner is called again. Red today: the judge pass does not exist.
- **A transient failure is retried:** a runner returning `error`, and one returning `protected-list` with detail `changed-paths-incomplete`, on tick 1 → both are called again on tick 2; neither leaves an entry in the refusal file. Red today: the judge pass does not exist.
- **Every refusal is classified (table-driven):** one case per member of `JUDGE_REFUSALS` asserting whether the pass remembers it — `protected-list` (path match), `secret-in-diff`, `same-provider` remembered (the last keyed by seat identity); the rest, including `same-actor`, retried — and a guard case that fails when a member of `JUDGE_REFUSALS` is in neither set, so a refusal added later cannot silently default. Red today: the judge pass does not exist.
- **A twice-bounced finding is read from the PR's verdict comments:** two automation-authored `changes` verdict comments rendered by the real renderer (not hand-typed), both listing finding F → the arbiter runner is called with `--finding=<findingId(F)>`; F in one `changes` comment and then an `accepted` comment, or the second comment from a non-automation login → not called. Red today: the judge pass does not exist.
- **A transient refusal does not use the cap:** cap 2, three candidates, the oldest returning `wait-not-elapsed` before any spawn → the other two are still judged this tick.
- **A protected-list PR is never judge-cleared:** a protected-path candidate reaches the runner, the runner refuses, and the pass records the refusal and does not retry it on the same head. Red today: the judge pass does not exist.
- A stood-down PR → the arbiter runner is called with `--pr` only, not the clear runner. Red today: the judge pass does not exist.
- **A recommended-only PR is not re-run:** a stood-down PR whose latest arbiter recommendation marker matches its current head and finding id → the arbiter runner is not called on the next tick; after the head moves, it is. Red today: the judge pass does not exist.
- **A twice-bounced finding with no stand-down reaches the arbiter:** a PR with two `review:changes` verdicts on one finding id and no stand-down label → the arbiter runner is called with `--pr=<n> --finding=<id>`; a PR with both a stand-down label and a twice-bounced finding → called once, with `--pr` only. Red today: the judge pass does not exist.
- Digest called once on the first tick of a day and not on the second. Red today: the judge pass does not exist.
- A runner that throws → printed, the next candidate still runs, the pass returns normally. Red today: the judge pass does not exist.

Extend `we:skills-src/conveyor/__tests__/runner.test.mjs`: `judge-pass` is in `MECHANICAL_PASS_NAMES`, `--skip-pass=judge-pass` skips it, and an unknown skip name still refuses.

## Proof plan

Tests first, red. After the build: both files green. Live: a `sweep --dry-run` on the real repo, then one real tick with the judge on, pasting each candidate's runner outcome (cleared, or the refusal reason); then turn the judge off with the switch CLI and run a second tick showing zero judge calls and a digest that says the judge is off. `npm run check:standards` last. `we:skills-src/conveyor/runner.mjs` is a trust-chain member, so this PR is on the protected list and the human clears it.

## Follow-ups

- If the per-tick cap proves too low or too high, tune `WE_JUDGE_PASS_MAX`; no ruling needed.

## Progress

- Prepared 2026-10-03. Scope corrected: the filed scope named `we:scripts/conveyor/tick-core.mjs`, but mechanical passes are registered in `we:skills-src/conveyor/runner.mjs` (`MECHANICAL_PASS_NAMES` and its `run(...)` calls for `we:scripts/operations/operator-notify.mjs` and `we:scripts/conveyor/parked-pr-conflict-watch.mjs`), with tests in `we:skills-src/conveyor/__tests__/runner.test.mjs`. The tick core plans dispatch and is not touched.
- Re-checked against the operator's send-back ruling of 2026-10-04 (block, on every confirmed referral): the refusal-caching finding is already closed in this card — `PERMANENT_REFUSALS` is an allow-list that excludes `wait-not-elapsed`, and the test plan names the fake-clock case "A wait that expires is retried" (head and labels unchanged, retried after the deadline, no entry in the refusal file). No further change was needed here.
- Revised after advisory review of the decision PR: the refusal memory was widened from "every refusal except `wait-not-elapsed`" to an allow-list (`PERMANENT_REFUSALS`), because CI flips, transient git failures and errors also change nothing in the head or labels; added table-driven classification and retry cases. Shape-B detection now reads the PR's own automation-authored verdict comments through `we:scripts/lib/finding-bounce.mjs` (the verdict ledger holds no finding ids and the jury log is clone-local with in-run rounds). `same-actor` moved out of the remembered set (it depends on comment markers the key does not cover), and the seat identity joined the key for `same-provider`.
