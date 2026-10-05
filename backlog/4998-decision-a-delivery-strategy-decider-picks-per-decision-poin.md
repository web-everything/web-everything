---
bornAs: x1hhjnb
kind: decision
parent: "3383"
status: resolved
dateOpened: "2026-10-03"
dateStarted: "2026-10-03"
dateResolved: "2026-10-03"
codifiedIn: "docs/agent/platform-decisions.md#delivery-decider-under-fixed-settings"
preparedDate: "2026-10-03"
preparedAgainstSha: "22103ded66ade34e9d6dac68081d1f487fdef7d7"
relatedTo: ["3361", "2692", "2740", "3611"]
relatedReport: reports/2026-10-03-delivery-strategy-survey-and-decider.md
tags: [policy, config, drain, conveyor]
---

# Decision: a delivery-strategy decider picks per decision point from live signals, and fixed settings always win

Operator ask 2026-10-03 (verbatim): "surely there must be many other such strategy that exist in the world and a
decider could pick between? Opus+codex research as very important". The same day the operator made several
delivery strategies configurable settings: verify mode (card 4991, PR #3811), overlap strategy (card 4992,
PR #3813), the main-protection policy keys (cards 5113, 5117, 5114, PR #3794) and backlog ids numbered
before publish (PR #3809). This card decides how a **decider** picks between strategies at run time, and how it
sits under those settings.

*Prepared 2026-10-03 (session research-delivery-strategies).* Research topic:
[/research/delivery-strategy-decider/](/research/delivery-strategy-decider/). Session report:
`we:reports/2026-10-03-delivery-strategy-survey-and-decider.md` (two independent surveys, Opus and Codex,
compared there; about 50 strategies with sources).

## FOUND (measured 2026-10-03, `origin/main` `22103ded6`)

- **Main is mostly unobserved.** Of the last 100 `we:.github/workflows/ci.yml` runs on main (09:25Z–17:55Z), 85
  were cancelled, 11 failed, 3 passed. Every completed main run from 12:00Z to 17:24Z failed. Cause:
  `we:.github/workflows/ci.yml:50-52` (per-ref concurrency group, `cancel-in-progress: true`, also on pushes to
  main). Fix filed as card 5000.
- **Serial testing cannot serve the merge rate.** About 312 merges in 12 h is 26/h; one 14-minute CI run at a
  time serves about 4/h. PRs today merge on their own green, about 6 merges stale at merge time.
- **That already breaks a statute.** `#gate-on-merged-tree-lane-fast-fail` puts the binding gate on the merged
  tree before main moves. Card 5117 (re-check before merge) is the enforcement.
- **The batched merge-queue build is already ruled and deferred.** `#event-driven-land-is-wake-only` clause 3
  defers it behind measured land-serialization saturation; tripwire #2740 (open) watches
  `we:scripts/readiness/conveyor-instrument.mjs`; clause 4 surfaces and routes, never auto-builds. GitHub's native
  queue is unavailable (user-owned repo) and kept off by `#pr-flow-rollout-mechanism`.
- **PR CI failure rate is about 16%** (16 of 97 completed `pull_request` runs), mixing real failures, flakes and
  red-main fallout. No per-test flake signal exists (card 4999).
- **Overlap:** 5 of 23 open PRs share a non-backlog file with another open PR.
- **Auto-revert is built but dormant.** #3361 (deferred 2026-08-26, "recover manually until it hurts").
- **The config surface exists in design.** Card 5113 adds `we:scripts/lib/delivery-policy.mjs`
  (`loadDeliveryPolicy`, per-field `sources`, `recordPolicyEvent` journal). A second settings home already exists
  for one strategy: `we:scripts/drain-overlap-yield-config.json` under `#drain-overlap-yield-landing-order`.
- **The heavy-slot cap is owned elsewhere.** `#heavy-command-admission-queue` keeps the cap a fixed number; epic
  #3611 owns making it adaptive.
- **Prior art is adaptive inside each point, never across the mode itself.** Zuul's window grows +1 per success
  and halves per failure; Mergify's dynamic batch grows with backlog; Ericsson's best batch size drops from 9 to 4
  as flakes rise. Learned models appear only inside one point (Uber's build-success predictor, Meta's test
  selection). No surveyed system uses a bandit to pick a queue mode.

## What the decider is

One pure function in `we:scripts`, `decide(signals, policy) → { choice, source, ruleId, signals, alternatives }`,
called by each daemon at its own decision point with a fresh snapshot. Signals come from card 5002
(`we:scripts/lib/delivery-signals.mjs`). Decision points: D1 verify order, D2 overlap (queue/stack/hold), D3
integration check, D5 main-red response, D6 heavy-slot priority, D7 test scope, D8 dispatch admission, D9
wide-change handling; D4 (speculation depth, batch size) only with the deferred batched-queue build. The full rule
table and the mapping of every setting ruled today are sections 5.4 and 5.7 of the report.

## Recommended path at a glance

| Fork | Default | Main alternative, and why it is not the default |
| --- | --- | --- |
| 1 — how the decider gets authority over a setting | **(a) an opt-in `auto` value per strategy field; precedence invariant → per-item override → fixed value → decider → platform default; safety-class fields tighten-only** | (b) decider always on, settings only as bounds: breaks the operator's rule that a fixed setting wins |

## Supported by default — not forks

- **A deterministic rule table, not a learned policy (settled by statute).** `#deterministic-core-thin-judgment`
  clause 1 requires a script-decidable choice to live in a reproducible, tested script; a bandit is randomized
  and exploratory. Both surveys agree. Revisit trigger: a field with at least 8 weeks of journaled decisions with
  linked outcomes, limited to knobs where every choice is already safe (batch size 2–4, test order, speculation
  depth within cap), safety rules outside any reward. Tuning mechanics (hold times, the grow-by-one /
  halve-on-failure rule) are build detail for the decider-core story.
- **v1 covers only points with a live mechanism.** D4 rules (speculation depth, batch size) ship only with the
  `#event-driven-land-is-wake-only` clause-3 build, after #2740 fires and the operator confirms it. The decider is
  never a way to start that build early.
- **Correctness of what lands is enforced, not un-gated.** Merging on a stale own-green is closed by enforcing
  `#gate-on-merged-tree-lane-fast-fail` through 5117. A second, correctness-based input to tripwire #2740 may be
  proposed only after 5000 and 5001 land and culprit-finding data shows integration-attributed red windows
  while `recheckWhenMainMoved` is `always`. Until then clause 3 is unchanged.
- **Shadow mode first.** A field set to `auto` starts in shadow: the decider computes and journals its choice next
  to the applied value (the platform default) until the operator reviews about a week of logs and flips that field
  live. Promotion is itself a configurable per-field setting, defaulting to shadow (ruled 2026-10-03).
- **Platform defaults stay today's ruled values.** `auto` is never the platform default in v1.
- **An impossible pin is reported, never substituted:** `blocked: fixed-policy-conflict`, journaled.
- **Decide at action time.** The decider is a library each daemon calls with a fresh snapshot, not a central
  daemon publishing decisions that are stale by the time a consumer acts (`#event-driven-land-is-wake-only`
  clause 1: a signal is never a trusted land order).
- **Every decision is journaled** through `recordPolicyEvent`: `{point, subject, choice, source:
  invariant|override|setting|decider|default, ruleId, signals, alternatives, heldSince}`, plus a `--explain` CLI.
- **Agent-specific caution (Codex survey).** Agent PRs share models and prompts, so their failures correlate;
  any batch rule starts small and halves on failure.

## Fork 1 — How the decider gets authority over a setting

*Fork-existence: forced invariant. The operator ruled that a fixed setting must still win over the decider;
branch (b) turns every setting into a bound the decider moves inside, so a fixed value no longer fixes anything.*

- **(a) Opt-in `auto` value per strategy field (default).** Each strategy field in `we:config/defineConfig.ts`
  gains the value `auto` (the setting's shape follows `#config-extends-platform-default`; its "most-permissive
  default" clause is not cited, because it runs the wrong way for safety knobs). Precedence per field, highest
  first:
  1. **Invariants** — no `auto`, never relaxed by anything below: CI parity with main (`prCi.*`), backlog ids
     numbered before publish, the statute/gate `review:human` class, never merging a red candidate, the sole main
     writer.
  2. **Per-item operator override** (a label or card field). Never relaxes an invariant.
  3. **Fixed value** — any value other than `auto` is final; the decider is not called.
  4. **Decider** — only for `auto`, inside the sibling bound fields (`stackMaxDepth`, `reservedForRepairs`).
     **Safety-class fields** (`mergeGate.onMainRed`, `mergeGate.recheckWhenMainMoved`) take `auto` only as
     tighten-only: the decider may choose values at least as strict as the platform default, never looser.
     `dispatchGate.overlapOverride` takes no `auto`.
  5. **Platform default** (`we:config/platformDefaults.ts`) when a signal is unknown.

  Decider-governed values are read only from tracked, committed settings: the delivery-policy loader and
  `we:scripts/drain-overlap-yield-config.json` become one home before D2 goes live. D6 decides heavy-slot priority
  only; the cap stays with `#heavy-command-admission-queue` and #3611.
- **(b) Decider always on; settings become bounds.** More adaptive from day one; breaks the ruling.
- **(c) Advisory only.** The decider logs; humans change settings. Not a separate branch: it is (a)'s shadow mode,
  per field, until flipped live.

```ts
// we:config/defineConfig.ts — Fork 1 (a): one more value on existing fields
export interface DispatchGatePolicyValue {
  overlapStrategy: 'queue' | 'stack' | 'auto';      // 'auto' = decider, inside stackMaxDepth
  stackMaxDepth: number;
  overlapOverride: 'off' | 'logged' | 'free';         // safety knob: no 'auto'
}
export interface MergeGatePolicyValue {
  onMainRed: 'halt' | 'warn' | 'off' | 'auto';        // 'auto' is tighten-only: halt, or halt-and-revert
  recheckWhenMainMoved: 'always' | 'if-older-than-N-min' | 'off' | 'auto';  // tighten-only
  recheckMaxAgeMin: number;
}
```

**Skeptic:** SURVIVES-WITH-AMENDMENT. Classification: (b) is excluded by the operator's ruling and (c) is (a)'s
shadow phase, so the fork is a forced invariant to ratify. Landed and folded in: invariants now sit above the
per-item override; safety-class fields are tighten-only (an `auto` that could pick `warn`/`off` on
`mergeGate.onMainRed` would make main less safe); one tracked settings home, because
`#drain-overlap-yield-landing-order` already keeps an overlap setting in a tracked file changed by a CLI verb; the
heavy-slot cap stays with #3611; `#config-extends-platform-default` cited for shape only. The same pass dissolved
two draft forks: "rule table vs bandit" (settled by `#deterministic-core-thin-judgment`) and "a correctness
un-gate for the batched queue" (REFUTED: `#gate-on-merged-tree-lane-fast-fail` already covers it; enforce it
through 5117 instead of amending `#event-driven-land-is-wake-only` clause 3).
**Screen:** clear. The precedence rule is visible to the operator, and (b) loses on merit (it breaks the ruling),
not on build order. The two dissolved draft forks were flagged by the screen too (impl detail; prioritization) and
are now "supported by default" entries.

## What ratifying files

Already filed with this card (each useful without the decider):

- 5002 — delivery signals snapshot (read-only).
- 5000 — main CI finishes every run it starts; main-CI coverage signal.
- 5001 — culprit finding for a red main (feeds #3361).
- 4999 — per-test flake score and time-boxed quarantine.
- 5003 — wide mechanical changes as a barrier with codemod replay.

On ratification, file:

1. `auto` values, tighten-only enforcement and the bound fields per Fork 1 in the delivery-policy loader
   (extends card 5113), and the one-home merge with `we:scripts/drain-overlap-yield-config.json`. Scope
   `we:config/defineConfig.ts`, `we:config/platformDefaults.ts`, `we:scripts/lib/delivery-policy.mjs`.
2. The decider core: rule table for D1, D2, D3, D5, D6, D7, D8, D9, hold times, journal, `--explain`, shadow
   mode. Scope `we:scripts/lib/delivery-decider.mjs` and its tests.
3. Wiring per consumer, inside the stories that own each point (4991, 4992, 5117, 5118, 5114).

## Ruling — RATIFIED 2026-10-03

Ratified by the operator (Nicolas Gilbert), 2026-10-03 ~14:45 ET, verbatim *"Ok for all"*, in answer to the
orchestrator's recommendation. Fork 1 (a) at the default. The one open point was shadow mode: **shadow first**.
With `auto`, the decider only logs what it would pick, with its reasons, and acts only after the operator has
reviewed about a week of logs and explicitly promotes the field. Promotion is a configurable setting, default
shadow. Pre-ratify staleness checks (`check:item`, `check:health` flags, statutes ratified since the stamp) found
no change to any default. Codified at `we:docs/agent/platform-decisions.md#delivery-decider-under-fixed-settings`.
Build stories filed: `5008` (auto value, tighten-only, promotion setting, one settings home) and `5009`
(decider core with shadow mode).

## Done when

1. **Executable** — the decision is ratified and `codifiedIn` names a new anchor in
   `we:docs/agent/platform-decisions.md` (proposed `#delivery-decider-under-fixed-settings`) carrying Fork 1's
   precedence order, the tighten-only rule and the invariant list; `npm run check:standards` passes with that
   anchor present.

### Review jury (provisional — pre-registered #2638)

Care level: `elevated`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
