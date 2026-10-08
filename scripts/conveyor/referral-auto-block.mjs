/**
 * @file scripts/conveyor/referral-auto-block.mjs
 * @description `review.referralDefault=auto-block` (operator ruling 2026-10-08, "keep as setting"). A CONFIRMED
 *   mandatory referral no longer waits for the operator: this pass records a `block` ruling as actor `auto-policy`
 *   (NEVER the operator; the comment says so) through the sanctioned `record-referral-ruling` operation, which
 *   then sends the PR back to the fixer. This pass does not clear `advisory:ruling-needed` itself: the caller
 *   (`review-hold-reconcile.mjs`) leaves a fully auto-blocked PR out of the label sweep, so the label is never added;
 *   a stale one from an earlier operator-mode pass is left to that sweep's next run (it is recomputed from live state).
 *
 * What it never does: clear, accept or card anything (`auto-policy` can only rule `block`); touch `review:human`
 * (operator-only); rule a finding the reviewer marked a judgment call (taste or policy); or rule a DISPUTE (a
 * finding the fixer keeps missing after N sends: that is `rulingNeeded`'s `reason: 'dispute'`, which stays for the
 * operator). The operator can still override any auto-block with a card or not-real ruling (`--supersedes`).
 *
 * Runs before the `advisory:ruling-needed` sweep in `review-hold-reconcile.mjs`, which skips the PRs handled here.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_POLICY_ACTOR } from '../lib/jury-core.mjs';
import { ignoredRulings, rulingNeeded } from '../lib/ruling-ledger.mjs';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { resolveReviewSettings } from '../lib/review-settings.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const AUTO_BLOCK_REASON = 'auto-blocked by policy review.referralDefault=auto-block';
export const AUTO_BLOCK_CHANNEL = 'review daemon (review.referralDefault=auto-block)';

/** A finding the reviewer marked a taste or policy decision (or a caller-supplied needs-ruling classifier says so). */
export const isJudgmentCall = (finding) => finding?.judgmentCall === true;

/**
 * PURE: which findings of this PR the policy rules, and which stay for the operator.
 * @returns {{block: object[], operator: object[]}|null} null = nothing to do. The ruling names each finding by its exact
 *   key (never `all-open`, which would also sweep disputes, judgment calls and unattempted findings, or anything that
 *   arrived after the listing was read).
 */
export function planAutoBlock(pr, { mode = 'operator', cardReadable = (ref) => referralCardReadable(ref, REPO_ROOT),
  isJudgment = isJudgmentCall, humanAt } = {}) {
  if (mode !== 'auto-block') return null;
  const need = rulingNeeded(pr, { cardReadable, ...(humanAt === undefined ? {} : { humanAt }) });
  if (!need) return null;
  // `reason: 'dispute'` findings are NEVER ruled here: they are the operator's.
  // A finding the fixer keeps missing is a DISPUTE even when the reviewer reports it again as pending (rulingNeeded
  // lists it once, as pending): once the ladder says escalate, it is the operator's, not another auto-block.
  const ig = ignoredRulings(pr, { ...(humanAt === undefined ? {} : { humanAt }) });
  const disputed = new Set(ig?.escalate ? ig.matches.map((m) => m.finding.key) : []);
  const pending = need.findings.filter((f) => f.reason === 'pending' && !disputed.has(f.key));
  if (!pending.length) return null;
  const operator = [...need.findings.filter((f) => f.reason !== 'pending' || disputed.has(f.key)), ...pending.filter(isJudgment)];
  const block = pending.filter((f) => !isJudgment(f));
  if (!block.length) return null;
  return { head: need.head, block, operator };
}

const defaultRunRuling = (args) => execFileSync(process.execPath, [resolve(REPO_ROOT, 'scripts/operations/run.mjs'), 'record-referral-ruling', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, cwd: REPO_ROOT });

/** The record-referral-ruling argv for one selection (`all-open` or one exact finding key). */
export function autoBlockArgs({ repo, pr, finding }) {
  return [`--repo=${repo}`, `--pr=${pr}`, `--finding=${finding}`, '--ruling=block', `--actor=${AUTO_POLICY_ACTOR}`,
    `--channel=${AUTO_BLOCK_CHANNEL}`, `--reason=${AUTO_BLOCK_REASON}`];
}

/**
 * Auto-block every open PR whose confirmed referrals await a ruling. Returns one entry per PR touched; the caller
 * skips those PRs in the `advisory:ruling-needed` sweep ONLY when `operatorKept` is 0 (nothing left for the operator).
 * @returns {Array<{num:number, action:'auto-blocked'|'failed', findings:number, operatorKept:number, error?:string}>}
 */
export function sweepAutoBlock({ repo, resolveRepo, listPrs, settings = resolveReviewSettings(), runRuling = defaultRunRuling,
  dryRun = false, ...planOpts } = {}) {
  if (settings.referralDefault !== 'auto-block') return [];
  const results = [];
  const prs = listPrs?.({ repo });
  for (const pr of Array.isArray(prs) ? prs : []) {
    const plan = planAutoBlock(pr, { mode: settings.referralDefault, ...planOpts });
    if (!plan) continue;
    const entry = { num: pr.number, action: 'auto-blocked', findings: plan.block.length, operatorKept: plan.operator.length };
    if (!dryRun) {
      try {
        for (const f of plan.block) runRuling(autoBlockArgs({ repo: repo ?? resolveRepo?.(), pr: pr.number, finding: f.key }));
      } catch (e) { entry.action = 'failed'; entry.error = String(e?.stderr || e?.message || e).split('\n')[0]; }
    }
    results.push(entry);
  }
  return results;
}
