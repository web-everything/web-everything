/**
 * PR #7224 operator send-back (canonical audit, 02f9f70e): the red-main probe's run inventory filtered only by
 * branch NAME, so (a) a fork pull_request run on a branch named `main` and (b) a later hourly backstop success for
 * an OLDER main SHA both reached the chronological reducer and cleared a genuine failure on newer main. Health
 * watch then published no incident and the drain freeze lifted on a red main.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeMainCiRuns } from '../../main-ci-red-probe.mjs';
import { mainRedState } from '../../main-ci-red-core.mjs';
import { drainFreezeSignal } from '../../../lib/red-main-freeze-shared.mjs';

const SOURCE = 'scripts/conveyor/main-ci-red-probe.mjs';
const head = 'a'.repeat(40), old = 'b'.repeat(40), fork = 'c'.repeat(40);
const row = (id, sha, conclusion, event) => ({ databaseId: id, headSha: sha, event, status: 'completed', conclusion,
  attempt: 1, createdAt: `2026-11-21T1${id}:00:00Z`, updatedAt: `2026-11-21T1${id}:10:00Z` });

export default {
  id: 'stale-backstop-masks-red-main',
  title: 'a fork PR run or an old-SHA hourly backstop success cannot clear a red main',
  card: 'PR #7224',
  fixedBy: { sha: 'HEAD', where: 'lane/skip-main-retest', paths: [SOURCE, 'scripts/lib/main-ci-reuse-runs.mjs'] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('withoutStaleScheduledSuccesses(runs'); },
  async run() {
    const violations = [];
    const cases = {
      'fork pull_request success on a branch named main': [row(1, old, 'success', 'push'), row(2, head, 'failure', 'push'),
        row(3, fork, 'success', 'pull_request')],
      'old-SHA backstop success after a newer failure': [row(1, old, 'success', 'push'), row(2, head, 'failure', 'push'),
        row(3, old, 'success', 'schedule')],
    };
    for (const [name, rows] of Object.entries(cases)) {
      const probe = probeMainCiRuns({ repoSlug: 'fixture/repo', config: { mainCiRedFlakeRerun: false }, exec: (_, args) => {
        if (args[0] === 'run') return JSON.stringify(rows);
        if (args[1] === 'repos/fixture/repo/git/ref/heads/main') return JSON.stringify({ object: { sha: head } });
        throw Error('fixture: unavailable evidence');
      } });
      const state = mainRedState(probe.runs);
      if (state.status !== 'red' || state.latestRed?.runId !== 2) violations.push(`${name}: red main read as ${state.status}`);
      const now = Date.parse('2026-11-21T15:00:00Z');
      if (!drainFreezeSignal({ state: {}, mainRedState: { red: state.status === 'red', expiresAt: now + 60_000 }, now }).red)
        violations.push(`${name}: drain freeze lifted on a red main`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
