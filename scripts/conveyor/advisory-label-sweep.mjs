#!/usr/bin/env node
/**
 * @file scripts/conveyor/advisory-label-sweep.mjs
 * @description THE `advisory:*` STALENESS SWEEP — drops `advisory:accepted` / `advisory:changes` from any open PR
 *   whose head has moved since the advisory that earned the label, so the label always describes the CURRENT head.
 *
 * WHY A SWEEP AND NOT A NEW POLLER. The advisory comment already records the exact commit the panel judged
 * (`Net basis: <base>..<head>`), and the runner already hands every mechanical pass ONE shared open-PR snapshot
 * per tick (`we:scripts/conveyor/open-pr-fetch.mjs`, with `labels`, `headRefOid` and `comments`). Comparing the
 * two is a pure function of data this tick already fetched — the same "piggyback on the runner tick" shape as
 * `parked-pr-conflict-watch.mjs` and `review-status-tag.mjs`, wired beside them in
 * `we:skills-src/conveyor/runner.mjs#makeCliMechanicalPasses`. No new cron, daemon, or state store: the label's
 * own presence is the state, exactly as for those siblings.
 *
 * THE LAG, STATED. A push is noticed on the next tick (~2 minutes), not instantly. That window is covered on the
 * read side: `we:scripts/operations/operator-queue.mjs` compares the advisory comment's head to the live head
 * itself and reports a label that outlived its head as a disagreement in NOT READY, so a stale label can never
 * put a PR in NEEDS YOU even before this sweep removes it.
 *
 * WHAT IT NEVER DOES: touch `review:human` / `review:changes` / `review:accepted`, add anything but an
 * `advisory:*` label, or post a comment. The ONE non-`advisory:*` label it may remove is `review:pending`, and
 * only in the repair path, where the advisory has demonstrably run (pinned by a test over every label mix). It
 * removes stale `advisory:*` labels (`planAdvisoryStaleLabels`) and, as the backstop for a missed `advise` label
 * write, REPAIRS a human-gated PR whose newest covering advisory disagrees with its labels
 * (`planAdvisoryRepairLabels`). BOTH plans read only advisory comments posted by a trusted principal (automation
 * or operator login — `trustedAdvisoryComments`), so a forged note from any other account changes no label.
 * Removing a label the PR does not carry is a `gh` error, so removals are intersected with the live labels by
 * construction (the plan only lists present ones).
 *
 * PURE-CORE / IO-SHELL: the plan is pure; {@link sweepAdvisoryLabels} is the shell, with the PR list and the
 * label provider injectable so the whole pass is testable with no `gh`.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { ADVISORY_LABELS, ADVISORY_LABEL_META, labelNames, planAdvisoryRepairLabels, planAdvisoryStaleLabels } from '../lib/advisory-labels.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { readPrsFromFile } from './open-pr-fetch.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

export const PR_LIST_LIMIT = 200;

/** True when the PR is human-gated: a covering advisory may be owed a label (see `planAdvisoryRepairLabels`). */
export function isHumanGated(pr) {
  return labelNames(pr?.labels).includes('review:human');
}

/** True when the PR carries either advisory label — the only PRs this pass has any business with. */
export function carriesAdvisoryLabel(pr) {
  const advisory = new Set(Object.values(ADVISORY_LABELS));
  return (Array.isArray(pr?.labels) ? pr.labels : [])
    .some((l) => advisory.has(typeof l === 'string' ? l : l?.name));
}

/**
 * The standalone open-PR discovery, used only when the runner's shared snapshot is unavailable. Just the four
 * fields this pass reads — `comments` is the heavy one, and it is the whole point (the advisory's reviewed head
 * lives in a comment). `exec` is injectable so the argv is assertable with no `gh` on PATH.
 * @param {{exec?: Function, repo?: string|null}} [o]
 * @returns {Array<object>}
 */
export function defaultListPrs({ exec = execFileSyncThrottled, repo = null } = {}) {
  // #gh-graphql-budget — read the host-shared open-PR snapshot (one right-sized list per repo per TTL for the
  // whole fleet) instead of a private `gh pr list`; null = not applicable (tests, cwd repo) → the direct read below.
  if (exec === execFileSyncThrottled) { const shared = readSharedOpenPrs({ repo, fields: 'number,labels,headRefOid,comments' }); if (shared) return shared; }
  const argv = ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,labels,headRefOid,comments'];
  if (repo) argv.push('--repo', repo);
  // #x5n4zn3 — was bare (no timeout).
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Drop stale advisory labels off every open PR that carries one.
 * @param {{repo?: string|null, listPrs?: Function, provider?: object, dryRun?: boolean}} [o]
 * @returns {Array<{num: number, remove: string[], error?: string}>} one entry per PR that needed (or would need) a change.
 */
export function sweepAdvisoryLabels({
  repo = null, listPrs = defaultListPrs, provider = createGhProvider(), dryRun = false,
} = {}) {
  const prs = listPrs({ repo });
  const results = [];
  // Resolved lazily and once, only when a write is about to happen — `GH_ARGV.setLabels` splices `--repo` into
  // its argv unconditionally, so a null repo must never reach it (the #xoh8fkw bug the conflict watch documents).
  let resolvedRepo = repo;
  for (const pr of (Array.isArray(prs) ? prs : []).filter((p) => carriesAdvisoryLabel(p) || isHumanGated(p))) {
    const input = { currentLabels: pr.labels, comments: pr.comments, headRefOid: pr.headRefOid };
    // Stale first (head moved past the advisory), else REPAIR (advisory covers head but the label is missing/wrong).
    const stale = planAdvisoryStaleLabels(input);
    const plan = stale.remove.length > 0 ? { add: null, remove: stale.remove } : planAdvisoryRepairLabels(input);
    if (!plan.add && plan.remove.length === 0) continue;
    const entry = { num: pr.number, remove: plan.remove, ...(plan.add ? { add: plan.add } : {}) };
    if (!dryRun) {
      try {
        if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
        // `gh pr edit --add-label` refuses a label the repo has never had; ensure is create-or-update.
        if (plan.add) provider.ensureLabel?.(resolvedRepo, plan.add, ADVISORY_LABEL_META[plan.add]);
        provider.setLabels(resolvedRepo, pr.number, { add: plan.add ?? undefined, remove: plan.remove });
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
    writeLineSync(2, 'usage: advisory-label-sweep.mjs sweep [--repo=<owner/name>] [--dry-run] [--prs-file=<path>]');
    process.exitCode = 2;
  } else {
    try {
      const results = sweepAdvisoryLabels({
        repo, dryRun, ...(prsFile ? { listPrs: () => readPrsFromFile(prsFile) } : {}),
      });
      for (const r of results) {
        const did = dryRun ? 'would' : r.error ? 'FAILED to' : 'did';
        const what = r.add ? `set ${r.add}${r.remove.length ? ` and remove ${r.remove.join(',')}` : ''} (advisory covers head, label missing)`
          : `remove ${r.remove.join(',')} (head moved past the advisory)`;
        writeLineSync(2, `  ⚠ PR #${r.num}: ${did} ${what}${r.error ? ` (${r.error})` : ''}`);
      }
      writeAllSync(1, `${JSON.stringify({ checked: true, changed: results.length, results })}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
}
