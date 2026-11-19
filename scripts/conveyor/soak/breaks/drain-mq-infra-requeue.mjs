/** PR #7103: a timed-out integration job and its derived test aggregate stranded a CLEAN head. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { infraFixture } from '../../../lib/__tests__/fixtures/drain-mq-infra.mjs';

const rootHere = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtureUrl = new URL('../../../lib/__tests__/fixtures/drain-mq-infra.mjs', import.meta.url).href;

export default {
  id: 'drain-mq-infra-requeue',
  title: 'PR #7103: a cancelled integration timeout plus derived test failure gets exactly one infrastructure requeue',
  card: 'PR #7103 merge-group run 44434828048',
  fixedBy: { sha: 'HEAD', where: 'lane/drain-mq-infra-requeue', paths: [
    'scripts/lib/drain-queue-safety.mjs', 'scripts/lib/drain-mq-infra-evidence.mjs',
  ] },
  fixPresent(root) {
    // The harness needs a synchronous answer. Exercise the target tree with injected IO;
    // file names, comments and diagnostic markers cannot claim that the fix is present.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { mqSameHeadGuard } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/drain-queue-safety.mjs')).href)};
      import { infraFixture } from ${JSON.stringify(fixtureUrl)};
      const f = infraFixture(mqSameHeadGuard);
      if (f.guard().hold) process.exit(1);
      f.secondFailure();
      if (!f.guard().hold) process.exit(1);
    `], { env: { ...process.env, WE_UNDER_TEST: '1' }, timeout: 10_000, maxBuffer: 64 * 1024,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return probe.status === 0;
  },
  async run({ sourceRoot = process.env.SOAK_TREE_ROOT || rootHere } = {}) {
    const { mqSameHeadGuard } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/drain-queue-safety.mjs')).href);
    const f = infraFixture(mqSameHeadGuard);
    const violations = [];
    const first = f.guard();
    if (first.hold || !first.line?.startsWith('mq-same-head-retry:')) violations.push('first pure infrastructure failure stayed held');
    f.secondFailure();
    if (!f.guard().hold) violations.push('second infrastructure failure got another requeue');
    if (!f.lines.some(line => line.startsWith('mq-infra-requeue-exhausted:'))) violations.push('retry exhaustion was silent');
    const unreadable = infraFixture(mqSameHeadGuard);
    delete unreadable.jobs[135261064381];
    if (!unreadable.guard().hold) violations.push('unreadable job evidence authorized requeue');
    const red = infraFixture(mqSameHeadGuard);
    red.mainRuns[0].conclusion = 'failure';
    if (!red.guard().hold || !red.lines.some(line => line.includes('main CI is failing')))
      violations.push('real failing main did not veto infrastructure retry with a main reason');
    red.mainRuns.unshift({ ...red.mainRuns[0], id: 10, conclusion: 'timed_out',
      created_at: '2026-11-18T01:40:00Z', updated_at: '2026-11-18T01:50:00Z' });
    if (!red.guard().hold) violations.push('newer timed-out main run concealed a real main failure');
    const cancelledMain = infraFixture(mqSameHeadGuard);
    cancelledMain.mainRuns[0].conclusion = 'cancelled';
    if (cancelledMain.guard().hold) violations.push('infra-only main cancellation blocked infrastructure retry');
    for (const [source, failure] of [['output', 'Runner lost connection tests: 1 failed'],
      ['annotations', '✗ integration suite: 1 failed'], ['logs', '× integration suite: 1 failed']]) {
      const mixed = infraFixture(mqSameHeadGuard);
      mixed.checks[0].conclusion = mixed.jobs[135261064381].conclusion = 'failure';
      mixed.jobs[135261064381].steps[1].conclusion = 'failure';
      mixed.checks[0].output.summary = 'Runner lost connection';
      mixed.logs[135261064381] = 'Execution interrupted.';
      if (source === 'output') mixed.checks[0].output.summary = failure;
      if (source === 'annotations') {
        mixed.checks[0].output.annotations_count = 1;
        mixed.annotations = [{ message: failure }];
      }
      if (source === 'logs') mixed.logs[135261064381] = failure;
      if (!mixed.guard().hold) violations.push(`test failure in ${source} authorized infrastructure retry`);
    }
    const duration = infraFixture(mqSameHeadGuard);
    duration.checks[0].conclusion = duration.jobs[135261064381].conclusion = 'failure';
    duration.jobs[135261064381].steps[1].conclusion = 'failure';
    duration.checks[0].output.annotations_count = 1;
    duration.annotations = [{ message: 'Error: invalid configuration' }];
    duration.logs[135261064381] = 'Error: invalid configuration';
    if (!duration.guard().hold) violations.push('duration alone authorized a failed job without timeout text');
    return { violations };
  },
  judge(report) { return report.violations; },
};
