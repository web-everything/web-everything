/**
 * @file breaks/withdrawn-operator-block-directs-takeover.mjs — red-team finding on PR 4797 (card xx0055i). The
 * operator-ruling round matched blocked findings to every historical operator `block` on the head by finding key
 * alone: it ignored the review run and never dropped a block that a later operator `not-real` withdrew. Thread on one
 * unchanged head: run-4 records finding K, a takeover runs, the operator rules run-4/K `block` with a direction, then
 * withdraws it (`not-real`); run-5 records K again and only its reviewer rules it `block`. At 6/5 rounds the planner
 * dispatched a directed takeover carrying the WITHDRAWN direction, where the cap should have asked a person.
 *
 * FIX — `operatorRulingRound` takes, per review run that holds each blocked finding, the ruling the acceptance gate's
 * own per-record state says DECIDES it; only an operator `block` deciding every one of them covers.
 *
 * SCENARIO: that thread through the tree's production `blockRuledReferralsFor` and `planReconcile`. RED = a directed
 * takeover (a dispatch carrying `operatorRulingRound`) goes out.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const CORE = 'scripts/conveyor/reconcile-core.mjs';
const HOLD = 'scripts/conveyor/review-referral-hold.mjs';
const JURY = 'scripts/lib/jury-core.mjs';
const TAKEOVER = 'scripts/conveyor/fix-takeover.mjs';
const LADDER = 'scripts/conveyor/fixer-ladder.mjs';
const REPO = 'web-everything/web-everything';
const PR = 4797;
const HEAD = 'd'.repeat(40);
const BOT = { login: 'web-everything' };
const OPERATOR = { login: 'chalbert' };
const at = (min) => new Date(Date.parse('2026-10-11T00:00:00Z') + min * 60_000).toISOString();

export async function replay(root = REPO_ROOT) {
  if (!existsSync(join(root, CORE)) || !existsSync(join(root, HOLD))) return { harness: false };
  const load = (rel) => import(pathToFileURL(join(root, rel)).href);
  const { planReconcile } = await load(CORE);
  const { blockRuledReferralsFor } = await load(HOLD);
  const { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } = await load(JURY);
  const { takeoverMarkerBody } = await load(TAKEOVER);
  const { loadFixerLadder } = await load(LADDER);
  const original = { summary: 'An identical diff can erase a deliberately re-added human hold', file: 'scripts/review-set-label.mjs', line: 12, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const key = referralFindingKey('judge', original);
  const record = (runId, rulings = []) => {
    const reviewer = mandatoryReferralReviewer(runId);
    return { version: 1, repo: REPO, pr: PR, head: HEAD, runId, reviewer, authorBody: '<!-- authored-by-actor: author -->', attempted: true,
      referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }],
      rulings: rulings.map((result, i) => ({ id: `r${i}`, key, reviewerId: reviewer.id, lens: reviewer.lens, result, rationale: 'ruled', evidence: ['e'] })) };
  };
  const recordAt = (rec, min) => ({ author: BOT, createdAt: at(min), body: renderReferralRecord(rec) });
  const operatorAt = (runId, result, reason, min) => ({ author: OPERATOR, createdAt: at(min), body: buildOperatorRulingComment({ version: 1, repo: REPO, pr: PR, head: HEAD,
    rulings: [{ runId, key, result }], actor: 'chalbert', channel: 'claude-code-chat', reason, at: at(min), clearerId: 'sess' }) });
  const comments = [
    recordAt(record('run-4'), 60),
    { author: BOT, createdAt: at(70), body: takeoverMarkerBody({ pr: PR, head: HEAD, attempts: 6, cap: 5, rung: { id: 'stronger-model' }, n: 1, budget: 1 }) },
    operatorAt('run-4', 'block', 'WITHDRAWN DIRECTION: keep block', 80),
    operatorAt('run-4', 'not-real', 'withdrawn: not a real defect', 85),
    recordAt(record('run-5'), 86),
    recordAt(record('run-5', ['block']), 87),
  ];
  const pr = { number: PR, state: 'OPEN', headRefName: 'lane/x', headRefOid: HEAD, body: '<!-- authored-by-actor: author -->', createdAt: at(0),
    labels: [{ name: 'review:human' }, { name: 'advisory:changes' }], mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments };
  const blockRuledReferrals = blockRuledReferralsFor(pr, { repo: REPO });
  const plan = planReconcile({ repo: 'we', agents: [], now: Date.parse(at(120)), requiredChecks: ['test'], fixerLadder: loadFixerLadder({ override: null }),
    durableCounts: { [PR]: 6 }, roundCapAction: 'takeover', takeoverBudget: 2, prs: [{ ...pr, blockRuledReferrals }] });
  const directed = plan.dispatch.filter((d) => d.operatorRulingRound);
  return { harness: true, blocked: blockRuledReferrals.length, directed: directed.map((d) => d.operatorAnswer?.reason ?? null),
    refusals: plan.refusals.map((r) => r.kind) };
}

export default {
  id: 'withdrawn-operator-block-directs-takeover',
  title: 'a withdrawn operator block on an earlier review run directed a takeover for a later run\'s reviewer block of the same finding',
  card: 'PR 4797 red-team finding (card xx0055i)',
  fixedBy: { sha: 'pending', where: 'lane/ruling-ends-dispute', paths: [CORE] },
  fixPresent(root) { return readFileSync(join(root, CORE), 'utf8').includes('function decidingOperatorBlocks'); },
  async run({ log } = {}) {
    try {
      const report = await replay();
      log?.(JSON.stringify(report));
      const violations = [];
      if (!report.harness) violations.push({ invariant: 'operator-ruling-round', detail: 'no reconcile-core / referral-hold module' });
      else if (report.blocked !== 1) violations.push({ invariant: 'scenario', detail: `expected one live blocked finding, got ${report.blocked}` });
      else if (report.directed.length) violations.push({ invariant: 'withdrawn-ruling-directs-nothing', detail: `directed takeover dispatched: ${JSON.stringify(report.directed)}` });
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
