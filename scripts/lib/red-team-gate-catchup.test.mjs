import { describe, expect, it, vi } from 'vitest';
import { planGateCatchUp, runGateCatchUp } from './red-team-gate-catchup.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, liveResultGateState, planRedTeamActions, redTeamGateMarker, redTeamGateOwed } from './red-team-gate.mjs';
import { applyRedTeamGate } from '../operations/red-team-gate-apply.mjs';
import { buildRoundExtensionComment } from '../conveyor/round-extension-mark.mjs';
import soak from '../conveyor/soak/breaks/red-team-gate-send-back-failed-never-retried.mjs';

const repo = 'web-everything/web-everything', pr = 6774, head = '8ea4e111' + 'a'.repeat(32);
const now = Date.parse('2026-11-14T16:20:00Z');
const comment = (body, createdAt = '2026-11-14T16:00:00Z', login = 'web-everything') => ({ body, createdAt, author: { login } });
const result = (impact = 'broken') => comment(`<!-- we:red-team-advisory pr=${pr} rev=${head} -->\n1. [**confirmed**] (edge-case, ${impact}) \`scripts/x.mjs:1\` — confirmed break`);
const record = outcome => comment(redTeamGateMarker(pr, head, outcome), '2026-11-14T16:01:00Z');
const advisory = () => comment(result().body.replace('[**confirmed**]', '[not confirmed]'));
const fixture = (comments = [result()]) => ({ repo, now, history: new Map(), setting: CONFIRMED_BREAKS_DEFAULTS,
  refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
  rawPrs: [{ number: pr, headRefOid: head, comments }] });
const grant = () => comment(buildRoundExtensionComment({ repo, pr, by: 1, actor: 'chalbert', channel: 'claude-code-chat',
  reason: 'one more round', at: '2026-11-14T16:02:00Z' }), '2026-11-14T16:02:00Z', 'chalbert');

describe('Gap 1 gate catch-up', () => {
  it('1 picks the #6774 live-head result whose send-back failed without a record', () => {
    expect(planGateCatchUp(fixture())).toMatchObject([{ repo, pr, head, key: expect.stringContaining(`${repo}#${pr}@${head}:`) }]);
  });
  it('2 a sent-back record leaves nothing owed', () => {
    expect(planGateCatchUp(fixture([result(), record('sent-back')]))).toEqual([]);
  });
  it('3 retries card plans until card-queued, including a prior card-failed record', () => {
    expect(planGateCatchUp(fixture([result('degraded'), record('card-failed')]))).toHaveLength(1);
    expect(planGateCatchUp(fixture([result('degraded'), record('card-queued')]))).toEqual([]);
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
    const f = fixture(), needsYou = vi.fn(), runGate = vi.fn(() => ({ status: 'card-failed' }));
    for (let i = 0; i < 4; i++) {
      runGateCatchUp({ ...f, now: now + i * 11 * 60_000, runGate, needsYou });
      expect(needsYou).toHaveBeenCalledTimes(i < 2 ? 0 : 1);
    }
    expect(runGate).toHaveBeenCalledTimes(4);
    expect(needsYou).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head, kind: 'red-team-gate-stuck' }));
    expect([...f.history.values()][0]).toMatchObject({ attempts: 4, alerted: true });
  });
  it('never throws on gate, needs-you, log or planner failures; thrown gates remain retryable', () => {
    const f = fixture(), runGate = () => { throw Error('timeout'); };
    for (let i = 0; i < 4; i++) expect(() => runGateCatchUp({ ...f, now: now + i * 11 * 60_000, runGate,
      needsYou: () => { throw Error('feed'); }, log: () => { throw Error('log'); } })).not.toThrow();
    expect(() => runGateCatchUp({ ...f, history: null })).not.toThrow();
  });
  it.each(['applied', 'already-acted', 'head-moved', 'no-red-team-on-head', 'advisory-only'])('does not count terminal status %s as a failure', status => {
    const f = fixture(); runGateCatchUp({ ...f, runGate: () => ({ status }) });
    expect([...f.history.values()][0].attempts).toBe(0);
  });
  it('10 runs at most one gate per tick even with duplicate and additional refusals', () => {
    const f = fixture();
    f.refusals.push(f.refusals[0], { ...f.refusals[0], prNumber: pr + 1 });
    f.rawPrs.push({ ...f.rawPrs[0], number: pr + 1, comments: [comment(result().body.replace(`pr=${pr}`, `pr=${pr + 1}`))] });
    const runGate = vi.fn(() => ({ status: 'applied' }));
    runGateCatchUp({ ...f, runGate }); expect(runGate).toHaveBeenCalledTimes(1);
  });
  it('11 owes exactly the actionable dry-run plans of applyRedTeamGate', async () => {
    for (const comments of [[result()], [result(), record('sent-back')], [result('degraded')],
      [result('degraded'), record('card-queued')], [advisory()], [result(), record('round-cap')],
      [result(), record('round-cap'), grant()]]) {
      const state = liveResultGateState(comments, pr, head, repo);
      const plan = planRedTeamActions(state.result, CONFIRMED_BREAKS_DEFAULTS);
      const out = await applyRedTeamGate({ repo, pr, dryRun: true }, { readPr: () => ({ headRefOid: head, comments }),
        readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), readRound: () => 1, readRoundAsOf: () => 1 });
      expect(redTeamGateOwed(state, plan)).toBe(out.status === 'dry-run');
    }
  });
  it('12 replays the failed-send-back soak break', async () => {
    expect(soak.judge(await soak.run())).toEqual([]);
  });
});
