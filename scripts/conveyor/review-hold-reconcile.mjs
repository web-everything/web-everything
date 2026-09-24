#!/usr/bin/env node
/**
 * @file scripts/conveyor/review-hold-reconcile.mjs
 * @description THE REVIEW-HOLD RECONCILE SWEEP (#x01u7az) — a one-time-and-ongoing cleanup pass for two
 *   contradictory/stray label states `we:scripts/review-set-label.mjs#decideSetLabel` now refuses to produce
 *   GOING FORWARD, but which already exist on open PRs from BEFORE the fix landed. A forward fix alone never
 *   touches a label that is already wrong; per the operator's own standing rule ("we always take failure as an
 *   opportunity to improve our product, never as a problem that needs manual intervention"), the cleanup is a
 *   mechanical pass, not a hand-run `gh pr edit`.
 *
 * TWO INDEPENDENT INVARIANTS, ONE SWEEP (they were both live on chalbert/web-everything on 2026-09-24, and both
 * are "a review:* label describing a state that no longer holds"):
 *
 *   1. AT MOST ONE review:* HOLD LABEL. `review:human` is itself a hold — a gate-self PR needs no `review:pending`
 *      on top of it to say "an independent review is owed"; the human hold already says that. Before this sweep's
 *      companion fix (`decideSetLabel`'s `rearm` branch), a mechanical re-arm of a `review:human` bounce added
 *      `review:pending` unconditionally, live on PR #2549 (`review:pending` added 2026-09-24T14:05:09Z by
 *      `we:scripts/conveyor/rearm-review.mjs`, on top of `review:human` set 01:32:17Z and never cleared — still
 *      both live on that PR as of this sweep's authoring). `planReviewHoldCleanup` drops the stray `review:pending`.
 *   2. `advisory:*` ONLY MEANS SOMETHING ON A `review:human` PR (`we:scripts/lib/advisory-labels.mjs`'s own
 *      header). Before this sweep's companion fix (`decideSetLabel`'s `clear-human` branch), clearing the human
 *      gate left a stamped `advisory:accepted`/`advisory:changes` behind with no `review:human` left for it to
 *      describe — live on PR #2578 (`advisory:accepted` stamped 13:29:54Z while `review:human`, `review:human`
 *      cleared 13:38:11Z, the advisory label never removed). `planReviewHoldCleanup` drops it.
 *
 * NOT A DUPLICATE of `we:scripts/conveyor/advisory-label-sweep.mjs` — that sweep drops an advisory label whose
 * REVIEWED HEAD has gone stale (the PR moved past what the advisory looked at); this one drops an advisory label
 * whose REVIEW:HUMAN GATE has gone stale (the PR is no longer gate-self at all, so no head comparison is even
 * meaningful). Both are real, disjoint conditions the SAME `advisory:*` pair can go stale under, and a PR could in
 * principle need either — running both mechanical passes on every tick (as `we:skills-src/conveyor/runner.mjs`
 * already does for the sibling sweep) is what makes them agree without a shared special case in either file.
 *
 * PURE-CORE / IO-SHELL, mirroring `advisory-label-sweep.mjs`'s own split: {@link planReviewHoldCleanup} takes
 * only a PR's `labels` and is fully unit-testable with no `gh`; {@link sweepReviewHoldLabels} is the IO shell,
 * with the PR list and the label provider injectable so the whole pass is testable without a real `gh` call too.
 *
 * WHAT IT NEVER DOES: add a label, or touch anything but the two removals named above. It never removes
 * `review:human` itself (that is `clear-human`'s job, a deliberate human/independent-agent act, never a sweep's),
 * and it never adds `review:pending`/`review:changes`/`review:accepted` — a stray label is dropped, never
 * replaced with a guess at what it should have said instead.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGhProvider } from '../lib/review-label-provider.mjs';
import { REVIEW_LABELS } from '../lib/review-escalation.mjs';
import { ADVISORY_LABELS } from '../lib/advisory-labels.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { defaultListPrs } from './advisory-label-sweep.mjs';
import { readPrsFromFile } from './open-pr-fetch.mjs';

/** Plain label names off a `gh --json labels` array (`[{name}]`) or a bare-string array. Pure. */
function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string' && n !== '');
}

/**
 * THE PURE DECISION: given a PR's OBSERVED `labels`, which labels are stray and must come off?
 * Both checks are independent and additive — a PR can trip either, both, or neither.
 * @param {{currentLabels?: Array<string|{name?: string}>}} o
 * @returns {{remove: string[]}}
 */
export function planReviewHoldCleanup({ currentLabels = [] } = {}) {
  const names = new Set(labelNames(currentLabels));
  const remove = [];
  // (1) at most one review:* hold — review:human already IS the hold; a live review:pending beside it is the
  // #2549 stray this sweep exists for.
  if (names.has(REVIEW_LABELS.human) && names.has(REVIEW_LABELS.pending)) {
    remove.push(REVIEW_LABELS.pending);
  }
  // (2) advisory:* only means something on a review:human PR — with review:human gone, drop whichever advisory
  // label (there is at most one live at a time by construction) is still riding along.
  if (!names.has(REVIEW_LABELS.human)) {
    if (names.has(ADVISORY_LABELS.ACCEPTED)) remove.push(ADVISORY_LABELS.ACCEPTED);
    if (names.has(ADVISORY_LABELS.CHANGES)) remove.push(ADVISORY_LABELS.CHANGES);
  }
  return { remove };
}

/** True when the PR carries a label combination {@link planReviewHoldCleanup} would act on — the only PRs
 *  this pass has any business fetching/looking at closely (a cheap pre-filter before the pure plan). */
export function needsReviewHoldCleanup(pr) {
  return planReviewHoldCleanup({ currentLabels: pr?.labels }).remove.length > 0;
}

/**
 * Drop every stray review-hold / gate-scoped-advisory label off every open PR that carries one.
 * @param {{repo?: string|null, listPrs?: Function, provider?: object, dryRun?: boolean}} [o]
 * @returns {Array<{num: number, remove: string[], error?: string}>} one entry per PR that needed (or would need) a change.
 */
export function sweepReviewHoldLabels({
  repo = null, listPrs = defaultListPrs, provider = createGhProvider(), dryRun = false,
} = {}) {
  const prs = listPrs({ repo });
  const results = [];
  let resolvedRepo = repo;
  for (const pr of Array.isArray(prs) ? prs : []) {
    const plan = planReviewHoldCleanup({ currentLabels: pr.labels });
    if (plan.remove.length === 0) continue;
    const entry = { num: pr.number, remove: plan.remove };
    if (!dryRun) {
      try {
        if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
        provider.setLabels(resolvedRepo, pr.number, { remove: plan.remove });
      } catch (e) {
        entry.error = String((e && e.message) || e).split('\n')[0];
      }
    }
    results.push(entry);
  }
  return results;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || undefined;
  const verb = argv.find((a) => !a.startsWith('--')) || 'sweep';
  const repo = flag('repo') || null;
  const dryRun = argv.includes('--dry-run');
  const prsFile = flag('prs-file');
  if (verb !== 'sweep') {
    writeLineSync(2, 'usage: review-hold-reconcile.mjs sweep [--repo=<owner/name>] [--dry-run] [--prs-file=<path>]');
    process.exitCode = 2;
  } else {
    try {
      const results = sweepReviewHoldLabels({
        repo, dryRun, ...(prsFile ? { listPrs: () => readPrsFromFile(prsFile) } : {}),
      });
      for (const r of results) {
        const did = dryRun ? 'would' : r.error ? 'FAILED to' : 'did';
        writeLineSync(2, `  ⚠ PR #${r.num}: ${did} remove ${r.remove.join(',')} (stray review-hold / gate-scoped advisory)${r.error ? ` (${r.error})` : ''}`);
      }
      writeAllSync(1, `${JSON.stringify({ checked: true, changed: results.length, results })}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
}
