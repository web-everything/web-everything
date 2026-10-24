import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runRedTeamOnSkip } from '../../lib/review-red-team-on-skip.mjs';
import { redTeamForHead, redTeamMarker } from '../../lib/red-team-gate.mjs';
import { recordRedTeamStatus, readRedTeamStatus, readDrainRedTeamEvidence, redTeamStatusDir } from '../../lib/drain-red-team-evidence.mjs';
import { createReviewJobIo, prepareReviewArc, runReviewJob, dispatchReviewJob, writeJobRecord, redTeamRunnerArgs, readRedTeamRecoveryStatus } from '../review-job.mjs';

vi.mock('../../lib/red-team-status-labels.mjs', () => ({ syncRedTeamStatusLabels: vi.fn() }));

const repo = 'web-everything/web-everything', head = 'a'.repeat(40), pr = 5762;
const payload = () => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });

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
  ])('passes %j to the job without losing its recovery mode', (flags, redTeamOnly, redTeamMode) => {
    const source = `
      import { runReviewJobCli } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-job.mjs')).href)};
      runReviewJobCli(process.argv.slice(1), { runJob: options => options });
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source,
      'run', '--pr=5762', '--repo=web-everything/web-everything', '--prefer-lane=7', ...flags], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '' },
    });
    expect(JSON.parse(output)).toEqual({ pr: '5762', repo, preferLane: 7, redTeamOnly, redTeamMode });
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
    runRedTeam: vi.fn(() => ({ status: 'ran', findings: [], comment: { status: 'posted' } })),
    runRedTeamGate: vi.fn(() => ({ status: 'ok', outcome: 'advisory' })), redTeamStatus: vi.fn(), ...over };
}

// Exercise the async shared seat through the same synchronous child boundary as the job.
function runSharedRecovery(input, { status, records = [], recordsUnreadable = false, commentsUnreadable = false, comments = [] } = {}) {
  const source = `
    import { readFileSync } from 'node:fs';
    import { runRedTeam } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-extra-seats.mjs')).href)};
    const { input, status, records, recordsUnreadable, commentsUnreadable, comments } = JSON.parse(readFileSync(0, 'utf8'));
    const calls = { provider: 0, reserve: 0, model: 0, recheck: 0 };
    const forbid = key => () => { calls[key]++; throw Error('unexpected ' + key); };
    const result = await runRedTeam({ ...input, env: {} }, {
      now: () => 1000, log: () => {},
      readRecords: () => { if (recordsUnreadable) throw Error('transient EIO'); return records; },
      readRedTeamStatus: () => status,
      readRecoveryComments: () => { if (commentsUnreadable) throw Error('transient EIO'); return comments; },
      cliAvailable: forbid('provider'), reserveCalls: forbid('reserve'),
      runSeat: forbid('model'), runRecheck: forbid('recheck'),
      listComments: () => comments, postComment: ({ body }) => comments.push({ body, author: { login: 'web-everything' } }),
      append: () => { throw Error('resume must reuse stored row'); },
    });
    process.stdout.write(JSON.stringify({ result, calls, comments }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    input: JSON.stringify({ input, status, records, recordsUnreadable, commentsUnreadable, comments }), encoding: 'utf8',
    timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '' },
  }));
}

describe('red-team-only review job', () => {
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
  it.each(['fresh', 'resume'])('a cap deferral rolls back %s admission without running the gate', redTeamMode => {
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
      expect(io.runRedTeamGate).not.toHaveBeenCalled();
      expect(out).not.toHaveProperty('redTeamGate');
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
        expect(out).toMatchObject({ outcome: 'blocked-on-infra', label: expect.stringMatching(/writer.*(live|unknown)/) });
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
      runLoop: () => ({ status: 0, stdout: JSON.stringify(payload()) }),
      redTeamStatus: input => { calls.push(input.status); return realIo.redTeamStatus(input); },
      unclaim: () => calls.push('unclaim'),
      runRedTeam: () => { calls.push('red-team'); return { status: 'ran' }; },
    });
    try {
      runReviewJob({ pr, repo, redTeamOnly: mode !== 'normal', redTeamMode: mode === 'normal' ? 'fresh' : mode }, io);
      expect(calls).toEqual(['queued', 'readback', 'unclaim', 'red-team', 'finished']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['fresh', 'resume'])('refuses a throwing strict queued hook in %s mode with zero red-team calls', redTeamMode => {
    const io = fakeIo({ redTeamStatus: vi.fn(() => {
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
          readEvidence: () => ({ loopPayload: payload(), recorded: true }), readStatus: status,
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
      const io = fakeIo({ prepareLane, runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify(payload()) })) });
      runReviewJob({ pr, repo, redTeamOnly }, io);
      expect(io.prepareLane).toBe(prepareLane);
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
        expect(io.runRedTeamGate).not.toHaveBeenCalled();
        if (redTeamOnly) expect(recover().rows[0].why).toBe('retry cooldown active');
        at += cap === 'quota-hold' ? 60 * 60_000 + 1 : 24 * 60 * 60_000;
        expect(recover().dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
        expect(job.redTeam).toMatchObject({ status: 'ran', comment: 'posted' });
        expect(observed.modelCalls).toBe(1);
        expect(read()).toMatchObject({ status: 'finished', result: 'ran' });
        expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(['queued', 'queued', 'finished']);
        expect(redTeamForHead(observed.comments, pr, head)).toMatchObject({ pr, rev: head });
        expect(io.runRedTeamGate).toHaveBeenCalledOnce();
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
    for (const hook of ['runLoop', 'runExtraSeats', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus', 'report']) expect(io[hook]).not.toHaveBeenCalled();
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

describe('red-team-only dispatch', () => {
  function withDispatch(run) {
    const dir = mkdtempSync(join(tmpdir(), 'review-red-team-only-'));
    const options = { pr, repo, redTeamOnly: true, root: '/daemon', dir,
      checkStaleness: () => ({ fresh: true, behind: 0 }), readCompletion: () => null,
      resolveSettingsEnv: () => ({}), ciGate: vi.fn(() => ({ allowed: false })), spawnJob: vi.fn(() => 4242) };
    try { run(options); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it.each(['fresh', 'resume'])('passes --red-team-only=%s and preferred lane, skipping CI admission', redTeamMode => withDispatch(options => {
    const out = dispatchReviewJob({ ...options, redTeamMode, preferLane: 7 });
    expect(out.jobPid).toBe(4242); expect(options.ciGate).not.toHaveBeenCalled();
    expect(options.spawnJob.mock.calls[0][0].argv).toEqual(expect.arrayContaining(['run', `--pr=${pr}`, `--repo=${repo}`, `--red-team-only=${redTeamMode}`, '--prefer-lane=7']));
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
  ])('builds exact child argv for %s mode', (redTeamMode, modeArgs) => {
    const loopFile = `review-${pr}.red-team.loop.json`;
    expect(redTeamRunnerArgs({ pr, repo, lanePath: '/lanes/lane-7', loopFile, redTeamMode })).toEqual([
      'scripts/operations/review-extra-seats.mjs', 'red-team', `--pr=${pr}`, `--repo=${repo}`,
      '--lane=/lanes/lane-7', `--loop-json=${loopFile}`, ...modeArgs,
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
