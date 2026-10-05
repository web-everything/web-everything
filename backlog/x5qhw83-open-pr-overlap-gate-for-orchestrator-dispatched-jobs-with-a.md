---
kind: story
size: 5
parent: "x0hvbwx"
status: open
blockedBy: ["xcs4nce", "xq4p21a"]
scope: ["we:scripts/readiness/overlap-chain.mjs", "we:scripts/readiness/__tests__/overlap-chain.test.mjs", "we:scripts/codex-direct-task.mjs", "we:scripts/gemini-direct-task.mjs", "we:scripts/__tests__/codex-direct-task.test.mjs", "we:scripts/__tests__/gemini-direct-task.test.mjs", "we:scripts/__tests__/direct-task-overlap-gate.test.mjs", "we:scripts/conveyor/health-smells/overlap-override-used.mjs", "we:scripts/conveyor/health-smells/__tests__/overlap-override-used.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "838e849ab8b35fa4b94216b7d474b3138d979ba5"
tags: [policy, dispatch, overlap, wip]
---

# Open-PR overlap gate for orchestrator-dispatched jobs, with a logged override mode

A job whose declared scope touches a file of another open PR is refused, unless policy allows an override.
In `logged` mode an override needs a named reason, writes a durable record, and shows on the WIP page.
Governed by `dispatchGate.overlapOverride` (default `off`, meaning no override).

## Progress

Prepared 2026-10-03 against `838e849ab`.

| Premise | Checked against the code |
| --- | --- |
| Dispatch already checks open-PR overlap. | **For conveyor builds only.** `we:scripts/conveyor/build-dispatch-policy.mjs:271-274` holds a build whose scope overlaps an open PR's files (rule `scope-vs-open-prs`, declared at `:77`). Conveyor fix and CI-heal jobs compare only against live claims, not open PRs (`filterFixesByInFlightScope`, `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1484`). The orchestrator's direct jobs (`we:scripts/codex-direct-task.mjs`, `we:scripts/gemini-direct-task.mjs`) take no scope and check nothing. |
| An override exists and is logged. | **No.** There is no flag to override the dispatch-time check, and no durable override record. The only overlap overrides are land-time yield flags (`we:scripts/conveyor/land-overlap-yield.mjs:103-127`), resolved in memory. So on 2026-10-03 the orchestrator overrode by judgment, about five times on open PR #3507's files, and each time #3507 needed another conflict-fix and review round. |
| The pieces to reuse exist. | `firstScopeOverlap` (`we:scripts/readiness/overlap-chain.mjs:96`), the open-PR fetch with files (`fetchOpenPrsRest` and `BUILD_DISPATCH_PR_FIELDS`, `we:scripts/conveyor/open-pr-fetch.mjs:48`, `:88`), and the policy-event journal and its health probe (stories #xcs4nce and #xq4p21a). |

The detached codex-job runner the orchestrator used on 2026-10-03 is not on main. When it lands, it calls the
same gate (follow-up).

## Design

1. **Pure gate** in `we:scripts/readiness/overlap-chain.mjs`:
   `openPrOverlapGate({ scope, openPrs, selfPr, policy, overrideReason })` returns
   `{ allowed, hits: [{ file, pr }], mode, record, reason, selfPrExempt }`, where `reason` is `null` or a short
   code (`overlap`, `override-reason-required`, `open-prs-unreadable`) the caller prints and the tests assert on,
   and `selfPrExempt` is `null` or `{ pr, files }` (the hits `selfPr` suppressed, below).
   - It ignores `selfPr`, the PR this job repairs, **only when `selfPr` is validated**: a repair must touch its
     own PR's files, but `--pr` is typed by the dispatcher, so the gate does not take it on trust.
     - **`selfPr` must be an open PR present in `openPrs`.** A number that is not in the list (closed, merged,
       mistyped, made up) is ignored as if `--pr` were absent: every hit counts, and the gate returns the code
       `self-pr-not-open` in `reason` when that is what caused a refusal, so the dispatcher sees why. (This also
       means `selfPr` cannot name a PR the gate has not read.)
     - **The exemption is never silent.** When a valid `selfPr` suppresses at least one hit, `selfPrExempt` is
       set and the wiring records one `overlap-self-pr` event (step 3) in every mode, so naming the overlapped
       PR as the one being repaired leaves the same kind of trail as an override.
     - **What this does not do.** It cannot tell a real repair of #3507 from a job that only claims to be one:
       both have a scope inside #3507's files, so a "scope must be a subset of `selfPr`'s files" rule would
       not separate them (and would wrongly refuse a repair that adds a new test file). What is enforceable
       here is validity plus visibility, and the card claims no more: a dispatcher that lies about `--pr`
       is visible on the WIP page, not prevented.
   - **An unreadable open-PR list fails closed.** The caller passes `openPrs: null` when the fetch threw or
     hit its page limit (a truncated list is not a complete one), distinct from `[]` (no open PRs). With
     `null`, the gate returns `allowed: false`, no hits, and a reason `open-prs-unreadable`, under `off` and
     `logged` alike (a reason cannot override a check that did not run). Under `free` it allows and sets
     `record` true, with `detail.overlapCheck: 'unreadable'` and subject `<repo>` (no PR is known), so the
     WIP page still shows that the check was blind (the smell in step 4 also rows these events). A refused
     run costs nothing and a retry re-reads.
   - `off` (default): any hit refuses. The message names each file and PR. A reason does not help.
   - `logged`: a hit refuses unless `overrideReason` is a real reason (non-empty after trimming, at least 15
     characters). When allowed, it returns `record` set to true.
   - `free`: allowed, and `record` is still true, so the WIP page still shows the overlap.
2. **Direct-job wiring.** `we:scripts/codex-direct-task.mjs` and `we:scripts/gemini-direct-task.mjs` gain
   `--scope=<repo:path,…>` (required), `--pr=<n>` (the PR being repaired, optional) and
   `--overlap-override-reason=<text>`. Before any model is spawned, they fetch open PRs with files, run the
   gate, and exit non-zero on a refusal. A refused run costs nothing.
3. **Record.** When `record` is true, call `recordPolicyEvent`: key `dispatchGate.overlapOverride`, event
   `overlap-override`, the reason, and detail `{ files, dispatcher, mode, repairing }`.
   - **One event per overlapped PR, keyed on that PR.** The subject is `<repo>#<hit.pr>`, the PR whose files
     were overlapped (from `hits[].pr`), **not** the PR being repaired. A job overlapping two open PRs writes two
     events, each with only that PR's files in `detail.files`. `repairing` is `selfPr` or `null` and is only
     context: `--pr` is optional, so no subject ever depends on it (a missing `--pr` must never produce
     `<repo>#undefined`, and a hit-bearing event is never written under a bare `<repo>`; the one bare-`<repo>`
     subject is the hit-less `overlapCheck: 'unreadable'` event in step 1, which has no PR to name). The smell (step 4) keys on this subject, so the writer and the
     reader agree by construction.
   - When `selfPrExempt` is set, also write one event `overlap-self-pr`, subject `<repo>#<selfPr>`, detail
     `{ files: selfPrExempt.files, dispatcher, mode }`, no reason (none is asked for), in every mode.
   - **Untrusted text.** The reason is free text typed by a dispatching agent, and file names come from
     other PRs. `recordPolicyEvent` truncates and strips them on write (story #xcs4nce), and the smell and the
     WIP page treat them as plain text. The gate also rejects, before the length check, a reason containing a
     control character, and refuses a reason longer than `POLICY_EVENT_REASON_MAX` (a longer one is refused,
     not truncated, so the recorded reason is the one the dispatcher meant). That constant is **exported by
     `we:scripts/lib/delivery-policy.mjs` (story #xcs4nce, value 200) and imported by the gate**: the gate's
     cap and the journal's truncation are one number by construction, never two numbers kept in step by hand.
     A reason the gate accepts therefore always reads back from the journal intact.
   - **What the 15-character floor is, and is not.** It stops an empty or one-word reason by accident. It
     does not make a reason *good*: any filler passes. The audit value comes from the visible record (the
     medium health episode that quotes the reason for 24 hours), not from the length check. The card does not
     claim more.
4. **WIP.** Add `we:scripts/conveyor/health-smells/overlap-override-used.mjs` on the `policyEvents` probe from
   story #xq4p21a: severity `medium`, action `alert`, one row per overlapped PR. A row's key is the subject
   `<repo>#<pr>` of the `overlap-override` events (step 3: the overlapped PR, written once per PR), so it
   breaches when an override that overlapped that PR was recorded in the last 24 hours, and the summary quotes
   the reason. It also gets one row
   per repo that has an `overlapCheck: 'unreadable'` event in the last 24 hours ("overlap check was blind"),
   so a `free`-mode blind spot is visible too. `overlap-self-pr` events get their own rows, one per `selfPr`
   and event type (the row key is `<event>:<subject>`, so an `overlap-self-pr` row and an `overlap-override`
   row for the same `<repo>#3507` never merge), at severity `low`, action `note`: a repair of one's own PR
   stays visible in the episode list without turning the health section yellow. The builder confirms in
   `we:scripts/conveyor/health-smells/` that a `low` episode is accepted and listed; if the framework has no
   such tier, the row goes in the smell's summary text instead and the card's claim narrows to that.
   (Only the `medium` listing is evidenced today by `we:../plateau-app/src/wip/progress-health.ts:65-75`.) A medium episode turns the
   live-state health section yellow and lists on the WIP page (`we:../plateau-app/src/wip/progress-health.ts:65-75`).

## MVP

Steps 1 to 4 for the two direct-job entry points.

## Test plan

- **Capability (RED today, fails before this lands):** `we:scripts/readiness/__tests__/overlap-chain.test.mjs`, gate cases. The open-PR fixture is #3507 with its
  four files (`we:scripts/lib/jury-core.mjs`, `we:scripts/operations/review-pr-io.mjs`,
  `we:scripts/operations/review-pr.mjs`, `we:scripts/review-set-label.mjs`):
  - `off`: a scope with `we:scripts/lib/jury-core.mjs` is refused and names #3507, even with a reason.
  - `logged`: no reason is refused; a too-short reason is refused; a real reason is allowed with `record`.
  - `free`: allowed with `record`.
  - `logged`: a reason one character over `POLICY_EVENT_REASON_MAX` and a reason containing a control
    character are each refused.
  - `logged`: a reason of exactly `POLICY_EVENT_REASON_MAX` characters is allowed, and after `record` then
    `readPolicyEvents` it reads back **intact** (no `…`). The gate imports the constant, so this fails if
    anyone gives the gate its own number.
  - **Unreadable open-PR list:** `openPrs: null` is refused with `open-prs-unreadable` under `off` and
    `logged` (even with a real reason); under `free` it is allowed with `record` true and
    `overlapCheck: 'unreadable'`. `[]` is allowed (nothing to overlap).
  - `selfPr` 3507 (open, in `openPrs`), scope inside #3507's files: allowed under every mode, with no
    `overlap-override` record but `selfPrExempt` set (and the wiring writes one `overlap-self-pr` event).
  - **`selfPr` that is not validated:** `selfPr` 9999 (not in `openPrs`) with the same scope under `off`: refused
    with `self-pr-not-open`, naming #3507, even though `--pr` was given (`self-pr-not-open` takes precedence over
    `overlap` as the `reason` whenever the refusal came from an ignored `selfPr`). Under `logged` without a reason: refused;
    with a real reason: allowed with `record`. `selfPr` omitted: same as an unknown number (every hit counts).
  - **Two overlapped PRs, one job, no `--pr`:** a scope touching one file of #3507 and one of another open PR
    produces two `overlap-override` events, subjects `<repo>#3507` and `<repo>#<other>`, each carrying only
    its own PR's files; no subject contains `undefined`.
  - **Producer/consumer fixture:** feed the events the wiring actually writes (the case above) to the
    `overlap-override-used` smell: it yields exactly one `overlap-override` row per overlapped PR (#3507 and
    the other), and a job that repaired a third PR is not given an `overlap-override` row of its own for
    `--pr` (the third PR gets a row only from an `overlap-self-pr` event, below).
  - A disjoint scope: allowed, no record.
  - Default (no config): behaves as `off`.
  - **Replay of #3507:** five sequential fix jobs on #3507's files. Before this story: all five dispatch.
    After it, under the default: all five are refused before spawning, so #3507 needs no extra rounds.
- **Capability (RED today, fails before this lands):** `we:scripts/__tests__/direct-task-overlap-gate.test.mjs`: a missing `--scope` exits with a usage error; a
  refusal exits non-zero before the spawn function is called (spawn injected and asserted unused); an allowed
  override writes one journal line; an open-PR fetch that throws, and one that returns a full page (the page
  limit reached), each exit non-zero before the spawn function is called.
- **Capability (RED today, fails before this lands):** `we:scripts/conveyor/health-smells/__tests__/overlap-override-used.test.mjs`: the shape is valid; an event in
  the last 24 hours breaches; an older one does not; an `overlapCheck: 'unreadable'` event yields a
  "blind" row for its repo. An `overlap-self-pr` event yields one row at severity `low`, keyed separately from
  an `overlap-override` row for the same `<repo>#<pr>` (both events present: two rows). A journaled reason
  carrying markup stays inert in the summary (plain text), and the summary stays within a fixed length.

## Proof plan

1. Live refusal: run `node we:scripts/codex-direct-task.mjs --scope=<a file of a currently open PR> --task="noop"`
   against real open PRs. **Before:** it spawns Codex. **After:** it refuses at once, naming the PR.
2. Live logged override: with a temp config set to `logged` and a real reason, show the journal line, then one
   health-watch tick showing the `overlap-override-used` episode, then `we:scripts/operations/run.mjs live-state --json` with the
   health section yellow.

## Follow-ups

- plateau-app: the WIP band must render journal text (override reasons, file names) as plain text, never as
  markup.
- The detached codex-job runner (not on main) calls `openPrOverlapGate` when it lands.
- Conveyor fix dispatch (`we:scripts/conveyor/reconcile-fix-dispatch.mjs:1484`): check other open PRs' files.
  This needs its own design, because a fix's scope is its own PR's files.

## Done when

1. **Executable:** the #3507 replay case fails before this lands (all five dispatch) and passes after (all
   five refused).
2. Proof steps 1 and 2 are pasted in the PR.
