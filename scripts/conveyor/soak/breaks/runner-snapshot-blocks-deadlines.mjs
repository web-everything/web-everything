/** #5755 / PR #6020: synchronous discovery must not hold the runner's deadline loop. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCliMechanicalPasses, MECHANICAL_PASS_NAMES } from '../../../../skills-src/conveyor/runner.mjs';
import { runPassAsTimedJob } from '../../../../skills-src/conveyor/pass-daemon.mjs';
import { createJobStore } from '../../../lib/daemon-jobs-runtime.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';

export default {
  id: 'runner-snapshot-blocks-deadlines',
  title: 'blocking PR discovery delays unrelated launches and existing timed-pass deadlines',
  card: '#5755 / PR #6020, send-back 5726 item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/5755-pass-timed-job', paths: ['skills-src/conveyor/runner.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'skills-src/conveyor/runner.mjs'), 'utf8')
      .includes("owned.ready = runRepo('conveyor/open-pr-snapshot.mjs'");
  },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'runner-snapshot-deadline-'));
    const store = createJobStore(join(root, 'jobs'));
    const children = new Map();
    const started = Date.now();
    let stopAt;
    let launchAt;
    let snapshotJobs = 0;
    let snapshotOutcome;
    let fallbacks = 0;
    const ports = {
      root, store, codeSha: 'fixture', snapshot: { materialize() {} },
      host: 'fixture-host', readStart: () => 'fixture-start',
      spawnFn: (...args) => {
        const child = spawn(...args);
        children.set(child.pid, child);
        return child;
      },
      probe: handle => {
        const child = children.get(Number(handle.split(':')[1]));
        return child && child.exitCode === null && child.signalCode === null ? 'alive' : 'dead';
      },
      // Fixture-owned children: stop() SIGKILLs and awaits close, so a dead owner means no group survives.
      reapGroup: handle => {
        const child = children.get(Number(handle.split(':')[1]));
        return !child || (child.exitCode !== null || child.signalCode !== null);
      },
      stop: async handle => {
        stopAt ??= Date.now() - started;
        const child = children.get(Number(handle.split(':')[1]));
        await new Promise(resolve => { child.once('close', resolve); child.kill('SIGKILL'); });
        return { gone: true, signal: 'SIGKILL' };
      },
      policyOptions: { platform: null, tool: { timeoutMs: 30 }, env: {}, log() {} },
      log() {}, alert() {},
    };
    writeFileSync(join(root, 'hung.mjs'), keepAliveScript({ anchorPid: process.pid, maxLifetimeMs: 5000 }));
    writeFileSync(join(root, 'blocked-fetch.mjs'), `
      const until = Date.now() + 400;
      while (Date.now() < until) {}
      throw new Error('shared discovery failed');
    `);
    const existing = runPassAsTimedJob({ passName: 'existing', repo: 'fixture/repo', entry: { script: 'hung.mjs', quiet: true } }, ports);
    try {
      const passes = makeCliMechanicalPasses({
        scriptsDir: join(root, 'scripts'), repo: CONSTELLATION_REPOS.we.slug,
        skipPasses: new Set(MECHANICAL_PASS_NAMES.filter(name => !['infra-blocked', 'parked-pr-progress-watch'].includes(name))),
        // This is the old discovery port: the pre-fix runner executes it inline.
        // The repaired runner instead dispatches discovery through runPass below.
        fetchOpenPrs() {
          const until = Date.now() + 400;
          while (Date.now() < until) {}
          throw new Error('shared discovery failed');
        },
        runPass: pass => {
          if (pass.passName === 'open-pr-snapshot') {
            snapshotJobs++;
            return runPassAsTimedJob({ ...pass, entry: { script: 'blocked-fetch.mjs', quiet: true } }, {
              ...ports, policyOptions: { ...ports.policyOptions, tool: { timeoutMs: 200 } },
            }).then(result => { snapshotOutcome = result.outcome; return result; });
          }
          if (pass.passName === 'parked-pr-progress-watch'
            && !pass.entry.args.some(arg => arg.startsWith('--prs-file='))) fallbacks++;
          launchAt ??= Date.now() - started;
          return { code: 0, signal: null };
        },
      });
      const pending = passes();
      const returnedAt = Date.now() - started;
      const [existingResult] = await Promise.all([existing, pending]);
      const violations = [];
      if (returnedAt >= 200) violations.push('mechanical invocation blocked the event loop');
      if (stopAt === undefined || stopAt >= 200) violations.push('existing pass deadline was delayed by discovery');
      if (launchAt === undefined || launchAt >= 200) violations.push('unrelated pass launch was delayed by discovery');
      if (snapshotJobs !== 1) violations.push('snapshot did not run as exactly one timed child job');
      if (existingResult.outcome !== 'timeout') violations.push('existing pass was not confirmed stopped at timeout');
      if (snapshotOutcome !== 'timeout' || fallbacks !== 1) violations.push('snapshot timeout did not lead to standalone discovery');
      const report = { violations, returnedAt, stopAt, launchAt, snapshotJobs, snapshotOutcome, fallbacks };
      log?.(JSON.stringify(report));
      return report;
    } finally {
      for (const child of children.values()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await existing;
      rmSync(root, { recursive: true, force: true });
    }
  },
  judge: report => report.violations,
};
