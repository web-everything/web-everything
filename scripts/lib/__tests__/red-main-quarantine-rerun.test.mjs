// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveQuarantineSettings, runSafetyNet, SAFETY_NET_LEDGER } from '../red-main-quarantine-io.mjs';
import { planSafetyNet, validateQuarantineList } from '../red-main-quarantine.mjs';

const now = Date.parse('2026-10-28T12:00:00Z');
const sha = 'a'.repeat(40);
const runId = 42;
const repoSlug = 'fixture/web-everything';
const job = 'soak-shard (5)';
const file = 'scripts/lib/__tests__/example.test.mjs';
const failure = (failedFile = file) => ({ complete: true, files: [failedFile], tests: [{ file: failedFile, name: 'fails' }] });
const originalRun = {
  databaseId: runId, headSha: sha, status: 'completed', conclusion: 'failure', attempt: 1,
  createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:10:00Z',
};
const rerun = { ...originalRun, attempt: 2, updatedAt: '2026-10-28T11:00:00Z' };
const dirs = [];
function temp() {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'quarantine-rerun-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('repeat-failure planner keys evidence by real run id and attempt', () => {
  const rows = [originalRun, { ...rerun, createdAt: rerun.updatedAt }]
    .map((run) => ({ ...run, jobFailures: { [job]: failure() } }));
  const plan = (overrides = {}) => planSafetyNet({
    status: 'red', firstRedSha: sha, failedJobs: [job, 'daemon-soak'],
    jobFailures: { [job]: failure() }, repeatRuns: rows, latestRunId: runId, latestAttempt: 2,
    touchedFiles: () => [], now, ...overrides,
  });
  const proof = { kind: 'repeat-failed', runIds: [runId, runId], attempts: [1, 2], shas: [sha, sha], count: 2 };
  const validate = (evidence) => validateQuarantineList({ version: 1, entries: [{
    test: file, job, brokenSha: sha, owner: 'operator', reason: 'repeat failure',
    addedAt: now, expiresAt: now + 60_000, proof: evidence,
  }] });

  it('counts attempt 2 of the same real run id as a second failure', () => {
    expect(plan()).toMatchObject({ action: 'add', entries: [{ test: file, job, proof }] });
    expect(validate(proof)).toEqual({ ok: true, errors: [] });
  });

  it('does not count the same id and same attempt twice even with different timestamps', () => {
    expect(plan({ repeatRuns: rows.map((row) => ({ ...row, attempt: 1 })), latestAttempt: 1 }).action).toBe('none');
  });

  it('requires the latest evidence to match both the requested run id and attempt', () => {
    expect(plan({ latestAttempt: 3 }).action).toBe('none');
    expect(plan({ latestRunId: runId + 1 }).action).toBe('none');
  });

  it('defaults absent run attempts and latestAttempt to 1 for distinct runs', () => {
    const repeatRuns = rows.map(({ attempt, ...row }, i) => ({ ...row, databaseId: runId + i }));
    const out = plan({ repeatRuns, latestRunId: runId + 1, latestAttempt: undefined });
    expect(out.action).toBe('add');
    const { attempts, ...legacy } = { ...proof, runIds: [runId, runId + 1] };
    expect(out.entries[0].proof).toEqual(legacy); // all-attempt-1 proof keeps its historical shape
  });

  it.each([0, -1, 1.5, '2', null])('refuses a non-positive-integer attempt: %s', (attempt) => {
    expect(plan({ repeatRuns: [rows[0], { ...rows[1], attempt }], latestAttempt: attempt }).action).toBe('none');
    expect(validate({ ...proof, attempts: [1, attempt] }).errors).toContain('entry 0: bad proof');
  });

  it.each([0, -1, 'unknown', 1.5])('keeps run id validation strict with attempt-keyed evidence: %s', (databaseId) => {
    expect(plan({ repeatRuns: rows.map((row) => ({ ...row, databaseId })), latestRunId: databaseId }).action).toBe('none');
    expect(validate({ ...proof, runIds: [databaseId, databaseId] }).errors).toContain('entry 0: bad proof');
  });

  it('rejects duplicate run ids with equal attempts, including numeric/string id aliases', () => {
    for (const runIds of [[runId, runId], [runId, String(runId)]]) {
      expect(validate({ ...proof, runIds, attempts: [2, 2] }).errors).toContain('entry 0: bad proof');
    }
  });

  it.each([[], [1], [1, 2, 3], null, '1,2'])('rejects malformed or misaligned attempts: %j', (attempts) => {
    expect(validate({ ...proof, attempts }).errors).toContain('entry 0: bad proof');
  });

  it('preserves legacy proof validation without attempts', () => {
    const { attempts, ...legacy } = proof;
    expect(validate({ ...legacy, runIds: [runId, runId + 1] })).toEqual({ ok: true, errors: [] });
    expect(validate(legacy).errors).toContain('entry 0: bad proof');
  });
});

function harness({ values = {} } = {}) {
  const dir = temp();
  const ledgerPath = join(dir, SAFETY_NET_LEDGER);
  const ledger = () => JSON.parse(readFileSync(ledgerPath, 'utf8'));
  let list = { version: 1, entries: [] };
  const exec = vi.fn(() => '');
  const readJobs = vi.fn(() => ({ failed: [{ id: 501, name: job }], jobs: [] }));
  const readLog = vi.fn(() => failure());
  const readList = vi.fn(() => ({ ok: true, list }));
  const write = vi.fn(({ change }) => {
    const result = change(list);
    if (result.ok) list = result.list;
    return result;
  });
  const settings = resolveQuarantineSettings({ env: {}, platform: null, file: join(dir, 'absent.json') });
  settings.value = { ...settings.value, ...values };
  const tick = (run = originalRun, overrides = {}) => runSafetyNet({
    dir, now, repoSlug, mode: { value: 'quarantine', source: 'test' }, settings,
    mainCiRuns: { runs: [run], failing: { runId: run.databaseId, jobs: [job, 'daemon-soak'] } },
    exec, readJobs, readLog, readList, write, touchedFiles: () => [], log: () => {}, ...overrides,
  });
  const noRerun = () => expect(exec.mock.calls.filter(([, argv]) => argv?.includes('rerun'))).toEqual([]);
  return { tick, ledger, exec, noRerun, readLog, write, list: () => list };
}

const snapshot = (run, jobFailures = { [job]: failure() }) => ({
  runId: run.databaseId, createdAt: run.createdAt, headSha: run.headSha, jobFailures,
});

describe('red-main passively collects repeat evidence; the conveyor owns reruns', () => {
  it('removes the duplicate rerun setting from defaults and ignores its old env/tool/platform values', () => {
    const config = join(temp(), 'settings.json');
    writeFileSync(config, JSON.stringify({ redMainQuarantine: { rerunFailedOnce: true } }));
    for (const settings of [
      resolveQuarantineSettings({ env: {}, platform: null, file: join(temp(), 'absent.json') }),
      resolveQuarantineSettings({ file: config, platform: { rerunFailedOnce: true },
        env: { WE_RED_MAIN_QUARANTINE_RERUN_FAILED_ONCE: 'on' } }),
    ]) {
      expect(settings.value).not.toHaveProperty('rerunFailedOnce');
      expect(settings.sources).not.toHaveProperty('rerunFailedOnce');
    }
  });

  it('attempt 1 stores a passive snapshot, adds nothing and never executes a rerun', () => {
    const h = harness();
    const out = h.tick();
    expect(out.plan.action).toBe('none');
    expect(out.applied).toBe(false);
    h.noRerun();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.ledger().reds[sha]).toMatchObject({ attempts: { 1: snapshot(originalRun) } });
    expect(h.ledger().reds[sha]).not.toHaveProperty('rerunRequestedFor');
    expect(h.ledger().reds[sha]).not.toHaveProperty('rerun');
  });

  it('attempt 2 failing the same file adds quarantine with repeat-failed proof for attempts [1,2]', () => {
    const h = harness({ values: { ttlMin: 15 } });
    h.tick();
    const out = h.tick(rerun);
    expect(out.plan.action).toBe('add');
    expect(out.applied).toBe(true);
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.list().entries).toEqual([expect.objectContaining({ test: file, job, brokenSha: sha,
      proof: { kind: 'repeat-failed', runIds: [runId, runId], attempts: [1, 2], shas: [sha, sha], count: 2 },
      expiresAt: now + 15 * 60_000,
    })]);
    expect(h.ledger().reds[sha].attempts).toMatchObject({ 1: snapshot(originalRun), 2: snapshot(rerun) });
    h.noRerun();
  });

  it('attempt 2 passing makes main green, adds nothing and records the flake outcome', () => {
    const h = harness();
    h.tick();
    const out = h.tick({ ...rerun, conclusion: 'success' });
    expect(out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('green') });
    expect(out.rerun).toEqual({ outcome: 'flake' });
    expect(h.ledger().reds[sha]).toMatchObject({ attempts: { outcome: 'passed-on-rerun (flake)' } });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.list().entries).toEqual([]);
    h.noRerun();
  });

  it('attempt 2 failing a different file remains unproven and preserves both snapshots', () => {
    const h = harness();
    h.tick();
    const different = failure('scripts/lib/__tests__/different.test.mjs');
    h.readLog.mockReturnValue(different);
    expect(h.tick(rerun).plan.action).toBe('none');
    expect(h.write).not.toHaveBeenCalled();
    expect(h.ledger().reds[sha].attempts).toMatchObject({
      1: snapshot(originalRun), 2: snapshot(rerun, { [job]: different }),
    });
    h.noRerun();
  });

  it('does not classify two failed attempts as a flake when a different run makes main green', () => {
    const h = harness();
    h.tick();
    h.readLog.mockReturnValue(failure('scripts/lib/__tests__/different.test.mjs'));
    h.tick(rerun);
    const out = h.tick({ ...rerun, databaseId: runId + 1, headSha: 'b'.repeat(40), conclusion: 'success',
      createdAt: '2026-10-28T11:30:00Z' });
    expect(out.rerun).toBeUndefined();
    expect(h.ledger().reds[sha].attempts).not.toHaveProperty('outcome');
    expect(h.ledger().reds[sha].attempts).toMatchObject({
      1: snapshot(originalRun),
      2: snapshot(rerun, { [job]: failure('scripts/lib/__tests__/different.test.mjs') }),
    });
    expect(h.write).not.toHaveBeenCalled();
    h.noRerun();
  });

  it.each([3, 4, 10])('preserves sufficient distinct-run history for proof count %s when attempt 2 fails', (count) => {
    const h = harness({ values: { repeatFailureCount: count } });
    h.tick();
    const history = Array.from({ length: count - 1 }, (_, i) => ({
      ...originalRun, databaseId: runId - count + i + 1,
      createdAt: new Date(Date.parse(originalRun.createdAt) - (count - i) * 60_000).toISOString(),
    }));
    const out = h.tick(rerun, {
      mainCiRuns: { runs: [...history, rerun], failing: { runId, jobs: [job, 'daemon-soak'] } },
    });
    expect(out).toMatchObject({ applied: true, plan: { action: 'add' } });
    expect(h.list().entries).toEqual([expect.objectContaining({
      test: file, proof: {
        kind: 'repeat-failed', count,
        runIds: [...history.slice(1).map((r) => r.databaseId), runId, runId],
        attempts: [...history.slice(1).map(() => 1), 1, 2], shas: [sha, sha],
      },
    })]);
    expect(h.write).toHaveBeenCalledOnce();
    h.noRerun();
  });

  it('same run id and same attempt never count twice, even with a changed updatedAt', () => {
    const h = harness();
    h.tick();
    h.tick();
    expect(h.tick({ ...originalRun, updatedAt: rerun.updatedAt }).plan.action).toBe('none');
    expect(h.write).not.toHaveBeenCalled();
    h.noRerun();
  });

  it.each([1, 2])('in-progress attempt %s adds nothing', (attempt) => {
    const h = harness();
    h.tick();
    const out = h.tick({ ...rerun, attempt, status: 'in_progress', conclusion: null });
    expect(out.plan.action).toBe('none');
    expect(h.write).not.toHaveBeenCalled();
    h.noRerun();
  });

  it.each([{ live: false }, { mode: { value: 'stop', source: 'test' } }])('shadow mode applies nothing: %j', (overrides) => {
    const h = harness();
    h.tick(originalRun, overrides);
    const out = h.tick(rerun, overrides);
    expect(out).toMatchObject({ shadow: true, applied: false, plan: { action: 'add' } });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.list().entries).toEqual([]);
    h.noRerun();
  });

  it.each([originalRun.createdAt, undefined, 'invalid'])('refuses attempt 2 without strictly later updatedAt: %s', (updatedAt) => {
    const h = harness();
    h.tick();
    expect(h.tick({ ...rerun, updatedAt }).plan.action).toBe('none');
    expect(h.write).not.toHaveBeenCalled();
    h.noRerun();
  });

  it('does not invent an earlier snapshot when first observing attempt 2', () => {
    const h = harness();
    expect(h.tick(rerun).plan.action).toBe('none');
    expect(h.write).not.toHaveBeenCalled();
    h.noRerun();
  });

  it('requires the immediately preceding attempt, rather than jumping from attempt 1 to 3', () => {
    const h = harness();
    h.tick();
    expect(h.tick({ ...rerun, attempt: 3 }).plan.action).toBe('none');
    expect(h.write).not.toHaveBeenCalled();
    h.noRerun();
  });

  it('resets snapshots on a new run id instead of combining attempts from different runs', () => {
    const h = harness();
    h.tick();
    const next = { ...rerun, databaseId: runId + 1 };
    expect(h.tick(next).plan.action).toBe('none');
    expect(h.ledger().reds[sha].attempts).toEqual({ 2: snapshot(next) });
    expect(h.write).not.toHaveBeenCalled();
    h.noRerun();
  });

  it.each([1, 2])('refuses incomplete log evidence at attempt %s', (attempt) => {
    const h = harness();
    if (attempt === 2) h.tick();
    h.readLog.mockReturnValue({ ...failure(), complete: false });
    expect(h.tick(attempt === 1 ? originalRun : rerun).plan.action).toBe('none');
    expect(h.ledger().reds[sha].attempts?.[String(attempt)]).toBeUndefined();
    expect(h.write).not.toHaveBeenCalled();
    h.noRerun();
  });
});
