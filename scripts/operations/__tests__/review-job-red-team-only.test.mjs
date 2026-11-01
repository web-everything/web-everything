import { settleRedTeamSkip } from '../../lib/red-team-skip-outcome.mjs';
import { createRedTeamCarryIo } from '../../lib/red-team-carry-io.mjs';
import { readRedTeamCarry } from '../../lib/red-team-carry-machine.mjs';
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { abandonStaleRedTeamRun, planRedTeamOnSkip, recoverStaleRunPayload, redTeamSkipNeedsSettlement, runRedTeamOnSkip } from '../../lib/review-red-team-on-skip.mjs';
import { redTeamForHead, redTeamMarker } from '../../lib/red-team-gate.mjs';
import { redTeamOwedFor } from '../../lib/review-red-team-policy.mjs';
import { writeJsonAtomic } from '../../lib/atomic-json-file.mjs';
import { recordRedTeamStatus, readRedTeamStatus, readDrainRedTeamEvidence, redTeamStatusDir } from '../../lib/drain-red-team-evidence.mjs';
import { proveCardOnlyHeadMove } from '../../lib/card-only-head-move.mjs';
import { createReviewJobIo, execReadRaw, prepareReviewArc, runReviewJob, dispatchReviewJob, writeJobRecord, redTeamRunnerArgs, readRedTeamRecoveryStatus } from '../review-job.mjs';
import { createExtraSeatsIo } from '../review-extra-seats.mjs';
import { newRunRecord, writeRun } from '../run-store.mjs';

vi.mock('../../lib/red-team-status-labels.mjs', () => ({ syncRedTeamStatusLabels: vi.fn() }));
vi.mock('../../lib/atomic-json-file.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, writeJsonAtomic: vi.fn(actual.writeJsonAtomic) };
});

const repo = 'web-everything/web-everything', head = 'a'.repeat(40), pr = 5762;
const payload = () => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });

describe('lane Git hardening', () => {
  it.each(['prepareLane', 'fetchRedTeamHead'])('%s hardens every Git call against inherited lane commands', method => {
    const env = {
      ...process.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.alternateRefsCommand', GIT_CONFIG_VALUE_0: 'lane-owned-alternate-command',
      GIT_CONFIG_KEY_1: 'review.fixture', GIT_CONFIG_VALUE_1: 'preserved',
      GIT_EXTERNAL_DIFF: 'lane-owned-diff-command', REVIEW_FIXTURE_TOKEN: 'preserved',
    };
    const original = { ...env }, calls = [];
    const exec = (file, args, options) => {
      calls.push({ file, args, options });
      if (file === 'gh') return JSON.stringify({ headRefOid: head });
      return args.includes('fetch') ? '' : `${head}\n`;
    };
    const io = createReviewJobIo({ env, exec });
    expect(io[method]({ lanePath: '/lanes/lane-7', repo, pr, head })).toEqual({ head });
    const gitCalls = calls.filter(call => call.file === 'git');
    expect(gitCalls).toHaveLength(method === 'prepareLane' ? 2 : 3);
    for (const { options } of gitCalls) {
      // Read Git's effective configuration, not just our helper's object shape.
      // This executes no fetch, callback, or repository write.
      const config = key => execFileSync('git', ['config', '--get', key], {
        env: options.env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      }).trim();
      expect(config('core.alternateRefsCommand')).toBe('true');
      expect(config('core.fsmonitor')).toBe('false');
      expect(config('core.hooksPath')).toBe('/dev/null');
      expect(config('review.fixture')).toBe('preserved');
      expect(options.env.GIT_EXTERNAL_DIFF).toBeUndefined();
      expect(options.env.GIT_NO_LAZY_FETCH).toBe('1');
      expect(options.env.REVIEW_FIXTURE_TOKEN).toBe('preserved');
      expect(options).toMatchObject({ cwd: '/lanes/lane-7', timeout: 180_000, maxBuffer: 1024 * 1024 });
    }
    expect(env).toEqual(original);
  });
});

describe('review-job CLI --red-team-only', () => {
  it.each([
    [[], 1],
    [['--red-team-only'], 0],
    [['--red-team-only=fresh'], 0],
    [['--red-team-only=resume'], 0],
  ])('rates only ordinary completed reviews (%j)', (flags, expectedRatings) => {
    const source = `
      import { runReviewJobCli } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-job.mjs')).href)};
      const ratings = [];
      runReviewJobCli(process.argv.slice(1), {
        runJob: () => ({ sessionSlug: 'review-5762', refused: false }),
        rate: path => ratings.push(path),
      });
      process.stdout.write(JSON.stringify({ ratings }) + '\\n');
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source,
      'run', '--pr=5762', `--repo=${repo}`, ...flags], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '' },
    });
    const [result, { ratings }] = output.trim().split('\n').map(line => JSON.parse(line));
    expect(result).toEqual({ sessionSlug: 'review-5762', refused: false });
    expect(ratings).toHaveLength(expectedRatings);
    if (expectedRatings) expect(ratings[0]).toMatch(/review-5762\.log$/);
  });
  it.each([
    [[], false, 'fresh'],
    [['--red-team-only'], true, 'fresh'],
    [['--red-team-only=fresh'], true, 'fresh'],
    [['--red-team-only=resume'], true, 'resume'],
    [['--red-team-only=unknown'], true, 'unknown'],
    [['--red-team-only='], true, ''],
    [['--red-team-only=fresh', '--red-team-stale-recovery'], true, 'fresh', true],
  ])('passes %j to the job without losing its recovery mode', (flags, redTeamOnly, redTeamMode, redTeamStaleRecovery) => {
    const source = `
      import { runReviewJobCli } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-job.mjs')).href)};
      runReviewJobCli(process.argv.slice(1), { runJob: options => options });
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source,
      'run', '--pr=5762', '--repo=web-everything/web-everything', '--prefer-lane=7', ...flags], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '' },
    });
    expect(JSON.parse(output)).toEqual({ pr: '5762', repo, preferLane: 7, redTeamOnly, redTeamMode,
      ...(redTeamStaleRecovery === true ? { redTeamStaleRecovery: true } : {}) });
  });
});

function fakeIo(over = {}) {
  return { root: '/daemon', now: () => 1_000, newActorId: () => 'actor',
    readPrevCompletion: () => null, claim: vi.fn(() => ({ ok: true })),
    updateRecord: vi.fn(), unclaim: vi.fn(), acquireLane: vi.fn(() => ({ lanePath: '/lanes/lane-7' })),
    releaseLane: vi.fn(), log: vi.fn(), report: vi.fn(), runLoop: vi.fn(), runExtraSeats: vi.fn(),
    carryAcrossRebaseSetting: vi.fn(), readCarryEvidence: vi.fn(), restampVerdict: vi.fn(),
    speculativeRedTeamSetting: vi.fn(() => ({ enabled: true })), startSpeculativeRedTeam: vi.fn(),
    readRedTeamOnlyPayload: vi.fn(() => ({ head, loopPayload: payload() })),
    prepareLane: vi.fn(() => ({ head })), clearRedTeamQueued: vi.fn(),
    fetchRedTeamHead: vi.fn(() => ({ head })),
    runRedTeam: vi.fn(() => ({ status: 'ran', findings: [], comment: { status: 'posted' } })),
    runRedTeamGate: vi.fn(() => ({ status: 'ok', outcome: 'advisory' })), redTeamStatus: vi.fn(), ...over };
}

// Exercise the async shared seat through the same synchronous child boundary as the job.
function runSharedRecovery(input, { status, records = [], recordsUnreadable = false, commentsUnreadable = false, comments = [], env = {}, probeFresh = false, failAppend = false, staleStatus = false, capDeferred = false } = {}) {
  const source = `
    import { readFileSync } from 'node:fs';
    import { runRedTeam } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-extra-seats.mjs')).href)};
    import { readStore } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../conveyor/run-scorecard-store.mjs')).href)};
    import { recordRedTeamStatus, readRedTeamStatus } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../lib/drain-red-team-evidence.mjs')).href)};
    const { input, status, records, recordsUnreadable, commentsUnreadable, comments, env, probeFresh, failAppend, staleStatus, capDeferred } = JSON.parse(readFileSync(0, 'utf8'));
    const calls = { provider: 0, reserve: 0, model: 0, recheck: 0 };
    const forbid = key => () => { calls[key]++; throw Error('unexpected ' + key); };
    let firstStatusRead = true;
    const result = await runRedTeam({ ...input, env }, {
      now: () => 1000, log: () => {},
      readRecords: options => recordsUnreadable ? readStore({ ...options, path: 'injected-scorecards.json',
        exists: () => true, read: () => { throw Object.assign(Error('transient EIO'), { code: 'EIO' }); } }).records : records,
      readRedTeamStatus: () => { if (staleStatus && firstStatusRead) { firstStatusRead = false; return status; } return env.WE_SHARED_RUNS_DIR ? readRedTeamStatus({ repo: input.repo, pr: input.pr, head: input.loopPayload.findings.read.netBasis.rev, env }) : status; },
      redTeamStatus: value => { if (env.WE_SHARED_RUNS_DIR) recordRedTeamStatus(value, { env }); },
      readRecoveryComments: () => { if (commentsUnreadable) throw Error('transient EIO'); return comments; },
      cliAvailable: probeFresh ? provider => { calls.provider++; return provider === 'codex'; } : forbid('provider'),
      reserveCalls: probeFresh ? () => { calls.reserve++; return capDeferred ? { used: 1, callIds: [] } : { used: 0, callIds: ['retry-call'] }; } : forbid('reserve'),
      makeScratch: () => 'fixture-scratch', writeFile: () => {}, removeScratch: () => {},
      runSeat: probeFresh ? () => { calls.model++; if (env.WE_SHARED_RUNS_DIR) calls.retryCountAtCall = readRedTeamStatus({ repo: input.repo, pr: input.pr, head: input.loopPayload.findings.read.netBasis.rev, env }).retryCount; return { report: null, error: 'injected failed retry' }; } : forbid('model'),
      runRecheck: forbid('recheck'),
      listComments: () => comments, postComment: ({ body }) => comments.push({ body, author: { login: 'web-everything' } }),
      append: row => { calls.append = (calls.append ?? 0) + 1; if (failAppend) throw Error('injected append failure'); if (!probeFresh) throw Error('resume must reuse stored row'); records.push(row); },
    });
    process.stdout.write(JSON.stringify({ result, calls, comments }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    input: JSON.stringify({ input, status, records, recordsUnreadable, commentsUnreadable, comments, env, probeFresh, failAppend, staleStatus, capDeferred }), encoding: 'utf8',
    timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '' },
  }));
}

// Keep the recorded effects between synchronous job children, including partial writes.
function runStoredRecovery(input, { status, prior, saved, failComment = false, failStore = false } = {}) {
  const source = `
    import { readFileSync } from 'node:fs';
    import { runRedTeam } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-extra-seats.mjs')).href)};
    import { readStore } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../conveyor/run-scorecard-store.mjs')).href)};
    const { input, status, prior, saved, failComment, failStore } = JSON.parse(readFileSync(0, 'utf8'));
    const comments = saved?.comments ?? [], rows = saved?.rows ?? [];
    const calls = { model: 0, recheck: 0, reserve: 0, provider: 0 };
    const forbid = key => () => { calls[key]++; throw Error('unexpected ' + key); };
    const result = await runRedTeam({ ...input, env: { WE_RED_TEAM_SKIP_CARD_ONLY: '1' } }, {
      now: () => 1000, log: () => {},
      readRecords: options => failStore ? readStore({ ...options, path: 'injected-scorecards.json', exists: () => true,
        read: () => { throw Object.assign(Error('temporary store failure'), { code: 'EIO' }); } }).records : [prior, ...rows],
      readRedTeamStatus: () => status, readRecoveryComments: () => comments,
      cliAvailable: forbid('provider'), reserveCalls: forbid('reserve'),
      runSeat: forbid('model'), runRecheck: forbid('recheck'),
      listComments: () => comments,
      postComment: ({ body }) => {
        if (failComment) throw Error('transient comment failure');
        comments.push({ body, author: { login: 'web-everything' } });
      },
      append: row => rows.push(row),
    });
    process.stdout.write(JSON.stringify({ result, comments, rows, calls }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    input: JSON.stringify({ input, status, prior, saved, failComment, failStore }), encoding: 'utf8',
    timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '' },
  }));
}

describe('red-team-only review job', () => {
  it('recovery fetch: lane without H fetches before queued and runRedTeam sees H', () => {
    let available = false;
    const events = [];
    const io = fakeIo({
      fetchRedTeamHead: vi.fn(input => {
        expect(input).toEqual({ lanePath: '/lanes/lane-7', repo, pr, head });
        events.push('fetch');
        available = true;
        return { head };
      }),
      redTeamStatus: input => events.push(input.status),
      runRedTeam: vi.fn(() => {
        expect(available).toBe(true);
        events.push('started');
        return { status: 'ran' };
      }),
    });
    expect(runReviewJob({ repo, pr, redTeamOnly: true }, io).redTeam.status).toBe('ran');
    expect(events).toEqual(['fetch', 'queued', 'started', 'finished']);
  });

  it.each(['fresh', 'resume'])('recovery fetch: %s failure preserves status and next tick starts', redTeamMode => {
    const prior = redTeamMode === 'resume' ? { status: 'finished', result: 'ran' } : null;
    let status = prior;
    const io = fakeIo({
      fetchRedTeamHead: vi.fn().mockImplementationOnce(() => { throw Error('fetch failed'); })
        .mockReturnValue({ head }),
      redTeamStatus: vi.fn(input => { status = { status: input.status, result: input.result }; }),
    });
    const options = { repo, pr, redTeamOnly: true, redTeamMode };
    expect(runReviewJob(options, io)).toMatchObject({ refused: true,
      reason: 'reviewed head could not be fetched into the lane; retry next tick' });
    expect(status).toBe(prior);
    expect(io.redTeamStatus).not.toHaveBeenCalled();
    expect(io.clearRedTeamQueued).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(io.runRedTeamGate).not.toHaveBeenCalled();
    expect(io.report).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce();
    expect(io.unclaim).toHaveBeenCalledOnce();
    expect(runReviewJob(options, io).redTeam.status).toBe('ran');
    expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(['queued', 'finished']);
  });

  it.each([undefined, {}, { head: 'b'.repeat(40) }])('recovery fetch: missing or mismatched pinned SHA refuses (%j)', fetched => {
    const io = fakeIo({ fetchRedTeamHead: () => fetched });
    expect(runReviewJob({ repo, pr, redTeamOnly: true }, io)).toMatchObject({ refused: true,
      reason: 'reviewed head could not be fetched into the lane; retry next tick' });
    expect(io.redTeamStatus).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
  });

  it('recovery fetch: absent IO refuses without persisting admission', () => {
    const io = fakeIo({ fetchRedTeamHead: undefined });
    expect(runReviewJob({ repo, pr, redTeamOnly: true }, io).refused).toBe(true);
    expect(io.redTeamStatus).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
  });

  it('real ops head missing from lane: scratch reports not our ref before fetch and red team starts after', () => {
    // Local-only fixture for the launcher gate; this writes temporary Git repositories.
    const dir = mkdtempSync(join(tmpdir(), 'red-team-missing-head-'));
    const origin = join(dir, 'origin'), lanePath = join(dir, 'lane');
    const git = args => execFileSync('git', args, { encoding: 'utf8', timeout: 30_000,
      maxBuffer: 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
    const seats = createExtraSeatsIo();
    let scratch;
    try {
      git(['init', '--quiet', '--initial-branch=main', origin]);
      const commit = message => git(['-C', origin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', message]);
      commit('base');
      git(['clone', '--quiet', '--no-local', '--single-branch', '--branch', 'main', origin, lanePath]);
      git(['-C', origin, 'checkout', '--quiet', '-b', 'ops/recovery-fixture']);
      commit('reviewed ops head');
      const pinned = git(['-C', origin, 'rev-parse', 'HEAD']);
      git(['-C', origin, 'update-ref', `refs/pull/${pr}/head`, pinned]);
      expect(() => git(['-C', lanePath, 'cat-file', '-e', `${pinned}^{commit}`])).toThrow();
      expect(() => seats.makeScratch({ lanePath, rev: pinned })).toThrow(/not our ref/);

      const loopPayload = { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: pinned } } } };
      const events = [];
      const io = fakeIo({
        acquireLane: () => ({ lanePath }),
        // Isolate the recovery boundary with H absent even if shared setup changes.
        prepareLane: () => ({ head: pinned }),
        readRedTeamOnlyPayload: () => ({ head: pinned, loopPayload }),
        fetchRedTeamHead: createReviewJobIo().fetchRedTeamHead,
        redTeamStatus: input => events.push(input.status),
        runRedTeam: vi.fn(input => {
          scratch = seats.makeScratch({ lanePath: input.lanePath, rev: input.loopPayload.findings.read.netBasis.rev });
          expect(git(['-C', scratch, 'rev-parse', 'HEAD'])).toBe(pinned);
          events.push('started');
          return { status: 'ran' };
        }),
      });
      expect(runReviewJob({ repo, pr, redTeamOnly: true }, io).redTeam.status).toBe('ran');
      expect(events).toEqual(['queued', 'started', 'finished']);
      expect(io.runRedTeam).toHaveBeenCalledOnce();
    } finally {
      if (scratch) seats.removeScratch(scratch);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['ok', 'fetch-error', 'missing-commit', 'moved-head', 'wrong-commit'])(
    'recovery fetch: production IO checks origin PR ref and pinned commit (%s)', kind => {
      const calls = [];
      const exec = vi.fn((file, args, options) => {
        calls.push([file, args]);
        expect(options).toMatchObject({ timeout: 180_000, maxBuffer: 1024 * 1024 });
        expect(args.slice(0, 2)).toEqual(['-C', '/lanes/lane-7']);
        if (args[2] === 'fetch') {
          if (kind === 'fetch-error') throw Error('fetch failed');
          return '';
        }
        if (args[4] === 'FETCH_HEAD^{commit}') return kind === 'moved-head' ? 'b'.repeat(40) : `${head}\n`;
        if (kind === 'missing-commit') throw Error('unknown commit');
        return kind === 'wrong-commit' ? 'b'.repeat(40) : `${head}\n`;
      });
      const io = fakeIo({ fetchRedTeamHead: createReviewJobIo({ env: {}, exec }).fetchRedTeamHead });
      const out = runReviewJob({ repo, pr, redTeamOnly: true }, io);
      expect(calls[0]).toEqual(['git', ['-C', '/lanes/lane-7', 'fetch', '--quiet', '--no-tags', 'origin', `pull/${pr}/head`]]);
      if (kind === 'ok') {
        expect(calls.slice(1)).toEqual([
          ['git', ['-C', '/lanes/lane-7', 'rev-parse', '--verify', 'FETCH_HEAD^{commit}']],
          ['git', ['-C', '/lanes/lane-7', 'rev-parse', '--verify', `${head}^{commit}`]],
        ]);
        expect(out.redTeam.status).toBe('ran');
      } else {
        expect(out.refused).toBe(true);
        expect(io.redTeamStatus).not.toHaveBeenCalled();
        expect(io.runRedTeam).not.toHaveBeenCalled();
      }
    });

  it.each(['WE_REVIEW_RED_TEAM', 'WE_REVIEW_EXTRA_SEATS'])(
    '%s disabled plus transient scorecard EIO leaves fresh recovery eligible after restoration', switchName => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-disabled-retry-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const read = () => readRedTeamStatus({ repo, pr, head, env });
      const production = createReviewJobIo({ env });
      const observations = [];
      let disabled = true;
      const io = fakeIo({ redTeamStatus: vi.fn(production.redTeamStatus),
        clearRedTeamQueued: vi.fn(production.clearRedTeamQueued),
        runRedTeam: input => {
          const observed = runSharedRecovery(input, { status: read(), recordsUnreadable: true,
            env: { [switchName]: disabled ? '0' : '1' } });
          observations.push(observed);
          return observed.result;
        },
      });
      const history = new Map();
      let job;
      const recover = (at, dispatch = options => { job = runReviewJob(options, io); return { jobPid: 42 }; }) => runRedTeamOnSkip({ repo,
        plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
        rawPrs: [{ number: pr, headRefOid: head, comments: [] }],
        readEvidence: () => ({ loopPayload: payload(), recorded: false, inFlight: false }), readStatus: read,
        setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: history, now: () => at,
        capacity: { lanes: 1 }, dispatch,
      });
      try {
        expect(recover(1000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
        expect(job.redTeam).toMatchObject({ status: 'disabled' });
        expect(read()).toBeNull();
        expect(io.runRedTeamGate).toHaveBeenCalledOnce();
        disabled = false;
        expect(recover(1001).rows[0].why).toBe('retry cooldown active');
        expect(recover(1_801_000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
        expect(job.redTeam).toMatchObject({ status: 'not-owed', deferredByGuard: true,
          reason: expect.stringContaining('scorecard store unreadable') });
        expect(read()).toBeNull();
        expect(io.runRedTeamGate).toHaveBeenCalledTimes(2);
        expect(io.clearRedTeamQueued).toHaveBeenCalledTimes(2);
        expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(['queued', 'queued']);
        expect(recover(3_601_000, () => ({ jobPid: 43 })).dispatched)
          .toEqual([{ prNumber: pr, jobPid: 43, mode: 'fresh' }]);
        expect(observations).toHaveLength(2);
        for (const observed of observations) {
          expect(observed.calls).toEqual({ provider: 0, reserve: 0, model: 0, recheck: 0 });
          expect(observed.comments).toEqual([]);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it.each(['WE_REVIEW_RED_TEAM', 'WE_REVIEW_EXTRA_SEATS'])(
    'normal review still persists finished/disabled when %s is off', switchName => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-normal-disabled-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const read = () => readRedTeamStatus({ repo, pr, head, env });
      const production = createReviewJobIo({ env });
      const io = fakeIo({ redTeamStatus: vi.fn(production.redTeamStatus),
        clearRedTeamQueued: vi.fn(production.clearRedTeamQueued),
        runLoop: () => ({ status: 0, stdout: JSON.stringify({ ...payload(), stopped: 'complete', runId: 'review-pr-disabled' }) }),
        runRedTeam: input => runSharedRecovery(input, { status: read(), recordsUnreadable: true,
          env: { [switchName]: '0' } }).result,
      });
      try {
        expect(runReviewJob({ repo, pr }, io)).toMatchObject({ outcome: 'auto-cleared', redTeam: { status: 'disabled' } });
        expect(read()).toMatchObject({ status: 'finished', result: 'disabled' });
        expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(['queued', 'finished']);
        expect(io.clearRedTeamQueued).not.toHaveBeenCalled();
        expect(io.runRedTeamGate).toHaveBeenCalledOnce();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it.each(['comments', 'scorecard'])('a transient %s-unreadable guard refusal rolls back fresh admission, runs the gate once and leaves recovery eligible', unreadable => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-guard-retry-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env });
    let observed;
    const io = fakeIo({ redTeamStatus: vi.fn(production.redTeamStatus),
      clearRedTeamQueued: vi.fn(production.clearRedTeamQueued),
      runRedTeam: input => {
        observed = runSharedRecovery(input, { status: read(),
          commentsUnreadable: unreadable === 'comments', recordsUnreadable: unreadable === 'scorecard' });
        return observed.result;
      },
    });
    try {
      const out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io);
      expect(out.redTeam).toMatchObject({ status: 'not-owed', deferredByGuard: true,
        reason: expect.stringContaining(unreadable === 'comments' ? 'PR comments unreadable' : 'scorecard store unreadable') });
      expect(observed.calls).toEqual({ provider: 0, reserve: 0, model: 0, recheck: 0 });
      expect(observed.comments).toEqual([]);
      expect(read()).toBeNull();
      expect(io.clearRedTeamQueued).toHaveBeenCalledWith({ repo, pr, head });
      expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(['queued']);
      expect(io.runRedTeamGate).toHaveBeenCalledOnce();
      expect(io.runRedTeamGate).toHaveBeenCalledWith({ repo, pr });
      expect(io.clearRedTeamQueued.mock.invocationCallOrder[0]).toBeLessThan(io.runRedTeamGate.mock.invocationCallOrder[0]);
      expect(out.redTeamGate).toMatchObject({ status: 'ok', outcome: 'advisory' });
      const retry = runRedTeamOnSkip({ repo,
        plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
        rawPrs: [{ number: pr, headRefOid: head, comments: [] }],
        readEvidence: () => ({ loopPayload: payload(), recorded: false, inFlight: false }), readStatus: read,
        setting: { enabled: true, retryCooldownMin: 30 }, now: () => 1_801_000,
        lastDispatch: new Map([[`${repo}#${pr}@${head}`, 1_000]]), capacity: { lanes: 1 },
        dispatch: () => ({ jobPid: 42 }),
      });
      expect(retry.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    ['recorded-result recovery finishes missing comment and miss rows with zero model invocations', null],
    ['two consecutive recovery attempts retry a failed comment then succeed with zero model invocations', 'comment'],
    ['a transient production scorecard EIO preserves resume eligibility and retries with zero model invocations', 'store'],
    ['card-only recovery publishes a recorded result after the skip setting is restored', 'card-only'],
  ])('%s', (_name, failure) => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-effects-recovery-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_SKIP_CARD_ONLY: '1' };
    const status = () => readRedTeamStatus({ repo, pr, head, env });
    const failFirstComment = failure === 'comment';
    const cardOnly = failure === 'card-only';
    const needsRetry = failure === 'comment' || failure === 'store';
    const loopPayload = payload();
    Object.assign(loopPayload.findings.read, { title: 'Recover stored result', netChangedFiles: [cardOnly ? 'backlog/123-card.md' : 'scripts/example.mjs'],
      diffText: cardOnly ? '+card update' : 'diff --git a/scripts/example.mjs b/scripts/example.mjs\n+export const example = true;\n' });
    const prior = { dispatchKind: 'review-seat', seat: 'red-team', lens: 'red-team', status: 'ok',
      pr, repo, rev: head, callId: 'recorded-call', provider: 'codex', model: 'm', foldedVerdict: cardOnly ? 'accept' : 'changes',
      changedFiles: loopPayload.findings.read.netChangedFiles, findings: cardOnly ? [] : [{ summary: 'Stored confirmed break', category: 'failing-input',
        file: 'scripts/example.mjs', line: 1, impactIfUnfixed: 'degraded', confirmedByRecheck: true,
        recheckReason: 'demonstrated break' }] };
    const evidence = () => readDrainRedTeamEvidence({ repo, pr, head, env,
      list: () => [], readScorecards: () => [prior, ...(observed?.rows ?? [])] });
    let observed, job, attempt = 0;
    const observations = [];
    const production = createReviewJobIo({ env, readEvidence: evidence });
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload }),
      redTeamStatus: vi.fn(production.redTeamStatus), clearRedTeamQueued: vi.fn(production.clearRedTeamQueued),
      runRedTeam: input => {
        expect(status()).toMatchObject({ status: 'queued', pid: process.pid });
        observed = runStoredRecovery(input, { status: status(), prior, saved: observed,
          failComment: failFirstComment && attempt === 0, failStore: failure === 'store' && attempt === 0 });
        observations.push(observed);
        attempt++;
        return observed.result;
      },
    });
    const history = new Map();
    const recover = at => runRedTeamOnSkip({ repo,
      plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
      rawPrs: [{ number: pr, headRefOid: head, comments: observed?.comments ?? [] }],
      readEvidence: evidence,
      readStatus: status,
      setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: history, now: () => at,
      capacity: { lanes: 1 }, dispatch: options => { job = runReviewJob(options, io); return { jobPid: 42 }; },
    });
    try {
      recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished',
        result: cardOnly ? 'ran' : { status: 'ran', comment: 'error' } },
      { env: { ...env, WE_RED_TEAM_SKIP_CARD_ONLY: '0' } });
      expect(status().skipCardOnly).toBe(false);
      const before = status();
      expect(recover(1_000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
      if (failure === 'store') {
        expect(job).toMatchObject({ outcome: 'red-team-only', redTeam: { status: 'not-owed', deferredByGuard: true,
          reason: expect.stringContaining('scorecard store unreadable') } });
        expect(status()).toMatchObject({ status: before.status, result: before.result });
        expect(observed.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
        expect(observed.comments).toEqual([]);
        expect(observed.rows).toEqual([]);
        expect(recover(1_001).rows[0].why).toBe('retry cooldown active');
        expect(recover(1_801_000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
      }
      expect(job).toMatchObject({ outcome: 'red-team-only', redTeam: { status: 'resumed' } });
      if (failFirstComment) {
        expect(observed.result).toMatchObject({ status: 'resumed', comment: { status: 'error' }, rowsWritten: 2 });
        expect(observed.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
        expect(observed.comments).toEqual([]);
        expect(status()).toMatchObject({ status: 'finished', result: 'resumed' });
        expect(recover(1_001).rows[0].why).toBe('retry cooldown active');
        expect(recover(1_801_000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
        expect(job).toMatchObject({ outcome: 'red-team-only', redTeam: { status: 'resumed' } });
      }
      expect(observed.result).toMatchObject({ status: 'resumed', callId: prior.callId,
        comment: { status: 'posted' }, rowsWritten: failFirstComment || cardOnly ? 0 : 2 });
      expect(observed.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
      expect(observed.comments).toHaveLength(1);
      expect(redTeamForHead(observed.comments, pr, head)).toMatchObject({ pr, rev: head });
      expect(observed.rows.map(row => row.missRole).sort()).toEqual(cardOnly ? [] : ['accepting-review', 'builder']);
      expect(observed.rows.every(row => row.redTeamCallId === prior.callId && row.rev === head && row.repo === repo && row.pr === pr)).toBe(true);
      expect(io.runRedTeamGate).toHaveBeenCalledWith({ pr, repo });
      expect(io.runRedTeamGate).toHaveBeenCalledTimes(needsRetry ? 2 : 1);
      expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(
        needsRetry ? ['queued', 'finished', 'queued', 'finished'] : ['queued', 'finished']);
      expect(status()).toMatchObject({ status: 'finished', result: 'resumed', skipCardOnly: true });
      expect(recover(3_601_000).dispatched).toEqual([]);
      // Re-enter the ordinary seat's real effects path to prove row/comment dedup, too.
      const deduped = runStoredRecovery({ repo, pr, loopPayload }, { prior, saved: observed });
      expect(deduped.result).toMatchObject({ status: 'already-ran' });
      expect(deduped.rows).toEqual(observed.rows);
      expect(deduped.comments).toEqual(observed.comments);
      observations.push(deduped);
      for (const observation of observations) expect(observation.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
      expect(attempt).toBe(needsRetry ? 2 : 1);
      expect(io.runLoop).not.toHaveBeenCalled(); expect(io.runExtraSeats).not.toHaveBeenCalled();
      expect(io.prepareLane).toHaveBeenCalledTimes(attempt);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['final-write', 'queued-readback'].flatMap(failure =>
    ['ran', { status: 'resumed', comment: 'error' }].map(prior => ({ failure, prior }))))(
    'recovers a durable queued resume after $failure fails and the writer dies: $prior', ({ failure, prior }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-dead-resume-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const loopPayload = payload();
      loopPayload.findings.read.diffText = '+export const example = true;';
      const cleanRow = { dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', pr, repo, rev: head,
        callId: 'recorded-call', provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' };
      const rawStatus = () => readRedTeamStatus({ repo, pr, head, env });
      let live = true, fault = true, observed;
      const observations = [];
      const evidence = () => readDrainRedTeamEvidence({ repo, pr, head, env,
        list: () => [], readScorecards: () => [cleanRow], isAlive: () => live });
      const status = () => readRedTeamRecoveryStatus({ repo, pr, head, env }, {
        readStatus: rawStatus, readEvidence: evidence,
      });
      const production = createReviewJobIo({ env, readEvidence: evidence,
        writeStatus: (input, options) => {
          if (fault && failure === 'final-write' && input.status === 'finished') throw Error('final status EIO');
          recordRedTeamStatus(input, options);
        },
        readStatus: input => {
          const stored = readRedTeamStatus(input);
          if (fault && failure === 'queued-readback' && stored?.status === 'queued') {
            // The queued write succeeded. Fail its readback AND the real catch's
            // atomic rollback, retaining the new writer's durable queued record.
            vi.mocked(writeJsonAtomic).mockImplementationOnce(() => { throw Error('rollback EIO'); });
            throw Error('queued readback EIO');
          }
          return stored;
        },
      });
      const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload }),
        redTeamStatus: vi.fn(production.redTeamStatus),
        runRedTeam: vi.fn(input => {
          observed = runStoredRecovery(input, { status: rawStatus(), prior: cleanRow, saved: observed,
            failComment: fault });
          observations.push(observed);
          return observed.result;
        }),
      });
      try {
        recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: prior }, { env });
        const initial = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'resume' }, io);
        if (failure === 'queued-readback') {
          expect(initial).toMatchObject({ outcome: 'blocked-on-infra', label: expect.stringContaining('queued red-team status could not be persisted') });
          expect(io.runRedTeam).not.toHaveBeenCalled();
          expect(io.runRedTeamGate).not.toHaveBeenCalled();
          expect(vi.mocked(writeJsonAtomic).mock.results.at(-1)).toMatchObject({ type: 'throw', value: expect.objectContaining({ message: 'rollback EIO' }) });
        } else {
          expect(initial.redTeam).toMatchObject({ status: 'resumed' });
          expect(observed.result.comment.status).toBe('error');
          expect(observed.comments).toEqual([]);
        }
        expect(rawStatus()).toMatchObject({ status: 'queued', result: prior, pid: process.pid });
        expect(status().status).toBe('queued');
        // Once the transient IO fault clears, liveness alone still refuses entry.
        fault = false;
        const callsBefore = io.runRedTeam.mock.calls.length;
        expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('blocked-on-infra');
        expect(io.runRedTeam).toHaveBeenCalledTimes(callsBefore);
        live = false;
        expect(status()).toMatchObject({ status: 'finished', result: prior });
        const retry = runRedTeamOnSkip({ repo,
          plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
          rawPrs: [{ number: pr, headRefOid: head, comments: observed?.comments ?? [] }],
          readEvidence: evidence, readStatus: status, capacity: { lanes: 1 },
          setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(),
          dispatch: options => {
            expect(options.redTeamMode).toBe('resume');
            expect(runReviewJob(options, io)).toMatchObject({ outcome: 'red-team-only', redTeam: { status: 'resumed' } });
            return { jobPid: 42 };
          },
        });
        expect(retry.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
        expect(rawStatus()).toMatchObject({ status: 'finished', result: 'resumed' });
        expect(observed.result).toMatchObject({ status: 'resumed', callId: cleanRow.callId, comment: { status: 'posted' } });
        expect(observed.comments).toHaveLength(1);
        expect(redTeamForHead(observed.comments, pr, head)).toMatchObject({ pr, rev: head });
        expect(observed.rows).toEqual([]);
        for (const observation of observations) expect(observation.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
        expect(io.runLoop).not.toHaveBeenCalled(); expect(io.runExtraSeats).not.toHaveBeenCalled();
        expect(io.releaseLane).toHaveBeenCalledTimes(3); expect(io.unclaim).toHaveBeenCalledTimes(3);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it('a confirmed-dead queued/ran prior admits and reaches the shared resume path without a model call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-crashed-resume-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const loopPayload = payload();
    loopPayload.findings.read.diffText = '+export const value = true;';
    const records = [{ dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', repo, pr, rev: head,
      callId: 'stored-call', provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' }];
    const evidence = () => ({ inFlight: false, recorded: true, loopPayload });
    let observed;
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload }),
      redTeamStatus: createReviewJobIo({ env, readEvidence: evidence }).redTeamStatus,
      runRedTeam: input => {
        expect(read()).toMatchObject({ status: 'queued', pid: process.pid, result: 'ran' });
        observed = runSharedRecovery(input, { status: read(), records });
        return observed.result;
      },
    });
    try {
      recordRedTeamStatus({ repo, pr, loopPayload, status: 'queued', result: 'ran' }, { env });
      writeFileSync(join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`),
        JSON.stringify({ ...read(), pid: 4242 }));
      expect(readRedTeamRecoveryStatus({ repo, pr, head, env }, { readEvidence: evidence }))
        .toMatchObject({ status: 'finished', result: 'ran' });
      const out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'resume' }, io);
      expect(out.redTeam).toMatchObject({ status: 'resumed' });
      expect(observed.result).toMatchObject({ status: 'resumed', callId: 'stored-call', comment: { status: 'posted' } });
      expect(observed.calls).toEqual({ provider: 0, reserve: 0, model: 0, recheck: 0 });
      expect(redTeamForHead(observed.comments, pr, head)).toMatchObject({ pr, rev: head });
      expect(read()).toMatchObject({ status: 'finished', result: 'resumed' });
      expect(io.runRedTeamGate).toHaveBeenCalledOnce();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    ['fresh recovery launches an abandoned stale running pass through production admission and the shared guard', true],
    ['fresh recovery without the stale flag refuses an abandoned running prior and keeps it intact', undefined],
    ['fresh recovery with a false stale flag refuses an abandoned running prior and keeps it intact', false],
    ['fresh recovery with a non-boolean stale flag refuses an abandoned running prior and keeps it intact', 'true'],
  ])('%s', (_name, redTeamStaleRecovery) => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-abandoned-running-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl') };
    const loopPayload = { ...payload(), findings: { read: { netBasis: { rev: head },
      diffText: 'diff --git a/scripts/example.mjs b/scripts/example.mjs\n+export const value = 1;',
      netChangedFiles: ['scripts/example.mjs'] } } };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env, readEvidence: input => readDrainRedTeamEvidence({ ...input,
      list: () => [], readScorecards: () => [], isAlive: () => false }) });
    let observed, admittedPrior;
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload }),
      redTeamStatus: production.redTeamStatus,
      clearRedTeamQueued: production.clearRedTeamQueued,
      runRedTeam: vi.fn(input => {
        admittedPrior = input.redTeamAdmission.prior;
        observed = runSharedRecovery(input, { status: read(), probeFresh: true });
        return observed.result;
      }),
    });
    try {
      recordRedTeamStatus({ repo, pr, loopPayload, status: 'running', result: null }, { env });
      const status = { ...read(), pid: 2147483647 };
      writeJsonAtomic(join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`), status);
      expect(abandonStaleRedTeamRun({ repo, pr, head, env, status,
        probe: { host: status.host, namespace: status.pidNamespace, isAlive: () => false } }).ok).toBe(true);
      expect(read()).toMatchObject({ status: 'running', result: null,
        staleAbandoned: { at: expect.any(String), pid: status.pid } });

      const prior = read();
      const result = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh',
        ...(redTeamStaleRecovery === undefined ? {} : { redTeamStaleRecovery }) }, io);
      if (redTeamStaleRecovery !== true) {
        expect(result).toMatchObject({ outcome: 'blocked-on-infra',
          label: expect.stringContaining('prior red-team status; not re-run') });
        expect(io.runRedTeam).not.toHaveBeenCalled();
        expect(read()).toEqual(prior);
        return;
      }
      expect(io.runRedTeam).toHaveBeenCalledOnce();
      expect(io.runRedTeam.mock.calls[0][0].redTeamStaleRecovery).toBe(true);
      expect(result.redTeam?.reason ?? '').not.toContain('prior red-team status; not re-run');
      expect(observed.calls.model).toBe(1);
      expect(observed.result.deferredByGuard).not.toBe(true);
      expect(admittedPrior).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fresh production admission holds a live running writer without stale abandonment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-live-running-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env, readEvidence: input => readDrainRedTeamEvidence({ ...input,
      list: () => [], readScorecards: () => [], isAlive: () => true, readPidStart: () => null }) });
    const io = fakeIo({ redTeamStatus: production.redTeamStatus,
      runRedTeam: vi.fn(input => runSharedRecovery(input, { status: read(), probeFresh: true }).result) });
    try {
      recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'running', result: null }, { env });
      const prior = read();
      expect(prior.pid).toBe(process.pid);
      expect(prior.staleAbandoned).toBeUndefined();
      expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io))
        .toMatchObject({ outcome: 'blocked-on-infra', label: expect.stringContaining('red-team writer is live or unknown') });
      expect(io.runRedTeam).not.toHaveBeenCalled();
      expect(read()).toEqual(prior);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fresh production admission and shared guard never rerun a finished ran result with a posted comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-finished-posted-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env });
    let observed;
    const io = fakeIo({ redTeamStatus: production.redTeamStatus,
      clearRedTeamQueued: production.clearRedTeamQueued,
      runRedTeam: vi.fn(input => {
        observed = runSharedRecovery(input, { status: read(), probeFresh: true });
        return observed.result;
      }),
    });
    try {
      recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished',
        result: { status: 'ran', comment: { status: 'posted' } } }, { env });
      const prior = read();
      expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io).redTeam)
        .toMatchObject({ status: 'not-owed', deferredByGuard: true,
          reason: expect.stringContaining('prior red-team status; not re-run') });
      expect(observed.calls).toEqual({ provider: 0, reserve: 0, model: 0, recheck: 0 });
      expect(observed.comments).toEqual([]);
      expect(read()).toEqual(prior);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fresh recovery preserves unknown finished-null history through production admission and launches no call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-null-history-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env });
    let observed;
    const io = fakeIo({ redTeamStatus: production.redTeamStatus,
      runRedTeam: input => {
        expect(input.redTeamAdmission.prior).toMatchObject({ status: 'finished', result: null });
        observed = runSharedRecovery(input, { status: read() });
        return observed.result;
      },
    });
    try {
      recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result: null }, { env });
      expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io).redTeam)
        .toMatchObject({ status: 'not-owed', deferredByGuard: true,
          reason: expect.stringContaining('prior red-team status; not re-run') });
      expect(observed.calls).toEqual({ provider: 0, reserve: 0, model: 0, recheck: 0 });
      expect(observed.comments).toEqual([]);
      expect(read()).toMatchObject({ status: 'finished', result: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    ['finished', 'ran'], ['finished', { status: 'resumed', comment: 'error' }], ['error', 'error'],
  ])('restores prior %s/%j evidence after a shared guard refusal and runs the gate once', (status, result) => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-guard-rollback-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env });
    const io = fakeIo({ redTeamStatus: vi.fn(production.redTeamStatus),
      clearRedTeamQueued: vi.fn(production.clearRedTeamQueued),
      runRedTeam: input => runSharedRecovery(input, { status: read(), commentsUnreadable: true }).result,
    });
    try {
      recordRedTeamStatus({ repo, pr, loopPayload: payload(), status, result }, { env });
      expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'resume' }, io).redTeam)
        .toMatchObject({ status: 'not-owed', deferredByGuard: true });
      expect(read()).toMatchObject({ status, result });
      expect(io.clearRedTeamQueued).not.toHaveBeenCalled();
      expect(io.runRedTeamGate).toHaveBeenCalledOnce();
      expect(io.runRedTeamGate).toHaveBeenCalledWith({ repo, pr });
      expect(io.redTeamStatus.mock.invocationCallOrder[1]).toBeLessThan(io.runRedTeamGate.mock.invocationCallOrder[0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['fresh', 'resume'])('a cap deferral rolls back %s admission and still runs the gate', redTeamMode => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-cap-gate-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env });
    const io = fakeIo({ redTeamStatus: vi.fn(production.redTeamStatus),
      clearRedTeamQueued: vi.fn(production.clearRedTeamQueued),
      runRedTeam: vi.fn(() => {
        expect(read()).toMatchObject({ status: 'queued', pid: process.pid });
        return { status: 'skipped', deferredByCap: true, reason: 'daily-cap' };
      }),
    });
    try {
      if (redTeamMode === 'resume') recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result: 'ran' }, { env });
      const before = read();
      const out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode }, io);
      expect(out.redTeam).toMatchObject({ status: 'skipped', deferredByCap: true });
      expect(io.runRedTeam).toHaveBeenCalledOnce();
      if (before) {
        expect(read()).toMatchObject({ status: before.status, result: before.result });
        expect(io.clearRedTeamQueued).not.toHaveBeenCalled();
      } else {
        expect(read()).toBeNull();
        expect(io.clearRedTeamQueued).toHaveBeenCalledOnce();
        expect(io.clearRedTeamQueued).toHaveBeenCalledWith({ repo, pr, head });
      }
      expect(io.runRedTeamGate).toHaveBeenCalledOnce();
      expect(io.runRedTeamGate).toHaveBeenCalledWith({ repo, pr });
      expect(out.redTeamGate).toEqual({ status: 'ok', outcome: 'advisory' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['failed', { status: 'failed', reason: 'provider quota exhausted' }, 'ran', { status: 'ran' }])(
    'cap-deferred failed retry preserves %j through repeated deferrals and recovery', priorResult => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-failed-cap-retry-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const read = () => readRedTeamStatus({ repo, pr, head, env });
      const loopPayload = payload();
      loopPayload.findings.read.diffText = '+export const value = true;';
      const records = [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head,
        status: 'quota-exhausted', redTeamCallId: 'original-failed-call' }];
      const evidence = () => ({ loopPayload, inFlight: false, queued: false, recorded: true,
        seatRecorded: true, completedRecorded: false, failedSeatCount: 1 });
      const production = createReviewJobIo({ env, readEvidence: evidence });
      let capDeferred = true, observed, at = 1_000;
      const io = fakeIo({
        readRedTeamOnlyPayload: () => ({ head, loopPayload }),
        redTeamStatus: vi.fn(production.redTeamStatus),
        clearRedTeamQueued: vi.fn(production.clearRedTeamQueued),
        runRedTeam: input => {
          expect(input.redTeamAdmission).toMatchObject({ retrySpent: true,
            prior: { status: 'finished', result: priorResult } });
          observed = runSharedRecovery(input, { status: read(), records, env, probeFresh: true, capDeferred });
          return observed.result;
        },
      });
      const history = new Map();
      let job;
      const recover = () => runRedTeamOnSkip({ repo,
        plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
        rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [], labels: ['review:accepted'] }],
        readEvidence: evidence, readStatus: read, readCarry: () => null,
        setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: history, now: () => at,
        capacity: { lanes: 1 }, dispatch: options => { job = runReviewJob(options, io); return { jobPid: 42 }; },
      });
      try {
        recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: priorResult }, { env });
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(recover().dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
          expect(job.redTeam).toMatchObject({ status: 'skipped', deferredByCap: true });
          expect(observed.calls.model).toBe(0);
          expect(observed.calls.append ?? 0).toBe(0);
          expect(observed.comments).toEqual([]);
          expect(read()).toMatchObject({ status: 'finished', result: priorResult });
          expect(read().retryCount).toBeUndefined();
          expect(io.redTeamStatus.mock.calls.at(-1)[0]).toMatchObject({ refundRetry: true });
          expect(recover().rows[0].why).toBe('retry cooldown active');
          at += 30 * 60_000 + 1;
        }
        capDeferred = false;
        expect(recover().dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
        expect(observed.calls.model).toBe(1);
        expect(observed.calls.retryCountAtCall).toBe(1);
        expect(job.redTeam.status).toBe('failed');
        expect(read()).toMatchObject({ status: 'finished', result: 'failed', retryCount: 1 });
        at += 30 * 60_000 + 1;
        expect(recover().dispatched).toEqual([]);
        expect(io.clearRedTeamQueued).not.toHaveBeenCalled();
        expect(io.runRedTeamGate).toHaveBeenCalledTimes(3);
        expect(io.runLoop).not.toHaveBeenCalled();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it('keeps a shared result-already-on-head refusal terminal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-guard-terminal-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env });
    const io = fakeIo({ redTeamStatus: production.redTeamStatus,
      clearRedTeamQueued: vi.fn(production.clearRedTeamQueued),
      runRedTeam: input => runSharedRecovery(input, { status: read(), comments: [{
        author: { login: 'web-everything' }, body: redTeamMarker(pr, head),
      }] }).result,
    });
    try {
      const out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io);
      expect(out.redTeam).toMatchObject({ status: 'not-owed', reason: expect.stringContaining('red-team result already on head') });
      expect(out.redTeam).not.toHaveProperty('deferredByGuard');
      expect(read()).toMatchObject({ status: 'finished', result: 'not-owed' });
      expect(io.clearRedTeamQueued).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['owned', 'foreign-host'])('normal review admits only its own local speculative writer (%s)', writer => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-spec-owner-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const realIo = createReviewJobIo({ env, readEvidence: input => readDrainRedTeamEvidence({ ...input,
      list: () => [], readScorecards: () => [], isAlive: () => true, readPidStart: () => null }) });
    const io = fakeIo({ redTeamStatus: realIo.redTeamStatus,
      startSpeculativeRedTeam: () => ({ pid: 4242, startedAt: 1000 }),
      runLoop: () => {
        recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'running' }, { env });
        writeFileSync(join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`),
          JSON.stringify({ ...read(), pid: 4242, ...(writer === 'foreign-host' ? { host: 'another-host' } : {}) }));
        return { status: 0, stdout: JSON.stringify({ ...payload(), stopped: 'complete' }) };
      },
      awaitSpeculativeRedTeam: () => ({ spec: { status: 'speculated' } }),
      cancelSpeculativeRedTeam: () => ({}), recordDiscardedRedTeam: () => ({ status: 'recorded' }),
      finishSpeculativeRedTeam: vi.fn(() => {
        expect(read()).toMatchObject({ status: 'queued', pid: process.pid });
        return { status: 'ran' };
      }),
    });
    try {
      const out = runReviewJob({ pr, repo }, io);
      if (writer === 'owned') {
        expect(out.redTeam.status).toBe('ran');
        expect(io.finishSpeculativeRedTeam).toHaveBeenCalledOnce();
      } else {
        // An ordinary review keeps its completed outcome; admission is refused, so no red team runs.
        expect(out.outcome).not.toBe('blocked-on-infra');
        expect(io.finishSpeculativeRedTeam).not.toHaveBeenCalled();
        expect(read()).toMatchObject({ status: 'running', pid: 4242, host: 'another-host' });
      }
      expect(io.runRedTeam).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['fresh', 'resume'].flatMap(redTeamMode => ['queued', 'running'].map(status => ({ redTeamMode, status }))))(
    'refuses a second $redTeamMode recovery after unclaim while the first child is active ($status)', ({ redTeamMode, status }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-overlap-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const read = () => readRedTeamStatus({ repo, pr, head, env });
      const realIo = createReviewJobIo({ env, readEvidence: input => readDrainRedTeamEvidence({ ...input,
        list: () => [], readScorecards: () => [], isAlive: () => true, readPidStart: () => null }) });
      let second;
      const first = fakeIo({ redTeamStatus: realIo.redTeamStatus, runRedTeam: vi.fn(input => {
        expect(first.unclaim).toHaveBeenCalledOnce();
        if (status === 'running') realIo.redTeamStatus({ ...input, status });
        const before = read();
        // The first claim is already released: the second job may claim, but must not steal its head's status.
        second = fakeIo({ redTeamStatus: realIo.redTeamStatus });
        expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, second)).toMatchObject({
          outcome: 'blocked-on-infra', label: expect.stringMatching(/writer.*(live|unknown)/),
        });
        expect(second.runRedTeam).not.toHaveBeenCalled();
        expect(second.runRedTeamGate).not.toHaveBeenCalled();
        expect(read()).toEqual(before);
        return { status: 'ran' };
      }) });
      try {
        if (redTeamMode === 'resume') recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result: 'ran' }, { env });
        expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, first).redTeam.status).toBe('ran');
        expect(first.runRedTeam).toHaveBeenCalledOnce();
        expect(second).toBeDefined();
        expect(second.runRedTeam).not.toHaveBeenCalled();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it.each(['queued', 'running'].flatMap(status => ['missing-pid', 'foreign-host', 'foreign-namespace', 'unknown-start',
    'unreadable', 'missing-evidence', 'incomplete-evidence', 'unknown-queue'].map(probe => ({ status, probe }))))(
    'refuses a $status writer with live or unknown liveness ($probe) without overwriting admission', ({ status, probe }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-writer-liveness-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const read = () => readRedTeamStatus({ repo, pr, head, env });
      try {
        recordRedTeamStatus({ repo, pr, loopPayload: payload(), status, result: 'ran' }, { env });
        const prior = { ...read(), ...(probe === 'missing-pid' ? { pid: null } : {}),
          ...(probe === 'foreign-host' ? { host: 'another-host' } : {}),
          ...(probe === 'foreign-namespace' ? { pidNamespace: 'another-namespace' } : {}),
          ...(probe === 'unknown-start' ? { pidStart: 'known-prior-start' } : {}) };
        writeFileSync(join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`), JSON.stringify(prior));
        const realIo = createReviewJobIo({ env, readEvidence: input => {
          if (probe === 'unreadable') throw Error('liveness EIO');
          if (probe === 'missing-evidence') return null;
          if (probe === 'incomplete-evidence') return {};
          if (probe === 'unknown-queue') return { inFlight: false, queued: null };
          return readDrainRedTeamEvidence({ ...input, list: () => [], readScorecards: () => [],
            isAlive: () => probe === 'unknown-start', readPidStart: () => null });
        } });
        const io = fakeIo({ redTeamStatus: realIo.redTeamStatus });
        expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io)).toMatchObject({
          outcome: 'blocked-on-infra', label: expect.stringMatching(/inspect|retry/),
        });
        expect(io.runRedTeam).not.toHaveBeenCalled();
        expect(io.runRedTeamGate).not.toHaveBeenCalled();
        expect(read()).toEqual(prior);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it.each(['queued', 'running'])('allows recovery after the previous %s writer is confirmed dead', status => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-dead-writer-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    try {
      recordRedTeamStatus({ repo, pr, loopPayload: payload(), status, result: 'ran' }, { env });
      const realIo = createReviewJobIo({ env, readEvidence: input => readDrainRedTeamEvidence({ ...input,
        list: () => [], readScorecards: () => [], isAlive: () => false }) });
      const io = fakeIo({ redTeamStatus: realIo.redTeamStatus });
      expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).redTeam.status).toBe('ran');
      expect(io.runRedTeam).toHaveBeenCalledOnce();
      expect(readRedTeamStatus({ repo, pr, head, env })).toMatchObject({ status: 'finished', result: 'ran' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['normal', 'fresh', 'resume'])('writes queued status before releasing the job slot in %s mode', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-queue-order-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const calls = [];
    const readStatus = input => {
      const status = readRedTeamStatus(input);
      if (status?.status === 'queued') calls.push('readback');
      return status;
    };
    const realIo = createReviewJobIo({ env, readStatus });
    const io = fakeIo({
      runLoop: () => ({ status: 0, stdout: JSON.stringify({ ...payload(), stopped: 'complete' }) }),
      redTeamStatus: input => { calls.push(input.status); return realIo.redTeamStatus(input); },
      unclaim: () => calls.push('unclaim'),
      runRedTeam: () => { calls.push('red-team'); return { status: 'ran' }; },
    });
    try {
      runReviewJob({ pr, repo, redTeamOnly: mode !== 'normal', redTeamMode: mode === 'normal' ? 'fresh' : mode }, io);
      expect(calls).toEqual(['queued', 'readback', 'unclaim', 'red-team', 'finished']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('preserves the accepted ordinary review outcome and done report when the queued status hook throws', () => {
    const loopPayload = { ...payload(), runId: 'review-pr-5762', stopped: 'complete',
      verdict: { verdict: 'accept', loop: { outcome: 'converged' } } };
    const io = fakeIo({
      runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify(loopPayload) })),
      redTeamStatus: vi.fn(({ status }) => {
        if (status === 'queued') throw Error('queued status persistence failed');
      }),
    });

    expect(runReviewJob({ pr, repo }, io)).toMatchObject({
      outcome: 'auto-cleared', verdict: 'accept', loopOutcome: 'converged', runId: loopPayload.runId,
    });
    expect(io.report.mock.calls.map(([report]) => report)).toEqual([
      expect.objectContaining({ status: 'started' }),
      expect.objectContaining({ status: 'done', outcome: 'auto-cleared', verdict: 'converged', runId: loopPayload.runId }),
    ]);
    expect(io.redTeamStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }));
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('queued status persistence failed'));
  });
  it.each(['fresh', 'resume'])('refuses a throwing strict queued hook in %s mode with zero red-team calls', redTeamMode => {
    const io = fakeIo({ redTeamStatus: vi.fn(({ status }) => {
      if (status !== 'queued') return;
      expect(io.unclaim).not.toHaveBeenCalled();
      expect(io.releaseLane).not.toHaveBeenCalled();
      throw Error('queued status persistence failed; inspect evidence before retrying');
    }) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io)).toMatchObject({
      outcome: 'blocked-on-infra', label: expect.stringContaining('queued status persistence failed'),
    });
    expect(io.redTeamStatus).toHaveBeenCalledOnce();
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(io.runRedTeamGate).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce();
    expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each(['fresh', 'resume'].flatMap(redTeamMode => ['write', 'readback', 'wrong-pid', 'unreadable-prior'].map(failure => ({ redTeamMode, failure }))))(
    'restores admission evidence after queued $failure failure in $redTeamMode mode without launching a seat', ({ redTeamMode, failure }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-queue-failure-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const read = () => readRedTeamStatus({ repo, pr, head, env });
      const prior = redTeamMode === 'resume' ? { status: 'resumed', comment: 'error' } : null;
      try {
        if (prior) recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result: prior }, { env });
        const before = read();
        const realIo = createReviewJobIo({ env,
          writeStatus: (input, options) => { recordRedTeamStatus(input, options); if (failure === 'write') throw Error('write EIO'); },
          readStatus: input => {
            const status = readRedTeamStatus(input);
            if (failure === 'unreadable-prior' || (status?.status === 'queued' && failure === 'readback')) throw Error('read EIO');
            return status?.status === 'queued' && failure === 'wrong-pid' ? { ...status, pid: -1 } : status;
          },
        });
        const io = fakeIo({ redTeamStatus: realIo.redTeamStatus });
        expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io)).toMatchObject({
          outcome: 'blocked-on-infra', label: expect.stringMatching(/inspect|retry/),
        });
        expect(io.runRedTeam).not.toHaveBeenCalled();
        expect(io.runRedTeamGate).not.toHaveBeenCalled();
        expect(read()).toEqual(before);
        expect(io.releaseLane).toHaveBeenCalledOnce();
        expect(io.unclaim).toHaveBeenCalledOnce();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it.each(['skipped', 'error', 'disabled', 'not-owed', 'null', 'undefined', 'throw', 'cap', 'quota-hold'].flatMap(failure =>
    ['ran', { status: 'resumed', comment: { status: 'error' } }].map(prior => ({ failure, prior }))))(
    'preserves durable clean result $prior after a resume child returns $failure', ({ failure, prior }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-resume-status-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const status = () => readRedTeamStatus({ repo, pr, head, env });
      try {
        recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result: prior }, { env });
        const io = fakeIo({ redTeamStatus: createReviewJobIo({ env }).redTeamStatus,
          runRedTeam: vi.fn(() => {
            expect(status()).toMatchObject({ status: 'queued', result: prior, pid: process.pid });
            if (failure === 'throw') throw Error('temporary child failure');
            if (['cap', 'quota-hold'].includes(failure)) return { status: 'skipped', deferredByCap: true, reason: failure };
            return failure === 'null' ? null : failure === 'undefined' ? undefined : { status: failure };
          }),
        });
        expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-only');
        expect(status()).toMatchObject({ status: 'finished', result: prior });
        const retry = runRedTeamOnSkip({ repo,
          plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
          rawPrs: [{ number: pr, headRefOid: head, comments: [] }],
          readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true }), readStatus: status,
          setting: { enabled: true, retryCooldownMin: 30 }, now: () => 1_801_000,
          lastDispatch: new Map([[`${repo}#${pr}@${head}`, 1_000]]), capacity: { lanes: 1 },
          dispatch: () => ({ jobPid: 42 }),
        });
        expect(retry.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
        for (const hook of ['runLoop', 'runExtraSeats', 'report']) expect(io[hook]).not.toHaveBeenCalled();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it('normal review and recovery use the same exported setup and identical lane arguments', () => {
    const prepareLane = vi.fn(() => ({ head }));
    const args = { pr, repo, lanePath: '/lanes/lane-7' };
    expect(prepareReviewArc(args, { prepareLane })).toEqual({ head });
    for (const redTeamOnly of [false, true]) {
      const io = fakeIo({ prepareLane, runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify({ ...payload(), stopped: 'complete' }) })) });
      runReviewJob({ pr, repo, redTeamOnly }, io);
      expect(io.prepareLane).toBe(prepareLane);
      expect(io.fetchRedTeamHead).toHaveBeenCalledTimes(redTeamOnly ? 1 : 0);
    }
    expect(prepareLane.mock.calls).toEqual([[args], [args], [args]]);
  });
  it('contains a red-team error and persists finished status before the normal gate', () => {
    const io = fakeIo({ runRedTeam: () => { throw Error('child failed'); } });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io)).toMatchObject({
      outcome: 'red-team-only', redTeam: { status: 'error', reason: 'child failed' },
    });
    expect(io.redTeamStatus.mock.calls.map(([input]) => [input.status, input.result]))
      .toEqual([['queued', undefined], ['finished', 'error']]);
    expect(io.redTeamStatus.mock.invocationCallOrder[1]).toBeLessThan(io.runRedTeamGate.mock.invocationCallOrder[0]);
  });
  it.each(['ok', 'fetch-error', 'moved-head', 'missing-head', 'oversized-output'])(
    'shared setup fetches refs/pull/<pr>/head pinned to head before any seats (%s)', kind => {
      const calls = [];
      const exec = vi.fn((file, argv, options) => {
        calls.push([file, argv]);
        expect(options.cwd).toBe('/lanes/lane-7');
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.maxBuffer).toBe(1024 * 1024);
        if (kind === 'oversized-output') throw Object.assign(Error('output exceeded maxBuffer'), { code: 'ENOBUFS' });
        if (file === 'gh') return JSON.stringify({ headRefOid: kind === 'missing-head' ? null : head });
        if (argv[0] === 'fetch') {
          if (kind === 'fetch-error') throw Error('not our ref');
          return '';
        }
        if (argv[0] === 'rev-parse') return kind === 'moved-head' ? 'b'.repeat(40) : head;
        throw Error('unexpected command');
      });
      const prepareLane = createReviewJobIo({ env: {}, exec }).prepareLane;
      const io = fakeIo({ prepareLane, runRedTeam: vi.fn(() => {
        calls.push(['red-team']);
        return { status: 'ran' };
      }) });
      const out = runReviewJob({ pr, repo, redTeamOnly: true }, io);
      if (kind === 'ok') {
        expect(calls).toEqual([
          ['gh', ['pr', 'view', String(pr), `--repo=${repo}`, '--json', 'headRefOid']],
          ['git', ['fetch', '--no-tags', `https://github.com/${repo}.git`, `refs/pull/${pr}/head`]],
          ['git', ['rev-parse', 'FETCH_HEAD^{commit}']], ['red-team'],
        ]);
        expect(out.redTeam.status).toBe('ran');
        expect(io.readRedTeamOnlyPayload).toHaveBeenCalledWith({ pr, repo, head });
      } else {
        expect(out.outcome).toBe('blocked-on-infra');
        expect(out.label).toMatch(/inspect|retry/);
        for (const hook of ['runLoop', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus']) expect(io[hook]).not.toHaveBeenCalled();
      }
      expect(io.releaseLane).toHaveBeenCalledOnce();
      expect(io.unclaim).toHaveBeenCalledOnce();
    });
  it('another repo scorecard with the same PR and head cannot resume recovery', () => {
    const source = `
      import { speculateRedTeam } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-extra-seats.mjs')).href)};
      const result = await speculateRedTeam({ repo: ${JSON.stringify(repo)}, pr: ${pr},
        read: { diffText: '+code', netBasis: { rev: ${JSON.stringify(head)} } }, resumeOnly: true, env: {} }, {
        now: () => 1000, log: () => {}, readRecords: () => [{ dispatchKind: 'review-seat',
          seat: 'red-team', repo: 'frontier-ui/frontierui', pr: ${pr}, rev: ${JSON.stringify(head)}, status: 'ok' }],
        cliAvailable: () => { throw Error('must refuse before provider selection'); },
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const io = fakeIo({ runRedTeam: vi.fn(() => JSON.parse(execFileSync(process.execPath,
      ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '' } }))) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).redTeam)
      .toMatchObject({ status: 'skipped', reason: expect.stringContaining('no clean prior red-team row') });
    expect(io.runRedTeam).toHaveBeenCalledOnce();
  });
  it.each(['snapshot', 'reservation', 'quota-hold', 'reservation-error'].flatMap(cap => [true, false].map(redTeamOnly => ({ cap, redTeamOnly }))))(
    'retries after the $cap deferral clears (initial red-team-only=$redTeamOnly)', ({ cap, redTeamOnly }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-cap-retry-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const read = () => readRedTeamStatus({ repo, pr, head, env });
      const loopPayload = payload();
      Object.assign(loopPayload, { stopped: 'complete', runId: 'review-pr-cap' });
      Object.assign(loopPayload.findings.read, { diffText: '+export const value = true;', netChangedFiles: ['x.mjs'] });
      const review = { ...loopPayload, op: 'review-pr', input: { repo, pr } };
      writeFileSync(join(dir, 'review-pr-cap.json'), JSON.stringify(review));
      let at = Date.parse('2026-10-23T15:00:00Z');
      let observed = { rows: [], comments: [], modelCalls: 0 };
      const evidence = () => readDrainRedTeamEvidence({ repo, pr, head, env, runsDir: dir,
        list: () => ['review-pr-cap'], read: () => review, readScorecards: () => observed.rows });
      const source = `
        import { readFileSync } from 'node:fs';
        import { runRedTeam, reserveSeatCalls } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-extra-seats.mjs')).href)};
        const { input, at, cap, saved, status } = JSON.parse(readFileSync(0, 'utf8'));
        const spent = { dispatchKind: 'review-seat', seat: 'juror', provider: 'codex', status: 'ok',
          callId: 'spent', scoredAt: '2026-10-23T15:00:00Z' };
        const held = { ...spent, status: 'quota-exhausted', quotaResetsAt: '2026-10-23T16:00:00Z' };
        const records = [...(cap === 'snapshot' ? [spent] : cap === 'quota-hold' ? [held] : []), ...saved.rows];
        const ledger = { version: 1, reservations: [{ callId: 'spent', provider: 'codex', at: spent.scoredAt }] };
        const result = await runRedTeam({ ...input, env: { WE_REVIEW_SEAT_CAP_CODEX: cap === 'quota-hold' ? '100' : '1' } }, {
          now: () => at, log: () => {}, readRecords: () => records,
          readRedTeamStatus: () => status,
          readRecoveryComments: () => saved.comments,
          cliAvailable: provider => provider === 'codex',
          reserveCalls: options => {
            if (cap === 'reservation-error' && at < Date.parse('2026-10-24T15:00:00Z')) throw Error('reservation EIO');
            return reserveSeatCalls({ ...options, records, ledger, newId: () => 'retry-call' });
          },
          makeScratch: () => '/fixture', removeScratch: () => {}, writeFile: () => {}, readHeadMessage: () => '',
          runSeat: async () => { saved.modelCalls++; return { report: { exitCode: 0,
            lastMessage: JSON.stringify({ lenses: { 'red-team': { verdict: 'accept', findings: [] } } }) } }; },
          runRecheck: () => { throw Error('empty findings need no recheck'); },
          append: row => saved.rows.push(row), logTrial: () => {},
          listComments: () => saved.comments,
          postComment: ({ body }) => saved.comments.push({ body, author: { login: 'web-everything' } }),
        });
        process.stdout.write(JSON.stringify({ ...saved, result }));
      `;
      const io = fakeIo({
        readRedTeamOnlyPayload: () => ({ head, loopPayload }),
        redTeamStatus: vi.fn(createReviewJobIo({ env, readEvidence: evidence }).redTeamStatus),
        clearRedTeamQueued: vi.fn(createReviewJobIo({ env }).clearRedTeamQueued),
        runLoop: () => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' }),
        runRedTeam: input => {
          expect(read()).toMatchObject({ status: 'queued', result: null });
          observed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
            input: JSON.stringify({ input, at, cap, saved: observed, status: read() }), encoding: 'utf8',
            timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '' },
          }));
          return observed.result;
        },
      });
      const history = new Map();
      let job;
      const recover = () => runRedTeamOnSkip({ repo,
        plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
        rawPrs: [{ number: pr, headRefOid: head, comments: observed.comments }],
        readEvidence: evidence, readStatus: read,
        setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: history, now: () => at,
        capacity: { lanes: 1 }, dispatch: options => { job = runReviewJob(options, io); return { jobPid: 42 }; },
      });
      try {
        if (redTeamOnly) expect(recover().dispatched).toHaveLength(1);
        else job = runReviewJob({ repo, pr }, io);
        const reason = cap === 'quota-hold' ? 'quota' : cap === 'reservation-error' ? 'no call launched' : 'daily-cap:';
        expect(job.redTeam).toMatchObject({ status: 'skipped', deferredByCap: true, reason: expect.stringContaining(reason) });
        expect(observed.modelCalls).toBe(0);
        expect(observed.rows).toEqual([]);
        expect(observed.comments).toEqual([]);
        expect(read()).toBeNull();
        expect(io.clearRedTeamQueued).toHaveBeenCalledOnce();
        expect(io.clearRedTeamQueued).toHaveBeenCalledWith({ repo, pr, head });
        expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(['queued']);
        expect(evidence()).toMatchObject({ scheduled: true, recorded: false, inFlight: false });
        expect(io.runRedTeamGate).toHaveBeenCalledOnce();
        expect(io.runRedTeamGate).toHaveBeenCalledWith({ repo, pr });
        expect(job.redTeamGate).toEqual({ status: 'ok', outcome: 'advisory' });
        if (redTeamOnly) expect(recover().rows[0].why).toBe('retry cooldown active');
        at += cap === 'quota-hold' ? 60 * 60_000 + 1 : 24 * 60 * 60_000;
        expect(recover().dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
        expect(job.redTeam).toMatchObject({ status: 'ran', comment: 'posted' });
        expect(observed.modelCalls).toBe(1);
        expect(read()).toMatchObject({ status: 'finished', result: 'ran' });
        expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(['queued', 'queued', 'finished']);
        expect(redTeamForHead(observed.comments, pr, head)).toMatchObject({ pr, rev: head });
        expect(io.runRedTeamGate).toHaveBeenCalledTimes(2);
        expect(recover().dispatched).toEqual([]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it.each(['fresh', 'resume'].flatMap(redTeamMode => ['clean', 'degraded', 'read-error'].map(gateCase => ({ redTeamMode, gateCase }))))(
    '$redTeamMode recovery preserves acceptance, review:human and completion through the real gate ($gateCase)', ({ redTeamMode, gateCase }) => {
      // The job invokes the asynchronous gate in a synchronous child in production.
      // Keep that boundary, replacing only the gate's external IO and label provider.
      const operationsUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../')).href;
      const source = `
        import { applyRedTeamGate } from ${JSON.stringify(`${operationsUrl}red-team-gate-apply.mjs`)};
        import { renderRedTeamComment } from ${JSON.stringify(`${operationsUrl}review-extra-seats.mjs`)};
        import { syncRedTeamStatusLabels } from ${JSON.stringify(new URL('../lib/red-team-status-labels.mjs', operationsUrl).href)};
        const { repo, pr, head, gateCase } = JSON.parse(process.argv[1]);
        const labels = new Set(['review:accepted', 'review:human', 'red-team:pending']);
        const mutations = [], effects = [];
        const comments = [{ author: { login: 'web-everything' }, body: renderRedTeamComment({
          pr, rev: head, provider: 'codex', model: 'fixture', foldedVerdict: 'accept', recheckStatus: 'ok',
          findings: gateCase === 'degraded' ? [{ summary: 'follow-up', category: 'edge-case',
            impactIfUnfixed: 'degraded', confirmedByRecheck: true, file: 'scripts/example.mjs', line: 1 }] : [],
        }) }];
        const live = () => ({ headRefOid: head, labels: [...labels], comments });
        const provider = {
          readPrState: live, readComments: () => comments, ensureLabel: () => {},
          setLabels: (_repo, _pr, change) => {
            mutations.push(change);
            for (const name of change.remove) labels.delete(name);
            if (change.add) labels.add(change.add);
          },
        };
        const result = await applyRedTeamGate({ repo, pr }, {
          readPr: () => { if (gateCase === 'read-error') throw Error('fixture read error'); return live(); },
          readGrantScope: () => null,
          readSetting: () => ({ value: { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' } }),
          readHead: () => head, readRound: () => 1,
          sendBack: () => { effects.push('sendBack'); return { ok: true }; },
          appendSendBackEvent: () => effects.push('verdict'),
          dequeueSentBack: () => effects.push('dequeue'),
          fileCard: () => { effects.push('card'); return { ok: true, session: 'fixture-card' }; },
          postComment: ({ body }) => comments.push({ author: { login: 'web-everything' }, body }),
          log: () => {},
          syncStatusLabels: input => syncRedTeamStatusLabels({ ...input, provider,
            env: { WE_RED_TEAM_STATUS_LABELS: '1' }, standingRuling: null }),
        });
        process.stdout.write(JSON.stringify({ result, labels: [...labels], mutations, effects }));
      `;
      const completion = { status: 'done', outcome: 'parked', verdict: 'accept' };
      const before = { ...completion };
      let gate;
      const io = fakeIo({
        readPrevCompletion: () => completion,
        report: vi.fn(flags => Object.assign(completion, flags)),
        runRedTeamGate: vi.fn(() => {
          gate = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source,
            JSON.stringify({ repo, pr, head, gateCase })], {
            encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '' },
          }));
          return gate.result;
        }),
      });
      const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io);
      expect(out.outcome).toBe('red-team-only');
      expect(io.runRedTeamGate).toHaveBeenCalledOnce();
      expect(io.runRedTeamGate).toHaveBeenCalledWith({ pr, repo });
      expect(out.redTeamGate.status).toBe(gateCase === 'clean' ? 'advisory-only' : gateCase === 'degraded' ? 'applied' : 'error');
      expect(gate.labels).toEqual(expect.arrayContaining(['review:accepted', 'review:human']));
      expect(gate.mutations.flatMap(({ remove }) => remove)).not.toContain('review:human');
      expect(gate.mutations.flatMap(({ add, remove }) => [add, ...remove]).filter(name => name?.startsWith('review:'))).toEqual([]);
      expect(gate.effects).toEqual(gateCase === 'degraded' ? ['card'] : []);
      if (gateCase !== 'read-error') expect(gate.mutations).toEqual([{ add: 'red-team:clear', remove: ['red-team:pending'] }]);
      expect(completion).toEqual(before);
      for (const hook of ['report', 'runLoop', 'runExtraSeats', 'restampVerdict']) expect(io[hook]).not.toHaveBeenCalled();
      // These are live-job lease operations, not review completion writes.
      expect(io.updateRecord).toHaveBeenCalledOnce();
      expect(io.updateRecord.mock.calls[0][0]).not.toHaveProperty('outcome');
      expect(io.unclaim).toHaveBeenCalledOnce();
      expect(io.unclaim).toHaveBeenCalledWith(`review-${pr}`, process.pid);
    });
  it.each([null, {}, { inFlight: true }, { inFlight: false, queued: true }])(
    'does not recover a queued resume on live or unknown liveness %j', evidence => {
      const status = { status: 'queued', result: 'ran', pid: 42 };
      expect(readRedTeamRecoveryStatus({ repo, pr, head }, {
        readStatus: () => status, readEvidence: () => evidence,
      })).toBe(status);
    });
  it('fails closed when queued resume liveness is unreadable', () => {
    expect(() => readRedTeamRecoveryStatus({ repo, pr, head }, {
      readStatus: () => ({ status: 'queued', result: 'ran', pid: 42 }),
      readEvidence: () => { throw Error('unreadable'); },
    })).toThrow('unreadable');
  });
  it.each(['mismatched', 'missing', 'not-owed', 'head-drift'])('refuses %s evidence without running any seats', kind => {
    const loopPayload = payload();
    if (['mismatched', 'head-drift'].includes(kind)) loopPayload.findings.read.netBasis.rev = 'b'.repeat(40);
    if (kind === 'not-owed') loopPayload.verdict.verdict = 'changes';
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head: kind === 'head-drift' ? 'b'.repeat(40) : head,
      loopPayload: kind === 'missing' ? null : loopPayload }) });
    const out = runReviewJob({ pr, repo, redTeamOnly: true }, io);
    expect(out.outcome).toBe('red-team-not-owed'); expect(out.reason).toBeTruthy();
    for (const hook of ['fetchRedTeamHead', 'runLoop', 'runExtraSeats', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus', 'report']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it('fails closed on unreadable stored evidence and releases its lane', () => {
    const io = fakeIo({ readRedTeamOnlyPayload: () => { throw Error('unreadable'); } });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io).outcome).toBe('blocked-on-infra');
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.report).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce();
  });
  it('still refuses a live job before acquiring a lane', () => {
    const io = fakeIo({ claim: () => ({ ok: false, heldBy: 99 }) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io).outcome).toBe('refused-live-job');
    expect(io.acquireLane).not.toHaveBeenCalled(); expect(io.runRedTeam).not.toHaveBeenCalled();
  });
});

describe('accepted head-move full review dispatch', () => {
  it('plain recovery dispatch spawns an ordinary job and runs its full loop plus red team', () => {
    const dir = mkdtempSync(join(tmpdir(), 'accepted-head-review-'));
    const io = fakeIo({ runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify({ ...payload(), stopped: 'complete' }) })) });
    const spawnJob = vi.fn(() => {
      runReviewJob({ pr, repo }, io);
      return 4242;
    });
    try {
      const old = 'b'.repeat(40);
      const result = runRedTeamOnSkip({ repo,
        plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
        rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted'], reviews: [], comments: [
          { body: `✅ review — accepted\n<!-- reviewed-sha: ${old} -->`, author: { login: 'web-everything' } },
          { body: `${redTeamMarker(pr, old)}\nRed team not required on this head: card-only diff`, author: { login: 'web-everything' } },
        ] }],
        readEvidence: () => ({ inFlight: false, recorded: false, seatRecorded: false }), readStatus: () => null,
        setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(),
        capacity: { lanes: 1, budget: { left: 1 } },
        dispatch: options => dispatchReviewJob({ ...options, root: '/daemon', dir,
          checkStaleness: () => ({ fresh: true, behind: 0 }), readCompletion: () => null,
          resolveSettingsEnv: () => ({}), ciGate: () => ({ allowed: true }), spawnJob }),
      });
      expect(result.rows[0].action).toBe('review');
      expect(spawnJob).toHaveBeenCalledTimes(1);
      expect(spawnJob.mock.calls[0][0].argv).not.toEqual(expect.arrayContaining([expect.stringContaining('--red-team-only')]));
      expect(io.runLoop).toHaveBeenCalledTimes(1);
      expect(io.runRedTeam).toHaveBeenCalledTimes(1);
      expect(io.readRedTeamOnlyPayload).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('red-team-only dispatch', () => {
  function withDispatch(run) {
    const dir = mkdtempSync(join(tmpdir(), 'review-red-team-only-'));
    const options = { pr, repo, redTeamOnly: true, root: '/daemon', dir,
      checkStaleness: () => ({ fresh: true, behind: 0 }), readCompletion: () => null,
      resolveSettingsEnv: () => ({}), ciGate: vi.fn(() => ({ allowed: false })), spawnJob: vi.fn(() => 4242) };
    try { run(options); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it.each(['fresh', 'resume'].flatMap(redTeamMode => [false, true].map(redTeamStaleRecovery => ({ redTeamMode, redTeamStaleRecovery }))))(
    'passes --red-team-only=$redTeamMode and preferred lane, skipping CI admission (stale=$redTeamStaleRecovery)', ({ redTeamMode, redTeamStaleRecovery }) => withDispatch(options => {
    const out = dispatchReviewJob({ ...options, redTeamMode, redTeamStaleRecovery, preferLane: 7 });
    expect(out.jobPid).toBe(4242); expect(options.ciGate).not.toHaveBeenCalled();
    expect(options.spawnJob.mock.calls[0][0].argv).toEqual(expect.arrayContaining(['run', `--pr=${pr}`, `--repo=${repo}`, `--red-team-only=${redTeamMode}`, '--prefer-lane=7']));
    expect(options.spawnJob.mock.calls[0][0].argv.includes('--red-team-stale-recovery')).toBe(redTeamStaleRecovery);
  }));
  it('still skips live-job with the same slug and record', () => withDispatch(options => {
    writeJobRecord({ slug: `review-${pr}`, pr, repo, pid: 99, cwd: '/daemon', startedAt: new Date().toISOString() }, options.dir);
    expect(dispatchReviewJob({ ...options, isAlive: () => true }).skipped).toBe('live-job');
    expect(options.spawnJob).not.toHaveBeenCalled(); expect(options.ciGate).not.toHaveBeenCalled();
  }));
  it('retains lane cool-off', () => withDispatch(options => {
    expect(dispatchReviewJob({ ...options, now: 1_000_000,
      readCompletion: () => ({ status: 'done', outcome: 'blocked-on-infra', label: 'lane-deferrals:5', updatedAt: new Date(999_000).toISOString() }) }).skipped).toBe('lane-cooloff');
    expect(options.spawnJob).not.toHaveBeenCalled();
  }));
});


describe('red-team child resume enforcement', () => {
  it.each([
    [undefined, []],
    ['fresh', ['--red-team-mode=fresh']],
    ['resume', ['--resume-only', '--red-team-mode=resume']],
  ].flatMap(([redTeamMode, modeArgs]) => [undefined, true].map(redTeamStaleRecovery => [redTeamMode, modeArgs, redTeamStaleRecovery])))(
    'builds exact child argv for %s mode (%j, stale=%s)', (redTeamMode, modeArgs, redTeamStaleRecovery) => {
    const loopFile = `review-${pr}.red-team.loop.json`;
    expect(redTeamRunnerArgs({ pr, repo, lanePath: '/lanes/lane-7', loopFile, redTeamMode, redTeamStaleRecovery })).toEqual([
      'scripts/operations/review-extra-seats.mjs', 'red-team', `--pr=${pr}`, `--repo=${repo}`,
      '--lane=/lanes/lane-7', `--loop-json=${loopFile}`, ...modeArgs,
      ...(redTeamStaleRecovery === true ? ['--red-team-stale-recovery'] : []),
    ]);
  });
  it.each(['fresh', 'resume'])('carries the exact pre-queue %s evidence to the shared child argv', redTeamMode => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-mode-plumbing-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const result = { status: 'ran', comment: { status: 'error' } };
    try {
      if (redTeamMode === 'resume') recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result }, { env });
      const prior = readRedTeamStatus({ repo, pr, head, env });
      const real = createReviewJobIo({ env, readEvidence: () => ({ inFlight: false }) });
      const io = fakeIo({ redTeamStatus: real.redTeamStatus });
      expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io).redTeam.status).toBe('ran');
      expect(io.runRedTeam).toHaveBeenCalledOnce();
      const input = io.runRedTeam.mock.calls[0][0];
      const admission = { pid: process.pid, prior: prior == null ? null : { repo, pr, head, status: 'finished', result } };
      expect(input).toEqual({ pr, repo, lanePath: '/lanes/lane-7', loopPayload: payload(), slug: `review-${pr}`,
        redTeamMode, redTeamAdmission: admission });
      expect(redTeamRunnerArgs({ ...input, loopFile: 'loop.json' })).toEqual([
        'scripts/operations/review-extra-seats.mjs', 'red-team', `--pr=${pr}`, `--repo=${repo}`,
        '--lane=/lanes/lane-7', '--loop-json=loop.json', ...(redTeamMode === 'resume' ? ['--resume-only'] : []),
        `--red-team-mode=${redTeamMode}`, `--red-team-admission=${JSON.stringify(admission)}`,
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['fresh', 'resume'])('forwards %s mode to the red-team-only job hook', redTeamMode => {
    const io = fakeIo({
      runRedTeam: vi.fn(() => ({ status: 'skipped' })) });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io);
    expect(out.outcome).toBe('red-team-only');
    expect(io.runRedTeam).toHaveBeenCalledOnce();
    expect(io.runRedTeam).toHaveBeenCalledWith({ pr, repo, lanePath: '/lanes/lane-7',
      loopPayload: payload(), slug: `review-${pr}`, redTeamMode });
    expect(io.runRedTeam).toHaveReturnedWith({ status: 'skipped' });
    expect(out.redTeam).toMatchObject({ status: 'skipped' });
    expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(['queued', 'finished']);
    for (const hook of ['runLoop', 'runExtraSeats', 'startSpeculativeRedTeam', 'report', 'restampVerdict']) expect(io[hook]).not.toHaveBeenCalled();
  });
});


describe('PR 5890 persisted review-pr recovery rows', () => {
  it('fresh admission drops bare resumed provenance and reaches normal red-team dispatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-pr-bare-resumed-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const loopPayload = { ...payload(), op: 'review-pr' };
    Object.assign(loopPayload.findings.read, { diffText: '+code', netChangedFiles: ['scripts/example.mjs'] });
    const status = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env });
    let observed;
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload }),
      redTeamStatus: production.redTeamStatus,
      runRedTeam: input => {
        observed = runSharedRecovery(input, { status: status(), records: [] });
        return observed.result;
      },
    });
    try {
      recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: 'resumed' }, { env });
      const out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io);
      // The provider sentinel proves admission reached the normal dispatch path;
      // no actual provider or paid call is available in this fixture.
      expect(out.redTeam).toMatchObject({ status: 'error', reason: 'unexpected provider' });
      expect(observed.calls).toEqual({ provider: 1, reserve: 0, model: 0, recheck: 0 });
      expect(io.runRedTeamGate).toHaveBeenCalledOnce();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('moved card-only skip settlement', () => {
  it('production carry adapter retries a lost comment reply through paged marker reads without repeating effects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'carry-adapter-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_SKIP_CARD_ONLY: '1' };
    const fromSha = 'b'.repeat(40), comments = [], labels = ['red-team:pending'];
    const old = { verdict: { verdict: 'changes' }, findings: { read: {
      netBasis: { rev: fromSha }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
    } } };
    const carried = { ...old, carriedFrom: fromSha, verdict: null,
      findings: { read: { ...old.findings.read, netBasis: { rev: head } } } };
    const exec = vi.fn((file, args, options) => {
      if (file === 'git') {
        expect(options.cwd).toBe('/lanes/lane-7');
        if (args[0] === 'merge-base') return '';
        if (args[0] === 'rev-list') return `${head} ${fromSha}`;
        if (args[0] === 'diff-tree') return 'backlog/123-card.md\0';
        throw Error('not numbering');
      }
      expect(file).toBe('gh');
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head, labels });
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: comments.length } } } } });
      if (args[0] === 'api') return comments.map(comment => [
        comment.body.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t'),
        '2026-10-26T00:00:00Z', comment.author.login, comment.id, '',
      ].join('\t')).join('\n');
      if (args[0] === 'label') return '';
      if (args[1] === 'edit') { labels.splice(0, labels.length, 'red-team:clear'); return ''; }
      if (args[1] === 'comment') {
        expect(args).toContain('--body-file');
        comments.push({ id: 'IC_carry', body: options.input, author: { login: 'web-everything' } });
        throw Error('lost comment reply');
      }
      throw Error(`unexpected command ${file}`);
    });
    try {
      writeRun({ ...newRunRecord({ id: 'review-pr-adapter', op: 'review-pr', input: { repo, pr } }), ...old }, env.WE_SHARED_RUNS_DIR);
      recordRedTeamStatus({ repo, pr, loopPayload: old, status: 'finished', result: 'skipped' }, { env });
      const io = createReviewJobIo({ root: dir, env, exec,
        readEvidence: key => readDrainRedTeamEvidence({ ...key, runsDir: env.WE_SHARED_RUNS_DIR, readScorecards: () => [] }) });
      const input = { repo, pr, head, readHead: head, redTeam: { status: 'skipped', policy: 'card-only' },
        carry: { loopPayload: carried, lanePath: '/lanes/lane-7' } };
      expect(io.settleRedTeamSkip(input).outcome).toBe('non-policy');
      expect(readRedTeamCarry({ repo, pr, head, env }).step).toBe('label');
      expect(io.settleRedTeamSkip(input).outcome).toBe('policy-clear');
      expect(io.settleRedTeamSkip(input).outcome).toBe('already');
      expect(readRedTeamCarry({ repo, pr, head, env }).step).toBe('done');
      expect(exec.mock.calls.filter(([file, args]) => file === 'gh' && args[1] === 'edit')).toHaveLength(1);
      expect(exec.mock.calls.filter(([file, args]) => file === 'gh' && args[1] === 'comment')).toHaveLength(1);
      expect(readRedTeamStatus({ repo, pr, head, env }).loopPayload.verdict).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['after-intent', 'after-label', 'after-comment', 'before-done',
    'lost-intent-reply', 'lost-label-reply', 'lost-comment-reply'].flatMap(boundary =>
    ['accept', 'changes'].map(verdict => ({ boundary, verdict }))))(
    'job and planner resume a $verdict carry after $boundary without a model', ({ boundary, verdict }) => {
      const dir = mkdtempSync(join(tmpdir(), 'carry-job-crash-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_SKIP_CARD_ONLY: '1' };
      const fromSha = 'b'.repeat(40), comments = [], labels = [];
      const loopPayload = { verdict: { verdict }, findings: { read: {
        netBasis: { rev: fromSha }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
      } } };
      const evidence = key => readDrainRedTeamEvidence({ ...key, env, runsDir: env.WE_SHARED_RUNS_DIR, readScorecards: () => [] });
      let crash = true;
      const checkpoint = step => { if (crash && step === boundary) throw Error('crash'); };
      const writeStatus = vi.fn((value, options) => {
        recordRedTeamStatus(value, options);
        checkpoint('lost-intent-reply');
      });
      const applyLabel = vi.fn(() => {
        labels.push('red-team:clear');
        checkpoint('lost-label-reply');
      });
      const postResult = vi.fn(({ body }) => {
        comments.push({ body, author: { login: 'web-everything' } });
        checkpoint('lost-comment-reply');
      });
      const carryIo = () => createRedTeamCarryIo({ env, readEvidence: evidence,
        readLive: () => ({ headRefOid: head, labels }), readComments: () => comments,
        proveMove: () => ({ ok: true }), writeStatus, applyLabel, postResult, checkpoint,
      });
      const io = fakeIo({ readRedTeamOnlyPayload: key => ({ ...evidence(key), head }),
        redTeamSkipCardOnlySetting: () => true, proveCardOnlyHeadMove: () => ({ ok: true }),
        settleRedTeamSkip: input => settleRedTeamSkip({ ...input, io: {
          env, carry: carryIo(), publishNeedsYou: vi.fn(),
        } }),
      });
      try {
        writeRun({ ...newRunRecord({ id: 'review-pr-carry-crash', op: 'review-pr', input: { repo, pr } }), ...loopPayload }, env.WE_SHARED_RUNS_DIR);
        recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: 'skipped' }, { env });
        expect(runReviewJob({ repo, pr, redTeamOnly: true }, io).redTeam.outcome).toBe('non-policy');
        expect(readRedTeamCarry({ repo, pr, head, env }).step).not.toBe('done');
        expect(planRedTeamOnSkip({ repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
          rawPrs: [{ number: pr, headRefOid: head, comments }], readEvidence: evidence,
          readStatus: key => readRedTeamStatus({ ...key, env }), proveMove: () => ({ ok: true }),
          readCarry: key => readRedTeamCarry({ ...key, env }),
          setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map(), now: 1000,
        })[0]).toMatchObject({ action: 'dispatch', mode: 'fresh' });
        crash = false;
        expect(runReviewJob({ repo, pr, redTeamOnly: true }, io).redTeam.outcome).toBe('policy-clear');
        expect(readRedTeamCarry({ repo, pr, head, env }).step).toBe('done');
        expect(readRedTeamStatus({ repo, pr, head, env }).loopPayload.verdict).toBeNull();
        expect(writeStatus).toHaveBeenCalledTimes(1);
        expect(applyLabel).toHaveBeenCalledTimes(1);
        expect(postResult).toHaveBeenCalledTimes(1);
        expect(labels).toEqual(['red-team:clear']);
        expect(comments).toHaveLength(1);
        expect(io.redTeamStatus).not.toHaveBeenCalled();
        expect(io.runRedTeam).not.toHaveBeenCalled();
        expect(io.runLoop).not.toHaveBeenCalled();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it.each(['card-only', 'numbering-only', 'settlement retry'].flatMap(kind =>
    ['changes', 'accept'].flatMap(verdict => ['before execution', 'during fetch'].map(policyChange => ({ kind, verdict, policyChange }))))) (
    'live policy off $policyChange refuses $kind recovery of $verdict without settlement or a comment', ({ kind, verdict, policyChange }) => {
      const fromSha = 'b'.repeat(40), comments = [];
      const env = { WE_RED_TEAM_SKIP_CARD_ONLY: '1' };
      const production = createReviewJobIo({ env });
      const readHead = kind === 'settlement retry' ? head : fromSha;
      const loopPayload = { verdict: { verdict }, findings: { read: {
        netBasis: { rev: readHead }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
      } }, ...(kind === 'settlement retry' ? { carriedFrom: fromSha, verdict: null } : {}) };
      const evidence = { head, loopPayload, recorded: false, seatRecorded: false,
        status: { head: readHead, status: 'finished', result: 'skipped', skipCardOnly: true, loopPayload } };
      const io = fakeIo({ readRedTeamOnlyPayload: () => evidence,
        redTeamSkipCardOnlySetting: production.redTeamSkipCardOnlySetting,
        proveCardOnlyHeadMove: () => ({ ok: true, kind }),
        fetchRedTeamHead: () => { env.WE_RED_TEAM_SKIP_CARD_ONLY = '0'; return { head }; },
        settleRedTeamSkip: vi.fn(() => comments.push('unexpected policy comment')) });
      // Resolve at execution, not when the IO is created or when the old skip was written.
      if (policyChange === 'before execution') env.WE_RED_TEAM_SKIP_CARD_ONLY = '0';
      expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io).outcome).toBe('red-team-not-owed');
      expect(io.settleRedTeamSkip).not.toHaveBeenCalled();
      expect(io.redTeamStatus).not.toHaveBeenCalled();
      expect(io.runRedTeam).not.toHaveBeenCalled();
      expect(comments).toEqual([]);
    });
  it.each(['missing', 'throwing', 'unknown'])('refuses %s live policy evidence before admission', kind => {
    const fromSha = 'b'.repeat(40);
    const loopPayload = { verdict: null, carriedFrom: fromSha, findings: { read: {
      netBasis: { rev: head }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
    } } };
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload, recorded: false, seatRecorded: false,
      status: { head, status: 'finished', result: 'skipped', skipCardOnly: true, loopPayload } }),
      redTeamSkipCardOnlySetting: kind === 'missing' ? undefined : () => {
        if (kind === 'throwing') throw Error('policy unreadable');
        return undefined;
      }, settleRedTeamSkip: vi.fn() });
    expect(runReviewJob({ repo, pr, redTeamOnly: true }, io).outcome).toBe('red-team-not-owed');
    expect(io.redTeamStatus).not.toHaveBeenCalled();
    expect(io.settleRedTeamSkip).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
  });
  it.each(['fresh', 'resume'])('a carried accepting payload cannot fall through to a model in %s mode', redTeamMode => {
    const loopPayload = { ...payload(), carriedFrom: 'b'.repeat(40) };
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload }), settleRedTeamSkip: vi.fn() });
    expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode }, io).outcome).toBe('red-team-not-owed');
    expect(io.redTeamStatus).not.toHaveBeenCalled();
    expect(io.settleRedTeamSkip).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
  });
  it.each([
    ['missing status', evidence => { evidence.status = null; }],
    ['wrong status head', evidence => { evidence.status.head = 'b'.repeat(40); }],
    ['wrong read head', evidence => { evidence.loopPayload.findings.read.netBasis.rev = 'b'.repeat(40); }],
    ['non-card paths', evidence => { evidence.loopPayload.findings.read.netChangedFiles = ['scripts/code.mjs']; }],
    ['code rename source', evidence => { evidence.loopPayload.findings.read.netRenameSources = ['scripts/code.mjs']; }],
    ['missing diff', evidence => { evidence.loopPayload.findings.read.diffText = ''; }],
    ['policy absent', evidence => { evidence.status.result = { status: 'skipped' }; }],
    ['policy disabled', evidence => { evidence.status.skipCardOnly = false; }],
    ['unfinished', evidence => { evidence.status.status = 'queued'; }],
    ['recorded result', evidence => { evidence.recorded = true; }],
    ['recorded seat', evidence => { evidence.seatRecorded = true; }],
    ['unknown seats', evidence => { delete evidence.seatRecorded; }],
    ['in flight', evidence => { evidence.inFlight = true; }],
    ['queued', evidence => { evidence.queued = true; }],
  ])('non-accept settlement retry fails closed for %s in planner and job', (_name, mutate) => {
    const loopPayload = { verdict: { verdict: 'changes' }, findings: { read: {
      netBasis: { rev: head }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
    } } };
    const evidence = { head, loopPayload, recorded: false, seatRecorded: false,
      status: { head, status: 'finished', result: { status: 'skipped', policy: 'card-only' },
        skipCardOnly: true, loopPayload } };
    mutate(evidence);
    expect(planRedTeamOnSkip({ repo,
      refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
      rawPrs: [{ number: pr, headRefOid: head, comments: [] }],
      readEvidence: () => evidence, readStatus: () => evidence.status,
      setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(),
    })[0].action).toBe('skip');
    const io = fakeIo({ readRedTeamOnlyPayload: () => evidence, settleRedTeamSkip: vi.fn() });
    expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io).outcome).toBe('red-team-not-owed');
    expect(io.settleRedTeamSkip).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
  });
  it('production readRedTeamOnlyPayload preserves historical status, recorded and seatRecorded evidence with the live head', () => {
    const root = mkdtempSync(join(tmpdir(), 'moved-card-io-read-'));
    const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), CONVEYOR_STATE_ROOT: root,
      WE_RED_TEAM_SKIP_CARD_ONLY: '1' };
    const fromSha = 'b'.repeat(40);
    const loopPayload = { verdict: { verdict: 'changes' }, findings: { read: {
      netBasis: { rev: fromSha }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
    } } };
    try {
      vi.stubEnv('WE_SHARED_RUNS_DIR', env.WE_SHARED_RUNS_DIR);
      vi.stubEnv('OPERATION_RUNS_DIR', env.WE_SHARED_RUNS_DIR);
      writeRun({ ...newRunRecord({ id: 'review-pr-moved-card', op: 'review-pr', input: { repo, pr } }),
        ...loopPayload }, env.WE_SHARED_RUNS_DIR);
      recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: 'skipped' }, { env });
      const io = createReviewJobIo({ root, env, exec: () => { throw Error('payload read must not execute commands'); } });
      expect(io.readRedTeamOnlyPayload({ repo, pr, head })).toMatchObject({ head, loopPayload,
        recorded: false, seatRecorded: false, completedRecorded: false, inFlight: false,
        status: { head: fromSha, status: 'finished', result: 'skipped', skipCardOnly: true } });
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });
  it('production proveCardOnlyHeadMove reads every Git object in the review lane with hardened Git env, never the daemon root', () => {
    const root = mkdtempSync(join(tmpdir(), 'moved-card-io-proof-')), fromSha = 'b'.repeat(40);
    const lanePath = join(root, 'lane');
    const exec = vi.fn((file, args, options) => {
      expect(file).toBe('git');
      expect(options.cwd).toBe(lanePath);
      expect(options.env.GIT_NO_LAZY_FETCH).toBe('1');
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'rev-list') return `${head} ${fromSha}`;
      if (args[0] === 'diff-tree') return 'backlog/123-card.md\0';
      throw Error('not numbering');
    });
    try {
      const io = createReviewJobIo({ root, env: { WE_SHARED_RUNS_DIR: join(root, 'runs') }, exec });
      expect(io.proveCardOnlyHeadMove({ fromSha, toSha: head, lanePath })).toMatchObject({ ok: true, kind: 'card-only' });
      expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['diff-tree', '--no-renames', head]),
        expect.objectContaining({ cwd: lanePath, timeout: 10_000, maxBuffer: 1024 * 1024 }));
      exec.mockClear();
      for (const missing of [undefined, '', null]) {
        expect(io.proveCardOnlyHeadMove({ fromSha, toSha: head, lanePath: missing })).toEqual({ ok: false });
      }
      expect(exec).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('production proveCardOnlyHeadMove proves a real numbering move that rewrites a doc reference with its default reader', () => {
    const root = mkdtempSync(join(tmpdir(), 'moved-card-io-numbering-'));
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    const commit = message => { git(['add', '-A']); git(['commit', '-q', '-m', message]); return git(['rev-parse', 'HEAD']); };
    try {
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Moved Card Test']);
      write('backlog/xabcdef-card.md', '---\nkind: story\n---\nbody\n');
      write('docs/agent/testing.md', 'See xabcdef.\n');
      const fromSha = commit('card');
      git(['update-ref', 'refs/remotes/origin/main', fromSha]);
      git(['mv', 'backlog/xabcdef-card.md', 'backlog/7001-card.md']);
      write('backlog/7001-card.md', '---\nbornAs: xabcdef\nkind: story\n---\nbody\n');
      write('docs/agent/testing.md', 'See 7001.\n');
      const toSha = commit('drain: JIT-number xabcdef→#7001 at land (#2288)');
      // The planner's reader proves it; the job's default reader must reach the same verdict.
      expect(proveCardOnlyHeadMove({ exec: execFileSync, cwd: root, fromSha, toSha })).toMatchObject({ ok: true, commits: [toSha] });
      // The daemon root is a different (non-repo) directory: the proof must read the lane, where the head was fetched.
      const daemonRoot = mkdtempSync(join(tmpdir(), 'moved-card-io-daemon-'));
      try {
        const io = createReviewJobIo({ root: daemonRoot, env: { ...process.env, WE_SHARED_RUNS_DIR: join(daemonRoot, 'runs') } });
        expect(io.proveCardOnlyHeadMove({ fromSha, toSha, lanePath: root })).toMatchObject({ ok: true, commits: [toSha] });
      } finally { rmSync(daemonRoot, { recursive: true, force: true }); }
      expect(Buffer.isBuffer(execReadRaw('git', ['cat-file', 'blob', `${toSha}:docs/agent/testing.md`], { cwd: root, encoding: null })))
        .toBe(true);
      expect(execReadRaw('git', ['rev-parse', 'HEAD'], { cwd: root }).trim()).toBe(toSha);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true].flatMap(failFirstComment => ['changes', 'accept'].map(verdict => ({ failFirstComment, verdict }))))(
    'fresh recovery settles a moved $verdict skip, retrying a transient comment failure=$failFirstComment without a model', ({ failFirstComment, verdict }) => {
    const dir = mkdtempSync(join(tmpdir(), 'moved-card-skip-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), CONVEYOR_STATE_ROOT: dir,
      WE_RED_TEAM_SKIP_CARD_ONLY: '1' };
    const fromSha = 'b'.repeat(40), comments = [];
    const loopPayload = { verdict: { verdict }, findings: { read: {
      netBasis: { rev: fromSha }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
    } } };
    const exec = vi.fn((file, args, options) => {
      expect(file).toBe('git');
      expect(options.cwd).toBe('/lanes/lane-7');
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'rev-list') return `${head} ${fromSha}`;
      if (args[0] === 'diff-tree') return 'backlog/123-card.md\0';
      throw Error('not numbering');
    });
    const postComment = vi.fn(({ body }) => {
      if (failFirstComment && postComment.mock.calls.length === 1) throw Error('transient comment failure');
      comments.push({ body, author: { login: 'web-everything' } });
    });
    const production = createReviewJobIo({ root: dir, env, exec });
    const labels = [];
    const applyLabel = vi.fn(() => labels.push('red-team:clear'));
    const io = fakeIo({ readRedTeamOnlyPayload: production.readRedTeamOnlyPayload,
      redTeamSkipCardOnlySetting: production.redTeamSkipCardOnlySetting,
      proveCardOnlyHeadMove: vi.fn(production.proveCardOnlyHeadMove),
      redTeamStatus: vi.fn(production.redTeamStatus),
      settleRedTeamSkip: input => settleRedTeamSkip({ ...input, io: { env,
        readComments: () => comments, postComment, publishNeedsYou: vi.fn(),
        carry: createRedTeamCarryIo({ env,
          readEvidence: key => production.readRedTeamOnlyPayload(key),
          readLive: () => ({ headRefOid: head, labels }), readComments: () => comments,
          proveMove: ({ fromSha, toSha }) => production.proveCardOnlyHeadMove({ fromSha, toSha, lanePath: input.carry.lanePath }),
          applyLabel, postResult: postComment,
        }),
      } }),
    });
    try {
      vi.stubEnv('WE_SHARED_RUNS_DIR', env.WE_SHARED_RUNS_DIR);
      vi.stubEnv('OPERATION_RUNS_DIR', env.WE_SHARED_RUNS_DIR);
      writeRun({ ...newRunRecord({ id: 'review-pr-card-settlement', op: 'review-pr', input: { repo, pr } }),
        ...loopPayload }, env.WE_SHARED_RUNS_DIR);
      recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: 'skipped' }, { env });
      expect(readRedTeamStatus({ repo, pr, head, env })).toBeNull();
      let out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io);
      const plan = () => planRedTeamOnSkip({ repo,
        refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
        rawPrs: [{ number: pr, headRefOid: head, comments }],
        readEvidence: () => production.readRedTeamOnlyPayload({ repo, pr, head }),
        readStatus: () => readRedTeamStatus({ repo, pr, head, env }),
        setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(),
      })[0];
      if (failFirstComment) {
        expect(out.redTeam).toMatchObject({ status: 'skipped', policy: 'card-only', outcome: 'non-policy' });
        expect(comments).toHaveLength(0);
        const persisted = readRedTeamStatus({ repo, pr, head, env });
        expect(redTeamSkipNeedsSettlement(persisted)).toBe(true);
        expect(persisted.loopPayload).toMatchObject({ carriedFrom: fromSha, verdict: null,
          findings: { read: { netBasis: { rev: head } } } });
        const evidence = production.readRedTeamOnlyPayload({ repo, pr, head });
        expect(evidence.loopPayload.carriedFrom).toBe(fromSha);
        expect(redTeamOwedFor(evidence.loopPayload)).toBe(false);
        expect(plan()).toMatchObject({ action: 'dispatch', mode: 'fresh' });
        out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io);
        expect(io.proveCardOnlyHeadMove).toHaveBeenCalledTimes(1);
      }
      expect(out.redTeam).toMatchObject({ status: 'skipped', policy: 'card-only', outcome: 'policy-clear' });
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain(redTeamMarker(pr, head));
      expect(applyLabel).toHaveBeenCalledTimes(1);
      expect(plan()).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
      expect(io.proveCardOnlyHeadMove).toHaveBeenCalledWith({ fromSha, toSha: head, lanePath: '/lanes/lane-7' });
      expect(io.runRedTeam).not.toHaveBeenCalled();
      expect(io.runLoop).not.toHaveBeenCalled();
      expect(readRedTeamStatus({ repo, pr, head, env })).toMatchObject({ status: 'finished',
        result: { status: 'skipped', policy: 'card-only' }, loopPayload: { carriedFrom: fromSha, verdict: null } });
      expect(loopPayload.findings.read.netBasis.rev).toBe(fromSha);
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses a moved card-only read if the execution-time proof fails', () => {
    const fromSha = 'b'.repeat(40);
    const loopPayload = { verdict: { verdict: 'changes' }, findings: { read: {
      netBasis: { rev: fromSha }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
    } } };
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload, recorded: false,
      seatRecorded: false, status: { head: fromSha, status: 'finished', result: 'skipped', skipCardOnly: true, loopPayload } }),
      proveCardOnlyHeadMove: () => ({ ok: false }), settleRedTeamSkip: vi.fn() });
    expect(runReviewJob({ repo, pr, redTeamOnly: true }, io).outcome).toBe('red-team-not-owed');
    expect(io.settleRedTeamSkip).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
  });
});


describe('R100 failed-seat recovery admission', () => {
  it('two interleaved admissions launch exactly one model call and preserve the winning status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-atomic-retry-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const loopPayload = payload();
    loopPayload.findings.read.diffText = 'diff --git a/scripts/a.mjs b/scripts/a.mjs\n+code';
    const records = [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' }];
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const evidence = () => ({ inFlight: false, queued: false, seatRecorded: true, recorded: true,
      completedRecorded: false, failedSeatCount: 1 });
    let winner, winningStatus;
    try {
      recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: 'ran' }, { env });
      const stale = read();
      const production = createReviewJobIo({ env, readEvidence: evidence, writeStatus: (input, options) => {
        // Worker A has read the failed status. Worker B admits before A's exclusive create.
        winner = runSharedRecovery({ repo, pr, loopPayload, redTeamMode: 'fresh' },
          { status: stale, records, env, probeFresh: true, failAppend: true, staleStatus: true });
        winningStatus = read();
        recordRedTeamStatus(input, options);
      } });
      const io = fakeIo({ redTeamStatus: production.redTeamStatus,
        readRedTeamOnlyPayload: () => ({ head, loopPayload }) });
      const result = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io);
      expect(winner.calls.model).toBe(1);
      expect(winner.calls.retryCountAtCall).toBe(1);
      expect(io.runRedTeam).not.toHaveBeenCalled();
      expect(result.label).toContain('retry already admitted');
      expect(read()).toEqual(winningStatus);
      // A shared runner that also read the old status must lose the same exclusive claim.
      const loser = runSharedRecovery({ repo, pr, loopPayload, redTeamMode: 'fresh' },
        { status: stale, records, env, probeFresh: true, staleStatus: true });
      expect(loser.calls.model).toBe(0);
      expect(loser.result.reason).toContain('retry already admitted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([true, false])('spends retry before the call even if seat append fails (job admission: %s)', admitted => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-lost-retry-row-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const records = [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' }];
    const evidence = () => ({ inFlight: false, queued: false, loopPayload: payload(),
      recorded: true, seatRecorded: true, completedRecorded: false, failedSeatCount: 1 });
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const production = createReviewJobIo({ env, readEvidence: evidence });
    const loopPayload = payload();
    loopPayload.findings.read.diffText = 'diff --git a/scripts/a.mjs b/scripts/a.mjs\n+code';
    let first;
    try {
      recordRedTeamStatus({ repo, pr, loopPayload, status: 'finished', result: 'ran' }, { env });
      const run = input => runSharedRecovery(input, { status: read(), records, env, probeFresh: true, failAppend: true });
      if (admitted) {
        runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, fakeIo({
          readRedTeamOnlyPayload: () => ({ head, loopPayload }), redTeamStatus: production.redTeamStatus,
          runRedTeam: input => { first = run(input); return first.result; },
        }));
      } else first = run({ repo, pr, loopPayload, redTeamMode: 'fresh' });
      expect(first.calls).toMatchObject({ model: 1, append: 1, retryCountAtCall: 1 });
      expect(records).toHaveLength(1);
      expect(read().retryCount).toBe(1);
      const recovery = runRedTeamOnSkip({ repo, plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
        rawPrs: [{ number: pr, headRefOid: head, comments: [] }], readEvidence: evidence, readStatus: read,
        setting: { enabled: true, retryCooldownMin: 30 }, now: () => 9_000_000, lastDispatch: new Map(),
        dispatch: () => { throw Error('must not dispatch'); } });
      expect(recovery.rows[0].action).toBe('skip');
      const second = run({ repo, pr, loopPayload, redTeamMode: 'fresh' });
      expect(second.calls.model).toBe(0);
      expect(second.result).toMatchObject({ deferredByGuard: true });
      let secondAdmission;
      runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, fakeIo({
        readRedTeamOnlyPayload: () => ({ head, loopPayload }), redTeamStatus: production.redTeamStatus,
        runRedTeam: input => { secondAdmission = run(input); return secondAdmission.result; },
      }));
      expect(secondAdmission.calls.model).toBe(0);
      expect(secondAdmission.result).toMatchObject({ deferredByGuard: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([1, 2].flatMap(retryCount => [0, 1, 2, 'completed'].flatMap(seatCount =>
    ['failed', { status: 'failed' }, 'ran', { status: 'ran' }, 'resumed', { status: 'resumed' }].map(result => ({ retryCount, seatCount, result })))))(
    'spent retry refuses fresh execution with $seatCount seat rows, count=$retryCount, result=$result', ({ retryCount, seatCount, result }) => {
      const loopPayload = payload();
      loopPayload.findings.read.diffText = 'diff --git a/scripts/a.mjs b/scripts/a.mjs\n+code';
      const records = Array.from({ length: seatCount === 'completed' ? 1 : seatCount }, () => ({
        dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: seatCount === 'completed' ? 'ok' : 'unparseable',
      }));
      const observed = runSharedRecovery({ repo, pr, loopPayload, redTeamMode: 'fresh' }, {
        status: { status: 'finished', result, retryCount }, records, probeFresh: true,
        comments: [{ body: `✅ review — accepted\n<!-- reviewed-sha: ${head} -->`, author: { login: 'web-everything' } }],
      });
      expect(observed.result).toMatchObject({ deferredByGuard: true });
      expect(observed.calls).toMatchObject({ model: 0, reserve: 0, provider: 0 });
      expect(observed.comments).toHaveLength(1);
    });

  it.each([1, 2, 3, 'completed'].flatMap(count => ['ran', 'failed'].map(result => ({ count, result }))))(
    'production admission permits one failed seat retry and persists failed over legacy ran: $count ($result)', ({ count, result }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-failed-retry-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const records = Array.from({ length: count === 'completed' ? 1 : count }, () => ({
        dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head,
        status: count === 'completed' ? 'ok' : 'unparseable',
      }));
      const read = () => readRedTeamStatus({ repo, pr, head, env });
      const production = createReviewJobIo({ env, readEvidence: () => ({
        inFlight: false, queued: false, completedRecorded: count === 'completed',
        seatRecorded: true, recorded: true, failedSeatCount: count === 'completed' ? 0 : count,
      }) });
      let observed;
      const loopPayload = payload();
      loopPayload.findings.read.diffText = 'diff --git a/scripts/a.mjs b/scripts/a.mjs\n+code';
      const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload }), redTeamStatus: production.redTeamStatus,
        runRedTeam: input => {
          observed = runSharedRecovery(input, { status: read(), records, env, probeFresh: true });
          return observed.result;
        } });
      try {
        recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result }, { env });
        runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, io);
        expect(observed.comments).toEqual([]);
        expect(observed.calls.model).toBe(count === 1 ? 1 : 0);
        expect(observed.calls.reserve).toBe(count === 1 ? 1 : 0);
        if (count === 1) {
          expect(observed.calls.retryCountAtCall).toBe(1);
          expect(observed.result).toMatchObject({ status: 'failed', reason: 'injected failed retry', comment: { status: 'not-posted' }, rowsWritten: 1 });
          expect(read()).toMatchObject({ status: 'finished', result: 'failed', retryCount: 1 });
        }
        if (count !== 1) expect(observed.result).toMatchObject({ status: 'not-owed', deferredByGuard: true });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  // Shared fixture: the store, a production job admission and the planner over one head.
  function retryFixture({ prefix, records, evidence }) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const loopPayload = payload();
    loopPayload.findings.read.diffText = 'diff --git a/scripts/a.mjs b/scripts/a.mjs\n+code';
    const readEvidence = () => ({ inFlight: false, queued: false, loopPayload, ...evidence });
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const path = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
    const production = createReviewJobIo({ env, readEvidence });
    const job = options => {
      let observed;
      const out = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' }, fakeIo({
        readRedTeamOnlyPayload: () => ({ head, loopPayload }), redTeamStatus: production.redTeamStatus,
        clearRedTeamQueued: production.clearRedTeamQueued,
        runRedTeam: input => { observed = runSharedRecovery(input, { status: read(), records, env, probeFresh: true, ...options }); return observed.result; },
      }));
      return { out, observed };
    };
    const recover = () => runRedTeamOnSkip({ repo, plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
      rawPrs: [{ number: pr, headRefOid: head, comments: [] }], readEvidence, readStatus: read,
      setting: { enabled: true, retryCooldownMin: 0 }, now: () => 9_000_000, lastDispatch: new Map(),
      capacity: { lanes: 1 }, dispatch: () => ({ jobPid: 42 }) });
    return { dir, env, loopPayload, read, path, marker: `${path}.retry-1`, job, recover };
  }

  it.each(['cap', 'guard', 'disabled'].flatMap(kind =>
    ['failed', { status: 'failed' }, 'ran', { status: 'ran' }].map(result => ({ kind, result }))))(
    'a $kind deferral with no model call preserves $result and refunds the retry so the planner re-dispatches', ({ kind, result }) => {
      const records = [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' }];
      const f = retryFixture({ prefix: 'red-team-refund-retry-', records,
        evidence: { recorded: true, seatRecorded: true, completedRecorded: false, failedSeatCount: 1 } });
      try {
        recordRedTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'finished', result }, { env: f.env });
        const deferred = f.job({ cap: { capDeferred: true }, guard: { commentsUnreadable: true },
          disabled: { env: { ...f.env, WE_REVIEW_RED_TEAM: '0' } } }[kind]);
        expect(deferred.observed.calls.model).toBe(0);
        expect(deferred.observed.result).toMatchObject({ cap: { status: 'skipped', deferredByCap: true },
          guard: { status: 'not-owed', deferredByGuard: true }, disabled: { status: 'disabled' } }[kind]);
        expect(f.read()).toMatchObject({ status: 'finished', result });
        expect(f.read().retryCount).toBeUndefined();
        expect(existsSync(f.marker)).toBe(false);
        // The cap (or transient read) clears: the one retry is still owed.
        expect(f.recover().rows[0]).toMatchObject({ action: 'dispatch', mode: 'fresh' });
        const retried = f.job({});
        expect(retried.observed.calls).toMatchObject({ model: 1, retryCountAtCall: 1 });
        expect(f.read().retryCount).toBe(1);
        expect(f.recover().rows[0].action).toBe('skip');
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });

  it('a deterministic no-call refusal keeps the spent retry instead of re-dispatching every cooldown', () => {
    const records = [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' }];
    const f = retryFixture({ prefix: 'red-team-keep-retry-', records,
      evidence: { recorded: true, seatRecorded: true, completedRecorded: false, failedSeatCount: 1 } });
    try {
      recordRedTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'finished', result: 'ran' }, { env: f.env });
      const comments = [{ body: `${redTeamMarker(pr, head)}\nRed team not required on this head: card-only diff`, author: { login: 'web-everything' } }];
      const settled = f.job({ comments });
      expect(settled.observed.calls.model).toBe(0);
      expect(settled.observed.result).toMatchObject({ status: 'not-owed' });
      expect(settled.observed.result.deferredByGuard).toBeUndefined();
      expect(f.read().retryCount).toBe(1);
      expect(existsSync(f.marker)).toBe(true);
      expect(f.recover().rows[0].action).toBe('skip');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('a normal review cap deferral beside a spent retry marker restores the replaced status instead of orphaning the marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-clear-marker-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const read = () => readRedTeamStatus({ repo, pr, head, env });
    const marker = `${join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`)}.retry-1`;
    const production = createReviewJobIo({ env });
    const io = fakeIo({ redTeamStatus: vi.fn(production.redTeamStatus),
      clearRedTeamQueued: vi.fn(production.clearRedTeamQueued),
      runLoop: () => ({ status: 0, stdout: JSON.stringify({ ...payload(), stopped: 'complete', runId: 'review-pr-cap' }) }),
      runRedTeam: () => ({ status: 'skipped', deferredByCap: true }),
    });
    try {
      // A recovery retry that ended in a deterministic skip: the spend and its marker stand.
      recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'queued', retryCount: 1 }, { env });
      recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result: { status: 'skipped' } }, { env });
      expect(read()).toMatchObject({ status: 'finished', retryCount: 1 });
      runReviewJob({ repo, pr }, io);
      expect(io.clearRedTeamQueued).toHaveBeenCalledOnce();
      expect(read()).toMatchObject({ status: 'finished', result: { status: 'skipped' }, retryCount: 1 });
      expect(existsSync(marker)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['direct', 'admitted'].flatMap(path => ['restored', 'missing'].map(status => ({ path, status }))))(
    'a surviving retry marker refuses fresh execution after stale status evidence ($path, $status)', ({ path, status }) => {
      // The seat row was lost too, so only the marker still proves the spend.
      const f = retryFixture({ prefix: 'red-team-stale-marker-', records: [],
        evidence: { recorded: false, seatRecorded: false, completedRecorded: false, failedSeatCount: 0 } });
      try {
        recordRedTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'finished', result: 'ran' }, { env: f.env });
        const stale = readFileSync(f.path, 'utf8');
        recordRedTeamStatus({ repo, pr, loopPayload: f.loopPayload, status: 'queued', result: 'ran', retryCount: 1 }, { env: f.env });
        if (status === 'restored') writeFileSync(f.path, stale);
        else rmSync(f.path);
        expect(existsSync(f.marker)).toBe(true);
        const observed = path === 'direct'
          ? runSharedRecovery({ repo, pr, loopPayload: f.loopPayload, redTeamMode: 'fresh' }, { status: null, records: [], env: f.env, probeFresh: true })
          : f.job({}).observed;
        if (observed) {
          expect(observed.calls).toMatchObject({ model: 0, reserve: 0 });
          expect(observed.result).toMatchObject({ status: 'not-owed', deferredByGuard: true });
        }
        expect(existsSync(f.marker)).toBe(true);
        expect(f.recover().rows[0].action).toBe('skip');
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    });
});


describe('PR 6039 red-team-only stale running payload recovery', () => {
  function staleJob({ alive = false, recovered = payload(), abandoned = false } = {}) {
    const pidStart = new Date(0).toISOString();
    const status = { repo, pr, head, status: 'running', result: null, pid: 6039,
      host: 'fixture-host', pidNamespace: 'fixture-namespace', pidStart,
      ...(abandoned ? { staleAbandoned: { at: 500, pid: 6039, reason: 'dead owner' } } : {}) };
    return fakeIo({
      readRedTeamOnlyPayload: vi.fn(() => ({ head, status,
        loopPayload: { findings: { read: { netBasis: { rev: head } } } } })),
      readStaleRunPayload: vi.fn(() => recovered),
      staleProbe: { host: status.host, namespace: status.pidNamespace,
        isAlive: vi.fn(() => alive), readPidStart: vi.fn(() => pidStart) },
    });
  }
  const options = { repo, pr, redTeamOnly: true, redTeamMode: 'fresh' };
  describe.each([false, true])('environment deadline recheck (staleAbandoned=%s)', abandoned => {
    it.each([
      ['shorter override', '60000', 60 * 60 * 1000, true],
      ['longer override', '14400000', 3 * 60 * 60 * 1000, false],
      ['invalid override within default', 'invalid', 60 * 60 * 1000, false],
      ['unsafe override past default', '9007199254740992', 3 * 60 * 60 * 1000, true],
      ['unset within default', undefined, 60 * 60 * 1000, false],
      ['unset past default', undefined, 3 * 60 * 60 * 1000, true],
    ])('%s for an unprobeable stored owner', (_name, value, age, recovered) => {
      const now = 20_000_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      vi.stubEnv('WE_RED_TEAM_STALE_RUN_MS', value);
      try {
        const io = staleJob({ abandoned });
        const { status } = io.readRedTeamOnlyPayload();
        Object.assign(status, { host: 'remote', pidStart: new Date(now - age).toISOString(),
          ...(abandoned ? { status: 'finished', result: { status: 'not-owed' } } : {}) });
        expect(runReviewJob(options, io).outcome).toBe(recovered ? 'red-team-only' : 'red-team-not-owed');
        expect(io.readStaleRunPayload).toHaveBeenCalledTimes(recovered ? 1 : 0);
        expect(io.runRedTeam).toHaveBeenCalledTimes(recovered ? 1 : 0);
        expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(recovered ? ['queued', 'finished'] : []);
      } finally {
        clock.mockRestore();
        vi.unstubAllEnvs();
      }
    });
  });
  it.each([false, true])('dead owner recovers accepting payload and runs red team (staleAbandoned=%s)', abandoned => {
    const recovered = { ...payload(), recoveryEvidence: 'full accepting review run' };
    const io = staleJob({ recovered, abandoned });
    const result = runReviewJob(options, io);
    expect(result.outcome).not.toBe('red-team-not-owed');
    expect(result.outcome).toBe('red-team-only');
    expect(io.readStaleRunPayload).toHaveBeenCalledOnce();
    expect(io.runRedTeam).toHaveBeenCalledOnce();
    expect(io.runRedTeam).toHaveBeenCalledWith(expect.objectContaining({ loopPayload: recovered, redTeamMode: 'fresh' }));
  });
  it.each([false, true])('live owner never recovers or starts even with staleAbandoned=%s', abandoned => {
    const io = staleJob({ alive: true, abandoned });
    expect(runReviewJob(options, io).outcome).toBe('red-team-not-owed');
    expect(io.readStaleRunPayload).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(io.redTeamStatus).not.toHaveBeenCalled();
  });
  it('missing full review run fails closed as red-team-not-owed', () => {
    const io = staleJob({ recovered: null });
    expect(runReviewJob(options, io).outcome).toBe('red-team-not-owed');
    expect(io.readStaleRunPayload).toHaveBeenCalledOnce();
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(io.redTeamStatus).not.toHaveBeenCalled();
  });
  it.each([
    ['rejecting', { verdict: { verdict: 'changes' } }],
    ['incomplete', { verdict: null }],
    ['carried', { carriedFrom: 'older-run' }],
  ])('a newer %s stored review prevents stale recovery from running an older accept', (_kind, over) => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-superseded-review-'));
    try {
      const older = { ...newRunRecord({ id: 'review-pr-old', op: 'review-pr', input: { repo, pr } }), ...payload() };
      const newest = { ...newRunRecord({ id: 'review-pr-new', op: 'review-pr', input: { repo, pr } }), ...payload(), ...over };
      writeRun(older, dir);
      writeRun(newest, dir);
      utimesSync(join(dir, `${older.id}.json`), new Date(1000), new Date(1000));
      utimesSync(join(dir, `${newest.id}.json`), new Date(2000), new Date(2000));
      const io = staleJob();
      io.readStaleRunPayload = vi.fn(key => recoverStaleRunPayload({ ...key, runsDir: dir }));
      expect(runReviewJob(options, io).outcome).toBe('red-team-not-owed');
      expect(io.readStaleRunPayload).toHaveBeenCalledOnce();
      expect(io.runRedTeam).not.toHaveBeenCalled();
      expect(io.redTeamStatus).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
