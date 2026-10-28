// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveQuarantineSettings, runSafetyNet, SAFETY_NET_LEDGER } from '../red-main-quarantine-io.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-rerun-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function harness({ values = {}, execError } = {}) {
  const dir = temp();
  const ledgerPath = join(dir, SAFETY_NET_LEDGER);
  const ledger = () => JSON.parse(readFileSync(ledgerPath, 'utf8'));
  let list = { version: 1, entries: [] };
  const persistedAtExec = [];
  const exec = vi.fn(() => {
    persistedAtExec.push(ledger().reds[sha]);
    if (execError) throw execError;
    return '';
  });
  const readJobs = vi.fn(() => ({ failed: [{ id: 501, name: job }], jobs: [] }));
  const readLog = vi.fn(() => failure());
  const readList = vi.fn(() => ({ ok: true, list }));
  const write = vi.fn(({ change }) => {
    const result = change(list);
    if (result.ok) list = result.list;
    return result;
  });
  const settings = resolveQuarantineSettings({ env: {}, platform: null, file: join(dir, 'absent.json') });
  // Pin the new switch here so behavior failures are independent of its default-resolution test.
  settings.value = { ...settings.value, rerunFailedOnce: true, ...values };
  const tick = (run = originalRun, overrides = {}) => runSafetyNet({
    dir, now, repoSlug, mode: { value: 'quarantine', source: 'test' }, settings,
    mainCiRuns: { runs: [run], failing: { runId: run.databaseId, jobs: [job, 'daemon-soak'] } },
    exec, readJobs, readLog, readList, write, touchedFiles: () => [], log: () => {}, ...overrides,
  });
  return { tick, ledger, ledgerPath, exec, persistedAtExec, readLog, write, list: () => list };
}

describe('red-main rerunFailedOnce settings cascade', () => {
  it('defaults to true with standard provenance and maps the environment switch', () => {
    const file = join(temp(), 'absent.json');
    const base = { env: {}, platform: null, file };
    expect(resolveQuarantineSettings(base)).toMatchObject({ value: { rerunFailedOnce: true }, sources: { rerunFailedOnce: 'standard' } });
    expect(resolveQuarantineSettings({ ...base, env: { WE_RED_MAIN_QUARANTINE_RERUN_FAILED_ONCE: 'off' } }))
      .toMatchObject({ value: { rerunFailedOnce: false }, sources: { rerunFailedOnce: 'env' } });
  });

  it('resolves standard → platform → tool → environment and rejects invalid boolean values', () => {
    const file = join(temp(), 'settings.json');
    const base = { file, platform: { rerunFailedOnce: false }, env: {} };
    expect(resolveQuarantineSettings(base)).toMatchObject({ value: { rerunFailedOnce: false }, sources: { rerunFailedOnce: 'platform' } });
    writeFileSync(file, JSON.stringify({ redMainQuarantine: { rerunFailedOnce: true } }));
    expect(resolveQuarantineSettings(base)).toMatchObject({ value: { rerunFailedOnce: true }, sources: { rerunFailedOnce: 'tool' } });
    expect(resolveQuarantineSettings({ ...base, env: { WE_RED_MAIN_QUARANTINE_RERUN_FAILED_ONCE: 'off' } }))
      .toMatchObject({ value: { rerunFailedOnce: false }, sources: { rerunFailedOnce: 'env' } });
    expect(resolveQuarantineSettings({ ...base, env: { WE_RED_MAIN_QUARANTINE_RERUN_FAILED_ONCE: 'on' } }))
      .toMatchObject({ value: { rerunFailedOnce: true }, sources: { rerunFailedOnce: 'env' } });
    expect(resolveQuarantineSettings({ ...base, env: { WE_RED_MAIN_QUARANTINE_RERUN_FAILED_ONCE: 'garbage' } }))
      .toMatchObject({ value: { rerunFailedOnce: true }, sources: { rerunFailedOnce: 'tool' } });
    writeFileSync(file, JSON.stringify({ redMainQuarantine: { rerunFailedOnce: 'off' } }));
    expect(resolveQuarantineSettings(base)).toMatchObject({ value: { rerunFailedOnce: false }, sources: { rerunFailedOnce: 'platform' } });
  });
});

describe('red-main requests one failed-job rerun for repeat evidence', () => {
  it.each(['failure', 'timed_out'])('persists intent before requesting exactly one completed %s rerun without quarantine writes', (conclusion) => {
    const h = harness();
    const out = h.tick({ ...originalRun, conclusion });
    expect(out.plan).toMatchObject({ action: 'none', why: expect.stringMatching(/not a proven flake/) });
    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.exec).toHaveBeenCalledWith('gh', ['run', 'rerun', String(runId), '--repo', repoSlug, '--failed'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL',
    });
    const intent = {
      rerunRequestedFor: sha,
      rerun: { runId, requestedAt: now, runKey: `${runId}@${originalRun.updatedAt}`, headSha: sha,
        createdAt: originalRun.createdAt, jobFailures: { [job]: failure() } },
    };
    expect(h.persistedAtExec).toEqual([expect.objectContaining(intent)]);
    expect(h.ledger().reds[sha]).toMatchObject(intent);
    expect(out.rerun).toEqual({ requested: true, runId, sha });
    expect(h.write).not.toHaveBeenCalled();
  });

  it('quarantines the same file after a second failed attempt on the same run id', () => {
    const h = harness({ values: { ttlMin: 15 } });
    h.tick();
    const out = h.tick(rerun);
    expect(out.plan.action).toBe('add');
    expect(out.applied).toBe(true);
    expect(h.write).toHaveBeenCalledOnce();
    // Appending 1 is the documented synthetic attempt-1 id; the latest id remains real.
    expect(h.list().entries).toEqual([expect.objectContaining({ test: file, job, brokenSha: sha,
      proof: { kind: 'repeat-failed', runIds: [Number(`${runId}1`), runId], shas: [sha, sha], count: 2 },
      expiresAt: now + 15 * 60_000,
    })]);
    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.ledger().reds[sha].rerun.jobFailures).toEqual({ [job]: failure() });
  });

  it('keeps a file seen only on attempt 2 unproven and preserves attempt-1 evidence', () => {
    const h = harness();
    h.tick();
    h.readLog.mockReturnValue(failure('scripts/lib/__tests__/different.test.mjs'));
    expect(h.tick(rerun).plan.action).toBe('none');
    expect(h.write).not.toHaveBeenCalled();
    expect(h.ledger().reds[sha].rerun).toMatchObject({ jobFailures: { [job]: failure() } });
  });

  it('records passed-on-rerun as a flake before returning on green with an empty list', () => {
    const h = harness();
    h.tick();
    const out = h.tick({ ...rerun, conclusion: 'success' });
    expect(out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('green') });
    expect(out.rerun).toEqual({ outcome: 'flake' });
    expect(h.ledger().reds[sha].rerun.outcome).toBe('passed-on-rerun (flake)');
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each([false, true])('never retries a request across ticks, including exec error=%s', (throws) => {
    const h = harness({ execError: throws ? new Error('rerun refused\nremote detail') : undefined });
    h.tick();
    h.tick();
    h.tick();
    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.ledger().reds[sha].rerunRequestedFor).toBe(sha);
    if (throws) expect(h.ledger().reds[sha].rerun.error).toBe('rerun refused');
    expect(h.write).not.toHaveBeenCalled();
  });

  it('does not rerun an in-progress workflow', () => {
    const h = harness();
    h.tick({ ...originalRun, status: 'in_progress', conclusion: null });
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.ledger().reds[sha]?.rerunRequestedFor).toBeUndefined();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('keeps the old none plan when rerunFailedOnce is disabled', () => {
    const h = harness({ values: { rerunFailedOnce: false } });
    expect(h.tick().plan).toMatchObject({ action: 'none', why: expect.stringMatching(/not a proven flake/) });
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.ledger().reds[sha].rerunRequestedFor).toBeUndefined();
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each([{ live: false }, { mode: { value: 'stop', source: 'test' } }])('reports a shadow request without executing or recording intent: %j', (overrides) => {
    const h = harness();
    const out = h.tick(originalRun, overrides);
    expect(out.rerun).toEqual({ requested: false, shadow: true, wouldRequest: { runId, sha } });
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.ledger().reds[sha].rerunRequestedFor).toBeUndefined();
    expect(h.ledger().reds[sha].rerun).toBeUndefined();
  });

  it('refuses incomplete evidence from any failed unit job', () => {
    const h = harness();
    const out = h.tick(originalRun, { mainCiRuns: { runs: [originalRun], failing: { runId, jobs: [job, 'integration', 'daemon-soak'] } } });
    expect(out.plan.action).toBe('none');
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.ledger().reds[sha].rerunRequestedFor).toBeUndefined();
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each([0, -1, 'unknown'])('refuses an invalid rerun id: %s', (databaseId) => {
    const h = harness();
    h.tick({ ...originalRun, databaseId });
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.ledger().reds[sha].rerunRequestedFor).toBeUndefined();
  });
});
