/** Real CLI break: 444 cleared items and a slow, rate-limited GitHub cannot occupy the tick. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBounded } from '../../../lib/bounded-child.mjs';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Startup and parsing the large backlog share CI CPUs with the other soak worlds. This is a runaway
// ceiling, not the async proof: the live refresh lock and overlapping tick below prove GitHub was not awaited.
const PLANNER_TIMEOUT_MS = 10000;

export default {
  id: 'large-queue-slow-already-done',
  title: 'large queue and slow/rate-limited GitHub do not block the planner or multiply calls',
  card: 'we:backlog/4776-bound-builder-planning-and-preserve-child-errors.md',
  fixedBy: { sha: 'working-tree', where: 'lane-8', paths: ['scripts/readiness/already-done-refresh.mjs'] },
  fixPresent(root) { return existsSync(join(root, 'scripts/readiness/already-done-refresh.mjs')); },
  async run({ log, root = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-large-queue-'));
    const violations = [];
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
      // Slow requests return a rate limit. The live-worker assertion below establishes ordering independently
      // of how long the planner took to start; its runaway ceiling need not be shorter than this delay.
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.SOAK_CALLS, JSON.stringify(process.argv.slice(2))+'\\n');
setTimeout(()=>{process.stderr.write('API rate limit exceeded\\n');process.exit(1)}, 2500);
`, { mode: 0o755 });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/soak/fixture.git'], { cwd: dir });
      const cache = join(dir, 'cache'); const callsPath = join(dir, 'calls');
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONVEYOR_QUEUE_FILE: join(dir, 'queue.json'),
        WE_DISPATCH_PLAN_ALREADY_DONE_CACHE_FILE: cache, WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle'),
        WE_PR_SNAPSHOT_DIR: join(dir, 'snapshot'), SOAK_CALLS: callsPath };
      const planTick = async () => JSON.parse(await runBounded(process.execPath,
        [join(root, 'scripts/readiness/dispatch-plan.mjs'), '--json', `--backlog-dir=${backlog}`, '--free-lanes=1',
          '--no-drift-check', '--no-pause-check', '--no-pr-limit-check'],
        { cwd: dir, env, timeoutMs: PLANNER_TIMEOUT_MS, maxBytes: 8 * 1024 * 1024 }));
      const started = Date.now();
      const plan = await planTick();
      const elapsedMs = Date.now() - started;
      if (plan.groundTruth.pending !== 444) violations.push({ invariant: 'queue-exercised', detail: JSON.stringify(plan.groundTruth) });
      if (plan.groundTruth.refresh.ids.length !== 2) violations.push({ invariant: 'bounded-selection', detail: JSON.stringify(plan.groundTruth) });
      if (!existsSync(`${cache}.refresh-lock`)) violations.push({ invariant: 'not-awaited', detail: 'slow worker did not outlive planner' });
      // A second tick WHILE the first worker is alive must not add any requests.
      const second = await planTick();
      if (second.groundTruth.refresh.started) violations.push({ invariant: 'single-flight', detail: 'overlapping tick started another worker' });
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
      try { const { pid } = JSON.parse(readFileSync(join(dir, 'cache.refresh-lock'), 'utf8')); process.kill(-pid, 'SIGKILL'); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};
