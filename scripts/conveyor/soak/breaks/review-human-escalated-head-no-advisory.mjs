/** #7385: the panel finished before review:human, but record was refused; one advisory is still owed.
 * Fixtures are reduced raw records, projected by the production reader. Unknown full SHAs use synthetic suffixes.
 */
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sealedBreakKeys } from '../../../lib/red-team-gate.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HOLD = 'scripts/conveyor/review-referral-hold.mjs';
const CORE = 'scripts/conveyor/reconcile-core.mjs';
export const HEAD = '85873d92475d'.padEnd(40, '0');
export const OLD_HEAD = '9957f63'.padEnd(40, '0');
export const NOW = Date.parse('2026-11-26T22:10:00Z');
export const REPO = 'fixture-owner/fixture-repo';
export const SETTINGS = { value: { enabled: true, onClean: 'resume', onBlock: 'send-back' } };
export const CAPTURED_OPTIONS = {
  change: { labels: ['review:human', 'review:awaiting-advisory', 'red-team:pending', 'review-round:5'],
    statusCheckRollup: [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'red-team', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] },
  // Keep the captured red review-gate row, but do not invent a branch-protection requirement for it.
  // A required review-gate takes the earlier review-hold route, not the mechanical head-move route.
  planOptions: { requiredChecks: ['test', 'red-team'] },
};
export const comment = (body, createdAt = '2026-11-25T21:14:00Z') => ({ body, createdAt, author: { login: 'web-everything' } });

function referralRecord(api) {
  const runId = 'review-pr-pr7385-advisory';
  const original = { file: 'scripts/example.mjs', line: 1, summary: 'A ruling is owed', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  return { version: 1, repo: REPO, pr: 7385, head: HEAD, runId,
    reviewer: api.jury.mandatoryReferralReviewer(runId), authorBody: '<!-- authored-by-actor: fixture-author -->',
    attempted: true, rulings: [], carried: [], superseded: [],
    referrals: [{ key: api.jury.referralFindingKey('judge', original), seat: 'judge', original, finding: api.jury.normalizeFinding(original) }] };
}

export function rawRun(api, { id = 'review-pr-pr7385-332540e3', second = false, incomplete = false, outcome = 'accept', ...overrides } = {}) {
  const start = second ? '2026-11-26T22:00:00Z' : '2026-11-25T21:05:00Z';
  const finish = second ? '2026-11-26T22:05:00Z' : '2026-11-25T21:10:00Z';
  const referral = outcome === 'pending-referral' ? referralRecord(api) : null;
  return { id, op: 'review-pr', input: { repo: REPO, pr: 7385 },
    findings: { read: { repo: REPO, pr: 7385, netBasis: { base: 'a'.repeat(40), rev: HEAD },
      netChangedFiles: ['scripts/example.mjs'], netRenameSources: [] },
      ...(referral ? { mandatoryReferrals: { effects: [{ type: 'review.mandatory-referrals', result: { records: [referral] } }] } } : {}) },
    verdict: { verdict: second ? 'needs-human' : 'accept', humanRequired: second,
      findings: [], lenses: api.jury.MANDATORY_LENSES,
      lensVerdicts: Object.fromEntries(api.jury.MANDATORY_LENSES.map(lens => [lens, outcome === 'changes' ? 'changes' : 'accept'])),
      ...(outcome === 'changes' ? { blockedReferrals: ['fixture-finding'] } : {}),
      ...(referral ? { pendingReferrals: [referral.referrals[0].key] } : {}) },
    pending: second ? null : { kind: 'effect', step: 'record' }, stopped: second ? 'complete' : 'effect-failed',
    effects: second ? [] : [{ type: 'review.label-swap', status: 'failed', error: 'gate-self: review:human is human-ceremony-only' }],
    stepTimings: [{ step: 'read', startedAt: start, finishedAt: start },
      ...(incomplete ? [] : [{ step: 'advise', startedAt: finish, finishedAt: finish }])],
    ...overrides };
}

export function advisory(api, outcome = 'accept', head = HEAD, at = '2026-11-26T22:05:00Z') {
  const run = rawRun(api, { second: true, outcome });
  return comment(api.review.renderAdvisoryNote({ read: { ...run.findings.read, netBasis: { ...run.findings.read.netBasis, rev: head } }, verdict: run.verdict }), at);
}

export function pendingReferral(api) {
  return comment(api.jury.renderReferralRecord(referralRecord(api)), '2026-11-26T22:04:00Z');
}

export function redTeamThread() {
  return [comment(`<!-- we:red-team-advisory pr=7385 rev=${HEAD} -->\n1. [**confirmed**] (edge-case, broken) \`scripts/example.mjs:1\` — captured break`, '2026-11-25T21:12:00Z'),
    comment(`<!-- we:red-team-gate pr=7385 rev=${HEAD} outcome=card-queued -->\n- 1 finding(s) filed as a follow-up card (#1).`)];
}

/** Exact status-file shape and in-memory run store; every mutable path belongs to the caller's temp root. */
export function redTeamFixture(api, root, { outcome = 'accept', shape = 'completed' } = {}) {
  const runsDir = join(root, 'runs'), env = { WE_SHARED_RUNS_DIR: runsDir };
  const old = rawRun(api);
  const fresh = rawRun(api, { id: 'review-pr-pr7385-advisory', second: true, outcome,
    ...(shape === 'completed' ? {} : { pending: { kind: 'confirm', step: 'confirm' }, stopped: 'confirm' }),
    ...(shape === 'verdict-less' ? { verdict: null } : {}) });
  const statusDir = api.evidence.redTeamStatusDir(env);
  mkdirSync(statusDir, { recursive: true });
  const status = { repo: REPO, pr: 7385, head: HEAD, status: 'finished', result: 'ran', loopPayload: old,
    sealedBreaks: sealedBreakKeys([{ confirmedByRecheck: true, category: 'edge-case', impactIfUnfixed: 'broken',
      file: 'scripts/example.mjs', line: 1, summary: 'captured break' }]) };
  const file = join(statusDir, `${encodeURIComponent(REPO)}-7385-${HEAD}.json`);
  writeFileSync(file, JSON.stringify(status));
  utimesSync(file, NOW / 1000 - 86400, NOW / 1000 - 86400);
  const evidence = api.evidence.readDrainRedTeamEvidence({ repo: REPO, pr: 7385, head: HEAD, runsDir, env, now: NOW,
    host: 'fixture-host', namespace: 'fixture-ns', isAlive: () => false, readPidStart: () => null,
    list: () => [fresh.id, old.id], read: id => {
      if (id === fresh.id) return fresh;
      if (id === old.id) return old;
      throw Error(`unexpected fixture run: ${id}`);
    }, stat: path => ({ mtimeMs: path.includes('advisory') ? NOW - 60_000 : NOW - 86400_000 }), readScorecards: () => [] });
  return { evidence, fresh, status, env };
}

export function scenario(api, { runs = [rawRun(api)], comments = [advisory(api, 'accept', OLD_HEAD, '2026-11-24T08:21:00Z'), ...redTeamThread()],
  change = {}, settings = SETTINGS, planOptions = {} } = {}) {
  const projected = runs.map(run => api.hold.reviewRunEvidence(run)).filter(Boolean);
  const [held] = api.hold.enrichPrsWithReferralHolds([{ number: 7385, state: 'OPEN', headRefOid: HEAD,
    headRefName: 'lane/fixture', baseRefName: 'main', createdAt: '2026-11-24T00:00:00Z', body: '', isDraft: false,
    labels: ['review:human', 'review:awaiting-advisory', 'red-team:pending'], commentsComplete: true, comments,
    rowsComplete: true, rowsHead: HEAD, mergeStateStatus: 'CLEAN',
    commits: [{ oid: HEAD, messageHeadline: "Merge branch 'main' into lane/fixture", parents: [{ oid: OLD_HEAD }, { oid: 'a'.repeat(40) }] }],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...change }],
  { repo: REPO, env: { WE_REVIEW_SAME_HEAD_MAX_REVIEWS: '1', WE_REVIEW_NO_VERDICT_COOLDOWN_RELEASES: '0' }, now: NOW,
    readRuns: () => projected, readComments: () => ({ comments, complete: false }) });
  const [pr] = api.hold.enrichPrsWithReferralHoldAutoResolve([held], { repo: REPO, env: {}, settings,
    decide: (p, h) => api.hold.decideReferralHoldAutoResolve(p, h, { repo: REPO, env: {}, settings, cardReadable: () => false }) });
  const plan = api.core.planReconcile({ repo: 'we', prs: [pr], agents: [], now: NOW, requiredChecks: ['test'],
    reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false }, advisoryReviewOnHumanHandoff: 'on',
    ciHealBudget: { cap: 2, capSource: 'fixture' }, ciHealBudgetRestore: {}, verdictSettings: {}, codeqlOwnBudget: {},
    operatorRulingExtraRounds: { value: 0, source: 'fixture' }, roundExtensionAnchor: { value: 'latest', source: 'fixture' },
    reviewLabelHeal: 'off', ...planOptions });
  return { pr, plan, projected };
}

export async function loadApi(root) {
  const load = path => import(pathToFileURL(join(root, path)).href);
  const [hold, core, review, jury] = await Promise.all([load(HOLD), load('scripts/conveyor/reconcile-core.mjs'),
    load('scripts/operations/review-pr.mjs'), load('scripts/lib/jury-core.mjs')]);
  return { hold, core, review, jury };
}

export function exercise(api) {
  const violations = [];
  const check = (ok, why) => { if (!ok) violations.push(why); };
  const first = scenario(api, CAPTURED_OPTIONS);
  check(first.pr.referralHold?.count === 1 && first.pr.referralHold?.attemptsSinceWake === 1, 'fixture must project one counted panel');
  check(first.plan.dispatch.length === 1 && first.plan.dispatch[0].kind === 'review'
    && first.plan.dispatch[0].advisoryReview?.reason === 'head-moved-advisory', 'tick 1 owes exactly one head-move advisory');
  for (const historicalCount of [5, 6]) {
    const comments = Array.from({ length: historicalCount }, (_, i) =>
      advisory(api, 'accept', OLD_HEAD, `2026-11-24T${String(10 + i).padStart(2, '0')}:00:00Z`));
    for (const mechanical of [false, true]) {
      const change = mechanical ? {} : {
        commits: [{ oid: HEAD, messageHeadline: 'Fix regression', parents: [{ oid: OLD_HEAD }] }],
      };
      const { pr, plan } = scenario(api, { comments, change });
      check(pr.referralHoldAutoResolve?.advisoryOwed === true, `history=${historicalCount} mechanical=${mechanical}: advisory is owed`);
      check(plan.dispatch.length === 1 && plan.dispatch[0].kind === 'review',
        `history=${historicalCount} mechanical=${mechanical}: historical rounds must not block the one owed advisory`);
      check(pr.labels.includes('review:human'), 'the bounded advisory retains the human gate');
      for (const incomplete of [false, true]) {
        const failed = scenario(api, { comments, change,
          runs: [rawRun(api), rawRun(api, { id: 'review-pr-pr7385-failed', second: true, incomplete })] });
        check(failed.plan.dispatch.length === 0,
          `history=${historicalCount} mechanical=${mechanical} incomplete=${incomplete}: second counted attempt must hold`);
      }
      const published = scenario(api, { comments: [...comments, advisory(api)], change });
      check(published.plan.dispatch.length === 0, `history=${historicalCount} mechanical=${mechanical}: published advisory must not repeat`);
    }
  }
  for (const outcome of ['accept', 'changes', 'pending-referral']) {
    const notes = [advisory(api, outcome), ...(outcome === 'pending-referral' ? [pendingReferral(api)] : [])];
    for (const partial of [false, true]) {
      const { plan } = scenario(api, { runs: [rawRun(api), rawRun(api, { id: 'review-pr-pr7385-advisory', second: true, outcome })], comments: notes,
        change: { labels: ['review:human', ...(partial ? ['review:awaiting-advisory'] : []),
          ...(outcome === 'accept' ? ['advisory:accepted'] : outcome === 'changes' ? ['advisory:changes'] : [])] } });
      check(plan.dispatch.every(row => row.kind === 'fix' && row.mode === 'advisory-fix' && outcome === 'changes'), `tick 2 ${outcome} partial=${partial}: never re-review`);
    }
  }
  for (const incomplete of [true, false]) {
    const { plan } = scenario(api, { runs: [rawRun(api), rawRun(api, { id: 'review-pr-pr7385-failed', second: true, incomplete })] });
    check(plan.dispatch.length === 0 && plan.refusals.some(row => row.kind === 'review-referrals-pending'
      && /write-back fails/.test(row.referralHoldAutoResolve?.why)), `counted failure incomplete=${incomplete} must hold with diagnostic`);
  }
  const converted = scenario(api, { comments: [comment(`✅ review — accepted\n<!-- reviewed-sha: ${HEAD} -->`)] });
  check(converted.plan.dispatch.length === 0 && converted.plan.refusals.some(row => row.kind === 'review-referrals-pending'), '#246 conversion remains deferred');
  return { violations };
}

export default {
  id: 'review-human-escalated-head-no-advisory', title: 'one halted pre-escalation panel owes one advisory, bounded by counted attempts',
  card: 'REVIEW-REARM-REDTEAM-PENDING.S1.1 (#7385; conversion #246 deferred)',
  // Pin after the wrapper creates the implementation commit; this task leaves the tree uncommitted.
  fixedBy: { sha: 'pending', where: 'lane/review-rearm-redteam-pending-m1', paths: [HOLD, CORE] },
  fixPresent(root) { return readFileSync(join(root, HOLD), 'utf8').includes('advisoryOwed: true')
    && readFileSync(join(root, CORE), 'utf8').includes("reason: 'referral-hold-resumed'"); },
  async run({ sourceRoot = ROOT, api } = {}) { return exercise(api ?? await loadApi(sourceRoot)); },
  judge: report => report.violations,
};
