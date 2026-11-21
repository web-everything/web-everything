/** PR #7224: earlier reused pushes must not become red-main incidents after the tip moves. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeMainCiRuns } from '../../main-ci-red-probe.mjs';
import { mainRedState } from '../../main-ci-red-core.mjs';
import { runMainRedAlert } from '../../health-watch-main-red.mjs';
import { drainFreezeSignal } from '../../../lib/red-main-freeze-shared.mjs';

const SOURCE = 'scripts/conveyor/main-ci-red-probe.mjs';
export default {
  id: 'reused-main-push-history',
  title: 'consecutive reused main pushes do not publish false red incidents',
  card: 'PR #7224',
  fixedBy: { sha: 'HEAD', where: 'lane/skip-main-retest', paths: [SOURCE, 'scripts/conveyor/main-ci-red-core.mjs'] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('runs = withoutReusedMainPushes('); },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-reused-main-'));
    const violations = [];
    try {
      for (const realConclusion of ['success', 'failure']) {
        const rows = [1, 2, 3].map(id => ({ databaseId: id, headSha: String(id).repeat(40),
          status: 'completed', conclusion: id === 1 ? realConclusion : 'failure', event: 'push', attempt: 1,
          createdAt: `2026-11-20T1${id}:00:00Z`, updatedAt: `2026-11-20T1${id}:10:00Z` }));
        const probe = probeMainCiRuns({ repoSlug: 'fixture/repo', config: { mainCiRedFlakeRerun: false },
          exec: (_, args) => {
            if (args[0] === 'run') return JSON.stringify(rows);
            if (/\/runs\/[23]\/attempts\/1\/jobs\?per_page=100$/.test(args[1])) return JSON.stringify({ total_count: 2,
              jobs: [{ name: 'main-execution', status: 'completed', conclusion: 'failure', run_attempt: 1 },
                { name: 'test', status: 'completed', conclusion: 'success', run_attempt: 1 }] });
            throw Error('fixture: unavailable evidence');
          } });
        const state = mainRedState(probe.runs);
        const expected = realConclusion === 'success' ? 'green' : 'red';
        if (state.status !== expected || (expected === 'red' && state.latestRed?.runId !== 1)) {
          violations.push(`${realConclusion}: reused history changed the real execution verdict`);
        }
        const now = Date.parse('2026-11-20T15:00:00Z');
        const published = [];
        await runMainRedAlert({ dir: join(dir, realConclusion), probe, now,
          publish: item => published.push(item), readDetails: () => null });
        if (expected === 'green' && published.length) violations.push('healthy main published an incident for reuse');
        const freeze = drainFreezeSignal({ state: {}, mainRedState: { red: state.status === 'red', expiresAt: now + 60_000 }, now });
        if (freeze.red !== (expected === 'red')) violations.push(`${realConclusion}: wrong drain freeze`);
      }
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
