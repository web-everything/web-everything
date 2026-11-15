import { describe, expect, it, vi } from 'vitest';
import { planGateCatchUp, runGateCatchUp } from './red-team-gate-catchup.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, liveResultGateState, planRedTeamActions, readRedTeamDisposition, redTeamGateMarker, redTeamGateOwed, redTeamResultCommentForHead } from './red-team-gate.mjs';
import { applyRedTeamGate } from '../operations/red-team-gate-apply.mjs';
import { buildClearedHumanMarker, buildReviewedShaMarker, parseLatestHumanClearedSha } from './review-escalation.mjs';
import { buildRoundExtensionComment } from '../conveyor/round-extension-mark.mjs';
import { buildVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';
import soak from '../conveyor/soak/breaks/red-team-gate-send-back-failed-never-retried.mjs';

const repo = 'web-everything/web-everything', pr = 6774, head = '8ea4e111' + 'a'.repeat(32);
const now = Date.parse('2026-11-14T16:20:00Z');
const comment = (body, createdAt = '2026-11-14T16:00:00Z', login = 'web-everything') => ({ body, createdAt, author: { login } });
const result = (impact = 'broken') => comment(`<!-- we:red-team-advisory pr=${pr} rev=${head} -->\n1. [**confirmed**] (edge-case, ${impact}) \`scripts/x.mjs:1\` — confirmed break`);
const record = outcome => comment(redTeamGateMarker(pr, head, outcome), '2026-11-14T16:01:00Z');
const advisory = () => comment(result().body.replace('[**confirmed**]', '[not confirmed]'));
const fixture = (comments = [result()]) => ({ repo, now, history: new Map(), setting: CONFIRMED_BREAKS_DEFAULTS, readGrantScope: () => null,
  refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
  rawPrs: [{ number: pr, headRefOid: head, comments }] });
const grant = () => comment(buildRoundExtensionComment({ repo, pr, by: 1, actor: 'chalbert', channel: 'claude-code-chat',
  reason: 'one more round', at: '2026-11-14T16:02:00Z' }), '2026-11-14T16:02:00Z', 'chalbert');

describe('Gap 1 gate catch-up', () => {
  it('stranger malformed gate text does not reduce one nomination to zero', () => {
    expect(planGateCatchUp(fixture())).toHaveLength(1);
    expect(planGateCatchUp(fixture([result(), comment('we:red-team-gate malformed', undefined, 'stranger')]))).toHaveLength(1);
  });
  it('1 picks the #6774 live-head result whose send-back failed without a record', () => {
    expect(planGateCatchUp(fixture())).toMatchObject([{ repo, pr, head, key: expect.stringContaining(`${repo}#${pr}@${head}:`) }]);
  });
  it('2 a sent-back record leaves nothing owed', () => {
    expect(planGateCatchUp(fixture([result(), record('sent-back')]))).toEqual([]);
  });
  it.each([null, 'card-failed', 'card-record-failed', 'card-queued'])('never nominates a card-only plan with record %s', outcome => {
    const f = fixture([result('degraded'), ...(outcome ? [record(outcome)] : [])]), runGate = vi.fn();
    expect(runGateCatchUp({ ...f, runGate }).picks).toEqual([]);
    expect(runGate).not.toHaveBeenCalled();
  });
  it('4 skips advisory-only and round-cap, retries a cap reopened by an operator grant', () => {
    expect(planGateCatchUp(fixture([advisory()]))).toEqual([]);
    expect(planGateCatchUp(fixture([result(), record('round-cap')]))).toEqual([]);
    expect(planGateCatchUp(fixture([result(), record('round-cap'), grant()]))).toHaveLength(1);
  });
  it('5 skips a five-minute result, accepts the fifteen-minute boundary and rejects unreadable time', () => {
    for (const at of ['2026-11-14T16:15:00Z', undefined, 'invalid']) {
      const c = { ...result(), createdAt: at };
      expect(planGateCatchUp(fixture([c]))).toEqual([]);
    }
    expect(planGateCatchUp(fixture([{ ...result(), createdAt: '2026-11-14T16:05:00Z' }]))).toHaveLength(1);
  });
  it('6 skips a changed live head or a refusal of another kind', () => {
    const f = fixture(); f.rawPrs[0].headRefOid = 'b'.repeat(40);
    expect(planGateCatchUp(f)).toEqual([]);
    expect(planGateCatchUp({ ...fixture(), refusals: [{ kind: 'other', prNumber: pr, headSha: head }] })).toEqual([]);
  });
  it('uses the supplied effective policy and REST comment timestamps', () => {
    const c = result(); c.created_at = c.createdAt; delete c.createdAt;
    expect(planGateCatchUp(fixture([c]))).toHaveLength(1);
    expect(planGateCatchUp({ ...fixture([c]), setting: { ...CONFIRMED_BREAKS_DEFAULTS, broken: 'advisory' } })).toEqual([]);
  });
  it('refuses grace or cooldown overrides below the safety floors and invalid clocks', () => {
    for (const override of [{ graceMin: 10 }, { graceMin: Infinity }, { cooldownMin: 5 }, { now: NaN }]) {
      expect(planGateCatchUp({ ...fixture(), ...override })).toEqual([]);
    }
  });
  it('7 fails closed on comments not an array, missing result or untrusted author', () => {
    for (const comments of [null, {}, undefined, [], [{ ...result(), author: { login: 'stranger' } }]]) {
      const f = fixture(); f.rawPrs[0].comments = comments;
      expect(planGateCatchUp(f)).toEqual([]);
    }
  });
  it('8 cooldown picks at T, skips T+5 and retries T+11; history is result-specific', () => {
    const f = fixture(); const runGate = vi.fn(() => ({ status: 'send-back-failed' }));
    runGateCatchUp({ ...f, runGate });
    expect(planGateCatchUp({ ...f, now: now + 5 * 60_000 })).toEqual([]);
    expect(planGateCatchUp({ ...f, now: now + 11 * 60_000 })).toHaveLength(1);
    f.rawPrs[0].comments[0].body += ' changed finding';
    expect(planGateCatchUp(f)).toHaveLength(1);
  });
  it('9 alerts exactly once on the third failure and keeps retrying after cooldown', () => {
    const f = fixture(), needsYou = vi.fn(), runGate = vi.fn(() => ({ status: 'send-back-failed' }));
    for (let i = 0; i < 4; i++) {
      runGateCatchUp({ ...f, now: now + i * 11 * 60_000, runGate, needsYou });
      expect(needsYou).toHaveBeenCalledTimes(i < 2 ? 0 : 1);
    }
    expect(runGate).toHaveBeenCalledTimes(4);
    expect(needsYou).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head, kind: 'red-team-gate-stuck' }));
    expect([...f.history.values()][0]).toMatchObject({ attempts: 4, alerted: true });
  });
  it('never throws on gate, needs-you, log or planner failures; thrown gates stop for operator review', () => {
    const f = fixture(), runGate = () => { throw Error('timeout'); };
    for (let i = 0; i < 4; i++) expect(() => runGateCatchUp({ ...f, now: now + i * 11 * 60_000, runGate,
      needsYou: () => { throw Error('feed'); }, log: () => { throw Error('log'); } })).not.toThrow();
    expect(() => runGateCatchUp({ ...f, history: null })).not.toThrow();
  });
  it.each(['applied', 'already-acted', 'head-moved', 'no-red-team-on-head', 'advisory-only'])('does not count terminal status %s as a failure', status => {
    const f = fixture(); runGateCatchUp({ ...f, runGate: () => ({ status }) });
    expect([...f.history.values()][0].attempts).toBe(0);
    expect(planGateCatchUp({ ...f, now: now + 11 * 60_000 })).toEqual([]);
  });
  it.each(['error', 'unknown'])('stops %s immediately and alerts once without retrying', status => {
    const f = fixture(), runGate = vi.fn(() => ({ status })), needsYou = vi.fn(), log = vi.fn();
    runGateCatchUp({ ...f, runGate, needsYou, log });
    expect(needsYou).toHaveBeenCalledTimes(1);
    expect(needsYou).toHaveBeenCalledWith(expect.objectContaining({ kind: 'red-team-gate-stuck',
      reason: expect.stringContaining(`status=${status}`) }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stopped for operator review'));
    expect(runGateCatchUp({ ...f, now: now + 11 * 60_000, runGate, needsYou }).picks).toEqual([]);
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(needsYou).toHaveBeenCalledTimes(1);
    f.rawPrs[0].comments[0].body += ' new result';
    expect(planGateCatchUp(f)).toHaveLength(1);
  });
  it('keeps a terminal key stopped even if needs-you publication fails', () => {
    const f = fixture(), runGate = vi.fn(() => ({ status: 'error' })), needsYou = vi.fn(() => { throw Error('feed'); });
    runGateCatchUp({ ...f, runGate, needsYou });
    runGateCatchUp({ ...f, now: now + 11 * 60_000, runGate, needsYou });
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(needsYou).toHaveBeenCalledTimes(1);
  });
  it.each(['send-back-failed', 'send-back-record-failed', 'send-back-wrong-head'])('only retries send-back failure %s after cooldown', status => {
    const f = fixture(), runGate = vi.fn(() => ({ status }));
    runGateCatchUp({ ...f, runGate });
    runGateCatchUp({ ...f, now: now + 11 * 60_000, runGate });
    expect(runGate).toHaveBeenCalledTimes(2);
  });
  it('excludes operator-card releases from send-back and card nomination, including reopened caps', () => {
    for (const impact of ['broken', 'degraded']) {
      const c = result(impact), id = liveResultGateState([c], pr, head, repo).resultId;
      const ruling = comment(`${redTeamGateMarker(pr, head, 'operator-card', id)}
- 1 finding(s) carded by the operator to \`we:backlog/follow-up.md\` (#1).`, '2026-11-14T16:01:30Z', 'chalbert');
      // Rule while the cap belongs to the operator, then reopen it with a later grant.
      for (const comments of [[c, ruling], [c, record('round-cap'), ruling, grant()]]) {
        const readDisposition = input => readRedTeamDisposition({ ...input, operatorRulings: { anyState: true } });
        expect(readDisposition({ comments, repo, pr, head, setting: CONFIRMED_BREAKS_DEFAULTS }).dispositions.get(1).state).toBe('released carded');
        expect(planGateCatchUp({ ...fixture(comments), readDisposition })).toEqual([]);
        if (comments.length > 2) {
          expect(liveResultGateState(comments, pr, head, repo)).toMatchObject({ sendBackOutcome: 'round-cap', reopened: true });
          expect(planGateCatchUp(fixture(comments))).toEqual([]);
        }
      }
    }
  });
  it.each(['operator-card', 'operator-block', 'operator-not-real', 'card-queued'])('never nominates a result with %s and another open finding', outcome => {
    const c = result();
    c.body += '\n2. [**confirmed**] (edge-case, broken) `scripts/y.mjs:2` — another break';
    const id = liveResultGateState([c], pr, head, repo).resultId;
    const line = outcome === 'operator-block' ? '- 1 confirmed break(s) sent back to the fixer (#1).'
      : outcome === 'operator-not-real' ? '- 1 finding(s) left advisory (#1).'
      : outcome === 'card-queued' ? '- 1 finding(s) filed as a follow-up card (#1).'
      : '- 1 finding(s) carded by the operator to `we:backlog/follow-up.md` (#1).';
    const ruling = comment(`${redTeamGateMarker(pr, head, outcome, id)}\n${line}`, '2026-11-14T16:01:30Z', 'chalbert');
    const readDisposition = input => readRedTeamDisposition({ ...input, operatorRulings: { anyState: true } });
    const comments = [c, ruling];
    const resolved = readDisposition({ comments, repo, pr, head }).dispositions;
    expect(resolved.get(1).state).toBe(outcome === 'operator-block' ? 'held'
      : outcome === 'operator-not-real' ? 'released not-real' : 'released carded');
    expect(resolved.get(2).state).toBe('open');
    expect(planGateCatchUp({ ...fixture(comments), readDisposition })).toEqual([]);
    expect(planGateCatchUp(fixture([c, record('round-cap'), ruling, grant()]))).toEqual([]);
  });
  it('excludes an operator record even without readable per-finding action lines', () => {
    const id = liveResultGateState([result()], pr, head, repo).resultId;
    expect(planGateCatchUp(fixture([result(), comment(redTeamGateMarker(pr, head, 'operator-block', id), undefined, 'chalbert')]))).toEqual([]);
  });
  it('does not confuse a ruling for an earlier result with the live result', () => {
    const earlier = result(); earlier.body += ' earlier';
    const id = liveResultGateState([earlier], pr, head, repo).resultId;
    const ruling = comment(redTeamGateMarker(pr, head, 'operator-block', id), '2026-11-14T15:59:00Z', 'chalbert');
    expect(planGateCatchUp(fixture([{ ...earlier, createdAt: '2026-11-14T15:58:00Z' }, ruling, result()]))).toHaveLength(1);
  });
  it.each([{}, comment('<!-- we:red-team-gate malformed -->'),
    comment('we:red-team-gate malformed', undefined, 'stranger'),
    comment(redTeamGateMarker(pr, head, 'operator-card'), undefined, 'stranger'),
    comment(redTeamGateMarker(pr, head, 'operator-block')),
    comment(redTeamGateMarker(pr, head, 'card-queued'), undefined, 'stranger')])(
    'ignores unreadable, malformed or untrusted records and logs each once across ticks: %j', c => {
      const f = fixture([result(), c]), log = vi.fn(), runGate = vi.fn(() => ({ status: 'send-back-failed' }));
      expect(runGateCatchUp({ ...f, log, runGate }).picks).toHaveLength(1);
      expect(runGateCatchUp({ ...f, log, runGate, now: now + 11 * 60_000 }).picks).toHaveLength(1);
      expect(log.mock.calls.filter(([line]) => line.includes('ignored'))).toHaveLength(1);
      expect([...f.history.values()].filter(entry => entry.ignored)).toHaveLength(1);
    });
  it('a throwing diagnostic logger cannot suppress catch-up for malformed records', () => {
    expect(planGateCatchUp({ ...fixture([result(), comment('we:red-team-gate malformed')]),
      log: () => { throw Error('log'); } })).toHaveLength(1);
  });
  it('leaves a clear-human ruling with the operator even after a grant reopens the cap', () => {
    const ruling = comment(`✅ review — \`review:human\` cleared via the sanctioned path

Cleared by chalbert via \`review-set-label.mjs --to=clear-human\` (gate-self).

${buildReviewedShaMarker(head)}
${buildClearedHumanMarker('chalbert')}`, '2026-11-14T16:01:30Z', 'chalbert');
    expect(parseLatestHumanClearedSha([ruling])).toBe(head);
    const comments = [result(), record('round-cap'), ruling, grant()];
    expect(liveResultGateState(comments, pr, head, repo).reopened).toBe(true);
    expect(planGateCatchUp(fixture(comments))).toEqual([]);
  });
  it.each([() => { throw Error('read'); }, () => null, () => ({}), () => ({ dispositions: new Map() }),
    () => ({ dispositions: new Map([[1, { state: 'open' }]]), rulings: new Map() })])('fails closed with no pick when disposition is unreadable or incomplete', readDisposition => {
    expect(planGateCatchUp({ ...fixture(), readDisposition })).toEqual([]);
  });
  it('uses the verified standing-ruling scope for automatic cap reopening and fails closed to null', () => {
    const scope = { ok: true, id: `${repo}#6000`, author: 'chalbert', by: 1, maxPerPr: 3, repos: [repo],
      cardOnlyHeads: { [head]: true }, uneditedComments: ['IC_auto'] };
    const autoGrant = { ...comment(buildRoundExtensionComment({ repo, pr, by: 1, actor: 'chalbert', channel: 'auto-round-grant',
      reason: 'one more', at: '2026-11-14T16:02:00Z', standingRuling: scope.id, head,
      episode: `${repo}#${pr}@${head}:review:12/12` }), '2026-11-14T16:02:00Z', 'web-everything[bot]'), id: 'IC_auto' };
    const f = fixture([result(), record('round-cap'), autoGrant]);
    const readGrantScope = vi.fn(() => scope), readDisposition = vi.fn(readRedTeamDisposition);
    expect(planGateCatchUp({ ...f, readGrantScope, readDisposition })).toHaveLength(1);
    expect(readGrantScope).toHaveBeenCalledWith({ repo, pr, head, comments: f.rawPrs[0].comments });
    expect(readDisposition).toHaveBeenCalledWith(expect.objectContaining({ standingRuling: scope }));
    for (const reader of [() => null, () => { throw Error('unreadable'); }]) {
      expect(planGateCatchUp({ ...f, readGrantScope: reader })).toEqual([]);
      expect(planGateCatchUp({ ...fixture([result(), record('round-cap'), grant()]), readGrantScope: reader })).toHaveLength(1);
    }
  });
  it('red-team break 1: a later grant is caught up despite a retained terminal history entry', () => {
    const f = fixture([result(), record('round-cap')]);
    const id = liveResultGateState(f.rawPrs[0].comments, pr, head, repo, null).resultId;
    const key = `${repo}#${pr}@${head}:${id}`;
    const withGrant = fixture([result(), record('round-cap'), grant()]);
    // Even a terminal entry is ignored once the cap is reopened.
    const history = new Map([[key, { terminal: true, settled: true, attempts: 0, lastAt: now - 11 * 60_000 }]]);
    // An unknown failure stays stopped for the operator even after a grant.
    const stuck = new Map([[key, { terminal: true, settled: false, attempts: 1, lastAt: now - 11 * 60_000 }]]);
    expect(planGateCatchUp({ ...withGrant, history: stuck })).toEqual([]);
    expect(planGateCatchUp({ ...withGrant, history })).toHaveLength(1);
    expect(planGateCatchUp({ ...fixture([result(), record('round-cap')]), history })).toEqual([]);
  });
  it('red-team break 2: a legacy operator ruling without result= only covers results posted before it', () => {
    const resultA = comment(result().body.replace('scripts/x.mjs:1', 'scripts/a.mjs:1'), '2026-11-14T15:00:00Z');
    const resultB = comment(result().body.replace('scripts/x.mjs:1', 'scripts/b.mjs:2'), '2026-11-14T15:40:00Z');
    const legacy = comment(`${redTeamGateMarker(pr, head, 'operator-block')}\n- 1 confirmed break(s) sent back to the fixer (#1).`, '2026-11-14T15:20:00Z', 'chalbert');
    expect(planGateCatchUp(fixture([resultA, legacy, resultB]))).toHaveLength(1);
    expect(planGateCatchUp(fixture([resultA, resultB, legacy]))).toEqual([]);
  });
  it.each(['operator-block', 'operator-card', 'operator-not-real'])('uses the carry position to scope legacy %s rulings on a revisited head', outcome => {
    const sourceHead = 'b'.repeat(40);
    const resultA = comment(result().body.replace('scripts/x.mjs:1', 'scripts/a.mjs:1'), '2026-11-14T15:00:00Z');
    const source = comment(result().body.replace(head, sourceHead), '2026-11-14T15:30:00Z');
    const legacy = comment(redTeamGateMarker(pr, head, outcome), '2026-11-14T15:20:00Z', 'chalbert');
    const carry = comment([
      buildVerdictCarriedMarker({ fromSha: sourceHead, toSha: head, patchId: 'c'.repeat(40) }),
      'Review verdict carried across an identical contribution.',
      source.body.replace(sourceHead, head),
    ].join('\n'), '2026-11-14T16:00:00Z');
    const comments = [resultA, legacy, source, carry];
    expect(redTeamResultCommentForHead(comments, pr, head)).toMatchObject({ carriedFrom: sourceHead, commentIndex: 3 });
    const disposition = readRedTeamDisposition({ comments, repo, pr, head, setting: CONFIRMED_BREAKS_DEFAULTS });
    expect(disposition.dispositions.get(1).state).toBe('open');
    expect(disposition.rulings.get(1)).toEqual([]);
    const runGate = vi.fn(() => ({ status: 'send-back-failed' }));
    expect(runGateCatchUp({ ...fixture(comments), runGate }).picks).toHaveLength(1);
    expect(runGate).toHaveBeenCalledTimes(1);
    // A later legacy ruling still belongs to the carried result.
    expect(planGateCatchUp(fixture([...comments, { ...legacy, createdAt: '2026-11-14T16:01:00Z' }]))).toEqual([]);
    // Explicit result bindings apply even when posted before the carry.
    const id = liveResultGateState(comments, pr, head, repo).resultId;
    const bound = { ...legacy, body: redTeamGateMarker(pr, head, outcome, id) };
    expect(planGateCatchUp(fixture([resultA, bound, source, carry]))).toEqual([]);
    // Eligibility is aged from the carry, not the older source result.
    expect(planGateCatchUp(fixture([...comments.slice(0, -1), { ...carry, createdAt: '2026-11-14T16:15:00Z' }]))).toEqual([]);
  });
  it('10 runs at most one gate per tick even with duplicate and additional refusals', () => {
    const f = fixture();
    f.refusals.push(f.refusals[0], { ...f.refusals[0], prNumber: pr + 1 });
    f.rawPrs.push({ ...f.rawPrs[0], number: pr + 1, comments: [comment(result().body.replace(`pr=${pr}`, `pr=${pr + 1}`))] });
    const runGate = vi.fn(() => ({ status: 'applied' }));
    runGateCatchUp({ ...f, runGate }); expect(runGate).toHaveBeenCalledTimes(1);
  });
  it('11 preserves apply gate owed semantics while catch-up nominates only send-backs', async () => {
    for (const comments of [[result()], [result(), record('sent-back')], [result('degraded')],
      [result('degraded'), record('card-queued')], [advisory()], [result(), record('round-cap')],
      [result(), record('round-cap'), grant()]]) {
      const state = liveResultGateState(comments, pr, head, repo);
      const plan = planRedTeamActions(state.result, CONFIRMED_BREAKS_DEFAULTS);
      const out = await applyRedTeamGate({ repo, pr, dryRun: true }, { readPr: () => ({ headRefOid: head, comments }),
        readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), readRound: () => 1, readRoundAsOf: () => 1 });
      expect(redTeamGateOwed(state, plan)).toBe(out.status === 'dry-run');
      expect(planGateCatchUp(fixture(comments)).length === 1).toBe(out.status === 'dry-run' && plan.sendBack.length > 0);
    }
  });
  it('12 replays the failed-send-back soak break', async () => {
    expect(soak.judge(await soak.run())).toEqual([]);
  });
});
