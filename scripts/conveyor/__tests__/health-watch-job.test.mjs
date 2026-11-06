import { removeReadonlyTree } from '../../lib/readonly-tree.mjs';
/**
 * @file scripts/conveyor/__tests__/health-watch-job.test.mjs
 * @description #4131 — the health-gh-probe JOB CHILD, for real: a detached process launched by the shared
 *   runtime from a pinned snapshot, whose probe body BLOCKS its worker thread the way a synchronous `execFileSync`
 *   read does. The heartbeat keeps advancing during the block (the job's own event loop is free), the result
 *   sidecar lands, and the tick side consumes it once. Plus the step's idempotent sidecar write and the worker
 *   timeout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runGhProbeJobs, ghProbeStep, runProbeWorker, prewarmSnapshots, RESULT_SUFFIX } from '../health-watch-job.mjs';
import { createJobStore, enqueueJob } from '../../lib/daemon-jobs-runtime.mjs';
import { HEALTH_GH_PROBE_KIND } from '../../../skills-src/conveyor/daemon-manifest.mjs';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let dir;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'health-job-child-')); });
afterAll(() => { removeReadonlyTree(dir); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snapshot = {
  materialize: (into) => {
    for (const d of ['scripts', 'skills-src']) cpSync(join(REPO, d), join(into, d), { recursive: true, filter: (s) => !s.includes('__tests__') });
    for (const f of ['package.json', 'package-lock.json']) cpSync(join(REPO, f), join(into, f));
  },
  // The proof worker uses only Node builtins. Give its snapshot a private dependency tree:
  // alias validation resolves symlinks and checks quarantine markers beside the target store,
  // so linking the checkout's node_modules would read live lane-pool state on snapshot reuse.
  install: (into) => {
    mkdirSync(join(into, 'node_modules'));
    writeFileSync(join(into, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  },
};

describe('health-gh-probe job child', () => {
  it('heartbeats while its worker is blocked, writes its result, and the tick consumes it once', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    mkdirSync(store.dir, { recursive: true });
    const job = enqueueJob({ store, kindDef: HEALTH_GH_PROBE_KIND, codeSha: 'test-snapshot', input: { sourceRoot: REPO, proofBlockMs: 2500 } });
    prewarmSnapshots({ jobsDir: store.dir, codeSha: 'test-snapshot', snapshot }); // what the detached prewarm child does; the tick builds nothing
    const opts = { store, codeSha: 'test-snapshot', snapshot, input: { sourceRoot: REPO }, reattachOpts: { heartbeatIntervalMs: 200 } };
    let state = {};
    const beats = new Set();
    let consumed = null;
    for (let i = 0; i < 100 && !consumed; i += 1) {
      const out = await runGhProbeJobs({ ...opts, now: Date.now(), due: false, state });
      state = out.state;
      const rec = store.read(job.id);
      if (rec?.job.status === 'running') beats.add(rec.job.heartbeatAt);
      if (out.result) consumed = out.result;
      await sleep(250);
    }
    if (!consumed) console.error(JSON.stringify(store.read(job.id)?.job), existsSync(join(store.dir, `${job.id}.log`)) ? readFileSync(join(store.dir, `${job.id}.log`), 'utf8') : 'no log');
    expect(consumed?.jobId).toBe(job.id);
    expect(beats.size).toBeGreaterThanOrEqual(4); // the heartbeat moved during the 2.5 s block
    const rec = store.read(job.id);
    expect(rec.job.status).toBe('succeeded');
    expect(rec.job.attempts).toBe(1);
    expect(rec.job.checkpoint.data.resultFile).toBe(`${job.id}${RESULT_SUFFIX}`);
    const again = await runGhProbeJobs({ ...opts, now: Date.now(), due: false, state });
    expect(again.result).toBeNull();
  }, 60000);

  it('a graceful stop (SIGTERM) takes the job and its probe subprocess down together', async () => {
    const store = createJobStore(join(dir, 'jobs-stop'));
    mkdirSync(store.dir, { recursive: true });
    const job = enqueueJob({ store, kindDef: HEALTH_GH_PROBE_KIND, codeSha: 'test-snapshot-stop', input: { sourceRoot: REPO, proofBlockMs: 30_000 } });
    prewarmSnapshots({ jobsDir: store.dir, codeSha: 'test-snapshot-stop', snapshot });
    const opts = { store, codeSha: 'test-snapshot-stop', snapshot, input: { sourceRoot: REPO }, reattachOpts: { heartbeatIntervalMs: 200 } };
    const group = (pgid) => { try { return execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };
    let pid = null;
    let members = [];
    for (let i = 0; i < 80 && members.length < 2; i += 1) {
      await runGhProbeJobs({ ...opts, now: Date.now(), due: false, state: {} });
      pid = store.read(job.id)?.job.pid ?? null;
      if (pid) members = group(pid);
      await sleep(250);
    }
    expect(pid).toBeTruthy();
    expect(members).toContain(pid); // the detached job leads its own process group…
    expect(members.length).toBeGreaterThanOrEqual(2); // …and its blocked probe's subprocess is in it
    process.kill(pid, 'SIGTERM');
    let left = members;
    for (let i = 0; i < 40 && left.length; i += 1) { await sleep(100); left = group(pid); }
    if (left.length) console.error(execFileSync('ps', ['-o', 'pid,ppid,pgid,stat,command', '-p', left.join(',')], { encoding: 'utf8' }));
    expect(left).toEqual([]);
  }, 60000);

  it.each([false, true])('escalates a SIGTERM-resistant CLI and empties its group (worker exits first: %s)', async (workerFirst) => {
    const fixture = join(dir, `resistant-${workerFirst}.mjs`);
    // Exercise the production shutdown handler in a real detached leader. The CLI and worker
    // belong to that leader; the worker's early exit must not cancel CLI escalation.
    writeFileSync(fixture, `
      import { spawn } from 'node:child_process';
      import { Worker } from 'node:worker_threads';
      import { installProbeShutdown } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts/conveyor/health-probe-shutdown.mjs')).href)};
      const finish = installProbeShutdown();
      const worker = new Worker(${JSON.stringify(keepAliveScript())}, { eval: true });
      const cli = spawn(process.execPath, ['-e', ${JSON.stringify(keepAliveScript({ prelude: "process.on('SIGTERM', () => process.send('term'));", postlude: "process.send('ready');" }))}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let workerExited = false;
      const workerExit = new Promise(resolve => worker.once('exit', () => {
        workerExited = true;
        process.send({ type: 'worker-exit' });
        resolve();
      }));
      const cliExit = new Promise(resolve => cli.once('exit', (code, signal) => {
        process.send({ type: 'cli-exit', signal, workerExited });
        resolve();
      }));
      process.on('SIGTERM', () => { if (${workerFirst}) void worker.terminate(); });
      cli.on('message', message => {
        process.send({ type: message, cliPid: cli.pid });
      });
      await cliExit;
      if (!${workerFirst}) await worker.terminate();
      await workerExit;
      await finish();
      process.disconnect();
    `);
    const child = spawn(process.execPath, [fixture], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const deadline = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 7000);
    try {
      const ready = new Promise((resolve, reject) => {
        child.on('message', message => {
          messages.push(message);
          if (message.type === 'ready') resolve(message);
        });
        child.once('exit', () => reject(new Error(`resistant fixture exited before readiness: ${stderr}`)));
      });
      const cli = await ready;
      expect(cli.cliPid).toBeGreaterThan(0);
      const started = Date.now();
      process.kill(child.pid, 'SIGTERM');
      expect(await exited, stderr).toEqual({ code: 0, signal: null });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(messages.some(message => message.type === 'term')).toBe(true);
      expect(messages.find(message => message.type === 'cli-exit')).toMatchObject({
        signal: 'SIGKILL', workerExited: workerFirst,
      });
      // pgrep includes zombies. Only exit 1 means an empty group; unreadable evidence fails.
      let members;
      try {
        members = execFileSync('pgrep', ['-g', String(child.pid)], { encoding: 'utf8', timeout: 1000 }).trim();
      } catch (error) {
        if (error.status !== 1) throw error;
        members = '';
      }
      expect(members).toBe('');
    } finally {
      clearTimeout(deadline);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await exited;
    }
  }, 15000);

  it('kills the detached leader and empties its group when its worker keeps running after SIGTERM', async () => {
    const fixture = join(dir, 'worker-keeps-running.mjs');
    writeFileSync(fixture, `
      import { spawn } from 'node:child_process';
      import { Worker } from 'node:worker_threads';
      import { installProbeShutdown } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts/conveyor/health-probe-shutdown.mjs')).href)};
      const finish = installProbeShutdown();
      const worker = new Worker(${JSON.stringify(keepAliveScript({ postlude: "require('node:worker_threads').parentPort.postMessage('ready');" }))}, { eval: true });
      const workerReady = new Promise(resolve => worker.once('message', resolve));
      const cli = spawn(process.execPath, ['-e', ${JSON.stringify(keepAliveScript({ prelude: "process.on('SIGTERM', () => process.send('term'));", postlude: "process.send('ready');" }))}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const cliReady = new Promise(resolve => cli.once('message', resolve));
      const cliExit = new Promise(resolve => cli.once('exit', (code, signal) => {
        process.send({ type: 'cli-exit', signal });
        resolve();
      }));
      await Promise.all([workerReady, cliReady]);
      process.send({ type: 'ready', cliPid: cli.pid });
      await cliExit;
      await finish();
      process.disconnect();
      // Leave the worker running: only the shutdown handler can end this leader.
    `);
    const child = spawn(process.execPath, [fixture], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const deadline = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 7000);
    try {
      const ready = await new Promise((resolve, reject) => {
        child.on('message', message => {
          messages.push(message);
          if (message.type === 'ready') resolve(message);
        });
        child.once('exit', () => reject(new Error(`persistent worker fixture exited before readiness: ${stderr}`)));
      });
      expect(ready.cliPid).toBeGreaterThan(0);
      const started = Date.now();
      process.kill(child.pid, 'SIGTERM');
      expect(await exited, stderr).toEqual({ code: null, signal: 'SIGKILL' });
      expect(Date.now() - started).toBeLessThan(6000);
      expect(messages.find(message => message.type === 'cli-exit')).toMatchObject({ signal: 'SIGKILL' });
      let members;
      try {
        members = execFileSync('pgrep', ['-g', String(child.pid)], { encoding: 'utf8', timeout: 1000 }).trim();
      } catch (error) {
        if (error.status !== 1) throw error;
        members = '';
      }
      expect(members).toBe('');
    } finally {
      clearTimeout(deadline);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await exited;
    }
  }, 15000);

  it('forces group shutdown when process-group evidence is unreadable', async () => {
    const fixture = join(dir, 'unreadable-group.mjs');
    writeFileSync(fixture, `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      cp.execFileSync = () => { throw new Error('fixture process-group read denied'); };
      syncBuiltinESMExports();
      const { installProbeShutdown } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'scripts/conveyor/health-probe-shutdown.mjs')).href)});
      installProbeShutdown();
      ${keepAliveScript()}
      process.send('ready');
    `);
    const child = spawn(process.execPath, [fixture], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const deadline = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 7000);
    try {
      await new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('exit', () => reject(new Error(`unreadable fixture exited before readiness: ${stderr}`)));
      });
      process.kill(child.pid, 'SIGTERM');
      expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
      expect(stderr).toContain('fixture process-group read denied; forcing group shutdown');
    } finally {
      clearTimeout(deadline);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      await exited;
    }
  }, 15000);

  it('the step writes its sidecar atomically and is idempotent on a rerun', async () => {
    const d = mkdtempSync(join(dir, 'step-'));
    const runWorker = async ({ input }) => ({ probes: { prs: [{ number: input.now }] }, errors: {} });
    const a = await ghProbeStep({ jobId: 'job-x', input: {}, dir: d, runWorker, now: () => 5 });
    const b = await ghProbeStep({ jobId: 'job-x', input: {}, dir: d, runWorker, now: () => 6 });
    expect(a.resultFile).toBe(b.resultFile);
    const body = JSON.parse(readFileSync(join(d, `job-x${RESULT_SUFFIX}`), 'utf8'));
    expect(body.probes.prs[0].number).toBe(6);
    expect(existsSync(join(d, `job-x${RESULT_SUFFIX}.tmp-${process.pid}`))).toBe(false);
  });

  it('the step hands the isolated lane-scan cache target through to the probe worker unchanged', async () => {
    const d = mkdtempSync(join(dir, 'step-target-'));
    const seen = [];
    const runWorker = async ({ input }) => { seen.push(input); return { probes: {}, errors: {} }; };
    await ghProbeStep({ jobId: 'job-t', input: { laneScanDir: '/isolated/health', laneScanWrite: true }, dir: d, runWorker, now: () => 5 });
    await ghProbeStep({ jobId: 'job-t2', input: { laneScanDir: null, laneScanWrite: false }, dir: d, runWorker, now: () => 5 });
    expect(seen[0]).toMatchObject({ laneScanDir: '/isolated/health', laneScanWrite: true });
    expect(seen[1]).toMatchObject({ laneScanDir: null, laneScanWrite: false });
  });

  it('a worker that does not answer in time is terminated and the step fails', async () => {
    const t0 = Date.now();
    await expect(runProbeWorker({ input: { proofBlockMs: 3000 }, timeoutMs: 500 })).rejects.toThrow(/timed out after 500ms/);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15000);
});
