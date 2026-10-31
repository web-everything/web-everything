/** Real CLI break: 444 cleared items and a slow, rate-limited GitHub cannot occupy the tick. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export default {
  id: 'large-queue-slow-already-done',
  title: 'large queue and slow/rate-limited GitHub do not block the planner or multiply calls',
  card: 'we:backlog/4776-bound-builder-planning-and-preserve-child-errors.md',
  fixedBy: { sha: 'working-tree', where: 'lane-8', paths: ['scripts/readiness/already-done-refresh.mjs'] },
  fixPresent(root) { return existsSync(join(root, 'scripts/readiness/already-done-refresh.mjs')); },
  async run({ log, root = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-large-queue-'));
    const violations = [];
    let child;
    let pausedWorker;
    const isWorkerPid = pid => Number.isInteger(pid) && pid > 1 && pid !== child?.pid && pid !== process.pid;
    try {
      const backlog = join(dir, 'backlog'); const bin = join(dir, 'bin');
      mkdirSync(backlog); mkdirSync(bin);
      const queue = [];
      for (let i = 0; i < 444; i++) {
        const num = String(8000 + i);
        writeFileSync(join(backlog, `${num}-fixture.md`), `---\nbornAs: x${num}fix\nkind: story\nsize: 1\nstatus: open\nscope: ["we:scripts/fixture-${i}.mjs"]\ndateOpened: 2020-01-01\n---\n# Fixture ${num}\n`);
        queue.push({ num, addedAt: '2020-01-01T00:00:00Z' });
      }
      writeFileSync(join(dir, 'queue.json'), JSON.stringify(queue));
      // Release responses only after both ticks return. The test pauses the worker's group once a
      // request is in flight, keeping it alive across the two ticks instead of racing a 2.5s response.
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.SOAK_CALLS, JSON.stringify(process.argv.slice(2))+'\\n');
const timer = setInterval(()=>{
  if (!fs.existsSync(process.env.SOAK_RELEASE)) return;
  clearInterval(timer);
  process.stderr.write('API rate limit exceeded\\n');
  process.exitCode = 1;
}, 25);
`, { mode: 0o755 });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/soak/fixture.git'], { cwd: dir });
      const cache = join(dir, 'cache'); const callsPath = join(dir, 'calls'); const release = join(dir, 'release');
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONVEYOR_QUEUE_FILE: join(dir, 'queue.json'),
        WE_DISPATCH_PLAN_ALREADY_DONE_CACHE_FILE: cache, WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle'),
        WE_PR_SNAPSHOT_DIR: join(dir, 'snapshot'), SOAK_CALLS: callsPath, SOAK_RELEASE: release };
      const runPlanner = () => {
        const output = []; const maxBytes = 8 * 1024 * 1024;
        let outputBytes = 0; let overBudget = false; let stderr = '';
        const planner = child = spawn(process.execPath, [join(root, 'scripts/readiness/dispatch-plan.mjs'), '--json', `--backlog-dir=${backlog}`, '--free-lanes=1',
          '--no-drift-check', '--no-pause-check', '--no-pr-limit-check'], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        planner.stdout.on('data', d => {
          if (overBudget) return;
          outputBytes += d.length;
          if (outputBytes > maxBytes) {
            overBudget = true;
            try { process.kill(-planner.pid, 'SIGKILL'); } catch {}
            return;
          }
          output.push(d);
        });
        planner.stderr.on('data', d => { stderr += d; });
        return new Promise((resolve, reject) => {
          // The response barrier proves non-blocking behavior; the base 5s watchdog bounds a hung planner.
          const timer = setTimeout(() => { try { process.kill(-planner.pid, 'SIGKILL'); } catch {} reject(new Error(`planner blocked on slow GitHub: ${stderr}`)); }, 5000);
          planner.on('error', e => { clearTimeout(timer); reject(e); });
          planner.on('close', code => {
            clearTimeout(timer);
            if (overBudget) reject(new Error(`planner stdout exceeded ${maxBytes} bytes; inspect planner output manually`));
            else if (code !== 0) reject(new Error(`planner exit ${code}: ${stderr}`));
            else { try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); } catch (e) { reject(e); } }
          });
        });
      };
      const started = Date.now();
      const first = runPlanner();
      // Observe errors immediately, including while waiting for the worker to reach the fake host.
      let plannerError;
      first.catch(e => { plannerError = e; });
      const requestDeadline = Date.now() + 10000;
      while (!existsSync(callsPath)) {
        if (plannerError) throw plannerError;
        if (Date.now() >= requestDeadline) throw new Error('refresh did not reach fake GitHub');
        await delay(25);
      }
      let worker;
      try { worker = JSON.parse(readFileSync(`${cache}.refresh-lock`, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (worker === undefined) {
        // A synchronous planner has no detached-worker lock. Release its request so it can return
        // within the runaway ceiling, then report the missing worker through not-awaited below.
        writeFileSync(release, '');
      } else {
        // A real request proves the reservation has been handed from planner to detached worker.
        const { pid } = worker;
        if (!isWorkerPid(pid)) throw new Error('invalid refresh worker pid');
        pausedWorker = pid;
        process.kill(-pausedWorker, 'SIGSTOP');
      }
      const plan = await first;
      const elapsedMs = Date.now() - started;
      if (plan.groundTruth.pending !== 444) violations.push({ invariant: 'queue-exercised', detail: JSON.stringify(plan.groundTruth) });
      if (plan.groundTruth.refresh.ids.length !== 2) violations.push({ invariant: 'bounded-selection', detail: JSON.stringify(plan.groundTruth) });
      if (worker === undefined || !existsSync(`${cache}.refresh-lock`)) violations.push({ invariant: 'not-awaited', detail: 'slow worker did not outlive planner' });
      // A second tick WHILE the first worker is alive must not add any requests.
      const second = await runPlanner();
      if (second.groundTruth.refresh.started) violations.push({ invariant: 'single-flight', detail: 'overlapping tick started another worker' });
      writeFileSync(release, '');
      if (pausedWorker) process.kill(-pausedWorker, 'SIGCONT');
      pausedWorker = null;
      const deadline = Date.now() + 18000;
      while (existsSync(`${cache}.refresh-lock`) && Date.now() < deadline) await delay(50);
      if (existsSync(`${cache}.refresh-lock`)) throw new Error('worker did not finish');
      const calls = existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      if (calls.length < 1 || calls.length > 2) violations.push({ invariant: 'network-budget', detail: `${calls.length} calls` });
      if (new Set(calls.map(args => args.find(arg => arg.startsWith('search=')))).size !== calls.length) violations.push({ invariant: 'no-retry', detail: 'repeated request' });
      if (existsSync(cache)) violations.push({ invariant: 'failed-is-unknown', detail: 'failed checks cached as verdicts' });
      log?.(JSON.stringify({ elapsedMs, calls: calls.length }));
      return { violations, elapsedMs, calls: calls.length };
    } catch (e) { violations.push({ invariant: 'crash', detail: String(e.stack || e) }); return { violations }; }
    finally {
      // Reap any background enrichment before deleting its inputs, including on the pre-fix RED path.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { if (pausedWorker) process.kill(-pausedWorker, 'SIGKILL'); } catch {}
      try { const { pid } = JSON.parse(readFileSync(join(dir, 'cache.refresh-lock'), 'utf8')); if (isWorkerPid(pid)) process.kill(-pid, 'SIGKILL'); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};
