import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, writeRun, readRun } from '../run-store.mjs';
import { createReviewJobIo, runReviewJob } from '../review-job.mjs';
import { readDrainRedTeamEvidence, readRedTeamStatus, redTeamStatusDir } from '../../lib/drain-red-team-evidence.mjs';
import { abandonStaleRedTeamRun, runRedTeamOnSkip, planRedTeamOnSkip, STALE_REDISPATCH_BACKOFF_MS } from '../../lib/review-red-team-on-skip.mjs';
import { readStore } from '../../conveyor/run-scorecard-store.mjs';
import { redTeamForHead } from '../../lib/red-team-gate.mjs';

vi.mock('../../lib/red-team-status-labels.mjs', () => ({ syncRedTeamStatusLabels: vi.fn() }));
const repo = 'web-everything/web-everything', pr = 6056, head = 'c'.repeat(40);
// The real producer writes running/read-only status and builds/appends its seat rows.
// Model calls, capacity, owner probes, clock and external publication are injected.
const child = `
  import { readFileSync } from 'node:fs';
  import { runRedTeam } from './scripts/operations/review-extra-seats.mjs';
  import { recordRedTeamStatus, readRedTeamStatus } from './scripts/lib/drain-red-team-evidence.mjs';
  import { readStore, appendScorecard } from './scripts/conveyor/run-scorecard-store.mjs';
  const { input, env, storePath, seed, completed, truncated, birth, foreign, cap, guard, comments: saved = [] } = JSON.parse(readFileSync(0, 'utf8'));
  const comments = [...saved]; let calls = 0;
  const readRecords = () => readStore({ path: storePath, strict: true }).records;
  const writeStatus = value => recordRedTeamStatus(value, { env,
    ...(seed ? { host: foreign ? 'foreign-host' : 'matrix-host', namespace: 'matrix-namespace', readPidStart: () => birth } : {}) });
  const result = await runRedTeam({ ...input, env }, {
    now: () => Date.now(), log: () => {},
    readRecords, readRedTeamStatus: key => readRedTeamStatus({ ...key, env }),
    readRecoveryComments: () => { if (guard) throw Error('injected unreadable comments'); return comments; },
    redTeamStatus: value => { if (!seed || value.status === 'running') writeStatus(value); },
    cliAvailable: provider => provider === 'codex',
    reserveCalls: () => cap ? { used: 1, callIds: [] } : { used: 0, callIds: ['matrix-' + process.pid] },
    makeScratch: () => 'fixture', writeFile: () => {}, removeScratch: () => {}, readHeadMessage: () => '',
    runSeat: async () => {
      calls++;
      if (seed && !completed) {
        if (!truncated) writeStatus({ ...input, status: 'running' });
        process.stdout.write(JSON.stringify({ calls })); process.exit(0);
      }
      return { report: { exitCode: 0, lastMessage: JSON.stringify({ lenses: { 'red-team': { verdict: 'accept', findings: [] } } }) } };
    },
    runRecheck: () => { throw Error('no findings to recheck'); },
    append: row => appendScorecard(row, { path: storePath }), logTrial: () => {},
    listComments: () => comments,
    postComment: ({ body }) => { if (!seed) comments.push({ body, author: { login: 'web-everything' } }); },
  });
  process.stdout.write(JSON.stringify({ result, comments, calls }));
`;
const invoke = data => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], {
  input: JSON.stringify(data), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '' },
}));
const cases = [
  ['local dead owner', {}],
  ['rounds 1-2 e492d241/effa09c8: foreign aged owner uses configured deadline', { foreign: true }],
  ['owner unreadable: explicit inspection skip', { unreadable: true }],
  ['round 4 c98bf4ec: truncated running payload', { truncated: true }],
  ['payload absent: explicit inspection skip', { absent: true, truncated: true }],
  ['round 7 bfdb5352: completed seat always resumes', { completed: true }],
  ['round 10 4ca0f15f: completed seat plus truncated payload restores on resume', { completed: true, truncated: true }],
  ['round 6 04d27192: same-second replacement', { sameSecond: true }],
  ['round 3 921413f9: daily-cap deferral remains retryable', { cap: true }],
  ['round 5 67c18f81: foreign owner admitted after abandonment', { foreign: true, truncated: true }],
  ['round 8 3d522cf9: guard failure preserves completed status', { completed: true, guard: true }],
  ['round 9 3d522cf9: completed seat with truncated read', { completed: true, truncated: true }],
];

describe('one recovery plan: planner → abandonment → admission → review arc → published result', () => {
  it.each(cases.flatMap(([name, state]) => [1, 2].map(attempt => [name, state, attempt])))(
    '%s / state %j / recovery attempt %i', (name, state, attempt) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-plan-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl'), WE_RED_TEAM_STALE_RUN_MS: '1000' };
      const storePath = join(dir, 'scorecards.json');
      const run = { ...newRunRecord({ id: 'review-pr-matrix', op: 'review-pr', input: { repo, pr } }),
        verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head }, diffText: '+export const value = 1;', netChangedFiles: ['scripts/example.mjs'] } } };
      const key = { repo, pr, head, env };
      const path = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
      let comments = [], observed, result;
      const probe = { host: 'matrix-host', namespace: 'matrix-namespace', isAlive: () => {
        if (state.unreadable) throw Error('owner probe unreadable'); return false;
      } };
      const readStatus = input => readRedTeamStatus({ ...input, env });
      const readEvidence = input => readDrainRedTeamEvidence({ ...input, env, runsDir: env.WE_SHARED_RUNS_DIR,
        host: probe.host, namespace: probe.namespace, isAlive: () => false,
        readScorecards: () => readStore({ path: storePath, strict: true }).records });
      const rawPr = () => ({ number: pr, headRefOid: head, labels: ['review:accepted'], reviews: [], comments });
      const refusal = { kind: 'already-reviewed-head', prNumber: pr, headSha: head };
      const seed = birth => invoke({ input: { repo, pr, loopPayload: readRun(run.id, env.WE_SHARED_RUNS_DIR) },
        env, storePath, seed: true, ...state, cap: false, guard: false, birth });
      try {
        writeRun(run, env.WE_SHARED_RUNS_DIR);
        seed(new Date(state.sameSecond ? Math.floor(Date.now() / 1000) * 1000 : Date.now() - 2000).toISOString());
        if (attempt === 2) {
          const first = planRedTeamOnSkip({ repo, refusals: [refusal], rawPrs: [rawPr()], readStatus, readEvidence,
            now: Date.now(), setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map(), env,
            probe: { ...probe, isAlive: () => false }, staleRedispatch: undefined,
          })[0];
          expect(abandonStaleRedTeamRun({ ...key, status: first.status, plan: first }).ok).toBe(true);
          const marker = statSync(`${path}.stale-redispatch-1`).mtimeMs;
          seed(new Date(Math.floor(marker / 1000) * 1000).toISOString());
        }
        if (state.absent) rmSync(join(env.WE_SHARED_RUNS_DIR, `${run.id}.json`));
        const now = Date.now() + (attempt === 2 ? STALE_REDISPATCH_BACKOFF_MS + 1000 : 0);
        const production = createReviewJobIo({ env, readEvidence, readStatus });
        const execute = options => runReviewJob(options, {
          ...production, root: dir, now: () => now, newActorId: () => 'matrix',
          readPrevCompletion: () => null, claim: () => ({ ok: true }), updateRecord: () => {}, unclaim: () => {},
          acquireLane: () => ({ lanePath: dir }), releaseLane: () => {}, log: () => {}, report: () => {},
          prepareLane: () => ({ head }), fetchRedTeamHead: () => ({ head }),
          runRedTeamGate: () => ({ status: 'applied' }),
          runRedTeam: input => {
            expect(input.loopPayload.verdict.verdict).toBe('accept');
            observed = invoke({ input, env, storePath, comments, cap: state.cap, guard: state.guard });
            comments = observed.comments; return observed.result;
          },
        });
        const tick = () => runRedTeamOnSkip({ repo, env, now: () => now, lastDispatch: new Map(),
          setting: { enabled: true, retryCooldownMin: 0 }, plan: { refusals: [refusal] }, rawPrs: [rawPr()],
          readStatus, readEvidence, probe, readCarry: () => null, capacity: { lanes: 1 },
          dispatch: options => { result = execute(options); return { jobPid: 42 }; },
        });
        const planned = tick();
        if (state.unreadable || state.absent) {
          expect(planned.rows[0]).toMatchObject({ action: 'skip', mode: 'skip' });
          expect(planned.rows[0].why).toMatch(/unreadable|flight|unavailable|owe/);
          expect(result).toBeUndefined(); return;
        }
        expect(planned.dispatched).toHaveLength(1);
        expect(result.outcome).toBe('red-team-only');
        expect(observed).toBeDefined();
        if (state.completed) {
          expect(planned.rows[0].mode).toBe('resume'); expect(observed.calls).toBe(0);
        }
        if (state.cap || state.guard) {
          expect(observed.result[state.cap ? 'deferredByCap' : 'deferredByGuard']).toBe(true);
          if (state.completed) expect(readStatus(key)).toMatchObject({ status: 'finished', result: 'ran' });
          const deferred = state;
          state = { ...state, cap: false, guard: false };
          const retry = tick();
          // A second capped attempt exhausts the bounded stale dispatch budget explicitly.
          if (!retry.dispatched.length) {
            expect(deferred.cap && attempt === 2).toBe(true);
            expect(retry.rows[0]).toMatchObject({ action: 'skip', mode: 'skip', why: expect.stringContaining('inspect') });
            return;
          }
        }
        expect(redTeamForHead(comments, pr, head)).toBeTruthy();
        expect(observed.result.status).toBe(state.completed ? 'resumed' : 'ran');
        expect(observed.calls).toBe(state.completed ? 0 : 1);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000,
  );
});

describe('detached recovery supersession validation', () => {
  it.each(['fresh', 'resume'].flatMap(mode => [
    'carryConflict after planning', 'carryConflict during fetch', 'unreadable evidence',
    'missing evidence', 'incomplete evidence',
  ].map(change => [mode, change])))(
    '%s detached recovery refuses %s before admission, provider calls and publication', (mode, change) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-plan-superseded-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl') };
      const storePath = join(dir, 'scorecards.json'), key = { repo, pr, head, env };
      const run = { ...newRunRecord({ id: 'review-pr-superseded', op: 'review-pr', input: { repo, pr } }),
        verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head },
          diffText: '+export const value = 1;', netChangedFiles: ['scripts/example.mjs'] } } };
      let changed = false;
      const readStatus = input => readRedTeamStatus({ ...input, env });
      const currentEvidence = input => readDrainRedTeamEvidence({ ...input, env, runsDir: env.WE_SHARED_RUNS_DIR,
        host: 'matrix-host', namespace: 'matrix-namespace', isAlive: () => false,
        readScorecards: () => readStore({ path: storePath, strict: true }).records });
      const readEvidence = vi.fn(input => {
        const evidence = currentEvidence(input);
        if (!changed) return evidence;
        if (change === 'unreadable evidence') throw Error('injected evidence EIO');
        if (change === 'missing evidence') return null;
        if (change === 'incomplete evidence') return {};
        return { ...evidence, carryConflict: true };
      });
      const provider = vi.fn(), publication = vi.fn();
      try {
        writeRun(run, env.WE_SHARED_RUNS_DIR);
        if (mode === 'resume') invoke({ input: { repo, pr, loopPayload: readRun(run.id, env.WE_SHARED_RUNS_DIR) },
          env, storePath, seed: true, completed: true, truncated: true, birth: new Date(Date.now() - 2000).toISOString() });
        const plan = planRedTeamOnSkip({ repo, env, now: Date.now(), lastDispatch: new Map(),
          refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
          rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted'], reviews: [], comments: [] }],
          setting: { enabled: true, retryCooldownMin: 0 }, readStatus, readEvidence,
          probe: { host: 'matrix-host', namespace: 'matrix-namespace', isAlive: () => false },
        })[0];
        expect(plan).toMatchObject({ action: 'dispatch', mode });
        if (plan.abandon) expect(abandonStaleRedTeamRun({ ...key, status: plan.status, plan }).ok).toBe(true);
        const before = readStatus(key);
        changed = change !== 'carryConflict during fetch';
        const production = createReviewJobIo({ env, readStatus, readEvidence });
        const admission = vi.fn(production.redTeamStatus), settle = vi.fn(publication);
        const runRedTeam = vi.fn(() => { provider(); publication(); return { status: 'ran', findings: [], comment: { status: 'posted' } }; });
        const result = runReviewJob({ repo, pr, redTeamOnly: true, redTeamMode: mode, redTeamPlan: plan }, {
          ...production, root: dir, now: () => Date.now(), newActorId: () => 'superseded',
          readPrevCompletion: () => null, claim: () => ({ ok: true }), updateRecord: () => {}, unclaim: () => {},
          acquireLane: () => ({ lanePath: dir }), releaseLane: () => {}, log: () => {}, report: () => {},
          prepareLane: () => ({ head }), fetchRedTeamHead: () => { changed = true; return { head }; },
          redTeamStatus: admission, runRedTeam, settleRedTeamSkip: settle,
        });
        expect(result).toMatchObject({ outcome: 'red-team-not-owed', refused: true,
          reason: expect.stringMatching(/supersedes|unreadable|incomplete/) });
        expect(admission).not.toHaveBeenCalled();
        expect(runRedTeam).not.toHaveBeenCalled();
        expect(provider).not.toHaveBeenCalled();
        expect(publication).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
        expect(readStatus(key)).toEqual(before);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000,
  );
});

it('executors cannot re-derive owner, payload or completed-seat decisions', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const job = read('../review-job.mjs');
  const recovery = read('../../lib/review-red-team-on-skip.mjs');
  const shared = read('../review-extra-seats.mjs');
  const arc = job.slice(job.indexOf('function runReviewArc('), job.indexOf('export function dispatchReviewJob('));
  const admission = job.slice(job.indexOf('redTeamStatus: input =>'), job.indexOf('fetchRedTeamHead:'));
  const abandon = recovery.slice(recovery.indexOf('export function abandonStaleRedTeamRun('), recovery.indexOf('export function recoverStaleRunPayload('));
  const guard = shared.slice(shared.indexOf('function redTeamRecoveryGuard('), shared.indexOf('export function redTeamReadFingerprint('));
  for (const executor of [arc, admission, abandon, guard]) {
    expect(executor).not.toMatch(/staleRedTeamRun\(|staleRunDeadlineMs\(|verifiedStaleRedTeamAbandonment\(|completedRedTeamSeat\(|priorRedTeamRow\(/);
    expect(executor).not.toMatch(/completedRecorded|cleanRecorded|seatRecorded|\.inFlight|\.queued\b|prior\??\.host|prior\??\.pidNamespace/);
  }
  expect(arc).not.toMatch(/redTeamOwedFor\(loopPayload\)|recoverStaleRunPayload\(/);
});
