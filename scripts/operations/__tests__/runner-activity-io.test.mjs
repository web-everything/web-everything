/** Real subprocess/disk fidelity, separate from the filesystem-free injected unit suite. */
import { it, expect, beforeAll, afterAll } from 'vitest';
import { makeGitOverlay } from '../../lib/hermetic-git-overlay.mjs';
import { DEFAULT_REPO_ROOT } from '../../lib/hermetic-tests.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createRunnerActivityReader, READ_TIMEOUT_MS, CLI_IO_TIMEOUT_MS } from '../runner-activity-io.mjs';
import { assessRunnerActivity } from '../runner-activity.mjs';
import { createFileRunStore, newRunRecord } from '../run-store.mjs';
import { DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { lockDirFor } from '../../readiness/file-locks.mjs';
import { RUNNER_LEASE_PATH } from '../../../skills-src/conveyor/runner-lock.mjs';

it('reads real durable outcomes through the bounded child without mutating them, and reports down', async () => {
  await withRealRepo(({ root }) => {
    const dir = join(root, '.operations', 'runs');
    const store = createFileRunStore(dir);
    const record = newRunRecord({ id: 'completed-dispatch', op: 'dispatch-lane' });
    record.effects.push({ key: 'completed-dispatch:2:0', stepIndex: 2, step: 'dispatch', index: 0,
      type: DISPATCH_EFFECT, status: 'applied', idempotent: false, dispatch: true,
      payload: { num: '123', launchKind: 'build' }, result: { resolvedBy: 'pr-merged' }, error: null,
      startedAt: '2026-09-15T10:00:00Z' });
    store.write(record);
    const path = join(dir, `${record.id}.json`);
    const before = readFileSync(path, 'utf8');
    const read = createRunnerActivityReader({ env: { ...process.env,
      CONVEYOR_RUNNER_LOCK_ROOT: join(root, 'absent-locks'), OPERATION_RUNS_DIR: dir } });
    const report = assessRunnerActivity(read({ limit: 10 }));
    expect(report.state).toBe('down');
    expect(report.completedDispatches).toEqual([expect.objectContaining({ outcome: 'applied', num: '123' })]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(store.list()).toEqual(['completed-dispatch']);
  });
});

it('kills a snapshot blocked in an actual filesystem read at the hard deadline', async () => {
  await withRealRepo(({ root }) => {
    const lockRoot = join(root, 'locks');
    const dir = lockDirFor(lockRoot, RUNNER_LEASE_PATH);
    mkdirSync(dir, { recursive: true });
    // Opening a FIFO with no writer blocks readFileSync: only the OUTER deadline can stop this read.
    execFileSync('mkfifo', [join(dir, 'lock.json')], { timeout: 2000 });
    const read = createRunnerActivityReader({ env: { ...process.env,
      CONVEYOR_RUNNER_LOCK_ROOT: lockRoot, OPERATION_RUNS_DIR: join(root, 'runs') } });
    let failure;
    try { read({ limit: 10 }); } catch (e) { failure = e; }
    expect(failure?.code).toBe('ETIMEDOUT');
    expect(failure?.signal).toBe('SIGKILL');
  });
  // #4075 follow-up (ci-heal-2721): the deadline this asserts (READ_TIMEOUT_MS) is fixed and never grows under
  // load — only the SLACK above it (for the SIGKILL to actually land and this test's own assertions to run)
  // needs headroom on a busy host.
}, READ_TIMEOUT_MS + 40_000);

const CLI = join(process.cwd(), 'scripts/operations/run.mjs');
// Pin origin/main to HEAD so the CLI's runner-freshness check stays local.
let overlay;
beforeAll(() => { overlay = makeGitOverlay(DEFAULT_REPO_ROOT); });
afterAll(() => overlay?.cleanup());

// The production IO deadline is already short (2s). The wall clock also includes the real CLI's
// module loading, nested Node startups, scheduling and SIGKILL/exit propagation. CI has exhausted
// the old 45s watchdog, so reserve 30 IO-timeout intervals (currently 60s) for that overhead.
// Keep this allowance separate from the production deadline; status/signal assertions below must
// still prove the CLI's own timeout refused the blocked IO, rather than our watchdog killing it.
const CLI_PROCESS_MARGIN_MS = 30 * CLI_IO_TIMEOUT_MS;
const OUTER_WALL_CEILING_MS = CLI_IO_TIMEOUT_MS + CLI_PROCESS_MARGIN_MS;
// Leave one more timeout interval for watchdog teardown; it is not part of the asserted bound.
const CLI_WATCHDOG_MS = OUTER_WALL_CEILING_MS + CLI_IO_TIMEOUT_MS;

it.each(['resume', 'initial-write', 'subsequent-write', 'call-log'])(
  'bounds actual CLI %s IO blocked on a FIFO', async (stage) => {
    await withRealRepo(({ root }) => {
      const runs = join(root, 'runs');
      const calls = join(root, 'calls');
      mkdirSync(runs);
      mkdirSync(calls);
      const fifo = stage === 'resume' ? join(runs, 'blocked.json')
        : stage === 'call-log' ? join(calls, new Date().toISOString().slice(0, 10) + '.jsonl')
          : join(root, 'write-fifo');
      execFileSync('mkfifo', [fifo], { timeout: 2000 });
      const env = { ...process.env, ...overlay.env, OPERATION_RUNS_DIR: runs, OPERATION_CALLS_DIR: calls,
        CONVEYOR_RUNNER_LOCK_ROOT: join(root, 'absent-locks') };
      if (stage.includes('write')) {
        // Atomic writes use an unpredictable PID/timestamp temp path. Redirect that write to
        // a real FIFO, optionally only after the initial run record has been persisted.
        const preload = join(root, 'block-write.cjs');
        writeFileSync(preload, `
          const fs = require('node:fs');
          const original = fs.writeFileSync;
          fs.writeFileSync = function(path, ...args) {
            if (typeof path === 'string' && path.endsWith('.tmp') &&
                (${JSON.stringify(stage)} === 'initial-write' || fs.existsSync(${JSON.stringify(join(runs, 'bounded.json'))}))) {
              return original(${JSON.stringify(fifo)}, ...args);
            }
            return original(path, ...args);
          };
        `);
        env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require=${preload}`;
      }
      let output;
      let failure;
      const started = Date.now();
      try {
        output = execFileSync(process.execPath, [CLI, 'runner-activity', '--json',
          stage === 'resume' ? '--resume=blocked' : '--run-id=bounded'], {
          env, encoding: 'utf8', timeout: CLI_WATCHDOG_MS, killSignal: 'SIGKILL',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) { failure = e; output = String(e.stdout || ''); }
      const elapsedMs = Date.now() - started;
      expect(elapsedMs).toBeLessThan(OUTER_WALL_CEILING_MS);
      expect(elapsedMs).toBeGreaterThanOrEqual(CLI_IO_TIMEOUT_MS);
      if (stage === 'call-log') {
        expect(failure).toBeUndefined();
        expect(JSON.parse(output).verdict.state).toBe('down');
      } else {
        expect(failure?.status).toBe(1);
        expect(failure?.signal).toBeNull(); // CLI refused; the test watchdog did not kill it.
        expect(output).toMatch(/ETIMEDOUT/);
      }
      if (stage === 'subsequent-write') expect(readFileSync(join(runs, 'bounded.json'), 'utf8')).toContain('runner-activity');
    });
  }, CLI_WATCHDOG_MS + CLI_PROCESS_MARGIN_MS,
);

it('persists and resumes runner-activity through the actual CLI', async () => {
  await withRealRepo(({ root }) => {
    const env = { ...process.env, ...overlay.env, OPERATION_RUNS_DIR: join(root, 'runs'),
      OPERATION_CALLS_DIR: join(root, 'calls'), CONVEYOR_RUNNER_LOCK_ROOT: join(root, 'absent') };
    for (const flag of ['--run-id=healthy', '--resume=healthy']) {
      // #4075 follow-up (ci-heal-2721): same real-CLI round trip as above, so the same load-tolerant outer
      // ceiling applies (this path is healthy/fast in the normal case — the ceiling only matters as a
      // load-tolerant safety margin, never as the expected duration).
      const output = execFileSync(process.execPath, [CLI, 'runner-activity', '--json', flag], {
        env, encoding: 'utf8', timeout: OUTER_WALL_CEILING_MS, killSignal: 'SIGKILL',
      });
      expect(JSON.parse(output).verdict.state).toBe('down');
    }
    expect(JSON.parse(readFileSync(join(root, 'runs/healthy.json'), 'utf8')).op).toBe('runner-activity');
    expect(readFileSync(join(root, 'calls', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
      .trim().split('\n')).toHaveLength(2);
  });
}, OUTER_WALL_CEILING_MS * 2 + 10_000);
