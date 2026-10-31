/** PR #6100: a synchronous native call must not defeat the worker timeout. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { runSweepWorker } from '../../pr-sweep-job.mjs';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';

export default {
  id: 'probe-worker-termination-blocks-timeout',
  title: 'a worker blocked in execFileSync cannot stall the sweep timeout',
  card: 'PR #6100',
  fixedBy: { sha: 'HEAD', where: 'lane/forge-fast-manifest', paths: ['scripts/conveyor/health-watch-job.mjs', 'scripts/conveyor/pr-sweep-job.mjs'] },
  fixPresent(root) {
    return ['health-watch-job.mjs', 'pr-sweep-job.mjs'].every((file) =>
      readFileSync(join(root, 'scripts/conveyor', file), 'utf8').includes('terminationGraceTimer'));
  },
  async run({ log } = {}) {
    const entered = new SharedArrayBuffer(4);
    const childScript = keepAliveScript({ maxLifetimeMs: 3000 });
    const url = new URL(`data:text/javascript,${encodeURIComponent(`
      import { workerData } from 'node:worker_threads';
      import { execFileSync } from 'node:child_process';
      Atomics.store(new Int32Array(workerData.input.entered), 0, 1);
      execFileSync(process.execPath, ['-e', ${JSON.stringify(childScript)}], { timeout: 5000 });
    `)}`);
    let worker, deadline;
    class BlockedWorker extends Worker {
      constructor(_url, options) { super(url, options); worker = this; }
    }
    try {
      const outcome = await Promise.race([
        runSweepWorker({ entered }, { timeoutMs: 500, WorkerClass: BlockedWorker }).catch((error) => error.message),
        new Promise((resolve) => { deadline = setTimeout(() => resolve('deadline missed'), 2500); }),
      ]);
      const violations = [];
      if (Atomics.load(new Int32Array(entered), 0) !== 1) violations.push('worker did not enter its synchronous call');
      if (outcome !== 'PR sweep worker timed out after 500ms') violations.push(`timeout failed to reject within its bounded grace: ${outcome}`);
      const report = { violations, outcome };
      log?.(JSON.stringify(report));
      return report;
    } finally {
      clearTimeout(deadline);
      await worker?.terminate();
    }
  },
  judge: (report) => report.violations,
};
