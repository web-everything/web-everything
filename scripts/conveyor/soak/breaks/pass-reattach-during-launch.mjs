/** #5755 / PR #6020: an observer must not complete an unclaimed live launch. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPassAsTimedJob } from '../../../../skills-src/conveyor/pass-daemon.mjs';
import { createJobStore, stopHandle } from '../../../lib/daemon-jobs-runtime.mjs';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';

async function launchRace(expired) {
  const root = mkdtempSync(join(tmpdir(), 'pass-launch-race-'));
  const store = createJobStore(join(root, 'jobs'));
  const pass = { passName: 'launch-race', repo: 'fixture/repo', entry: { script: 'hung.mjs' } };
  let owner;
  let observer;
  let offset = 0;
  let watchdog;
  const signals = [];
  const probe = handle => !handle ? 'dead'
    : owner.exitCode === null && owner.signalCode === null ? 'alive' : 'dead';
  const ports = {
    root, store, codeSha: 'fixture', snapshot: { materialize() {} },
    now: () => Date.now() + offset,
    host: 'fixture-host', readStart: () => 'fixture-start', probe,
    reapGroup: handle => !!handle && probe(handle) === 'dead',
    spawnFn: (...args) => { owner = spawn(...args); return owner; },
    stop: (handle, options) => stopHandle(handle, {
      ...options, probe, termGraceMs: 20, killGraceMs: 1000, pollMs: 10,
      kill: (pid, signal) => { signals.push(signal); process.kill(pid, signal); },
    }),
    policyOptions: { platform: null, tool: { timeoutMs: 100 }, env: {}, log() {} },
    log() {}, alert() {},
  };
  try {
    writeFileSync(join(root, 'hung.mjs'), keepAliveScript({ anchorPid: process.pid, maxLifetimeMs: 5000 }));
    const launcher = runPassAsTimedJob(pass, {
      ...ports,
      readStart() {
        if (expired) offset = 200;
        // Re-entry before the first invocation populates activePasses models a
        // separate adapter reading the same durable record during readProcStart.
        observer = runPassAsTimedJob(pass, { ...ports, store: createJobStore(store.dir) });
        return 'fixture-start';
      },
    });
    const results = await Promise.race([
      Promise.all([launcher, observer]),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('deadline monitors did not settle')), 3000); }),
    ]);
    const [record] = store.list().records;
    const childAlive = probe(record.job.handle ?? 'finished') === 'alive';
    const violations = [];
    if (results[0].outcome !== 'timeout') violations.push('launcher abandoned its deadline');
    if (childAlive || !signals.length) violations.push('live child escaped deadline stop');
    if (record.job.handle || record.job.passResult?.outcome !== 'timeout') violations.push('timeout did not confirm death and release handle');
    return { expired, results, childAlive, signals, violations };
  } finally {
    clearTimeout(watchdog);
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      await new Promise(resolve => {
        owner.once('close', resolve);
        try { process.kill(-owner.pid, 'SIGKILL'); } catch { resolve(); }
      });
    }
    // Let monitors settle before removing their store, including on a failing tree.
    await observer?.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

export default {
  id: 'pass-reattach-during-launch',
  title: 'reattachment while a pass launches must preserve its live child deadline',
  card: '#5755 / PR #6020, red-team send-back x1b8hlo item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/5755-pass-timed-job', paths: ['skills-src/conveyor/pass-daemon.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'skills-src/conveyor/pass-daemon.mjs'), 'utf8')
      .includes('const awaitingClaim =');
  },
  async run({ log } = {}) {
    const cases = [];
    for (const expired of [false, true]) cases.push(await launchRace(expired));
    const report = { cases, violations: cases.flatMap(c => c.violations.map(v => `expired=${c.expired}: ${v}`)) };
    log?.(JSON.stringify(report));
    return report;
  },
  judge: report => report.violations,
};
