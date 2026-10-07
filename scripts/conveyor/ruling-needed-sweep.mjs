#!/usr/bin/env node
/**
 * @file scripts/conveyor/ruling-needed-sweep.mjs
 * @description THE `advisory:ruling-needed` LABEL — a derived view, never a source of truth. A PR carries it
 *   exactly while its CURRENT head has an attempted mandatory-referral record with confirmed findings that still
 *   await a block/card/not-real ruling (`we:scripts/lib/ruling-ledger.mjs#rulingNeeded`). It goes on when the
 *   review parks and comes off on a ruling or a new head, because it is recomputed from the PR thread each tick.
 *
 * WHY: live 2026-10-04, PR #3794 sat parked about 8 hours ("review paused: N referrals need a ruling") with
 * nothing on the PR that said so; the label is the at-a-glance half of the fix (the NEEDS-YOU row, push and
 * health alert are the rest).
 *
 * Deliberately NOT in `ADVISORY_LABELS`: that pair is dropped by the staleness sweep whenever no advisory note
 * covers the head, and a parked review posts no fresh note, so a member of that pair would flap off every tick.
 * It never touches `review:*` or `advisory:accepted|changes`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { labelNames } from '../lib/advisory-labels.mjs';
import { RULING_NEEDED_LABEL, RULING_NEEDED_LABEL_META, rulingNeeded } from '../lib/ruling-ledger.mjs';
import { loadFixerLadder } from './fixer-ladder.mjs';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The gate's own card rule, so the label never clears while the gate still holds a `card` ruling on a missing card. */
const gateCardReadable = (ref) => referralCardReadable(ref, REPO_ROOT);

/** PURE: what to do about the label on one PR. */
export function planRulingNeededLabel(pr, opts = {}) {
  const has = labelNames(pr?.labels).includes(RULING_NEEDED_LABEL);
  const need = rulingNeeded(pr, opts);
  if (need && !has) return { action: 'add', need };
  if (!need && has) return { action: 'remove', need: null };
  return { action: 'none', need };
}

export function defaultListPrs({ exec = execFileSyncThrottled, repo = null } = {}) {
  if (exec === execFileSyncThrottled) { const shared = readSharedOpenPrs({ repo, fields: 'number,labels,headRefOid,comments' }); if (shared) return shared; }
  const argv = ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,labels,headRefOid,comments'];
  if (repo) argv.push('--repo', repo);
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Add/remove the label on every open PR whose derived state disagrees with it.
 * @returns {Array<{num:number, action:'add'|'remove', error?:string}>}
 */
export function sweepRulingNeededLabels({ repo = null, listPrs = defaultListPrs, provider = createGhProvider(), dryRun = false } = {}) {
  const prs = listPrs({ repo });
  const results = [];
  let resolvedRepo = repo;
  // Where the effective fixer-escalation ladder hands a twice-ignored finding to the operator.
  let humanAt;
  try { humanAt = loadFixerLadder().humanAt; } catch { /* the platform default stands */ }
  for (const pr of Array.isArray(prs) ? prs : []) {
    const plan = planRulingNeededLabel(pr, { cardReadable: gateCardReadable, ...(humanAt === undefined ? {} : { humanAt }) });
    if (plan.action === 'none') continue;
    const entry = { num: pr.number, action: plan.action };
    if (!dryRun) {
      try {
        if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
        if (plan.action === 'add') {
          provider.ensureLabel(resolvedRepo, RULING_NEEDED_LABEL, RULING_NEEDED_LABEL_META);
          provider.setLabels(resolvedRepo, pr.number, { add: RULING_NEEDED_LABEL });
        } else provider.setLabels(resolvedRepo, pr.number, { remove: [RULING_NEEDED_LABEL] });
      } catch (e) { entry.error = String((e && e.message) || e).split('\n')[0]; }
    }
    results.push(entry);
  }
  return results;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || undefined;
  try {
    const dryRun = argv.includes('--dry-run');
    const results = sweepRulingNeededLabels({ repo: flag('repo') || null, dryRun });
    for (const r of results) writeLineSync(2, `  PR #${r.num}: ${dryRun ? 'would ' : r.error ? 'FAILED to ' : ''}${r.action} ${RULING_NEEDED_LABEL}${r.error ? ` (${r.error})` : ''}`);
    writeAllSync(1, `${JSON.stringify({ checked: true, changed: results.length, results })}\n`);
  } catch (e) { writeLineSync(2, `error: ${String(e?.message ?? e)}`); process.exitCode = 1; }
}
