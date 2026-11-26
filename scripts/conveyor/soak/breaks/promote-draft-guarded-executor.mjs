/** Guarded executor replay: real daemon scheduling and executor, entirely injected local IO. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTickAllRepos, resolveFixPassBudgets } from '../../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import { buildOperatorAnswer } from '../../stand-down-answer-core.mjs';

const weRepo = ghRepoSlug('we');
const frontierRepo = ghRepoSlug('frontierui');
const head = 'a'.repeat(40);
const comment = (id, body) => ({ id, body, author: { login: 'chalbert' } });
const stop = comment('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?', head }));
const answer = disposition => comment('answer', buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert',
  channel: 'chat', reason: disposition === 'close-superseded' ? 'Fresh close ruling' : 'No code owed',
  disposition, ...(disposition === 'rearm-review' ? { noCodeOwed: true } : {}) }));
const entries = [
  ...[1, 2].map(prNumber => ({ kind: 'promote-draft', prNumber, headRefOid: head })),
  ...[52, 53].map(prNumber => ({ kind: 'restore-review-label', prNumber })),
  ...[42, 43].map(prNumber => ({ kind: 'rearm-no-code', prNumber, expectHead: head, answerId: 'answer' })),
  ...[62, 63].map(prNumber => ({ kind: 'close-superseded', prNumber })),
];

/** Exposed to the daemon log contract tests so the producer and log assertions share real execution. */
export function guardedScenario() {
  let time = 0, mode = 'budget', adoption = false, latch = false;
  let receipts = new Map(), committed = new Set();
  const prCursors = {}, budgetRotation = {}, events = [], passes = [];
  const empty = () => ({ dispatched: [], refusals: [] });
  const event = (type, pr) => events.push({ type, pr, afterLatch: latch, committed: committed.has(pr) });
  const write = (type, pr) => event(type, pr);
  const options = {
    repos: [weRepo, frontierRepo],
    fixTick: empty, ciHealTick: empty, hungCiTick: () => ({ dispatch: [], applied: [], refusals: [] }),
    mainRedRebaseTick: () => ({ dispatch: [], applied: [], refusals: [] }),
    missingRunTick: () => ({ dispatch: [], applied: [], refusals: [] }),
    notesTick: () => ({ notes: [], prsByNumber: new Map() }), notesDryRun: true,
    awaitVerifyTick: async () => ({ rows: [] }), stuckFixerTick: async () => ({ rows: [] }),
    orphanGuardTick: null, allowStandDownAutoProceed: false, authGateOverride: () => ({ paused: false }),
    now: () => time, prCursors, budgetRotation,
    passBudgets: resolveFixPassBudgets({ env: {}, file: { fixPassBudget: { promoteDraftMs: 1000 } } }),
    adoptYieldProbe: o => {
      if (o?.fresh && adoption) { latch = true; return true; }
      return false;
    },
    promoteDraftTick: options => runReconcilePromoteDraftDispatch({ ...options, root: '.',
      checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => { time += mode === 'mixed' ? 0 : 1001; return { dispatch: entries, refusals: [] }; },
      readHeadCheckState: () => ({ state: 'green' }),
      readPrLabels: ({ prNumber }) => {
        event('labels', prNumber);
        if (mode === 'reads' && prNumber === 42) adoption = true;
        return prNumber === 42 || prNumber === 43 ? ['review:changes'] : [];
      },
      readComments: () => [],
      readThread: pr => pr < 60
        ? [comment('verdict', '🔁 review — changes requested\n\nFix defect'),
          comment('begin', `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${head}\``),
          stop, answer('rearm-review'), ...(receipts.get(pr) ?? [])]
        : [stop, answer('close-superseded')],
      readClaim: () => null,
      acquireRearmLock: ({ prNumber }) => { event('lock', prNumber); return () => event('unlock', prNumber); },
      postComment: ({ prNumber, comment: body }) => {
        write('receipt', prNumber); committed.add(prNumber);
        receipts.set(prNumber, [comment(`receipt-${prNumber}`, body)]);
        if (mode === 'receipt') adoption = true;
      },
      rearm: ({ prNumber }) => {
        write('writer', prNumber);
        if (mode === 'child') adoption = true;
        return { status: 0, stdout: JSON.stringify({ ok: true, labelsObserved: true, labels: ['review:pending'] }) };
      },
      provider: { ready: pr => { write('ready', pr); committed.add(pr); } },
      clearAwaitingCi: ({ pr }) => { write('follow-up', pr); if (mode === 'mixed') adoption = true; },
      addLabel: ({ prNumber }) => { write('addLabel', prNumber); if (prNumber === 52) throw Error('fixture label failure; retry next pass'); },
      readCardsOnMain: () => [], closePr: ({ prNumber }) => write('close', prNumber),
    }),
  };
  return { prCursors, budgetRotation, events, passes, async pass(nextMode = 'budget') {
    mode = nextMode; adoption = false; latch = false; receipts = new Map(); committed = new Set();
    // Every replay pass represents recurring eligible work; only scheduling state survives.
    budgetRotation['promote-draft'] = weRepo;
    const before = structuredClone(prCursors), start = events.length;
    const result = await runTickAllRepos(options);
    const pass = { result, before, events: events.slice(start), mode }; passes.push(pass); return pass;
  } };
}

export default {
  id: 'promote-draft-guarded-executor',
  title: 'every promote executor half progresses under overrun and refuses stale authority',
  card: 'NOCODE-REARM-GUARDED-EXECUTOR',
  // The wrapper must replace this after creating the implementation commit; this task may not commit.
  fixedBy: { sha: 'PENDING-IMPLEMENTATION-COMMIT', where: 'lane/nocode-rearm-guarded-executor', paths: [
    'scripts/operations/promote-draft-pr-dispatch.mjs', 'scripts/lib/daemon-rebuild/adopt-yield.mjs',
    'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  ] },
  fixPresent: root => readFileSync(resolve(root, 'scripts/operations/promote-draft-pr-dispatch.mjs'), 'utf8').includes('function guardWrite('),
  async run() {
    const fixture = guardedScenario(), violations = [];
    for (const mode of ['budget', 'budget', 'reads', 'child', 'receipt', 'mixed']) await fixture.pass(mode);
    const budgetPasses = fixture.passes.filter(p => !p.result.yieldedForAdoption);
    for (let i = 1; i < budgetPasses.length; i++) {
      const attempted = budgetPasses.slice(i - 1, i + 1).flatMap(p => p.events)
        .filter(e => ['labels', 'lock', 'close'].includes(e.type)).map(e => e.pr);
      for (const row of entries) if (!attempted.includes(row.prNumber)) violations.push(`starved ${row.kind} #${row.prNumber} across two admitted passes`);
    }
    for (const pass of fixture.passes) {
      const repo = pass.result.promoteDraft.repos.find(r => r.repo === weRepo)?.result;
      if (!repo) { violations.push(`${pass.mode}: missing executor result`); continue; }
      for (const e of pass.events) {
        if (e.afterLatch && ['ready', 'addLabel', 'close', 'receipt', 'writer', 'follow-up'].includes(e.type)
          && !(e.committed && ['writer', 'follow-up'].includes(e.type))) violations.push(`${pass.mode}: ${e.type} #${e.pr} after latch`);
        if (e.type === 'receipt' && !pass.events.some(later => later.type === 'writer' && later.pr === e.pr)) violations.push(`${pass.mode}: receipt #${e.pr} stranded by adoption`);
      }
      for (const row of entries) {
        const attempted = pass.events.some(e => e.pr === row.prNumber && ['labels', 'lock', 'close'].includes(e.type));
        if (!attempted && repo.refusals.filter(r => r.pr === row.prNumber && /-deferred-(budget|adoption)$/.test(r.kind)).length !== 1) violations.push(`${pass.mode}: unattempted #${row.prNumber} not named once`);
      }
      for (const [half, kind] of [['rearm', 'rearm-no-code'], ['restore', 'restore-review-label'], ['close', 'close-superseded']]) {
        const prs = entries.filter(e => e.kind === kind).map(e => e.prNumber);
        if (!pass.events.some(e => prs.includes(e.pr)) && repo.nextHalfCursors?.[half] !== (pass.before[`promote-draft-${half}`]?.[weRepo] ?? null)) violations.push(`${pass.mode}: zero-attempt ${half} cursor moved`);
      }
    }
    return { violations, passes: fixture.passes };
  },
  judge: report => report.violations,
};
