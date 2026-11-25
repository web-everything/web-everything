/** Live case we#7448/#7451: a fixer that recorded "no change" and stood down on a PR whose only red is the stale
 * review:changes hold deadlocked (fixer won't push, rearm refuses an unchanged head, nobody answers). Through the REAL
 * daemon path (runTickAllRepos -> runReconcileFixDispatch -> runReconcilePass -> the writer) the fix daemon requests
 * exactly ONE fresh review of the unchanged head (an `auto-rearm` record, never an operator ruling), writes nothing in
 * dry-run / opted-out / read-only paths, never when code is owed, and a second tick on the same head posts nothing.
 * Contract: we:scripts/conveyor/stand-down-no-code-owed.mjs.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

export default {
  id: 'no-code-owed-stand-down-deadlock',
  title: 'the fix daemon requests exactly one fresh review for a no-change stand-down, never when code is owed',
  card: 'STANDDOWN-EMPTY-ROUND (we#7448, we#7451)',
  fixedBy: { sha: 'uncommitted', where: 'stand-down-no-code-owed', paths: ['scripts/conveyor/stand-down-no-code-owed.mjs', 'scripts/conveyor/reconcile-pass.mjs'] },
  fixPresent(root) {
    return existsSync(join(root, 'scripts/conveyor/stand-down-no-code-owed.mjs'))
      && readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('enrichNoCodeOwedRearm(');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const load = p => import(pathToFileURL(join(root, p)).href);
    const { runReconcilePass } = await load('scripts/conveyor/reconcile-pass.mjs');
    const { runReconcileFixDispatch, planFixDispatchClaimStatus } = await load('scripts/conveyor/reconcile-fix-dispatch.mjs');
    const { runTickAllRepos } = await load('skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
    const { resolveFixSettings } = await load('scripts/conveyor/fix-takeover.mjs');
    const nco = await load('scripts/conveyor/stand-down-no-code-owed.mjs');
    const { buildStandDownComment } = await load('scripts/conveyor/stand-down.mjs');
    const { buildNoChangeComment } = await load('scripts/conveyor/rearm-review.mjs');
    const { parseOperatorAnswer } = await load('scripts/conveyor/stand-down-answer-core.mjs');
    const { parseAutoRearmRequest } = await load('scripts/conveyor/auto-rearm-request.mjs');
    const { countUnresolvedStandDowns } = await load('scripts/conveyor/reconcile-core.mjs');
    const { AUTOMATION_LOGINS } = await load('scripts/lib/marker-authorship.mjs');
    const { ghRepoSlug } = await load('scripts/lib/constellation-repos.mjs');
    const weSlug = ghRepoSlug('we'), frontierSlug = ghRepoSlug('frontierui');
    const head = 'a'.repeat(40), author = { login: AUTOMATION_LOGINS[0] };
    const thread = (begunAt = head) => [
      { id: 'V1', author, body: '🔁 review — changes requested\n\nRecorded by loop-console operator.\n\nrequired check "merge-gate" FAILURE' },
      { id: 'B1', author, body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${begunAt.slice(0, 9)}\`\n<!-- fix-claim who=f -->` },
      { id: 'N1', author, body: buildNoChangeComment({ actor: 'conveyor fix agent', since: begunAt.slice(0, 9) }) },
      { id: 'SD1', author, createdAt: '2026-11-24T21:39:00Z', body: buildStandDownComment({ reason: 'needs-judgment', detail: 'nothing to repair' }) },
    ];
    const run = (name, conclusion, id) => ({ id, name, app: { id: 15368 }, check_suite: { id: 900 }, head_sha: head,
      status: 'completed', conclusion, completed_at: '2026-11-24T21:00:00Z',
      details_url: `https://github.com/o/r/actions/runs/1/job/${name === 'merge-gate' ? 55 : 60 + id}` });
    const checks = () => ({ head, complete: true, runs: [run('test', 'success', 1), run('merge-gate', 'failure', 2)] });
    const gateRow = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/55' };
    const rollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, gateRow];
    const verdict = () => ({ num: 7448, ok: false, head_sha: head, completed_at: '2026-11-24T21:00:00Z',
      results: [{ status: 'hold', id: 'review-hold-labels', reason: 'labels: review:changes' }] });
    const report = { scenarios: {} };

    async function scenario(name, { comments, setting, override, ticks = 1 }) {
      const writes = [], posted = [];
      let thr = comments;
      const pr = () => ({ number: 7448, headRefOid: head, headRefName: 'lane/x', baseRefName: 'main', rowsComplete: true, rowsHead: head,
        labels: [{ name: 'review:changes' }], files: [], body: '', comments: thr, statusCheckRollup: rollup });
      const reserved = new Set();
      const writer = (prs, opts) => nco.enrichPrsWithNoCodeOwedRearm(prs, { ...opts, repo: weSlug, requiredChecks: ['test', 'merge-gate'],
        readBindings: () => [{ context: 'test', integration_id: 15368 }, { context: 'merge-gate', integration_id: 15368 }],
        readComments: () => thr, readState: () => ({ headRefOid: head, labels: [{ name: 'review:changes' }], statusCheckRollup: rollup }),
        readRoster: () => ({ checks: ['test', 'merge-gate'], source: 'live' }),
        readChecks: checks, readVerdict: verdict,
        reserve: ({ standDownId }) => { writes.push('reserve'); if (reserved.has(standDownId)) return false; reserved.add(standDownId); return true; },
        post: ({ body }) => { writes.push('post'); const c = { id: `A${posted.length + 1}`, author, body }; posted.push(c); thr = [...thr, c]; return c; },
        log: () => {} });
      const same = p => p;
      const options = { readPrs: () => [pr()], readAgents: () => [], enrich: same, env: {},
        readRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }),
        enrichNoCodeOwedRearm: writer, enrichStandDownAutoProceed: same,
        // The pass's own merge-gate excusal annotates a review-hold-only gate; replayed here from the same verdict.
        excuseMergeGateHolds: prs => prs.map(p => ({ ...p, statusCheckRollup: p.statusCheckRollup.map(r => r.name === 'merge-gate'
          ? { ...r, mergeGateReviewHold: { holds: ['review-hold-labels'], jobId: 55 } } : r) })),
        enrichMainRed: prs => ({ prs, mainRedWindows: [] }),
        enrichAlreadyLanded: same, enrichBaseRef: same, enrichSystemFix: same, enrichEscalationBase: same,
        enrichFixClaims: same, enrichTimeouts: same, enrichReferralHolds: same, enrichReferralAutoResolve: same,
        enrichLedgerHolds: same, enrichRulings: same, enrichScopeBloat: same, enrichCodeQL: same,
        enrichStandingRulingGrants: same, enrichMechanicalRound: same, enrichOwedMainRule: () => {},
        resolveMainSha: () => null, readPriority: () => null };
      const dispatchOptions = { repo: 'we', checkStaleness: () => ({ fresh: true }), netScope: null, prStack: null,
        resolveProfile: () => ({ capabilities: { fix: false } }) };
      const plans = [];
      const reconcile = input => { const out = runReconcilePass({ ...options, ...input }); plans.push(out); return out; };
      const result = () => ({ writes, posted, plans, refusals: plans.flatMap(p => p.refusals ?? []).map(r => `${r.kind}:${String(r.why ?? '').slice(0, 80)}`).join(' | '),
        unresolved: countUnresolvedStandDowns(thr, { headRefOid: head }),
        reviews: plans.flatMap(p => p.dispatch ?? []).filter(d => d.kind === 'review' && d.autoRearmReview).length,
        fixes: plans.flatMap(p => p.dispatch ?? []).filter(d => d.kind === 'fix').length });
      if (setting === 'dry') { planFixDispatchClaimStatus({ repo: 'we', reconcile, checkStaleness: () => ({ fresh: true }), resolveProfile: dispatchOptions.resolveProfile }); return { writes, posted }; }
      const fixSettings = resolveFixSettings({ env: {}, platform: {}, read: () => JSON.stringify({ fix: { standDownAutoProceed: setting } }) });
      const emptyTick = () => ({ dispatched: [], refusals: [] });
      for (let i = 0; i < ticks; i += 1) {
        await runTickAllRepos({ repos: [weSlug, frontierSlug], fixSettings, ...(override === undefined ? {} : { allowStandDownAutoProceed: override }),
          fixTick: input => runReconcileFixDispatch({ ...dispatchOptions, ...input, reconcile }),
          ciHealTick: emptyTick, hungCiTick: emptyTick, mainRedRebaseTick: emptyTick, missingRunTick: emptyTick,
          promoteDraftTick: emptyTick, notesTick: emptyTick });
      }
      return result();
    }

    const live = await scenario('live', { comments: thread(), setting: undefined, ticks: 2 });
    report.scenarios.liveWrites = live.writes.join(',');
    report.scenarios.liveRecord = live.posted.length ? parseAutoRearmRequest(live.posted[0]) : null;
    report.scenarios.liveAsAnswer = live.posted.length ? parseOperatorAnswer(live.posted[0]) : null;
    report.scenarios.liveReviews = live.reviews;
    report.scenarios.liveRefusals = live.refusals;
    report.scenarios.liveFixes = live.fixes;
    report.scenarios.liveUnresolved = live.unresolved;
    report.scenarios.dry = (await scenario('dry', { comments: thread(), setting: 'dry' })).writes.join(',');
    report.scenarios.optedOut = (await scenario('off', { comments: thread(), setting: false })).writes.join(',');
    report.scenarios.codeOwed = (await scenario('owed', { comments: thread('b'.repeat(40)), setting: undefined })).writes.join(',');
    return report;
  },
  judge(report) {
    const s = report.scenarios, out = [];
    if (s.liveWrites !== 'reserve,post') out.push(`deadlock/loop: two daemon ticks on the same head wrote "${s.liveWrites}" (want exactly reserve,post)`);
    if (!s.liveRecord) out.push('no auto-rearm request record was posted by the automation identity');
    if (s.liveAsAnswer) out.push('the request parses as an operator answer (it must be a separate record type)');
    if (!(s.liveReviews >= 1)) out.push('no fresh review dispatch was planned for the unchanged head');
    if (s.liveFixes) out.push(`a fixer was dispatched (${s.liveFixes}); the request must never reach fixers`);
    if (s.liveUnresolved !== 1) out.push(`the stand-down was resolved by the request (unresolved=${s.liveUnresolved}, want 1)`);
    if (s.dry) out.push(`dry-run wrote ${s.dry}`);
    if (s.optedOut) out.push(`opted-out daemon wrote ${s.optedOut}`);
    if (s.codeOwed) out.push(`code owed was re-reviewed mechanically (${s.codeOwed})`);
    return out;
  },
};
