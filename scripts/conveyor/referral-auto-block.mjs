/**
 * @file scripts/conveyor/referral-auto-block.mjs
 * @description `review.referralDefault=auto-block` (operator ruling 2026-10-08, "keep as setting"). A CONFIRMED
 *   mandatory referral no longer waits for the operator: this pass records a `block` ruling as actor `auto-policy`
 *   (NEVER the operator; the comment says so) through the sanctioned `record-referral-ruling` operation, which
 *   then sends the PR back to the fixer. This pass does not clear `advisory:ruling-needed` itself: the caller
 *   (`review-hold-reconcile.mjs`) re-reads each PR in the label sweep after this pass, so new rulings and any
 *   remaining operator work decide that label from fresh state.
 * A trusted human clearance of the current head is final: this pass never auto-blocks it.
 *
 * What it never does: clear, accept or card anything (`auto-policy` can only rule `block`); touch `review:human`
 * (operator-only); rule a finding the reviewer marked a judgment call (taste or policy); or rule a DISPUTE (a
 * finding the fixer keeps missing after N sends: that is `rulingNeeded`'s `reason: 'dispute'`, which stays for the
 * operator). The operator can still override any auto-block with a card or not-real ruling (`--supersedes`).
 *
 * Runs before the `advisory:ruling-needed` sweep in `review-hold-reconcile.mjs`, which independently re-reads the PRs handled here.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_POLICY_ACTOR } from '../lib/jury-core.mjs';
import { ignoredRulings, rulingNeeded } from '../lib/ruling-ledger.mjs';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { resolveReviewSettings } from '../lib/review-settings.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { parseLatestHumanClearedSha } from '../lib/review-escalation.mjs';
import { defaultReadPr } from './advisory-label-sweep.mjs';

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
  if (parseLatestHumanClearedSha((Array.isArray(pr?.comments) ? pr.comments : []).filter(isTrustedMarkerAuthor))?.toLowerCase()
    === String(pr?.headRefOid ?? '').toLowerCase()) return null;
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
 * re-reads each PR in the `advisory:ruling-needed` sweep to decide any remaining operator signal.
 * @returns {Array<{num:number, action:'auto-blocked'|'failed', findings:number, operatorKept:number, error?:string}>}
 */
export function sweepAutoBlock({ repo, resolveRepo, listPrs, settings = resolveReviewSettings(), runRuling = defaultRunRuling,
  readPr = defaultReadPr, dryRun = false, ...planOpts } = {}) {
  if (settings.referralDefault !== 'auto-block') return [];
  const results = [];
  let resolvedRepo = repo;
  const prs = listPrs?.({ repo });
  for (const pr of Array.isArray(prs) ? prs : []) {
    // Missing markers in a partial snapshot cannot exclude a PR from this pass.
    let live;
    try {
      if (resolvedRepo == null) resolvedRepo = resolveRepo?.();
      if (typeof resolvedRepo !== 'string' || !resolvedRepo.trim()) throw new Error('missing repository');
      live = readPr({ repo: resolvedRepo, number: pr.number });
      if (live?.state !== 'OPEN') throw new Error('PR is not open');
      if (!Array.isArray(live.labels) || live.labels.some((label) =>
        typeof (label?.name ?? label) !== 'string' || !(label?.name ?? label).trim())) throw new Error('unusable labels');
      if (typeof live.headRefOid !== 'string' || !live.headRefOid.trim()) throw new Error('missing head');
      if (!Array.isArray(live.comments)) throw new Error('comments read returned no array');
      if (live.number != null && live.number !== pr.number) throw new Error('PR number mismatch');
    } catch (e) {
      results.push({ num: pr.number, action: 'failed', findings: 0, operatorKept: 0, error: `live re-read failed: ${String(e?.message ?? e).split('\n')[0]}` });
      continue;
    }
    const plan = planAutoBlock(live, { mode: settings.referralDefault, ...planOpts });
    if (!plan) continue;
    const entry = { num: pr.number, action: 'auto-blocked', findings: plan.block.length, operatorKept: plan.operator.length };
    if (!dryRun) {
      try {
        for (const f of plan.block) runRuling(autoBlockArgs({ repo: resolvedRepo, pr: pr.number, finding: f.key }));
      } catch (e) { entry.action = 'failed'; entry.error = String(e?.stderr || e?.message || e).split('\n')[0]; }
    }
    results.push(entry);
  }
  return results;
}
