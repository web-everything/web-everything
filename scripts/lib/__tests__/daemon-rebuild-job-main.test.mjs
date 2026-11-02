import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../daemon-jobs-runtime.mjs', async importOriginal => ({
  ...await importOriginal(),
  runJob: vi.fn(),
}));

import { runJob } from '../daemon-jobs-runtime.mjs';
import * as jobs from '../daemon-rebuild/rebuild-job.mjs';
import { alertsFilePath } from '../daemon-rebuild/state.mjs';
import { acquireRead, cloneLockDirs } from '../daemon-clone-lock.mjs';
import { heartbeat } from '../../readiness/file-locks.mjs';

// Intended seam: export jobMain({ runChild = runRebuildChild,
// reportTimeout = reportReaderWaitTimeout, env = process.env,
// ppid = process.ppid, host = hostname() } = {}). The runtime is mocked only
// to drive its registered step; the result writer and timeout reporter stay real.
let scratch;
let env;
let input;
const jobId = 'fixture-rebuild';
beforeEach(() => {
  vi.resetAllMocks();
  scratch = fs.mkdtempSync(join(tmpdir(), 'rebuild-job-main-'));
  env = {
    OPERATION_RUNS_DIR: scratch,
    DAEMON_JOB_ID: jobId,
    DAEMON_JOB_ATTEMPT: '2',
    DAEMON_JOB_HEARTBEAT_MS: '1000',
    DAEMON_JOB_FUTURE_SETTING: 'also-private',
    WE_DAEMON_STATE_DIR: join(scratch, 'state'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(scratch, 'locks'),
    WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS: 'unsafe:999',
    [jobs.REBUILD_AS_JOB_ENV]: '1',
    PRESERVED_SETTING: 'keep-me',
  };
  input = { root: join(scratch, 'clone'), mainOnly: true, entries: ['daemon.mjs'] };
  runJob.mockImplementation(async ({ steps }) => {
    expect(steps).toHaveLength(1);
    await steps[0].run({ jobId, input });
    return { outcome: 'succeeded' };
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // Do not install the production signal handlers on the test worker.
  vi.spyOn(process, 'on').mockReturnValue(process);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const readResult = () => JSON.parse(fs.readFileSync(join(scratch, `${jobId}${jobs.RESULT_SUFFIX}`), 'utf8'));

describe('detached rebuild jobMain integration', () => {
  it.each([60796, 1, 0])('passes a sanitized child env with only a live spawner identity (ppid %s)', async ppid => {
    const original = { ...env };
    const runChild = vi.fn(async () => ({ reason: 'ready-recorded', readyRecorded: true, target: 'abc' }));
    const reportTimeout = vi.fn(() => null);
    await jobs.jobMain({ runChild, reportTimeout, env, ppid, host: 'host' });
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runChild).toHaveBeenCalledTimes(1);
    const call = runChild.mock.calls[0][0];
    expect(call.input).toEqual(input);
    expect(call.env[jobs.REBUILD_AS_JOB_ENV]).toBe('0');
    expect(call.env.PRESERVED_SETTING).toBe('keep-me');
    expect(Object.keys(call.env).filter(k => k.startsWith('DAEMON_JOB_') || k === 'OPERATION_RUNS_DIR')).toEqual([]);
    if (ppid > 1) expect(call.env.WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS).toBe(`host:${ppid}`);
    else expect(call.env).not.toHaveProperty('WE_DAEMON_CLONE_LOCK_IGNORE_OWNERS');
    expect(env).toEqual(original);
    expect(readResult()).toMatchObject({ reason: 'ready-recorded', readyRecorded: true, target: 'abc' });
  });

  it('overrides the child reason in the result file and emits the timeout event through injected IO', async () => {
    const r = { reason: 'tick-in-progress', heldBy: 'host:123', moved: false };
    const runChild = vi.fn(async () => r);
    const event = vi.fn();
    const exec = vi.fn(() => 'node daemon.mjs');
    const lockRoot = env.WE_DAEMON_CLONE_LOCK_ROOT;
    expect(acquireRead(input.root, { lockRoot, owner: 'host:123', pid: 123,
      nowMs: 1000, probe: () => 'alive',
    }).ok).toBe(true);
    expect(heartbeat(cloneLockDirs(input.root, lockRoot).readersRoot,
      'host:123', 'host:123', new Date(2000).toISOString(), 123)).toBe(true);
    const reportTimeout = vi.fn(args => jobs.reportReaderWaitTimeout({
      ...args, io: fs, event, exec, now: () => 5000, host: 'host',
    }));
    await jobs.jobMain({ runChild, reportTimeout, env, ppid: 456, host: 'host' });
    expect(reportTimeout).toHaveBeenCalledTimes(1);
    expect(reportTimeout).toHaveBeenCalledWith(expect.objectContaining({ root: input.root, r }));
    const detail = { pid: 123, command: 'node daemon.mjs', tickAgeMs: 3000 };
    expect(readResult()).toMatchObject({ reason: 'reader-wait-timeout', detail });
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith(input.root, {
      kind: 'reader-wait-timeout-needs-you', ...detail,
    }, { env: expect.objectContaining({ WE_DAEMON_STATE_DIR: env.WE_DAEMON_STATE_DIR }) });
    expect(JSON.parse(fs.readFileSync(alertsFilePath(input.root, env), 'utf8'))).toEqual({
      at: new Date(5000).toISOString(), kind: 'reader-wait-timeout-needs-you', detail,
    });
  });

  it('preserves a non-timeout child reason without emitting a timeout event', async () => {
    const r = { reason: 'smoke-transient', readyRecorded: false, alerts: [{ kind: 'smoke-failed' }] };
    const event = vi.fn();
    const exec = vi.fn();
    const reportTimeout = vi.fn(args => jobs.reportReaderWaitTimeout({ ...args, io: fs, event, exec }));
    await jobs.jobMain({ runChild: vi.fn(async () => r), reportTimeout, env, ppid: 456, host: 'host' });
    expect(reportTimeout).toHaveBeenCalledTimes(1);
    expect(readResult()).toMatchObject({ reason: r.reason, readyRecorded: false, alerts: ['smoke-failed'] });
    expect(readResult()).not.toHaveProperty('detail');
    expect(event).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(fs.existsSync(alertsFilePath(input.root, env))).toBe(false);
  });
});
