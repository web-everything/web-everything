---
bornAs: xq4p21a
kind: story
size: 3
parent: "5112"
status: open
blockedBy: ["5113"]
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/__tests__/merge-ai-prs-step-refusal-alert.test.mjs", "we:scripts/conveyor/health-smells/drain-step-refused.mjs", "we:scripts/conveyor/health-smells/__tests__/drain-step-refused.test.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "838e849ab8b35fa4b94216b7d474b3138d979ba5"
tags: [policy, drain, alert, health-watch]
---

# A drain step that refuses raises a visible alert, never only a log line

When a drain step refuses (JIT numbering first), record a policy event and open a high-severity health smell,
so the WIP page turns red. Governed by `drain.onStepRefusal` (default `alert`).

## Progress

Prepared 2026-10-03 against `838e849ab`.

| Premise | Checked against the code |
| --- | --- |
| The numbering refused silently on 2026-10-03. | Confirmed. `numberPendingHashes` refuses the whole pass when a hash-path citation sits outside its rewrite scope. It prints one `console.warn` and returns `{ assigned: [], error }` (`we:scripts/lane-drain.mjs:868-875`). |
| The drain sees the refusal. | **No.** `we:scripts/merge-ai-prs.mjs:5655` calls `numberPendingHashes` and never reads `n.error`. The `--json` result only carries `numbered.warning`, which is set on a push failure only (`we:scripts/merge-ai-prs.mjs:5735-5741`). Nothing alerts. The hash then stays on main, and after 30 minutes push-to-main `check:standards` hard-errors (`we:scripts/check-standards-rules.mjs:2859`, `:2870-2899`). That is the 282 un-numbered cards. |
| A smell can carry this. | Yes. Smells are one file each in `we:scripts/conveyor/health-smells/`, picked up by `we:scripts/conveyor/health-smells/index.mjs`. The shape is checked by `we:scripts/conveyor/health-smells-shape.mjs:10-33`. A `high` episode turns the live-state health section red (`we:scripts/operations/live-state.mjs:96-108`), and the Plateau WIP page shows it. |

**Start after PR #3788 lands.** It changes the refusal path in `we:scripts/lane-drain.mjs` and its test. This
story does not edit that file, but its replay test reuses the refusal fixture shape from
`we:scripts/__tests__/lane-drain-numbering.test.mjs`.

## Design

1. **Extract the numbering step.** Move the body at `we:scripts/merge-ai-prs.mjs:5653-5745` that calls
   `numberPendingHashes` into an exported `runJitNumberingStep({ cwd, policy, record })` that returns the
   result. Pure apart from the injected `record`. Behaviour is unchanged except for the steps below.
2. **Read the refusal.** When the result has `error`:
   - Always put it in the `--json` result as `numbered.error` (next to `numbered.warning`).
   - Under `alert` (default): call `recordPolicyEvent` from the loader (story #5113) with key
     `drain.onStepRefusal`, event `drain-step-refused`, subject `jit-numbering`, the error as reason, and the
     main tip SHA in detail.
   - Under `log`: today's behaviour, the `console.warn` only.
3. **Record recovery.** When the step later runs without `error`, and the last journal event for that subject
   was a refusal, record `drain-step-ok` for it. This lets the smell close.
4. **Cover the other silent step.** Do the same for resolve-on-land failures (`resolveOnLandReport.failed`,
   declared at `we:scripts/merge-ai-prs.mjs:5650`), with subject `resolve-on-land`.
   - **Subjects are an open set, with the same recovery rule.** Other drain stories raise this alert for a
     step they cannot run safely, each under its own subject: `main-state-read` (story #5118, the main-run
     read failed) and `recheck-state` (story #5117, the re-check counter could not be read or written).
     Each uses the same event pair: `drain-step-refused` when the step refuses, and `drain-step-ok` the next
     time that subject's step runs cleanly after a refusal, so its episode closes like the other two. The
     helper that records the pair takes the subject as an argument and holds no fixed list.
5. **Probe and smell.** Add one probe line, `probes.policyEvents = readPolicyEvents({ sinceMs: 24h })`, beside
   the existing probes (`we:scripts/conveyor/health-watch.mjs:735-812`). Other policy smells reuse it. Add
   `we:scripts/conveyor/health-smells/drain-step-refused.mjs`:
   - scope `host`, cadence `every-tick`, probes `policyEvents`, `openAfter: 1`, `closeAfter: 2`,
     severity `high`, action `alert`;
   - one row per subject; it breaches when the newest event for that subject is `drain-step-refused`;
   - its recommendation quotes the refusal reason, for example the file and hash that block numbering. The
     reason is text derived from repository content (a filename a PR chose), so it goes through the journal's
     write-time cap and control-character strip (story #5113), and the WIP page renders it as plain text.
     Add a case to `we:scripts/conveyor/health-smells/__tests__/drain-step-refused.test.mjs`: a refusal reason
     carrying a control character, markup and a 5 000-character filename comes back truncated, stripped, and
     with the markup inert in the summary.

## MVP

Steps 1 to 5. Under the default, a numbering refusal turns the WIP health section red within one health-watch
tick, and the smell names the cause.

## Test plan

- **Capability (RED today, fails before this lands):** `we:scripts/__tests__/merge-ai-prs-step-refusal-alert.test.mjs`:
  - `alert`: a refusing step records one `drain-step-refused` event with subject `jit-numbering`, and the JSON
    result carries `numbered.error`.
  - `log`: no event is recorded; `numbered.error` is still in the JSON result; the warn line is still printed.
  - Default (no config): behaves as `alert`.
  - After a refusal, a clean run records `drain-step-ok` once. A second clean run records nothing.
  - A resolve-on-land failure records an event with subject `resolve-on-land`.
  - An arbitrary subject (`main-state-read`) records `drain-step-refused`, then `drain-step-ok` after a clean
    run, and the smell's episode for it closes. The smell lists a subject it has never heard of.
  - **Replay of 2026-10-03:** in a temp git repo, commit a pending card `xhash01-alpha` and a script outside the rewrite
    scope that cites that card by its hash-named backlog path (the refusal fixture from
    `we:scripts/__tests__/lane-drain-numbering.test.mjs`). Run the step. Before this story: the result has
    `error` and nothing is recorded. After it: the event is recorded and the smell breaches.
- **Capability (RED today, fails before this lands):** `we:scripts/conveyor/health-smells/__tests__/drain-step-refused.test.mjs`: the shape passes
  `we:scripts/conveyor/health-smells-shape.mjs`; a refusal breaches; refusal then ok does not; two subjects
  are scored separately.

## Proof plan

Before/after on a reproduced refusal, not only unit tests:

1. In a scratch clone of origin/main, plant the replay fixture and run the extracted step with
   `WE_POLICY_EVENTS_FILE` set to a temp file. **Before** (current main): only the warn line. **After**: the
   event line in the journal.
2. Run one health-watch tick against that journal through its fixture flags
   (`we:scripts/conveyor/health-watch.mjs:733-812`). Show the `drain-step-refused` episode opening.
3. Run `node we:scripts/operations/run.mjs live-state --json` with the same environment. Show
   `sections.health.status` as `red` with the reason.
4. Remove the citation and run again. Show `drain-step-ok`, and the episode closing after two ticks.

## Follow-ups

- Other drain steps that can stop quietly: the numbering-mutex miss at `we:scripts/merge-ai-prs.mjs:5745`
  (it retries, so it is contention, not refusal). Add it only if live data shows it sticking.

## Done when

1. **Executable:** the replay case in `we:scripts/__tests__/merge-ai-prs-step-refusal-alert.test.mjs` fails
   before this lands (no event) and passes after.
2. Proof steps 1 to 4 are pasted in the PR.
