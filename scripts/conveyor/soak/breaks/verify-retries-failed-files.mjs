/** A load-flaky edited test must not force the entire verify gate to run again. */
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const sample = {
  stdout: ' Test Files  1 failed\n Tests  1 failed\n Duration  1s\n',
  stderr: ' FAIL  edited.test.mjs > works under load\nAssertionError: load spike\n',
  failureDetails: { tests: [{ file: 'edited.test.mjs', name: 'works under load' }], summary: 'load spike', truncated: false },
  changedFiles: ['edited.test.mjs'], cwd: '/repo', mode: 'all',
};
export default {
  id: 'verify-retries-failed-files',
  title: 'verify retries only failed edited files and refuses skipped or repeat-red assertions',
  card: 'verify failed-file retry',
  fixedBy: { sha: 'working-tree', where: 'working-tree', paths: ['scripts/lib/gate-timeout-retry.mjs', 'scripts/verify-lane.mjs'] },
  fixPresent(root) {
    // Probe the target tree's behavior; comments/marker strings never establish fix presence.
    const module = pathToFileURL(join(root, 'scripts/lib/gate-timeout-retry.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(module)}); process.exit(m.isolatedRetryFailures(${JSON.stringify(sample)}).length === 1 ? 0 : 1);`],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    return r.status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || ROOT;
    const m = await import(pathToFileURL(join(root, 'scripts/lib/gate-timeout-retry.mjs')).href);
    const violations = [];
    if (typeof m.retryFailedPhase !== 'function') return { violations: ['failed-file retry is unavailable'] };
    for (const status of ['passed', 'pending', 'failed']) {
      const calls = [], logs = [];
      const red = { exitCode: 1, output: sample, failureDetails: sample.failureDetails };
      const r = await m.retryFailedPhase({ result: red, attempts: 1, cwd: '/repo', infrastructureFailure: () => false,
        onFlake: row => logs.push(row), run: async files => {
          calls.push(files);
          return status === 'failed' ? red : { exitCode: 0, retryReportText: JSON.stringify({ testResults: [{
            name: '/repo/edited.test.mjs', status: 'passed', assertionResults: [{ fullName: 'works under load', status }],
          }] }) };
        } });
      if (JSON.stringify(calls) !== JSON.stringify([['edited.test.mjs']])) violations.push(`${status}: retried scope changed`);
      if ((r.result.exitCode === 0) !== (status === 'passed')) violations.push(`${status}: unsafe verdict`);
      if (logs.length !== (status === 'passed' ? 1 : 0)) violations.push(`${status}: wrong flake audit`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
