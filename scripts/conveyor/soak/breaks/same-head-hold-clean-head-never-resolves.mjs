/** Live break 2026-11-18, PR #7012, head 494d81b6c: a clean advisory with no referral record stays paused.
 * RED: review-referrals-pending. GREEN: already-reviewed-head; removing the advisory must still keep the pause.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HOLD_PATH = 'scripts/conveyor/review-referral-hold.mjs';
const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const src = process.env.SOAK_SOURCE_ROOT;
const imp = rel => import(pathToFileURL(join(src, rel)).href);
const { enrichPrsWithReferralHolds, enrichPrsWithReferralHoldAutoResolve } = await imp('${HOLD_PATH}');
const { planReconcile } = await imp('scripts/conveyor/reconcile-core.mjs');
const repo = 'web-everything/web-everything';
// Synthetic full SHA preserving the observed prefix; no captured full SHA is available.
const head = '494d81b6c'.padEnd(40, '0');
const base = 'b'.repeat(40);
const startedAt = Date.parse('2026-11-18T12:00:00Z');
const now = startedAt + 30 * 60000;
const runs = [{ id: 'review-pr-7012', repo, pr: 7012, head, startedAt,
  completedAt: startedAt + 10 * 60000, parked: false, pending: [], attempted: true,
  persistenceFailed: false, count: 0, rulings: [] }];
const advisory = { author: { login: 'web-everything' }, createdAt: '2026-11-18T12:10:00Z',
  body: ['ADVISORY REVIEW, NOT A RECORDED VERDICT', '**Verdict:** accept',
    'Net basis: \u0060' + base + '..' + head + '\u0060', '**Advisory outcome:** \u0060accept\u0060'].join('\\n') };
const scenario = comments => {
  const pr = { number: 7012, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'lane/clean-head',
    headRefOid: head, body: '', createdAt: '2026-11-18T11:00:00Z',
    labels: [{ name: 'review:human' }, { name: 'advisory:accepted' }], comments,
    mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const held = enrichPrsWithReferralHolds([pr], { repo, now, env: {}, readRuns: () => runs,
    readComments: () => { throw new Error('unexpected comment read'); } });
  const [enriched] = enrichPrsWithReferralHoldAutoResolve(held, { repo, env: {},
    settings: { value: { enabled: true, onClean: 'resume', onBlock: 'send-back' } } });
  const plan = planReconcile({ prs: [enriched], agents: [], now, requiredChecks: ['gate'],
    reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false } });
  return { hold: enriched.referralHold, refusals: plan.refusals.map(r => r.kind), dispatch: plan.dispatch };
};
process.stdout.write(JSON.stringify({ clean: scenario([advisory]), missing: scenario([]) }));
`;

export default {
  id: 'same-head-hold-clean-head-never-resolves',
  title: 'a clean same-head advisory with no referral record reaches the human review instead of staying paused',
  card: 'live break 2026-11-18, PR #7012, head 494d81b6c',
  fixedBy: { sha: 'pending', where: 'main', paths: [HOLD_PATH] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, HOLD_PATH), 'utf8').includes("return noFinding('no referral record names the live head')");
    } catch { return false; }
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-clean-same-head-'));
    const violations = [];
    try {
      const childFile = join(dir, 'child.mjs');
      writeFileSync(childFile, CHILD);
      let out;
      try {
        out = JSON.parse(execFileSync('node', [childFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, SOAK_SOURCE_ROOT: sourceRoot } }));
      } catch (e) {
        violations.push({ invariant: 'scenario-runs', detail:
          String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' | ') });
        return { violations };
      }
      log?.(JSON.stringify(out));
      for (const [name, result] of Object.entries(out)) {
        const hold = result.hold;
        if (hold?.kind !== 'same-head' || hold.count !== 1 || hold.attemptsSinceWake !== 1
          || hold.reviewStartedAt !== Date.parse('2026-11-18T12:00:00Z')) {
          violations.push({ invariant: 'one-finished-review-' + name, detail: 'scenario must retain the real same-head hold with one attempt' });
        }
        if (result.dispatch.length) violations.push({ invariant: 'no-dispatch-' + name, detail: 'the held head must not dispatch another review' });
      }
      if (!out.clean.refusals.includes('already-reviewed-head') || out.clean.refusals.includes('review-referrals-pending')) {
        violations.push({ invariant: 'clean-head-resolves', detail: 'expected already-reviewed-head without review-referrals-pending; got ' + out.clean.refusals.join(',') });
      }
      if (!out.missing.refusals.includes('review-referrals-pending') || out.missing.refusals.includes('already-reviewed-head')) {
        violations.push({ invariant: 'missing-advisory-fails-closed', detail: 'expected review-referrals-pending without already-reviewed-head; got ' + out.missing.refusals.join(',') });
      }
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations.map(v => '[' + v.invariant + '] ' + v.detail); },
};
