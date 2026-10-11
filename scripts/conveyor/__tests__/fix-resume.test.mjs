/**
 * Card xrbu1bp — round N>1 resumes the previous round's fixer session (chosen / declined), and the fixer ladder's
 * stronger-model rung starts at `fix.strongerModelFromRound` (rung by round).
 */
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  baseRebasedUnder, buildRoundResumePrompt, findSessionLane, jobModel, laneFromJournal, latestSessionRow,
  planRoundEscalation, planRoundResume, roundOf,
} from '../fix-resume.mjs';
import { resolveFixSettings } from '../fix-takeover.mjs';
import {
  dispatchFix, launchTableFor, roundEscalationFor, runReconcileFixDispatch, tryResumeRoundFix,
} from '../reconcile-fix-dispatch.mjs';
import { DEFAULT_FIXER_ESCALATION } from '../../lib/fixer-escalation-policy.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const SID = '11111111-2222-4333-8444-555555555555';
const OPUS = { provider: 'claude', model: 'claude-opus-5', effort: 'high' };
/** The platform ladder with the stronger-model rung routed to Opus on Claude (cross-provider unavailable). */
const LADDER = {
  policy: DEFAULT_FIXER_ESCALATION,
  routes: { resend: null, 'stronger-model': OPUS, 'cross-provider': { provider: 'codex', model: 'astra' } },
  available: (r) => r.id !== 'cross-provider',
};
const SETTINGS = { resumeAcrossRounds: 'on', strongerModelFromRound: 3, roundHistory: 'on' };

const prior = { id: '11111111', sessionId: SID, name: 'fix-77', state: 'done', cwd: '/scratch/x', startedAt: 2 };
const job = { template: 'bg', respawnFlags: ['-n', 'fix-77', '--model', 'sonnet'] };
const freeLane = { lane: 4, path: '/lanes/we/lane-4', held: 'free', head: HEAD, sessionHead: HEAD };
const planned = (o = {}) => ({ pr: 77, itemNum: null, laneRef: 'lane/x', headRefOid: HEAD, baseRefName: 'main', attempts: 1, scope: ['we:x'], ...o });
const resumable = (o = {}) => ({ planned: planned(), settings: SETTINGS, prior, job, transcript: true, lane: freeLane, base: { rebased: false }, ...o });

describe('fix settings cascade — card xrbu1bp keys', () => {
  const noFile = () => { throw new Error('no file'); };
  it('built-in: resume on, stronger model from round 3', () => {
    expect(resolveFixSettings({ env: {}, read: noFile })).toMatchObject({ resumeAcrossRounds: 'on', strongerModelFromRound: 3 });
  });
  it('settings file, then env, win in that order; a bad value falls through', () => {
    const read = () => JSON.stringify({ fix: { resumeAcrossRounds: 'off', strongerModelFromRound: 4 } });
    expect(resolveFixSettings({ env: {}, read })).toMatchObject({ resumeAcrossRounds: 'off', strongerModelFromRound: 4 });
    // the file layer is its `fix` object: a flat (un-namespaced) key is not a setting
    const flat = () => JSON.stringify({ resumeAcrossRounds: 'off', strongerModelFromRound: 4 });
    expect(resolveFixSettings({ env: {}, read: flat })).toMatchObject({ resumeAcrossRounds: 'on', strongerModelFromRound: 3 });
    expect(resolveFixSettings({ env: { WE_FIX_RESUME_ACROSS_ROUNDS: 'on', WE_FIX_STRONGER_MODEL_FROM_ROUND: '2' }, read }))
      .toMatchObject({ resumeAcrossRounds: 'on', strongerModelFromRound: 2, sources: { resumeAcrossRounds: 'env', strongerModelFromRound: 'env' } });
    expect(resolveFixSettings({ env: { WE_FIX_STRONGER_MODEL_FROM_ROUND: 'soon' }, read }).strongerModelFromRound).toBe(4);
  });
});

describe('rung by round (planRoundEscalation / roundEscalationFor)', () => {
  it('round = spent rounds + 1', () => {
    expect(roundOf({})).toBe(1);
    expect(roundOf({ attempts: 2 })).toBe(3);
  });
  it('rounds 1 and 2 stay on the ordinary route; round 3 and later take the stronger-model rung', () => {
    expect(planRoundEscalation({ round: 2, fromRound: 3, fixerLadder: LADDER })).toBeNull();
    const r3 = planRoundEscalation({ round: 3, fromRound: 3, fixerLadder: LADDER });
    expect(r3).toMatchObject({ round: 3, fromRound: 3, rung: { id: 'stronger-model', model: 'claude-opus-5' }, route: OPUS });
    expect(planRoundEscalation({ round: 6, fromRound: 3, fixerLadder: LADDER }).rung.id).toBe('stronger-model');
  });
  it('0 turns it off; no launchable stronger rung keeps the ordinary route', () => {
    expect(planRoundEscalation({ round: 5, fromRound: 0, fixerLadder: LADDER })).toBeNull();
    expect(planRoundEscalation({ round: 5, fromRound: 3, fixerLadder: { ...LADDER, available: () => false } })).toBeNull();
  });
  it('only an ordinary round escalates; ruling, takeover, conflict and restack rounds keep their own route', () => {
    const loadLadder = () => LADDER;
    expect(roundEscalationFor(planned({ attempts: 2 }), { fixSettings: SETTINGS, loadLadder }).rung.id).toBe('stronger-model');
    for (const extra of [{ takeover: { rung: {} } }, { rulingNotAddressed: { matches: [1] } }, { isConflict: true }, { restack: {} }]) {
      expect(roundEscalationFor(planned({ attempts: 4, ...extra }), { fixSettings: SETTINGS, loadLadder })).toBeNull();
    }
    const load = vi.fn(() => LADDER);
    expect(roundEscalationFor(planned({ attempts: 1 }), { fixSettings: SETTINGS, loadLadder: load })).toBeNull();
    expect(load).not.toHaveBeenCalled(); // the ladder is only read once a round reaches the setting
  });
  it('the launch table of a round-3 fix is the routing policy\'s stronger-model route', () => {
    const esc = roundEscalationFor(planned({ attempts: 2 }), { fixSettings: SETTINGS, loadLadder: () => LADDER });
    expect(launchTableFor(planned({ attempts: 2 }), esc)).toMatchObject({ model: 'claude-opus-5', effort: 'high' });
    expect(launchTableFor(planned({ attempts: 1 }), null)).toBeNull();
  });
  it('dispatchFix launches a round-3 ordinary fix with --model opus, and a round-2 fix on the ordinary route', () => {
    const launch = (attempts) => {
      const calls = [];
      dispatchFix({ ...planned({ attempts }), itemNum: '3438', laneRef: 'lane/3438-x', lane: 9 }, {
        root: '/repo',
        readBrief: () => '{{PR_NUM}} {{ITEM_NUM}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}} {{LANE_REF}}',
        mintSessionId: () => '22222222-2222-4222-8222-222222222222',
        readFixClaim: () => null, acquireClaim: () => ({ ok: true }), releaseClaim: () => {},
        grantConflictHelper: () => {}, wrapFix: false, fixSettings: SETTINGS, loadLadder: () => LADDER,
        readHistoryInputs: () => null, postNotice: () => false,
        spawnAgent: (argv) => { calls.push(argv); return ''; },
      });
      return calls[0];
    };
    const r3 = launch(2);
    expect(r3[r3.indexOf('--model') + 1]).toBe('opus');
    const r2 = launch(1);
    expect(r2.indexOf('--model') === -1 || r2[r2.indexOf('--model') + 1] !== 'opus').toBe(true);
  });
});

describe('planRoundResume — chosen', () => {
  it('resumes the previous round\'s session when every bound holds', () => {
    expect(planRoundResume(resumable())).toMatchObject({ resume: true, sessionId: SID, round: 2, lane: freeLane });
  });
  it('a stacked PR resumes when its base was only fast-forwarded', () => {
    expect(planRoundResume(resumable({ planned: planned({ baseRefName: 'lane/base' }) })).resume).toBe(true);
  });
  it('a round that needs the model the session already runs on still resumes', () => {
    const opusJob = { template: 'bg', respawnFlags: ['--model', 'opus'] };
    expect(planRoundResume(resumable({ planned: planned({ attempts: 3 }), job: opusJob, desiredModel: 'opus' })).resume).toBe(true);
  });
});

describe('planRoundResume — declined (cold start, with the reason)', () => {
  const reason = (o) => planRoundResume(resumable(o)).reason;
  it.each([
    ['setting-off', { settings: { ...SETTINGS, resumeAcrossRounds: 'off' } }],
    ['first-round', { planned: planned({ attempts: 0 }) }],
    ['takeover', { planned: planned({ takeover: { attempts: 5, cap: 5 } }) }],
    ['conflict', { planned: planned({ isConflict: true }) }],
    ['restack', { planned: planned({ restack: { bottom: 1 } }) }],
    ['no-prior-session', { prior: null }],
    ['prior-session-busy', { prior: { ...prior, state: 'working' } }],
    ['job-record-gone', { job: null }],
    ['not-a-bg-session', { job: { ...job, template: 'p' } }],
    ['transcript-gone', { transcript: false }],
    ['model-escalated', { desiredModel: 'opus' }],
    ['lane-not-found', { lane: null }],
    ['session-head-unknown', { lane: { ...freeLane, held: 'taken', sessionHead: null } }],
    ['pr-moved', { lane: { ...freeLane, sessionHead: OTHER } }],
    ['base-rebased', { base: { rebased: true } }],
    ['base-unknown', { base: { rebased: null, why: 'gh down' } }],
  ])('%s', (want, o) => {
    expect(reason(o)).toBe(want);
  });
});

describe('the previous session and its lane', () => {
  it('latestSessionRow picks the newest row of the slug; jobModel reads --model', () => {
    const rows = [{ ...prior, startedAt: 1, sessionId: 'old' }, prior, { ...prior, name: 'fix-78', startedAt: 9 }];
    expect(latestSessionRow(rows, 'fix-77').sessionId).toBe(SID);
    expect(jobModel(job)).toBe('sonnet');
    expect(jobModel({})).toBeNull();
  });
  it('laneFromJournal: the session\'s acquire, the head it was released at, and whether anyone took the lane since', () => {
    const events = [
      { lane: 4, action: 'acquire', actor: { session: SID }, session: 'fix-77' },
      { lane: 4, action: 'release', leaseOwnerSession: SID, headBefore: HEAD },
    ];
    expect(laneFromJournal(events, { slug: 'fix-77', sessionId: SID })).toEqual({ lane: 4, takenSince: false, takenBy: null, releasedHead: HEAD });
    const taken = [...events, { lane: 4, action: 'acquire-reset', actor: { session: 'zzz' }, session: 'review-9' }];
    expect(laneFromJournal(taken, { slug: 'fix-77', sessionId: SID })).toMatchObject({ takenSince: true, takenBy: 'review-9' });
    expect(laneFromJournal(events, { slug: 'fix-77', sessionId: 'someone-else' })).toBeNull();
  });
  it('findSessionLane: own live lease first, else the journal (free or taken)', () => {
    const fs = (files) => ({
      list: (d) => { const kids = new Set(); for (const f of Object.keys(files)) if (f.startsWith(`${d}/`)) kids.add(f.slice(d.length + 1).split('/')[0]); if (!kids.size) throw new Error('ENOENT'); return [...kids]; },
      read: (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; },
    });
    const lease = JSON.stringify({ session: 'fix-77', ownerSession: SID, acquiredAt: new Date().toISOString(), ttlMinutes: 240 });
    const own = fs({ '/pool/we/lane-4/.git/.lane-lease': lease, '/pool/we/lane-5/x': '' });
    expect(findSessionLane({ slug: 'fix-77', sessionId: SID, poolRoot: '/pool', ...own, readJournal: () => [], headOf: () => HEAD }))
      .toMatchObject({ lane: 4, held: 'own', sessionHead: HEAD, path: join('/pool', 'we', 'lane-4') });
    const journal = [
      { lane: 5, action: 'acquire', actor: { session: SID }, session: 'fix-77' },
      { lane: 5, action: 'release', leaseOwnerSession: SID, headBefore: HEAD },
    ];
    const free = fs({ '/pool/we/lane-5/x': '' });
    expect(findSessionLane({ slug: 'fix-77', sessionId: SID, poolRoot: '/pool', ...free, readJournal: () => journal, headOf: () => HEAD }))
      .toMatchObject({ lane: 5, held: 'free', sessionHead: HEAD });
    const otherLease = JSON.stringify({ session: 'review-9', ownerSession: 'zzz', acquiredAt: new Date().toISOString(), ttlMinutes: 240 });
    const taken = fs({ '/pool/we/lane-5/.git/.lane-lease': otherLease });
    expect(findSessionLane({ slug: 'fix-77', sessionId: SID, poolRoot: '/pool', ...taken, readJournal: () => journal, headOf: () => OTHER }))
      .toMatchObject({ lane: 5, held: 'taken', sessionHead: HEAD, takenBy: 'review-9' });
  });
  it('baseRebasedUnder: main is never rebased; a stacked base asks GitHub compare', () => {
    const P = 'c'.repeat(40);
    expect(baseRebasedUnder({ baseRefName: 'main', ghApi: () => { throw new Error('no call'); } })).toEqual({ rebased: false });
    expect(baseRebasedUnder({ baseRefName: 'lane/b', firstParent: P, repoSlug: 'o/r', ghApi: () => 'ahead\n' })).toEqual({ rebased: false });
    expect(baseRebasedUnder({ baseRefName: 'lane/b', firstParent: P, repoSlug: 'o/r', ghApi: () => 'diverged' })).toEqual({ rebased: true });
    expect(baseRebasedUnder({ baseRefName: 'lane/b', firstParent: P, repoSlug: 'o/r', ghApi: () => { throw new Error('502'); } }).rebased).toBeNull();
    expect(baseRebasedUnder({ baseRefName: 'lane/b', firstParent: null, repoSlug: 'o/r', ghApi: () => 'ahead' }).rebased).toBeNull();
    expect(baseRebasedUnder({ baseRefName: 'lane/../x', firstParent: P, repoSlug: 'o/r', ghApi: () => 'ahead' }).rebased).toBeNull();
  });
  it('the resume prompt names the lane to re-take (free) or a fresh acquire (taken), and carries the history', () => {
    const free = buildRoundResumePrompt({ pr: 77, round: 2, lane: freeLane, headRefOid: HEAD, history: '# All rounds so far' });
    expect(free).toContain('--lane=4 --no-reset');
    expect(free).toContain('# All rounds so far');
    const taken = buildRoundResumePrompt({ pr: 77, round: 2, lane: { ...freeLane, held: 'taken', head: OTHER }, headRefOid: HEAD });
    expect(taken).not.toContain('--no-reset');
    expect(taken).toContain('acquire a fresh lane exactly as step 1');
  });
});

describe('tryResumeRoundFix', () => {
  const base = {
    root: '/repo', fixSettings: SETTINGS, wrapFix: false, loadLadder: () => LADDER, listAgentsAll: () => [],
    postNotice: () => false, readHistoryInputs: () => null,
  };
  it('chosen: resumes the recorded session with the round prompt, no cold start', () => {
    const resume = vi.fn(() => ({ resumed: true, result: { sessionId: SID, pr: 77, lane: null, resumed: true } }));
    const r = tryResumeRoundFix(planned(), { ...base, readInputs: () => ({ prior, job, transcript: true, lane: freeLane, base: { rebased: false } }), resume });
    expect(r.resumed).toBe(true);
    expect(r.result).toMatchObject({ sessionId: SID, lane: 4, round: 2, roundResume: true });
    expect(resume).toHaveBeenCalledTimes(1);
    const [, opts] = resume.mock.calls[0];
    expect(opts.candidate).toBe(SID);
    expect(opts.prompt).toContain('New review round — PR #77');
    expect(opts.sessionCwdFor()).toBe('/scratch/x');
  });
  it('declined: a round-3 fix that escalates the model cold-starts instead of resuming a Sonnet session', () => {
    const resume = vi.fn();
    const r = tryResumeRoundFix(planned({ attempts: 2 }), { ...base, readInputs: () => ({ prior, job, transcript: true, lane: freeLane, base: { rebased: false } }), resume });
    expect(r.resumed).toBe(false);
    expect(r.resumeAttempt).toMatchObject({ attempted: false, refused: 'model-escalated', round: 3 });
    expect(resume).not.toHaveBeenCalled();
  });
  it('declined: the wrapped launch and round 1 never even read the inputs', () => {
    const readInputs = vi.fn();
    expect(tryResumeRoundFix(planned(), { ...base, wrapFix: true, readInputs }).resumeAttempt.refused).toBe('wrapped-launch');
    expect(tryResumeRoundFix(planned({ attempts: 0 }), { ...base, readInputs }).resumeAttempt.refused).toBe('first-round');
    expect(readInputs).not.toHaveBeenCalled();
  });
  it('dry run: decides, never posts or resumes', () => {
    const resume = vi.fn(); const postNotice = vi.fn();
    const r = tryResumeRoundFix(planned(), { ...base, dryRun: true, postNotice, resume, readInputs: () => ({ prior, job, transcript: true, lane: freeLane, base: { rebased: false } }) });
    expect(r.decision).toMatchObject({ resume: true, sessionId: SID });
    expect(resume).not.toHaveBeenCalled();
    expect(postNotice).not.toHaveBeenCalled();
  });
});

describe('runReconcileFixDispatch — the round resume runs before the lane pop', () => {
  const FRESH = () => ({ fresh: true, behind: 0 });
  const item = { num: '3438', slug: 'x', specPath: 'backlog/3438-x.md', scope: ['we:scripts/a.mjs'] };
  const run = (tryResumeRound, attempts = 1) => {
    const dispatchCalls = [];
    const result = runReconcileFixDispatch({
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 1764, headRefName: 'lane/3438-x', headRefOid: HEAD, baseRefName: 'main', attempts }], refusals: [], notes: [], prs: 1, agents: 0 }),
      findItemFn: (k) => (k === '3438' ? item : null), loadItems: () => [],
      pickFreeLanes: () => [2], checkStaleness: FRESH, fetchItemlessDiffPaths: () => [],
      listBuildClaims: () => [], listFixClaims: () => [],
      tryResumeRound,
      dispatch: (p, o) => { dispatchCalls.push({ p, o }); return { sessionId: 's', pr: p.pr, lane: p.lane, resumed: false }; },
    });
    return { result, dispatchCalls };
  };
  it('a resumed round uses no lane and no fresh dispatch', () => {
    const tryResumeRound = vi.fn(() => ({ resumed: true, result: { sessionId: SID, pr: 1764, lane: 4, resumed: true, roundResume: true } }));
    const { result, dispatchCalls } = run(tryResumeRound);
    expect(tryResumeRound).toHaveBeenCalledWith(expect.objectContaining({ pr: 1764, attempts: 1, baseRefName: 'main' }), expect.anything());
    expect(dispatchCalls).toEqual([]);
    expect(result.dispatched).toEqual([{ sessionId: SID, pr: 1764, lane: 4, resumed: true, roundResume: true }]);
  });
  it('a declined resume cold-starts on a free lane and carries the reason', () => {
    const tryResumeRound = () => ({ resumed: false, resumeAttempt: { attempted: false, refused: 'pr-moved', round: 2 } });
    const { dispatchCalls } = run(tryResumeRound);
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].p.lane).toBe(2);
    expect(dispatchCalls[0].o.resumeAttempt).toMatchObject({ refused: 'pr-moved' });
  });
  it('round 1 never asks for a resume; a throwing resume only means a cold start', () => {
    const never = vi.fn();
    expect(run(never, 0).dispatchCalls).toHaveLength(1);
    expect(never).not.toHaveBeenCalled();
    const { dispatchCalls, result } = run(() => { throw new Error('listing failed'); });
    expect(dispatchCalls).toHaveLength(1);
    expect(result.refusals).toEqual([]);
  });
});
