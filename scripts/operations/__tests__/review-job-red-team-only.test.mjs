import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runRedTeamOnSkip } from '../../lib/review-red-team-on-skip.mjs';
import { redTeamForHead, redTeamMarker } from '../../lib/red-team-gate.mjs';
import { recordRedTeamStatus, readRedTeamStatus, readDrainRedTeamEvidence } from '../../lib/drain-red-team-evidence.mjs';
import { createReviewJobIo, runReviewJob, dispatchReviewJob, writeJobRecord, redTeamRunnerArgs, readRedTeamRecoveryStatus } from '../review-job.mjs';

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
    readRedTeamComments: vi.fn(() => []),
    readRedTeamStatus: vi.fn(() => null), readRedTeamRecords: vi.fn(() => []), recordRedTeamQueued: vi.fn(),
    restoreRedTeamStatus: vi.fn(),
    runRedTeam: vi.fn(() => ({ status: 'ran', findings: [], comment: { status: 'posted' } })),
    runRedTeamGate: vi.fn(() => ({ status: 'ok', outcome: 'advisory' })), redTeamStatus: vi.fn(), ...over };
}

describe('red-team-only review job', () => {
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
        ...(redTeamMode === 'resume' ? {
          readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
          readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }],
        } : {}),
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
  it.each(['fresh', 'resume'])('refuses a result posted after the daemon snapshot in %s mode with zero red-team calls', redTeamMode => {
    const io = fakeIo({
      ...(redTeamMode === 'resume' ? {
        readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
        readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }],
      } : {}),
      readRedTeamComments: vi.fn(() => [{ author: { login: 'web-everything' }, body: redTeamMarker(pr, head) }]),
    });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io)).toMatchObject({
      outcome: 'red-team-not-owed', reason: 'red-team result already on head',
    });
    expect(io.readRedTeamComments).toHaveBeenCalledOnce();
    expect(io.readRedTeamComments).toHaveBeenCalledWith({ pr, repo });
    for (const hook of ['recordRedTeamQueued', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each(['fresh', 'resume'].flatMap(redTeamMode => ['throws', 'malformed', 'missing-hook'].map(kind => ({ redTeamMode, kind }))))(
    'refuses an unreadable PR comment thread ($kind) in $redTeamMode mode with zero red-team calls', ({ redTeamMode, kind }) => {
      const io = fakeIo({
        ...(redTeamMode === 'resume' ? {
          readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
          readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }],
        } : {}),
        readRedTeamComments: kind === 'missing-hook' ? undefined : vi.fn(() => {
          if (kind === 'throws') throw Error('unreadable');
          return null;
        }),
      });
      expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io)).toMatchObject({
        outcome: 'red-team-not-owed', reason: 'PR comments unreadable',
      });
      for (const hook of ['recordRedTeamQueued', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus']) expect(io[hook]).not.toHaveBeenCalled();
      expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
    });
  it.each(['fresh', 'resume'])('writes queued status before releasing the job slot in %s mode', redTeamMode => {
    const calls = [];
    const io = fakeIo({
      ...(redTeamMode === 'resume' ? {
        readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
        readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head,
          status: 'ok', findings: [] }],
      } : {}),
      recordRedTeamQueued: vi.fn(input => calls.push(input.status)),
      redTeamStatus: vi.fn(input => calls.push(input.status)),
      unclaim: vi.fn(() => calls.push('unclaim')),
    });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io);
    expect(out.outcome).toBe('red-team-only');
    expect(calls).toEqual(['queued', 'unclaim', 'finished']);
  });
  it.each(['fresh', 'resume'])('refuses a throwing strict queued hook in %s mode with zero red-team calls', redTeamMode => {
    const io = fakeIo({
      ...(redTeamMode === 'resume' ? {
        readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
        readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }],
      } : {}),
      recordRedTeamQueued: vi.fn(() => {
        expect(io.unclaim).not.toHaveBeenCalled();
        expect(io.releaseLane).not.toHaveBeenCalled();
        throw Error('write failed');
      }),
    });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io)).toMatchObject({
      outcome: 'red-team-not-owed', reason: 'queued red-team status could not be persisted',
    });
    expect(io.recordRedTeamQueued).toHaveBeenCalledOnce();
    for (const hook of ['runRedTeam', 'runRedTeamGate', 'redTeamStatus']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each(['fresh', 'resume'].flatMap(redTeamMode => ['write', 'readback'].map(failure => ({ redTeamMode, failure }))))(
    'restores admission evidence after queued $failure EIO in $redTeamMode mode and retries after cooldown', ({ redTeamMode, failure }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-queued-rollback-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const write = input => recordRedTeamStatus(input, { env });
      const read = () => readRedTeamStatus({ repo, pr, head, env });
      const recorded = redTeamMode === 'resume';
      try {
        if (recorded) write({ repo, pr, loopPayload: payload(), status: 'finished', result: { status: 'ran', comment: 'error' } });
        const prior = read();
        const restore = createReviewJobIo({ env }).restoreRedTeamStatus;
        const io = fakeIo({ readRedTeamStatus: read,
          readRedTeamRecords: () => recorded ? [{ dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', repo, pr, rev: head }] : [],
          recordRedTeamQueued: vi.fn(input => {
            if (failure === 'readback') {
              write(input);
              expect(read()).toMatchObject({ status: 'queued', result: prior?.result ?? null });
            }
            throw Object.assign(Error('transient queued status EIO'), { code: 'EIO' });
          }),
          restoreRedTeamStatus: vi.fn(input => {
            expect(io.unclaim).not.toHaveBeenCalled();
            expect(io.releaseLane).not.toHaveBeenCalled();
            restore(input);
          }),
          redTeamStatus: vi.fn(write),
        });
        const history = new Map();
        const recover = at => runRedTeamOnSkip({ repo,
          plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
          rawPrs: [{ number: pr, headRefOid: head, comments: [] }],
          readEvidence: () => ({ loopPayload: payload(), recorded }), readStatus: read,
          setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: history, now: () => at,
          capacity: { lanes: 1 }, dispatch: options => {
            expect(runReviewJob(options, io)).toMatchObject({
              outcome: 'red-team-not-owed', reason: 'queued red-team status could not be persisted',
            });
            return { jobPid: 42 };
          },
        });
        expect(recover(1_000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: redTeamMode }]);
        expect(read()).toEqual(prior);
        expect(io.restoreRedTeamStatus).toHaveBeenCalledOnce();
        for (const hook of ['runRedTeam', 'runRedTeamGate', 'redTeamStatus']) expect(io[hook]).not.toHaveBeenCalled();
        expect(recover(1_001).rows[0]).toMatchObject({ action: 'skip', why: 'retry cooldown active' });
        io.unclaim.mockClear(); io.releaseLane.mockClear();
        expect(recover(1_801_000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: redTeamMode }]);
        expect(read()).toEqual(prior);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it('keeps the admission refusal and releases the claim when status rollback also fails', () => {
    const io = fakeIo({ recordRedTeamQueued: () => { throw Error('readback EIO'); },
      restoreRedTeamStatus: vi.fn(() => { throw Error('rollback EIO'); }),
    });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io)).toMatchObject({
      outcome: 'red-team-not-owed', reason: 'queued red-team status could not be persisted',
    });
    expect(io.restoreRedTeamStatus).toHaveBeenCalledOnce();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('rollback EIO'));
    for (const hook of ['runRedTeam', 'runRedTeamGate', 'redTeamStatus']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it('uses the stored payload for the existing red team and gate without a new review round', () => {
    const loopPayload = payload();
    const io = fakeIo({ readRedTeamOnlyPayload: vi.fn(() => ({ head, loopPayload })) });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, preferLane: 7 }, io);
    expect(out).toMatchObject({ outcome: 'red-team-only', verdict: null, runId: null, redTeam: { status: 'ran' } });
    expect(io.readRedTeamOnlyPayload).toHaveBeenCalledWith({ pr, repo });
    expect(io.readRedTeamStatus).toHaveBeenCalledWith({ pr, repo, head });
    expect(io.runRedTeam).toHaveBeenCalledTimes(1);
    expect(io.runRedTeam).toHaveBeenCalledWith({ pr, repo, lanePath: '/lanes/lane-7', loopPayload, slug: `review-${pr}`, redTeamMode: 'fresh' });
    expect(io.runRedTeamGate).toHaveBeenCalledTimes(1);
    expect(io.runRedTeamGate).toHaveBeenCalledWith({ pr, repo });
    expect(io.recordRedTeamQueued).toHaveBeenCalledWith({ pr, repo, lanePath: '/lanes/lane-7', loopPayload,
      slug: `review-${pr}`, redTeamMode: 'fresh', status: 'queued' });
    expect(io.redTeamStatus.mock.calls.map(([c]) => c.status)).toEqual(['finished']);
    for (const hook of ['runLoop', 'runExtraSeats', 'report', 'carryAcrossRebaseSetting', 'readCarryEvidence', 'restampVerdict', 'speculativeRedTeamSetting', 'startSpeculativeRedTeam']) {
      expect(io[hook], hook).not.toHaveBeenCalled();
    }
    expect(io.acquireLane.mock.calls[0][0]).toMatchObject({ lane: 7 });
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each([
    ['recorded-result recovery finishes missing comment and miss rows with zero model invocations', null],
    ['two consecutive recovery attempts retry a failed comment then succeed with zero model invocations', 'comment'],
    ['a transient production scorecard EIO preserves resume eligibility and retries with zero model invocations', 'store'],
    ['card-only recovery publishes a recorded result after the skip setting is restored', 'card-only'],
  ])('%s', (_name, failure) => {
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
    let observed, job, attempt = 0;
    let status = { status: 'finished', result: cardOnly ? 'ran' : { status: 'ran', comment: 'error' } };
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload }), readRedTeamRecords: () => [prior, ...(observed?.rows ?? [])],
      readRedTeamStatus: () => status,
      recordRedTeamQueued: vi.fn(input => { status = { status: input.status, result: input.result ?? null }; }),
      redTeamStatus: vi.fn(input => { status = { status: input.status, result: input.result }; }),
      runRedTeam: input => {
        // Mirror the production synchronous job hook's child-process boundary, while running the REAL
        // runRedTeam -> speculateRedTeam -> resumeRedTeam path with only external effects injected.
        const source = `
          import { readFileSync } from 'node:fs';
          import { runRedTeam } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-extra-seats.mjs')).href)};
          import { readStore } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../conveyor/run-scorecard-store.mjs')).href)};
          const { input, prior, saved, failComment, failStore } = JSON.parse(readFileSync(0, 'utf8'));
          const comments = saved?.comments ?? [], rows = saved?.rows ?? [];
          const calls = { model: 0, recheck: 0, reserve: 0, provider: 0 };
          const forbid = key => () => { calls[key]++; throw Error('unexpected ' + key); };
          const result = await runRedTeam({ ...input, resumeOnly: input.redTeamMode === 'resume',
            env: { WE_RED_TEAM_SKIP_CARD_ONLY: '1' } }, {
            now: () => 1_000, log: () => {}, readRecords: () => failStore
              ? readStore({ path: '/injected/scorecards.json', exists: () => true,
                read: () => { throw Object.assign(Error('temporary store failure'), { code: 'EIO' }); } }).records
              : [prior, ...rows],
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
        observed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
          input: JSON.stringify({ input, prior, saved: observed, failComment: failFirstComment && attempt === 0,
            failStore: failure === 'store' && attempt === 0 }), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        }));
        attempt++;
        return observed.result;
      },
    });
    const history = new Map();
    const recover = at => runRedTeamOnSkip({ repo,
      plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
      rawPrs: [{ number: pr, headRefOid: head, comments: observed?.comments ?? [] }],
      readEvidence: () => ({ loopPayload, recorded: true }),
      readStatus: () => status,
      setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: history, now: () => at,
      capacity: { lanes: 1 }, dispatch: options => { job = runReviewJob(options, io); return { jobPid: 42 }; },
    });
    const recovery = recover(1_000);
    expect(recovery.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
    if (failure === 'store') {
      expect(job).toMatchObject({ outcome: 'red-team-only', redTeam: { status: 'skipped' } });
      expect(observed.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
      expect(observed.comments).toEqual([]);
      expect(recover(1_001).dispatched).toEqual([]);
      expect(recover(1_801_000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
    }
    expect(job).toMatchObject({ outcome: 'red-team-only', redTeam: { status: 'resumed' } });
    if (failFirstComment) {
      expect(observed.result).toMatchObject({ status: 'resumed', comment: { status: 'error' }, rowsWritten: 2 });
      expect(observed.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
      expect(observed.comments).toEqual([]);
      // Persist the production hook's string result, then retry at the cooldown boundary.
      expect(status).toEqual({ status: 'finished', result: 'resumed' });
      expect(recover(1_001).dispatched).toEqual([]);
      expect(recover(1_801_000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
      expect(job).toMatchObject({ outcome: 'red-team-only', redTeam: { status: 'resumed' } });
    }
    expect(observed.result).toMatchObject({ status: 'resumed', comment: { status: 'posted' }, rowsWritten: failFirstComment || cardOnly ? 0 : 2 });
    expect(observed.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
    expect(observed.comments).toHaveLength(1);
    expect(redTeamForHead(observed.comments, pr, head)).toMatchObject({ pr, rev: head });
    expect(observed.rows.map(row => row.missRole).sort()).toEqual(cardOnly ? [] : ['accepting-review', 'builder']);
    expect(observed.rows.every(row => row.redTeamCallId === prior.callId && row.rev === head)).toBe(true);
    expect(io.runRedTeamGate).toHaveBeenCalledWith({ pr, repo });
    expect(io.recordRedTeamQueued).toHaveBeenCalledTimes(needsRetry ? 2 : 1);
    expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(
      needsRetry ? ['finished', 'finished'] : ['finished']);
    expect(recover(3_601_000).dispatched).toEqual([]);
    expect(io.runLoop).not.toHaveBeenCalled(); expect(io.runExtraSeats).not.toHaveBeenCalled();
  });
  it.each(['error', 'skipped', 'disabled', 'not-owed', null])('refuses a finished non-recoverable result %s without running any seats', prior => {
    const io = fakeIo({ readRedTeamStatus: vi.fn(() => ({ status: 'finished',
      result: { status: prior } })) });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io);
    expect(out).toMatchObject({ outcome: 'red-team-not-owed', reason: `prior result ${prior ?? 'unknown'}; not re-run` });
    expect(io.readRedTeamStatus).toHaveBeenCalledWith({ pr, repo, head });
    for (const hook of ['runLoop', 'runExtraSeats', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus', 'report']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  const cleanRow = { dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', pr, repo, rev: head };
  it.each(['final-write', 'queued-readback'].flatMap(failure =>
    ['ran', { status: 'resumed', comment: 'error' }].map(prior => ({ failure, prior }))))(
    'recovers a durable queued resume after $failure fails and the writer dies: $prior', ({ failure, prior }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-dead-resume-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const write = input => recordRedTeamStatus(input, { env });
      const rawStatus = () => readRedTeamStatus({ repo, pr, head, env });
      let live = true;
      const evidence = () => readDrainRedTeamEvidence({ repo, pr, head, env,
        list: () => [], readScorecards: () => [cleanRow], isAlive: () => live });
      const status = () => readRedTeamRecoveryStatus({ repo, pr, head, env }, {
        readStatus: rawStatus, readEvidence: evidence,
      });
      try {
        write({ repo, pr, loopPayload: payload(), status: 'finished', result: prior });
        const io = fakeIo({ readRedTeamStatus: status, readRedTeamRecords: () => [cleanRow],
          recordRedTeamQueued: input => {
            write(input);
            if (failure === 'queued-readback') throw Error('transient readback failure');
          },
          // Keep the crash-recovery case: even the best-effort rollback cannot write.
          restoreRedTeamStatus: () => { throw Error('transient rollback failure'); },
          redTeamStatus: vi.fn(),
          runRedTeam: () => ({ status: 'skipped' }),
        });
        runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'resume' }, io);
        expect(rawStatus()).toMatchObject({ status: 'queued', result: prior });
        expect(status().status).toBe('queued');
        expect(runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-not-owed');
        live = false;
        io.recordRedTeamQueued = write;
        const retry = runRedTeamOnSkip({ repo,
          plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
          rawPrs: [{ number: pr, headRefOid: head, comments: [] }],
          readEvidence: evidence, readStatus: status, capacity: { lanes: 1 },
          setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(),
          dispatch: options => {
            expect(options.redTeamMode).toBe('resume');
            expect(runReviewJob(options, io).outcome).toBe('red-team-only');
            return { jobPid: 42 };
          },
        });
        expect(retry.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
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
  it.each(['skipped', 'error', 'disabled', 'not-owed', 'null', 'undefined', 'throw'].flatMap(failure =>
    ['ran', { status: 'resumed', comment: { status: 'error' } }].map(prior => ({ failure, prior }))))(
    'preserves durable clean result $prior after a resume child returns $failure', ({ failure, prior }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-resume-status-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      const store = input => recordRedTeamStatus(input, { env });
      const status = () => readRedTeamStatus({ repo, pr, head, env });
      try {
        store({ repo, pr, loopPayload: payload(), status: 'finished', result: prior });
        const io = fakeIo({ readRedTeamStatus: status, readRedTeamRecords: () => [cleanRow],
          recordRedTeamQueued: vi.fn(input => {
            store(input);
            expect(status()).toMatchObject({ status: 'queued', pid: process.pid });
          }),
          redTeamStatus: vi.fn(store),
          runRedTeam: vi.fn(() => {
            if (failure === 'throw') throw Error('temporary child failure');
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
        expect(io.report).not.toHaveBeenCalled();
        expect(io.runLoop).not.toHaveBeenCalled(); expect(io.runExtraSeats).not.toHaveBeenCalled();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it.each(['ran', { status: 'ran', comment: 'error' }, 'resumed', { status: 'resumed', comment: 'error' }])('resumes both production result shapes %j with a clean stored row', result => {
    const io = fakeIo({ readRedTeamStatus: () => ({ status: 'finished', result }), readRedTeamRecords: () => [cleanRow] });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-only');
    expect(io.runRedTeam).toHaveBeenCalledOnce();
    expect(io.runRedTeam).toHaveBeenCalledWith({ pr, repo, lanePath: '/lanes/lane-7', loopPayload: payload(), slug: `review-${pr}`, redTeamMode: 'resume' });
  });
  it.each(['error', { status: 'error' }, { status: 'ran', comment: 'posted' }, { status: 'ran', comment: { status: 'posted' } },
    { status: 'resumed', comment: 'posted' }, { status: 'resumed', comment: { status: 'posted' } }])('refuses resume result %j with zero red-team calls', result => {
    const io = fakeIo({ readRedTeamStatus: () => ({ status: 'finished', result }), readRedTeamRecords: () => [cleanRow] });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-not-owed');
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.redTeamStatus).not.toHaveBeenCalled();
  });
  it.each(['ran', 'resumed'].flatMap(result =>
    ['missing', 'error-row', 'wrong-head', 'wrong-repo', 'unreadable', 'malformed'].map(kind => ({ result, kind }))))('refuses $result resume on $kind scorecards with zero red-team calls', ({ result, kind }) => {
    const io = fakeIo({ readRedTeamStatus: () => ({ status: 'finished', result }),
      readRedTeamRecords: () => {
        if (kind === 'unreadable') throw Error('unreadable');
        if (kind === 'malformed') return null;
        return kind === 'missing' ? [] : [{ ...cleanRow,
          ...(kind === 'error-row' ? { status: 'error' } : {}),
          ...(kind === 'wrong-head' ? { rev: 'b'.repeat(40) } : {}),
          ...(kind === 'wrong-repo' ? { repo: 'other/repo' } : {}) }];
      } });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-not-owed');
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.redTeamStatus).not.toHaveBeenCalled();
  });
  it.each(['row', 'error-row', 'status', 'queued', 'unreadable'])('re-reads and refuses fresh mode on %s evidence with zero red-team calls', kind => {
    const io = fakeIo({ readRedTeamRecords: vi.fn(() => {
      if (kind === 'unreadable') throw Error('unreadable');
      return kind.endsWith('row') ? [{ ...cleanRow, status: kind === 'error-row' ? 'error' : 'ok' }] : [];
    }), readRedTeamStatus: vi.fn(() => ['status', 'queued'].includes(kind) ? { status: kind === 'queued' ? 'queued' : 'finished', result: 'ran' } : null) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io).outcome).toBe('red-team-not-owed');
    expect(io.readRedTeamRecords).toHaveBeenCalledOnce(); expect(io.readRedTeamStatus).toHaveBeenCalledWith({ pr, repo, head });
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.redTeamStatus).not.toHaveBeenCalled();
  });
  it('fails closed on an unreadable head status without running the red team', () => {
    const io = fakeIo({ readRedTeamStatus: () => { throw Error('unreadable'); } });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io).outcome).toBe('blocked-on-infra');
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.redTeamStatus).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each(['mismatched', 'missing', 'not-owed'])('refuses %s evidence without running any seats', kind => {
    const loopPayload = payload();
    if (kind === 'mismatched') loopPayload.findings.read.netBasis.rev = 'b'.repeat(40);
    if (kind === 'not-owed') loopPayload.verdict.verdict = 'changes';
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload: kind === 'missing' ? null : loopPayload }) });
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
    ['fresh', []],
    ['resume', ['--resume-only']],
  ])('builds exact child argv for %s mode', (redTeamMode, modeArgs) => {
    const loopFile = `review-${pr}.red-team.loop.json`;
    expect(redTeamRunnerArgs({ pr, repo, lanePath: '/lanes/lane-7', loopFile, redTeamMode })).toEqual([
      'scripts/operations/review-extra-seats.mjs', 'red-team', `--pr=${pr}`, `--repo=${repo}`,
      '--lane=/lanes/lane-7', `--loop-json=${loopFile}`, ...modeArgs,
    ]);
  });
  it.each(['fresh', 'resume'])('forwards %s mode to the red-team-only job hook', redTeamMode => {
    const io = fakeIo({ readRedTeamStatus: () => redTeamMode === 'resume' ? { status: 'finished', result: 'ran' } : null,
      readRedTeamRecords: () => redTeamMode === 'resume' ? [{ dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', pr, repo, rev: head }] : [],
      runRedTeam: vi.fn(() => ({ status: 'skipped' })) });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io);
    expect(out.outcome).toBe('red-team-only');
    expect(io.runRedTeam).toHaveBeenCalledOnce();
    expect(io.runRedTeam).toHaveBeenCalledWith({ pr, repo, lanePath: '/lanes/lane-7',
      loopPayload: payload(), slug: `review-${pr}`, redTeamMode });
    expect(io.runRedTeam).toHaveReturnedWith({ status: 'skipped' });
    expect(out.redTeam).toMatchObject({ status: 'skipped' });
  });
});
