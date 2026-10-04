---
bornAs: xzaqgfu
kind: story
status: resolved
size: 3
parent: "4936"
blockedBy: ["4874"]
scope: ["we:skills-src/jury/panel-fanout.mjs", "we:skills-src/jury/__tests__/panel-fanout.test.mjs", "we:scripts/lib/judge-panel.mjs", "we:scripts/lib/__tests__/judge-panel.test.mjs"]
dateOpened: "2026-09-30"
dateResolved: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "4a2606bc2f711efd86849e250db36b1b100a0fa4"
tags: [routing, dispatch, review]
---

# Jury panel jurors judging a PR diff take their model size from the review need, and every seat records what it ran on

When the `/jury` panel fan-out judges a PR diff, its native Claude jurors default to the review-need tier: Haiku for inert prose, Sonnet by default, Opus for critical changes. Today every juror defaults to Sonnet at medium effort. An explicit `model`/`effort` in the payload still wins. Every seat's output records the provider, model, effort and reason it ran with. The jurors stay native Claude: this card changes size, not provider or authority.

## Progress

**Implementation preflight (2026-10-03).** Blocked in this checkout at `4b3c1073f`: the declared prerequisite #4874 is still open locally, and `we:scripts/lib/review-need.mjs` is absent. Searching the implementation sources found no `reviewNeedFor` definition. The local remote-tracking ref `origin/lane/card-4874` at `de1ca5bc9` contains that module, but bringing its implementation into this checkout would exceed this card's four-file scope; dependency integration is pending. No routing implementation or resolution is claimed.

Before-change baseline: `npx vitest run we:skills-src/jury/__tests__/panel-fanout.test.mjs we:scripts/lib/__tests__/judge-panel.test.mjs` (remove the `we:` path qualifiers when executing) passed both suites, 98 tests. `node we:scripts/verify-lane.mjs` initially exited 3 with `selection-required` because the checkout had no diff. The required tier regression, mutation and live panel proofs remain pending the prerequisite; there is no after-change routing proof yet.

After recording this blocker, `node we:scripts/verify-lane.mjs` passed its card-only selection (no related tests) and `npm run check:standards`: 0 errors, 5286 warnings. This verifies the progress-note edit only, not completion of the implementation.

**Re-aim (2026-10-03).** Old premise: "Mandatory jurors stay native Claude at high care under #4374". The card was to expose native-only model and effort policy and reject provider edits that change authority. #4374 has been re-aimed (it now routes model size by risk on native Claude), so that premise is stale. The goal stays the same: explicit, recorded model and effort for native jurors, with authority unchanged. It now uses the shared review-need tier from 4874. Re-parented from the launch-routing audit epic 4733, whose audit row still points here, to the review-routing epic 4936.

**Grounding.**

- `judgePanel` takes a panel-wide `model`/`effort` plus per-seat overrides, and defaults to `DEFAULT_MODEL = 'sonnet'` and `DEFAULT_EFFORT = 'medium'` (`we:scripts/lib/judge-panel.mjs:384`, lines 393-394 and 416-417; defaults at `we:scripts/lib/judge-spawn.mjs:362-363`).
- The `/jury` CLI caller forwards `payload.model`/`payload.effort` only when they are set (`we:skills-src/jury/panel-fanout.mjs:367-376`). Its output seats carry no model or effort (lines 386-400), so a run cannot show what it ran on.
- `judgePanel` jurors are tool-free (`judgePanel` never forwards `allowedTools`; see `we:scripts/operations/review-pr.mjs:1223`). The tool question therefore does not arise here.
- `review-pr`'s mandatory seats do not use `judgePanel` (`we:scripts/operations/review-pr.mjs:1968`). 4374 covers them. This card covers only the `/jury` fan-out.
- `we:scripts/lib/dispatch-routing-policy.json` has a `judge` operation entry, but `judgePanel` does not read it. The original card asked for policy-file routing "or encode and validate its native-only authority constraint explicitly". This card takes the second branch: the tier comes from 4874, and the provider is fixed to Claude.

## Design

1. `we:skills-src/jury/panel-fanout.mjs` accepts an optional `payload.changedFiles: string[]`, and treats `payload.subject === 'pr-diff'` as the PR-diff case. When both are present and the payload has no explicit `model`, it calls `reviewNeedFor({ changedFiles })` (4874) and passes `model: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' }[need.tier]` to `judgePanel`. Effort is `high` for Opus, the panel default otherwise, and omitted for Haiku unless proven supported (same rule as 4374). A per-juror `model`/`effort` in the roster still wins over this default.
2. Any other subject (design, decision prose), or a PR-diff payload without `changedFiles`, keeps today's defaults. The tier never applies without a touch-set to derive it from.
3. **Provider stays Claude.** `we:skills-src/jury/panel-fanout.mjs` refuses a payload or juror carrying `provider`/`providerName` other than `claude`, with a clear error, before any spawn. A routing edit cannot quietly move `/jury` authority to another provider.
4. **Records.** `judgePanel`'s per-juror result gains `{ provider: 'claude', model, effort }`, which it already resolved. The fan-out output seat gains those fields plus `modelReason` (`tier <tier> (<reasons>)`, `payload`, or `default`).
5. **Launch failures.** An unknown `effort` is refused before any spawn (the existing judge-spawn enum check). A spawn that fails after launch is a failed seat, as today. It is never retried, because an indeterminate launch may have run.

## MVP

Steps 1-5 in one PR touching the four scoped files. Incremental and additive: callers that pass no `changedFiles` see no change. Blocked only on 4874, which provides `reviewNeedFor`. This card does not touch the #3507 files.

## Test plan

- (RED today) `we:skills-src/jury/__tests__/panel-fanout.test.mjs`:
  - a pr-diff payload with card-only `changedFiles` spawns `--model haiku`; one with a gate file spawns `--model opus --effort high`; one with ordinary code spawns `sonnet`;
  - an explicit `payload.model` wins; a per-juror model wins;
  - a non-pr-diff subject keeps the defaults;
  - a `provider: 'codex'` payload is refused with no spawn;
  - output seats carry `provider`, `model`, `effort` and `modelReason`.
- (RED today) `we:scripts/lib/__tests__/judge-panel.test.mjs`: per-juror results include the resolved `provider`/`model`/`effort`. An unknown effort is refused before any spawn. A spawn failure is not retried (the spawn count stays 1).
- (RED today) **Must on error:** `changedFiles` that is malformed or empty on a pr-diff payload gives Opus (the fail-closed tier from 4874). It never gives Haiku.
- (RED today) **Must for non-code:** docs, config and data diffs get Sonnet or Opus per 4874. Only inert prose with care `none` gets Haiku.

## Proof plan

Run both suites. Mutation check: drop the tier branch; the haiku and opus cases must fail. Live: run the we:skills-src/jury/panel-fanout.mjs CLI with `--payload-file=<f> --depth=0 --max-depth=2 --max-total-budget-usd=2 --json` twice, with a two-juror pr-diff payload for a real card-only PR and for a real gate-file PR. Paste the output seats' `model`/`modelReason` here.

## Done when

1. Both suites pass with the new cases; the mutation check fails them.
2. The two live outputs show `haiku` and `opus` with reasons, recorded here.
3. `npm run check:standards` passes.

## Follow-ups

The 2026-09-30 launch audit (4733) deferred this adapter. Once this lands, its audit row can be marked done.
