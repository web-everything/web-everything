/**
 * Card xrbu1bp — round N>1 resumes the previous round's fixer session (chosen / declined), and the fixer ladder's
 * stronger-model rung starts at `fix.strongerModelFromRound` (rung by round).
 */
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  baseRebasedUnder, buildRoundResumePrompt, findSessionLane, isScratchSessionDir, jobModel, JOURNAL_TAIL_BYTES, laneFromJournal,
  latestSessionRow, planRoundEscalation, planRoundResume, prFirstParent, readJournalTail, readRoundResumeInputs, roundOf,
} from '../fix-resume.mjs';
import { resolveFixSettings } from '../fix-takeover.mjs';
import {
  dispatchFix, formatReplay, launchTableFor, replayFixLaunch, roundEscalationFor, runReconcileFixDispatch, tryResumeRoundFix,
} from '../reconcile-fix-dispatch.mjs';
import { dispatchScratchRoot } from '../../operations/dispatch-lane-io.mjs';
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
const resumable = (o = {}) => ({ planned: planned(), settings: SETTINGS, prior, job, transcript: true, lane: freeLane, base: { rebased: false }, scratchRoot: '/scratch', ...o });

describe('fix settings cascade — card xrbu1bp keys', () => {
  const noFile = () => { throw new Error('no file'); };
  it('built-in: resume on, stronger model from round 3', () => {
    expect(resolveFixSettings({ env: {}, read: noFile })).toMatchObject({ resumeAcrossRounds: 'on', strongerModelFromRound: 3 });
  });
  it('settings file, then env, win in that order; a bad value falls through', () => {
    const read = () => JSON.stringify({ fix: { resumeAcrossRounds: 'off', strongerModelFromRound: 4 } });
    expect(resolveFixSettings({ env: {}, read })).toMatchObject({ resumeAcrossRounds: 'off', strongerModelFromRound: 4 });
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
    ['prior-cwd-not-scratch', { prior: { ...prior, cwd: '/lanes/we/lane-4' } }],
    ['prior-cwd-not-scratch', { scratchRoot: null }],
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
  it('readJournalTail reads at most JOURNAL_TAIL_BYTES from the file tail and drops the torn first line', () => {
    const tailBytes = 64;
    const tail = `n":1}\n${JSON.stringify({ action: 'acquire', lane: 3 })}\n${JSON.stringify({ action: 'release', lane: 3 })}\n`;
    const size = 2 * tailBytes + 17;
    const calls = [];
    const readAt = (fd, buf, off, len, pos) => { calls.push({ len, pos }); buf.write(tail.padStart(len, 'x').slice(-len), off); return len; };
    const io = { open: () => 9, fstat: () => ({ size }), readAt, close: () => {} };
    const events = readJournalTail('/pool/.lane-journal.jsonl', { tailBytes, ...io });
    expect(calls).toEqual([{ len: tailBytes, pos: size - tailBytes }]);
    expect(events).toEqual([{ action: 'acquire', lane: 3 }, { action: 'release', lane: 3 }]);
    // a file within the bound is read whole from 0, and its first line is kept
    const small = `${JSON.stringify({ action: 'acquire', lane: 1 })}\n`;
    const smallCalls = [];
    const smallIo = { ...io, fstat: () => ({ size: small.length }), readAt: (fd, buf, off, len, pos) => { smallCalls.push({ len, pos }); buf.write(small, off); return len; } };
    expect(readJournalTail('/f', { tailBytes, ...smallIo })).toEqual([{ action: 'acquire', lane: 1 }]);
    expect(smallCalls).toEqual([{ len: small.length, pos: 0 }]);
    expect(JOURNAL_TAIL_BYTES).toBe(4 * 1024 * 1024);
  });
  // `gh pr view --json commits` (captured live, PR #4757): its commits carry no `parents` at all.
  const PR_VIEW_COMMITS = JSON.stringify({ commits: [{
    authoredDate: '2026-10-10T12:39:12Z', authors: [{ login: 'x' }], committedDate: '2026-10-10T12:39:12Z',
    messageBody: '', messageHeadline: 'conveyor fix: resume', oid: 'a99c637a41a14b9137da9c1d6856e4ec425d75b8',
  }] });
  // `gh api repos/{o}/{r}/pulls/{n}/commits?per_page=1` (captured live, PR #4757, trimmed): oldest commit first, with parents.
  const PULL_COMMITS = JSON.stringify([{
    sha: 'a99c637a41a14b9137da9c1d6856e4ec425d75b8',
    commit: { committer: { name: 'test', date: '2026-10-10T12:39:12Z' } },
    parents: [{ sha: '1be5affcd252f21798e3242eeb64b1d7e02e7016', url: 'https://api.github.com/repos/web-everything/web-everything/commits/1be5affcd252f21798e3242eeb64b1d7e02e7016' }],
  }]);
  /** An `exec` that answers like gh does for each read shape, and records what was asked. */
  const ghExec = (calls = [], { compare = 'ahead' } = {}) => (cmd, args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return args.includes('--jq') ? '\n' : PR_VIEW_COMMITS; // no parents field to read
    if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/commits/.test(args[1])) return PULL_COMMITS;
    if (args[0] === 'api' && /\/compare\//.test(args[1])) return `${compare}\n`;
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  it('prFirstParent reads the first commit\'s parent from the pull-commits list (the pr-view payload has none)', () => {
    const calls = [];
    expect(prFirstParent({ pr: 4757, repoSlug: 'web-everything/web-everything', exec: ghExec(calls) })).toBe('1be5affcd252f21798e3242eeb64b1d7e02e7016');
    expect(calls).toEqual([['api', 'repos/web-everything/web-everything/pulls/4757/commits?per_page=1']]);
    expect(prFirstParent({ pr: 4757, repoSlug: 'o/r', exec: () => '[]' })).toBeNull();
    expect(prFirstParent({ pr: 4757, repoSlug: 'o/r', exec: () => 'not json' })).toBeNull();
    expect(prFirstParent({ pr: 4757, repoSlug: 'o/r', exec: () => { throw new Error('502'); } })).toBeNull();
    expect(prFirstParent({ pr: '1/../2', repoSlug: 'o/r', exec: ghExec() })).toBeNull();
  });
  it('readRoundResumeInputs: a stacked PR whose base only moved forward reads as not rebased (end to end over gh)', () => {
    const calls = [];
    const inputs = readRoundResumeInputs({
      planned: planned({ pr: 4757, baseRefName: 'lane/fixer-history-takeover' }), slug: 'fix-77', root: '/repo', repoSlug: 'web-everything/web-everything',
      listAgentsAll: () => [prior], readJob: () => job, home: '/home', poolRoot: '/nowhere', git: () => HEAD, exec: ghExec(calls),
    });
    expect(inputs.base).toEqual({ rebased: false });
    expect(calls.map((a) => a[1])).toEqual([
      'repos/web-everything/web-everything/pulls/4757/commits?per_page=1',
      'repos/web-everything/web-everything/compare/1be5affcd252f21798e3242eeb64b1d7e02e7016...lane%2Ffixer-history-takeover',
    ]);
    const diverged = readRoundResumeInputs({
      planned: planned({ pr: 4757, baseRefName: 'lane/b' }), slug: 'fix-77', root: '/repo', repoSlug: 'o/r',
      listAgentsAll: () => [prior], readJob: () => job, home: '/home', poolRoot: '/nowhere', git: () => HEAD, exec: ghExec([], { compare: 'diverged' }),
    });
    expect(diverged.base).toEqual({ rebased: true });
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

describe('the resume trigger starts only in a dispatch scratch directory (#4174)', () => {
  it('isScratchSessionDir: a direct child of the scratch root, nothing else', () => {
    expect(isScratchSessionDir('/ws/.operations/dispatch/83fd9579-1e17-4ec2', '/ws/.operations/dispatch')).toBe(true);
    expect(isScratchSessionDir('/ws/.operations/dispatch/x/', '/ws/.operations/dispatch/')).toBe(true);
    for (const cwd of [
      '/ws/.lanes/web-everything/lane-8', // the lane the fixer cd'd into
      '/ws/.operations/dispatch', // the root itself
      '/ws/.operations/dispatch/a/b', // deeper than one segment
      '/ws/.operations/dispatch/../../.lanes/we/lane-8', // `..` out of the root
      '/ws/.operations/dispatch-x/a', // a prefix sibling
      'dispatch/a', '', null, undefined, 42, // relative or not a path
      '/ws/.operations/dispatch/.hidden', '/ws/.operations/dispatch/a\nb',
    ]) expect(isScratchSessionDir(cwd, '/ws/.operations/dispatch')).toBe(false);
    expect(isScratchSessionDir('/ws/.operations/dispatch/a', null)).toBe(false);
    expect(isScratchSessionDir('/ws/.operations/dispatch/a', 'relative/root')).toBe(false);
  });
  it('a symlink in the scratch root that resolves into a lane is refused (realpath is compared)', () => {
    const realpath = (p) => (p === '/ws/.operations/dispatch/evil' ? '/ws/.lanes/we/lane-8' : p);
    expect(isScratchSessionDir('/ws/.operations/dispatch/evil', '/ws/.operations/dispatch', realpath)).toBe(false);
    const throwing = () => { throw new Error('ENOENT'); };
    expect(isScratchSessionDir('/ws/.operations/dispatch/gone', '/ws/.operations/dispatch', throwing)).toBe(true);
  });
});

describe('tryResumeRoundFix', () => {
  const base = {
    root: '/repo', fixSettings: SETTINGS, wrapFix: false, loadLadder: () => LADDER, listAgentsAll: () => [],
    postNotice: () => false, readHistoryInputs: () => null, scratchRoot: '/scratch', realpath: (p) => p,
    isolateSession: () => ({ write: { ok: true }, hooks: { ok: true, count: 8 } }),
  };
  const inputsOk = () => ({ prior, job, transcript: true, lane: freeLane, base: { rebased: false } });
  it('the guard hooks are re-written in the earlier session\'s cwd BEFORE the resume trigger spawns', () => {
    const order = [];
    const isolateSession = vi.fn((cwd) => { order.push(`isolate ${cwd}`); return { write: { ok: true }, hooks: { ok: true, count: 8 } }; });
    const resume = vi.fn(() => { order.push('resume'); return { resumed: true, result: { sessionId: SID } }; });
    tryResumeRoundFix(planned(), { ...base, readInputs: inputsOk, isolateSession, resume });
    expect(order).toEqual(['isolate /scratch/x', 'resume']);
  });
  it.each([
    ['the hooks write failed', () => ({ write: { ok: true }, hooks: { ok: false, reason: 'write-failed' } })],
    ['the worktree write failed', () => ({ write: { ok: false, reason: 'write-failed' }, hooks: { ok: true } })],
    ['the isolation threw', () => { throw new Error('EACCES'); }],
    ['no result', () => undefined],
  ])('%s: no resume (cold start writes fresh hooks), nothing posted', (_, isolateSession) => {
    const resume = vi.fn(); const postNotice = vi.fn();
    const r = tryResumeRoundFix(planned(), { ...base, readInputs: inputsOk, isolateSession, resume, postNotice });
    expect(r.resumeAttempt).toMatchObject({ attempted: false, refused: 'guard-hooks-unwritten' });
    expect(resume).not.toHaveBeenCalled();
    expect(postNotice).not.toHaveBeenCalled();
  });
  it('a dry run never writes the hooks', () => {
    const isolateSession = vi.fn();
    tryResumeRoundFix(planned(), { ...base, dryRun: true, readInputs: inputsOk, isolateSession, resume: vi.fn() });
    expect(isolateSession).not.toHaveBeenCalled();
  });
  it('a prior session whose listing cwd is a lane checkout is never resumed there (cold start, no trigger spawned)', () => {
    const resume = vi.fn();
    const inLane = { ...prior, cwd: '/lanes/we/lane-4' };
    const r = tryResumeRoundFix(planned(), { ...base, readInputs: () => ({ prior: inLane, job, transcript: true, lane: freeLane, base: { rebased: false } }), resume });
    expect(r.resumed).toBe(false);
    expect(r.resumeAttempt).toMatchObject({ attempted: false, refused: 'prior-cwd-not-scratch' });
    expect(resume).not.toHaveBeenCalled();
  });
  it('the default scratch root is the dispatcher\'s own, and resumeOptions cannot move the trigger cwd', () => {
    const resume = vi.fn(() => ({ resumed: true, result: { sessionId: SID } }));
    const root = '/ws/webeverything';
    const scratch = dispatchScratchRoot({ root });
    const inScratch = { ...prior, cwd: join(scratch, 'abc-123') };
    const { scratchRoot: _omit, ...noRoot } = base;
    tryResumeRoundFix(planned(), {
      ...noRoot, root, readInputs: () => ({ prior: inScratch, job, transcript: true, lane: freeLane, base: { rebased: false } }), resume,
      resumeOptions: { sessionCwdFor: () => '/lanes/we/lane-4' },
    });
    const [, opts] = resume.mock.calls[0];
    expect(opts.sessionCwdFor()).toBe(join(scratch, 'abc-123'));
    expect(isScratchSessionDir(opts.sessionCwdFor(), scratch)).toBe(true);
  });
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

describe('replayFixLaunch / formatReplay — the read-only replay of the next fix launch', () => {
  const view = (o = {}) => JSON.stringify({ number: 4757, headRefName: 'lane/fixer-resume-ladder', headRefOid: HEAD, baseRefName: 'lane/b', labels: [{ name: 'review:changes' }], state: 'OPEN', ...o });
  const exec = (o) => (cmd, args) => {
    expect(args.slice(0, 2)).toEqual(['pr', 'view']);
    return view(o);
  };
  it('a given round: stronger-model route from round 3, and a resume decision passed through dry-run', () => {
    const resumeRound = vi.fn(() => ({ resumed: false, dryRun: true, decision: { resume: true, sessionId: SID, lane: { lane: 4, path: '/lanes/we/lane-4', held: 'free' } } }));
    const readComments = vi.fn();
    const r = replayFixLaunch({ pr: 4757, round: 6, exec: exec(), readComments, fixSettings: SETTINGS, resumeRound, loadLadder: () => LADDER });
    expect(readComments).not.toHaveBeenCalled();
    expect(resumeRound).toHaveBeenCalledWith(expect.objectContaining({ pr: 4757, attempts: 5, baseRefName: 'lane/b', headRefOid: HEAD }), expect.objectContaining({ dryRun: true }));
    expect(r).toMatchObject({ pr: 4757, round: 6, attempts: 5, roundOverride: true, route: { rung: 'stronger-model', cliModel: 'opus', fromRound: 3 } });
    expect(r.launch).toEqual({ mode: 'resume', sessionId: SID, lane: 4, lanePath: '/lanes/we/lane-4', held: 'free' });
    const text = formatReplay(r);
    expect(text).toContain('next fix would be round 6 (round given)');
    expect(text).toContain('stronger-model route — claude-opus-5 (--model opus), from round 3');
    expect(text).toContain(`resume ${SID} — no cold start; checkout: re-take its untouched lane-4 (--no-reset)`);
    expect(text).toContain('dry run: nothing claimed, posted, spawned or resumed');
  });
  it('no round given: counted from the thread; a declined resume replays as a cold start with its reason', () => {
    const resumeRound = () => ({ resumed: false, decision: { resume: false, reason: 'base-unknown', why: 'gh down' } });
    const r = replayFixLaunch({ pr: 4757, exec: exec({ labels: [] }), readComments: () => [], fixSettings: SETTINGS, resumeRound, loadLadder: () => LADDER });
    expect(r).toMatchObject({ round: 1, attempts: 0, roundOverride: false, route: { rung: 'ordinary', why: 'round 1 < fix.strongerModelFromRound=3' } });
    expect(r.launch).toEqual({ mode: 'cold-start', reason: 'base-unknown', why: 'gh down' });
    expect(formatReplay(r)).toContain('cold start with the round-history brief — base-unknown: gh down');
    expect(formatReplay(r)).toContain('(0 round(s) spent)');
  });
  it('a conflict round stays on the ordinary route; a taken lane replays as a fresh acquire', () => {
    const resumeRound = () => ({ resumed: false, decision: { resume: true, sessionId: SID, lane: { lane: 5, held: 'taken' } } });
    const r = replayFixLaunch({ pr: 4757, round: 4, exec: exec({ labels: [{ name: 'merge-status:conflicting' }] }), readComments: () => [], fixSettings: SETTINGS, resumeRound, loadLadder: () => LADDER });
    expect(r.route).toMatchObject({ rung: 'ordinary', why: 'a conflict round stays on the ordinary route' });
    expect(formatReplay(r)).toContain('its lane-5 was reused since, so a fresh lane at the PR ref');
  });
});
