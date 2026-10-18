import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { claimReviewDispatch, decideSameHeadHold, enrichPrsWithReferralHolds } from '../review-referral-hold.mjs';
import { defaultReadNotesForRepo } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
import { runReviewTick } from '../../../skills-src/conveyor/review-daemon.mjs';
import { dispatchReviewByMode, runReviewJob } from '../../operations/review-job.mjs';
import { runRedTeam } from '../../operations/review-extra-seats.mjs';
import { redTeamMarker } from '../../lib/red-team-gate.mjs';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { repoKeyForSlug } from '../../lib/constellation-repos.mjs';
import { planReconcile } from '../reconcile-core.mjs';

// x9jlvy0: replay the saved-result/missing-comment boundary from PR #5461.
const repo = 'web-everything/web-everything';
const head = '3373a3326ef2b649303f7b26b69efabfdfe179a6';
const number = 5461;
const pr = (over = {}) => ({ number, headRefOid: head, comments: [], labels: ['review:accepted'], ...over });
const row = (over = {}) => ({ repo, pr: number, rev: head, dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', ...over });
const run = (over = {}) => ({ repo, pr: number, head, startedAt: 1, completedAt: 2,
  parked: false, persistenceFailed: false, rulings: [], ...over });
let dir, opts;
const save = records => writeFileSync(opts.redTeam.storePath, JSON.stringify({ version: 1, records }));
const settings = value => writeFileSync(opts.redTeam.settingsPath, JSON.stringify({ redTeam: value }));
const decide = (p = pr(), runs = [run()], extra = {}) => decideSameHeadHold(p, runs, { ...opts, ...extra });
const claim = (extra = {}) => claimReviewDispatch(pr(), { ...opts, ...extra });
const reservationPath = () => join(opts.redTeam.stateDir,
  createHash('sha256').update(JSON.stringify([repo, number, head])).digest('hex'));
const dispatch = (extra = {}) => dispatchReviewByMode({
  mode: 'job', repo, pr: number, root: '/daemon', dir: join(dir, 'jobs'),
  env: {}, checkoutExists: () => true, checkStaleness: () => ({ fresh: true, behind: 0 }),
  stackCheck: () => ({ base: null }), readCompletion: () => null,
  resolveSettingsEnv: () => ({}), ciGate: () => ({ allowed: true, headSha: head }),
  beforeSpawn: () => claim(), spawnJob: () => 4242, ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'redteam-owed-'));
  const platform = join(dir, 'platform.json');
  writeFileSync(platform, '{}');
  opts = { repo, env: { WE_PLATFORM_PREFERENCES_FILE: platform, WE_POLICY_CASCADE_LOG: '1' },
    redTeam: { storePath: join(dir, 'scorecards.json'), stateDir: join(dir, 'lifts'),
      settingsPath: join(dir, 'settings.json'), log: vi.fn() } };
  resetCascadeLogForTest();
  settings({});
  save([row()]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('same-head hold when the post-accept red-team comment is owed', () => {
  it('does not spend the release during non-review reconcile planning or ledger decisions', () => {
    const enrich = () => enrichPrsWithReferralHolds([pr()], { ...opts, readRuns: () => [run()] })[0];
    expect(enrich().referralHold).toBeNull();
    expect(enrich().referralHold).toBeNull();
    expect(decide()).toBeNull();
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it('does not spend the release through the fix daemon defaultReadNotesForRepo path', () => {
    const reconcile = ({ readPrs }) => {
      const [p] = enrichPrsWithReferralHolds(readPrs(), { ...opts, readRuns: () => [run()] });
      expect(p.referralHold).toBeNull();
      return { notes: [] };
    };
    for (let tick = 0; tick < 2; tick++) defaultReadNotesForRepo({ repo, reconcile, readPrs: () => [pr()] });
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
    expect(claim()).toBe(true);
  });
  it('keeps ledger sameHeadToday decisions without a redTeam option read-only and fail-closed', () => {
    expect(decideSameHeadHold(pr(), [run()], { repo, env: opts.env })).toMatchObject({ kind: 'same-head' });
    expect(decideSameHeadHold(pr({ comments: undefined }), [run()], { repo, env: opts.env }))
      .toMatchObject({ kind: 'same-head' });
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it('carries the owed-comment exception through the real reconcile planner', () => {
    const [p] = enrichPrsWithReferralHolds([pr({ labels: [{ name: 'review:pending' }],
      headRefName: 'lane/redteam-comment-retry', state: 'OPEN', isDraft: false,
      mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    })], { ...opts, now: 3, readRuns: () => [run()] });
    expect(p.owedRedTeamReview).toEqual({ repo, pr: number, head });
    // Match reconcile-pass: evidence uses the GitHub slug; the pure planner uses the internal key.
    const plan = planReconcile({ repo: repoKeyForSlug(repo), prs: [p], agents: [], requiredChecks: ['test'], now: 3 });
    expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', prNumber: number,
      owedRedTeamReview: p.owedRedTeamReview }));
  });
  it('releases on the first decision in a real Node process without asynchronous reader warmup', () => {
    const source = `
      import { claimReviewDispatch, decideSameHeadHold } from './scripts/conveyor/review-referral-hold.mjs';
      const pr = ${JSON.stringify(pr())}, runs = ${JSON.stringify([run()])}, opts = ${JSON.stringify(opts)};
      delete opts.redTeam.log;
      opts.redTeam.log = () => {};
      const first = decideSameHeadHold(pr, runs, opts);
      const second = decideSameHeadHold(pr, runs, opts);
      const claimed = claimReviewDispatch(pr, { ...opts, readRuns: () => runs });
      console.log(JSON.stringify([first, second, claimed, decideSameHeadHold(pr, runs, opts)?.kind]));
    `;
    expect(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source],
      { encoding: 'utf8', timeout: 30_000 }))).toEqual([null, null, true, 'same-head']);
  });
  it('lifts an owed head using the saved scorecard row', () => {
    expect(decide()).toBeNull();
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=true (standard)'));
  });
  it('keeps the hold when a trusted comment is already present', () => {
    expect(decide(pr({ comments: [{ body: redTeamMarker(number, head), author: { login: 'chalbert' } }] })))
      .toMatchObject({ kind: 'same-head' });
  });
  it('keeps the hold on a different reviewed head', () => {
    const other = 'b'.repeat(40);
    expect(decide(pr({ headRefOid: other }), [run({ head: other })])).toMatchObject({ kind: 'same-head' });
  });
  it.each([
    ['no evidence', []], ['different repo', [row({ repo: 'other/repo' })]],
    ['different PR', [row({ pr: number + 1 })]], ['failed probe', [row({ status: 'error' })]],
    ['miss row only', [row({ dispatchKind: 'red-team-miss' })]],
  ])('keeps the hold with %s', (_, records) => {
    save(records);
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('lifts once, then holds again with the same durable state after a restart', () => {
    expect(decide()).toBeNull();
    expect(claim()).toBe(true);
    const [reservation] = readdirSync(opts.redTeam.stateDir);
    expect(JSON.parse(readFileSync(join(opts.redTeam.stateDir, reservation, 'receipt.json'), 'utf8')))
      .toMatchObject({ repo, pr: number, head });
    const restarted = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { decideSameHeadHold } from './scripts/conveyor/review-referral-hold.mjs';
      console.log(JSON.stringify(decideSameHeadHold(${JSON.stringify(pr())}, ${JSON.stringify([run()])}, ${JSON.stringify(opts)})));
    `], { encoding: 'utf8', timeout: 30_000 });
    expect(JSON.parse(restarted)).toMatchObject({ kind: 'same-head' });
    // A second head has its own allowance; the first remains spent.
    const other = 'c'.repeat(40);
    save([row(), row({ rev: other })]);
    expect(decide(pr({ headRefOid: other }), [run({ head: other })])).toBeNull();
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('keeps the hold when the tool setting is off and logs its source', () => {
    settings({ reArmOnMissingComment: false });
    expect(decide()).toMatchObject({ kind: 'same-head' });
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=false (tool)'));
  });
  it('honors the platform setting and the environment override', () => {
    writeFileSync(opts.env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ redTeam: { reArmOnMissingComment: false } }));
    expect(decide()).toMatchObject({ kind: 'same-head' });
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=false (platform)'));
    opts.env.WE_RED_TEAM_REARM_ON_MISSING_COMMENT = 'on';
    expect(decide()).toBeNull();
    expect(opts.redTeam.log).toHaveBeenCalledWith(expect.stringContaining('reArmOnMissingComment=true (env)'));
  });
  it.each(['store', 'settings', 'platform', 'state'])('keeps the hold on a %s read error', kind => {
    if (kind === 'state') writeFileSync(opts.redTeam.stateDir, 'not a directory');
    else writeFileSync(kind === 'store' ? opts.redTeam.storePath : kind === 'settings'
      ? opts.redTeam.settingsPath : opts.env.WE_PLATFORM_PREFERENCES_FILE, '{unreadable JSON');
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it.each(['store', 'settings', 'platform'])('keeps the hold when the %s file cannot be read', kind => {
    // Reading a directory as UTF-8 raises EISDIR on the host; this exercises actual IO failure, not just parsing.
    if (kind === 'store') opts.redTeam.storePath = dir;
    else if (kind === 'settings') opts.redTeam.settingsPath = dir;
    else opts.env.WE_PLATFORM_PREFERENCES_FILE = dir;
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('does not count an untrusted marker or a marker for another head as posted', () => {
    expect(decide(pr({ comments: [
      { body: redTeamMarker(number, head), author: { login: 'stranger' } },
      { body: redTeamMarker(number, 'b'.repeat(40)), author: { login: 'chalbert' } },
    ] }))).toBeNull();
  });
  it('keeps the hold when the comment snapshot is unavailable', () => {
    expect(decide(pr({ comments: undefined }))).toMatchObject({ kind: 'same-head' });
  });
  it('releases through the production enricher until dispatch claims the allowance', () => {
    const enrich = () => enrichPrsWithReferralHolds([pr()], { ...opts, readRuns: () => [run()] })[0];
    expect(enrich().referralHold).toBeNull();
    expect(enrich().referralHold).toBeNull();
    expect(claim()).toBe(true);
    expect(enrich().referralHold).toMatchObject({ kind: 'same-head' });
  });
  it('keeps the hold when a prior reservation exists with no receipt', () => {
    mkdirSync(reservationPath(), { recursive: true });
    expect(decide()).toMatchObject({ kind: 'same-head' });
    expect(claim()).toBe(false);
    expect(decide()).toMatchObject({ kind: 'same-head' });
    const restarted = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { decideSameHeadHold } from './scripts/conveyor/review-referral-hold.mjs';
      console.log(decideSameHeadHold(${JSON.stringify(pr())}, ${JSON.stringify([run()])}, ${JSON.stringify(opts)}).kind);
    `], { encoding: 'utf8', timeout: 30_000 });
    expect(restarted.trim()).toBe('same-head');
  });
  it.each(['writeReceipt', 'renameReceipt'])('keeps the hold after %s fails inside the reservation', effect => {
    const fail = () => { throw new Error('injected receipt failure'); };
    expect(claim({ redTeam: { ...opts.redTeam, [effect]: fail } })).toBe(false);
    expect(existsSync(reservationPath())).toBe(true);
    expect(existsSync(join(reservationPath(), 'receipt.json'))).toBe(false);
    expect(claim()).toBe(false);
    expect(decide()).toMatchObject({ kind: 'same-head' });
  });
  it('writes a temporary receipt before atomically renaming it at dispatch', () => {
    const writes = [];
    const writeReceipt = (file, body) => {
      expect(existsSync(join(reservationPath(), 'receipt.json'))).toBe(false);
      writes.push(file);
      writeFileSync(file, body);
    };
    const renameReceipt = (from, to) => {
      expect(writes).toEqual([from]);
      expect(from).toMatch(/receipt\.json\.\d+\.tmp$/);
      expect(to).toBe(join(reservationPath(), 'receipt.json'));
      // Keep the production rename, including its atomic replacement semantics.
      renameSync(from, to);
    };
    expect(claim({ redTeam: { ...opts.redTeam, writeReceipt, renameReceipt } })).toBe(true);
  });
  it.each(['ci', 'stack', 'cooloff', 'live-job'])('does not spend the release when dispatch is skipped by %s', gate => {
    if (gate === 'live-job') {
      dispatch({ beforeSpawn: () => true }); // Seed only a live-job record, never a rearm receipt.
    }
    const spawnJob = vi.fn(() => 4243);
    const extras = gate === 'ci' ? { ciGate: () => ({ allowed: false, reason: 'unreadable-ci' }) }
      : gate === 'stack' ? { stackCheck: () => ({ skipped: 'stack-held' }) }
      : gate === 'cooloff' ? { readCompletion: () => ({ status: 'done', outcome: 'blocked-on-infra',
        label: 'lane-deferrals:5', updatedAt: new Date().toISOString() }) }
      : { isAlive: () => true };
    expect(dispatch({ ...extras, spawnJob }).skipped).toBeTruthy();
    expect(spawnJob).not.toHaveBeenCalled();
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it('allows only one competing dispatch and keeps a failed spawn spent', () => {
    const spawnJob = vi.fn(() => { throw new Error('spawn failed'); });
    expect(() => dispatch({ spawnJob })).toThrow('spawn failed');
    expect(dispatch({ spawnJob }).skipped).toBe('same-head-hold');
    expect(spawnJob).toHaveBeenCalledTimes(1);
  });
  it('grants exactly one release to concurrent dispatcher processes', async () => {
    const source = `
      import { claimReviewDispatch } from './scripts/conveyor/review-referral-hold.mjs';
      const opts = ${JSON.stringify(opts)};
      opts.redTeam.log = () => {};
      console.log(JSON.stringify(claimReviewDispatch(${JSON.stringify(pr())}, {
        ...opts, readRuns: () => ${JSON.stringify([run()])},
      })));
    `;
    const results = await Promise.all(Array.from({ length: 2 }, () => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 30_000 })));
    expect(results.map(r => JSON.parse(r.stdout)).sort()).toEqual([false, true]);
  });
  it.each([false, true])('claims immediately before the session spawn (wrapped=%s)', wrapReview => {
    const spawn = vi.fn(() => {
      expect(existsSync(join(reservationPath(), 'receipt.json'))).toBe(true);
      return wrapReview ? { handle: 'worker' } : 'backgrounded · worker · review';
    });
    const extras = { mode: 'session', wrapReview, spawnAgent: spawn, launchWrapped: spawn,
      readBrief: () => 'Review {{PR}}', mintSessionId: () => 'owed-test',
      ensureSessionCwd: p => p, sessionCwdFor: () => join(dir, 'session'),
      isolateSession: () => ({ worktreeSettings: {} }) };
    expect(dispatch(extras).skipped).toBeUndefined();
    expect(dispatch(extras).skipped).toBe('same-head-hold');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('wires the daemon claim after lane deferral and pins it to the CI head', () => {
    const claimReview = vi.fn(p => claimReviewDispatch(p, { ...opts, readRuns: () => [run()] }));
    const tick = (lanes, ciHead = head) => runReviewTick({ repo,
      readPrs: () => [pr()], readAgents: () => [], holdReconcile: () => [],
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: number,
        owedRedTeamReview: { repo, pr: number, head } }], refusals: [] }),
      tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      acquirableLanes: () => lanes, claimReview,
      dispatch: o => dispatch({ ...o, ciGate: () => ({ allowed: true, headSha: ciHead }) }),
    });
    expect(tick(0).dispatched).toEqual([]);
    expect(tick(1, 'b'.repeat(40)).dispatched).toEqual([]);
    expect(claimReview).not.toHaveBeenCalled();
    expect(tick(1).dispatched).toHaveLength(1);
    expect(claimReview).toHaveBeenCalledTimes(1);
    expect(existsSync(join(reservationPath(), 'receipt.json'))).toBe(true);
  });
  it('preserves ledger-authorized releases that do not request an owed-comment exception', () => {
    const claimReview = vi.fn(() => { throw new Error('must not override the ledger'); });
    const out = runReviewTick({ repo, readPrs: () => [pr()], readAgents: () => [], holdReconcile: () => [],
      // A configured ledger source already authorized this review. There is no owed-comment token.
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: number }], refusals: [] }),
      claimReview, acquirableLanes: () => 1, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      dispatch: o => dispatch({ ...o, beforeSpawn: o.beforeSpawn ?? (() => true) }),
    });
    expect(out.dispatched).toHaveLength(1);
    expect(claimReview).not.toHaveBeenCalled();
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it('claims a standalone daemon tick by fetching comments when shared readers are absent', () => {
    const readComments = vi.fn(() => []);
    const out = runReviewTick({ repo, holdReconcile: () => [],
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: number,
        owedRedTeamReview: { repo, pr: number, head } }], refusals: [] }),
      claimReview: p => claimReviewDispatch(p, { ...opts, readComments }),
      acquirableLanes: () => 1, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      dispatch: o => dispatch(o),
    });
    expect(out.dispatched).toHaveLength(1);
    expect(readComments).toHaveBeenCalledWith({ repo, number });
  });
  it('keeps the hold when dispatch cannot expand the capped comment thread', () => {
    expect(claimReviewDispatch(pr({ comments: Array.from({ length: 100 }, () => ({ body: 'old' })) }), {
      ...opts, readComments: () => { throw new Error('thread read failed'); },
    })).toBe(false);
    expect(existsSync(opts.redTeam.stateDir)).toBe(false);
  });
  it('reposts saved red-team evidence after hold release without invoking the model', async () => {
    expect(decide()).toBeNull();
    let replayInput;
    const loopPayload = { verdict: { verdict: 'accept', loop: { outcome: 'converged' } },
      runId: 'saved-review', stopped: 'complete', findings: { read: {
        title: 'saved red-team pass', diffText: 'diff --git a/x.mjs b/x.mjs\n+fixed',
        netChangedFiles: ['x.mjs'], netBasis: { rev: head },
      } } };
    const spawnJob = vi.fn(() => {
      runReviewJob({ pr: number, repo, pid: 1 }, {
        root: '/daemon', now: () => Date.now(), newActorId: () => 'review-actor',
        readPrevCompletion: () => null, report: () => {}, claim: () => ({ ok: true }),
        updateRecord: () => {}, unclaim: () => {}, acquireLane: () => ({ lanePath: '/lane' }),
        runLoop: () => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' }),
        releaseLane: () => {}, log: () => {},
        // Production runs the asynchronous seat in a synchronous child. Capture that child's input here.
        runRedTeam: input => { replayInput = input; return { status: 'resumed', comment: { status: 'posted' } }; },
        runRedTeamGate: () => ({ status: 'ok', outcome: 'advisory' }),
      });
      return 4242;
    });
    expect(dispatch({ spawnJob }).jobPid).toBe(4242);
    expect(replayInput?.loopPayload?.findings?.read?.netBasis?.rev).toBe(head);
    const postComment = vi.fn();
    const runSeat = vi.fn(() => { throw new Error('must not call the model'); });
    const runRecheck = vi.fn(() => { throw new Error('must not recheck'); });
    const result = await runRedTeam({ ...replayInput, env: {}, record: false,
    }, { now: () => Date.now(), readRecords: () => [row({ findings: [], provider: 'codex', model: 'saved', callId: 'saved-call' })],
      log: () => {}, listComments: () => [], postComment, runSeat, runRecheck });
    expect(result).toMatchObject({ status: 'resumed', rev: head, comment: { status: 'posted' } });
    expect(postComment).toHaveBeenCalledWith(expect.objectContaining({ pr: number, repo,
      body: expect.stringContaining(redTeamMarker(number, head)) }));
    expect(runSeat).not.toHaveBeenCalled();
    expect(runRecheck).not.toHaveBeenCalled();
    expect(spawnJob).toHaveBeenCalledTimes(1);
  });
  it('keeps the hold if fetching the full capped comment thread fails', () => {
    const p = pr({ comments: Array.from({ length: 100 }, () => ({ body: 'old comment' })) });
    expect(enrichPrsWithReferralHolds([p], { ...opts, readRuns: () => [run()],
      readComments: () => { throw new Error('thread read failed'); } })[0].referralHold)
      .toMatchObject({ kind: 'same-head' });
  });
});
