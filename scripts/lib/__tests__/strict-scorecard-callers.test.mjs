// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MissingStoreError, resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { createRedTeamIo, runRedTeam, speculateRedTeam } from '../../operations/review-extra-seats.mjs';
import { createReviewJobIo } from '../../operations/review-job.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { readDrainRedTeamEvidence, readRecoveryWitness, readRedTeamStatus, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { emptyDiffExemptionEvidence } from '../red-team-empty-net-diff.mjs';
import { failedRedTeamRetry, skippedRedTeamRetry } from '../red-team-run-result.mjs';
import { publishStoredRedTeamResult } from '../red-team-withheld-publish.mjs';
import { planRedTeamOnSkip, planRedTeamRecovery } from '../review-red-team-on-skip.mjs';

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(present) {
  const root = mkdtempSync(join(tmpdir(), 'strict-scorecard-callers-'));
  roots.push(root);
  const env = { CONVEYOR_STATE_ROOT: join(root, 'state'), WE_SHARED_RUNS_DIR: join(root, 'runs'),
    OPERATION_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_STATUS_LABELS: '0', WE_RED_TEAM_SKIP_CARD_ONLY: '1' };
  // The legacy publisher's default reader intentionally resolves process.env.
  vi.stubEnv('CONVEYOR_STATE_ROOT', env.CONVEYOR_STATE_ROOT);
  const key = { repo: 'example/project', pr: 6999, head: 'a'.repeat(40) };
  const read = { repo: key.repo, pr: key.pr, netBasis: { rev: key.head, base: 'b'.repeat(40), scored: true },
    netChangedFiles: ['backlog/6999.md'], diffText: '+changed', diffScored: true };
  const loopPayload = { verdict: { verdict: 'accept' }, findings: { read } };
  const run = { ...newRunRecord({ id: 'review-pr-strict-store', op: 'review-pr', input: { repo: key.repo, pr: key.pr } }), ...loopPayload };
  writeRun(run, env.WE_SHARED_RUNS_DIR);
  const storePath = resolveScorecardStorePath(env);
  mkdirSync(dirname(storePath), { recursive: true });
  if (present) writeFileSync(storePath, JSON.stringify({ version: 1, records: [] }));
  const statusPath = join(redTeamStatusDir(env), `${encodeURIComponent(key.repo)}-${key.pr}-${key.head}.json`);
  mkdirSync(dirname(statusPath), { recursive: true });
  const status = { ...key, status: 'finished', result: { status: 'skipped' }, loopPayload };
  writeFileSync(statusPath, JSON.stringify(status));
  const forbidden = () => { throw Error('unexpected provider, reservation, publication or Git call'); };
  const io = { ...createRedTeamIo({ env, root, storePath, readCompleteComments: () => [] }),
    log: () => {}, cliAvailable: forbidden, reserveCalls: forbidden, runSeat: forbidden,
    append: forbidden, postComment: forbidden, gitExec: forbidden };
  const evidence = () => readDrainRedTeamEvidence({ ...key, env });
  const witness = () => readRecoveryWitness({ ...key, env });
  return { root, env, key, read, loopPayload, status, statusPath, storePath, io, evidence, witness, forbidden };
}

function publication(f, throughSeatIo) {
  // Both states lack the exact-head completed row required to seal a legacy result.
  writeFileSync(f.statusPath, JSON.stringify({ ...f.status, result: 'ran', legacyHoldPublished: true }));
  if (throughSeatIo) {
    const io = createRedTeamIo({ env: f.env, root: f.root, storePath: f.storePath,
      readCompleteComments: () => [],
      recordStatus: (_input, { sealFinished }) => sealFinished(f.key) });
    return io.redTeamStatus({ ...f.key, status: 'finished', loopPayload: f.loopPayload });
  }
  return publishStoredRedTeamResult({ status: f.key, statusDir: redTeamStatusDir(f.env),
    listComments: () => [], postComment: f.forbidden, publishNeedsYou: f.forbidden });
}

// One row per production strict read site, followed by its admission/retry consumers.
// Every row runs twice against the same real filesystem setup: missing vs present-empty.
const callers = [
  {
    name: 'review-extra-seats: createRedTeamIo.readRecords',
    run: f => f.io.readRecords({ strict: true }),
    missing: MissingStoreError, empty: value => expect(value).toEqual([]),
  },
  {
    name: 'review-extra-seats: sealFinished.readSeatRow',
    run: f => publication(f, true),
    check: value => expect(value).toEqual({ status: 'held' }),
  },
  {
    name: 'drain-red-team-evidence: readRecoveryWitness',
    run: f => f.witness(), missing: MissingStoreError,
    empty: (value, f) => { expect(value.seats).toEqual([]); expect(value.newest.findings.read).toEqual(f.read); },
  },
  {
    name: 'drain-red-team-evidence: readDrainRedTeamEvidence',
    run: f => f.evidence(), missing: MissingStoreError,
    empty: value => expect(value).toMatchObject({ seatRecorded: false, completedRecorded: false, failedSeatCount: 0 }),
  },
  {
    name: 'red-team-withheld-publish: default readSeatRow',
    run: f => publication(f, false),
    check: value => expect(value).toEqual({ status: 'held' }),
  },
  {
    name: 'red-team-empty-net-diff: emptyDiffExemptionEvidence',
    run: f => emptyDiffExemptionEvidence({ ...f.key, read: { ...f.read, diffText: '', netChangedFiles: [] },
      storePath: f.storePath, cwd: f.root, exec: f.forbidden }),
    check: (value, _f, present) => expect(value).toEqual({ exempt: false, reason: present ? 'seat-record-missing' : 'store-missing' }),
  },
  {
    name: 'review-extra-seats: strict empty-claim speculation',
    run: f => speculateRedTeam({ ...f.key, read: { ...f.read, diffText: '', netChangedFiles: [] },
      lanePath: f.root, env: f.env }, f.io),
    check: (value, _f, present) => {
      expect(value).toEqual({ status: 'skipped', reason: `empty net diff not proven (${present ? 'seat-record-missing' : 'store-missing'}) — inspect stored evidence before retrying; no call launched` });
      expect(value).not.toHaveProperty('policy');
    },
  },
  {
    name: 'review-extra-seats: redTeamRecoveryGuard',
    run: f => {
      rmSync(f.statusPath);
      return runRedTeam({ ...f.key, redTeamMode: 'fresh', loopPayload: f.loopPayload, lanePath: f.root, env: f.env }, f.io);
    },
    check: (value, _f, present) => {
      if (present) expect(value).toMatchObject({ status: 'skipped', policy: 'card-only' });
      else expect(value).toMatchObject({ status: 'not-owed', deferredByGuard: true,
        reason: expect.stringContaining('scorecard store missing; inspect stored evidence') });
    },
  },
  {
    name: 'review-job: default readSeatRecords via readRedTeamOnlyPayload',
    run: f => createReviewJobIo({ root: f.root, env: f.env, exec: f.forbidden }).readRedTeamOnlyPayload(f.key),
    missing: MissingStoreError,
    empty: (value, f) => expect(value).toMatchObject({ head: f.key.head, loopPayload: { findings: { read: f.read } } }),
  },
  {
    name: 'red-team-run-result: skipped retry through strict drain evidence',
    run: f => ({ retryAuthorized: skippedRedTeamRetry(f.status, f.evidence()) }),
    missing: MissingStoreError, empty: value => expect(value).toEqual({ retryAuthorized: true }),
  },
  {
    name: 'review-red-team-on-skip: planRedTeamRecovery through strict witness',
    run: f => planRedTeamRecovery(f.witness(), { now: Date.now(), env: f.env,
      setting: { enabled: true, retryCooldownMin: 0 }, probe: { isAlive: f.forbidden } }),
    missing: MissingStoreError, empty: value => expect(value).toMatchObject({ mode: 'fresh', retry: true }),
  },
  {
    name: 'review-red-team-on-skip: planRedTeamOnSkip through strict drain evidence',
    run: f => planRedTeamOnSkip({ repo: f.key.repo, env: f.env,
      refusals: [{ kind: 'already-reviewed-head', prNumber: f.key.pr, headSha: f.key.head }],
      rawPrs: [{ number: f.key.pr, headRefOid: f.key.head, comments: [], reviews: [] }],
      readEvidence: f.evidence, readStatus: key => readRedTeamStatus({ ...key, env: f.env }),
      now: Date.now(), setting: { enabled: true, retryCooldownMin: 0 }, lastDispatch: new Map() })[0],
    check: (value, _f, present) => {
      if (present) expect(value).toMatchObject({ action: 'dispatch', mode: 'fresh' });
      else expect(value).toMatchObject({ action: 'skip', why: 'red-team evidence unreadable; inspect stored evidence before retrying' });
    },
  },
];

describe('strict scorecard caller matrix: missing fails closed; present-empty preserves behavior', () => {
  it.each(callers)('$name', async ({ run, missing, empty, check }) => {
    for (const present of [false, true]) {
      const f = fixture(present);
      if (!present && missing) await expect(async () => run(f)).rejects.toThrow(missing);
      else (check ?? empty)(await run(f), f, present);
      // No row may silently create missing evidence or turn a held legacy result into a clear seal.
      if (!present) expect(() => readFileSync(f.storePath)).toThrow();
      const status = existsSync(f.statusPath) ? JSON.parse(readFileSync(f.statusPath, 'utf8')) : null;
      expect(status?.sealedBreaks).not.toEqual([]);
    }
  });
  it('retry predicates reject explicitly unknown evidence even with legacy zero-seat counters', () => {
    const f = fixture(false);
    expect(skippedRedTeamRetry(f.status, { ok: false, failedSeatCount: 0, completedRecorded: false })).toBe(false);
    expect(failedRedTeamRetry({ ...f.status, result: 'failed' }, { ok: false, failedSeatCount: 1, completedRecorded: false })).toBe(false);
  });
});
