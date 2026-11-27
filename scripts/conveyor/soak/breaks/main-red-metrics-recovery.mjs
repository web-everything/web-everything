/** PR #7553: later main tips must not rewrite a recovered episode or freeze alert state. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMainRedAlert, readMainRedReport } from '../../health-watch-main-red.mjs';

const CORE = 'scripts/conveyor/main-ci-red-core.mjs';
const ALERT = 'scripts/conveyor/health-watch-main-red.mjs';
const MINUTE = 60_000;
const START = Date.parse('2026-11-26T00:00:00Z');
const red = { headSha: 'a'.repeat(40), databaseId: 1, status: 'completed', conclusion: 'failure',
  createdAt: new Date(START).toISOString() };
const green = { ...red, headSha: 'b'.repeat(40), databaseId: 2, conclusion: 'success',
  createdAt: new Date(START + 35 * MINUTE).toISOString() };
const tip = { sha: green.headSha, requiredChecks: ['test'], checksTotal: 1,
  checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }] };

export default {
  id: 'main-red-metrics-recovery',
  title: 'closed red minutes stay fixed across later main tips and metric refusal preserves alerts',
  card: 'PR #7553',
  fixedBy: { sha: 'HEAD', where: 'RED-METRICS replay and alert persistence', paths: [CORE, ALERT] },
  fixPresent(root) {
    return readFileSync(join(root, CORE), 'utf8').includes('open.end === null')
      && readFileSync(join(root, ALERT), 'utf8').includes('metricsIncomplete');
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-main-red-metrics-'));
    const violations = [];
    try {
      for (const shape of ['pending', 'failed-read']) {
        const stateDir = join(dir, shape);
        const base = { dir: stateDir, readDetails: () => null, publish: async () => {} };
        await runMainRedAlert({ ...base, probe: { runs: [red] }, now: START + 30 * MINUTE });
        await runMainRedAlert({ ...base, probe: { runs: [red, green], tip }, now: START + 40 * MINUTE });
        await runMainRedAlert({ ...base, probe: shape === 'pending'
          ? { runs: [red, green], tip: { ...tip, checksTotal: 0, checkRuns: [] } }
          : { error: 'probe unavailable' }, now: START + 60 * MINUTE });
        await runMainRedAlert({ ...base, probe: { runs: [red, green], tip }, now: START + 80 * MINUTE });
        const report = readMainRedReport(stateDir, { from: START, to: START + 90 * MINUTE, now: START + 90 * MINUTE });
        if (report.days['2026-11-26'] !== 40 || report.openEpisodes !== 0)
          violations.push(`${shape}: closed episode changed to ${report.days['2026-11-26']} red minutes`);
      }
      const stateDir = join(dir, 'backlog');
      const base = { dir: stateDir, readDetails: () => null, publish: async () => {},
        writeMetrics: async () => ({ warnings: ['journal full'] }) };
      const started = await runMainRedAlert({ ...base, probe: { runs: [red] }, now: START + 30 * MINUTE });
      const pendingMetrics = Array(10000).fill(started.metrics[0]);
      try {
        const cleared = await runMainRedAlert({ ...base, probe: { runs: [red, green], tip }, now: START + 40 * MINUTE,
          readState: () => ({ ...started.next, pendingMetrics }) });
        const saved = JSON.parse(readFileSync(join(stateDir, 'main-red-alert.json'), 'utf8'));
        if (saved.fingerprint !== null || saved.pendingMetrics?.length !== 10000 || !cleared.metricWarnings.length)
          violations.push('metric backlog did not preserve bounded pending evidence and persist the green clear');
      } catch (error) { violations.push(`metric backlog froze alert persistence: ${error.message}`); }
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
