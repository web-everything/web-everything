---
bornAs: xwjx23w
kind: story
size: 3
status: open
dateOpened: "2026-07-12"
tags: [prepare, readiness, freshness, defer, tooling]
scope:
  - we:scripts/readiness/
  - we:scripts/check-readiness.mjs
  - we:skills-src/prepare-decision-item/SKILL.md
  - we:scripts/backlog.mjs
  - we:scripts/__tests__/backlog-cli-snapshot.test.mjs
---

# /prepare candidate set must be origin-fresh and defer-aware

Close the gap that let `/prepare all` (2026-07-12) prepare-hold and nearly stamp two decisions carrying a standing operator defer: make the prepare flow (a) read candidate bodies at the origin/main tip, never a possibly-stale primary tree, and (b) screen out — or at least surface — decisions whose body carries an operator-defer block or a defer-scoped `priority: low`. Today `we:scripts/readiness/engine.mjs`'s `priority: low` filler exclusion applies only to Tier A, so deferred Tier-B decisions still enter the prep candidate pool.

## Why (the 2026-07-12 near-miss)

A `/prepare all` session built its candidate set and read #2444/#2446 from the primary checkout, which was stale — a concurrent session had landed `eff5725a` (re-scope #2445; operator-defer blockquotes + `priority: low` on both decisions). The session prepare-held both, ran the full research spend, and authored prepared-fork bodies before a skeptic sub-agent reading the *current* file surfaced the defer. The stamp was averted, but every guard fired late: nothing in the candidate-set step reads origin-fresh bodies or respects defer markers.

## What to change

- **`we:scripts/readiness/engine.mjs` (Tier-B filler gap):** the `isFiller` (`priority === 'low'`) exclusion filters only `tierAopen`; apply an equivalent screen (or an explicit `deferred` surfacing) to the Tier-B decision projection so `check:readiness --select` stops offering defer-parked decisions as prep candidates. Keep them visible under a "deferred" label rather than silently hidden — `priority: low` is "pickable, out of auto-select" by ruling.
- **`we:skills-src/prepare-decision-item/SKILL.md` (step 1):** require a `git fetch origin` + candidate-body reads at the origin/main tip (or inside the freshly-refreshed lane), and add a hard step-1 check: a body carrying a `**Deferred (… operator call)**` block is excluded from the candidate set — an operator defer is binding on prep, not just on ratification.
- **`prepare-hold` guard (optional hardening):** `node we:scripts/backlog.mjs prepare-hold <NNN>` could warn (not block) when the target's origin-tip body carries a defer block, catching the case where a session bypasses the skill.

## Grounding

- `we:scripts/readiness/engine.mjs` — `isFiller` applied to `tierAopen` only; `tierB` projection has no `priority: low` exclusion.
- `we:scripts/check-readiness.mjs:91-110` — the #2204 fetch-first fix fast-forwards local main before *ranking*, but nothing protects the later per-item body reads during prep authoring.
- Prep-assessment notes on [#2444](/backlog/2444-plateau-loop-phase-1-agent-runner-shape-cli-spawn-contract-s/) and [#2446](/backlog/2446-where-does-plateau-loop-live-plateau-app-module-own-repo-or-/) record the near-miss this item closes.
