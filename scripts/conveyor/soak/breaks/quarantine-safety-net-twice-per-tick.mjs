/** PR #5283 review: two smells independently ran the quarantine writer during one health tick. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const MAIN = 'scripts/conveyor/health-smells/main-ci-red.mjs';
const CARDS = 'scripts/conveyor/health-smells/red-main-quarantined-test.mjs';

export default {
  id: 'quarantine-safety-net-twice-per-tick',
  title: 'Both quarantine smells share one safety-net result per health tick in either order',
  card: 'PR #5283 review — duplicate quarantine safety-net execution',
  fixedBy: { sha: 'HEAD', where: 'lane/quarantine-proven-flake', paths: [MAIN, CARDS] },
  fixPresent(root) { return readFileSync(join(root, MAIN), 'utf8').includes('quarantineSafetyNetForTick'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || ROOT;
    const load = (path) => import(pathToFileURL(join(root, path)).href);
    const { runHealthTick } = await load('scripts/conveyor/health-watch-core.mjs');
    const { runSafetyNet, SAFETY_NET_SHADOW_LOG } = await load('scripts/lib/red-main-quarantine-io.mjs');
    const { QUARANTINE_SAFETY_NET_DEFAULTS } = await load('scripts/lib/red-main-quarantine.mjs');
    const { default: main } = await load(MAIN);
    const { default: cards } = await load(CARDS);
    const fixture = JSON.parse(readFileSync(join(root, 'scripts/lib/__tests__/fixtures/red-main-quarantine-62da75ed3.json'), 'utf8'));
    // Exercise an eligible addition: the recorded episode had no re-run of the failing commit. Keep that
    // negative replay intact and supply, only here, an earlier run of the failing sha whose re-run passed.
    fixture.mainCiRuns.runs.push({ ...fixture.mainCiRuns.runs[0], databaseId: 7, createdAt: '2026-10-14T06:08:00Z', updatedAt: '2026-10-14T06:15:00Z', attempt: 2 });
    const rerunJobs = [{ name: 'integration', conclusion: 'failure', run_attempt: 1 }, { name: 'integration', conclusion: 'success', run_attempt: 2 }];
    const file = 'scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs';
    const now = Date.parse(fixture.now);
    const violations = [];
    for (const live of [false, true]) for (const reverse of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), 'soak-quarantine-tick-'));
      try {
        let calls = 0;
        let list = { version: 1, entries: [] };
        const safetyNet = (mainCiRuns, options) => {
          calls++;
          return runSafetyNet({ dir, now: options.now, mainCiRuns, live,
            mode: { value: live ? 'quarantine' : 'stop', source: 'test' },
            settings: { value: QUARANTINE_SAFETY_NET_DEFAULTS, sources: {} },
            readJobs: (id, opts) => (opts?.filter === 'all' ? { jobs: id === 7 ? rerunJobs : [] } : { failed: fixture.failedJobs }),
            readLog: () => ({ files: [file], tests: [], complete: true }),
            readList: () => ({ ok: true, list }),
            write: ({ change }) => { const result = change(list); if (!result.ok) throw new Error(result.error); list = result.list; return result; },
            log: () => {},
          });
        };
        const smells = (reverse ? [cards, main] : [main, cards]).map((smell) => ({ ...smell,
          evaluate(probes, ctx) { ctx.quarantineSafetyNet = safetyNet; return smell.evaluate(probes, ctx); },
        }));
        // Reuse the probe even at the same clock value: each runHealthTick must get a fresh result.
        const probes = { mainCiRuns: fixture.mainCiRuns };
        const first = runHealthTick(null, probes, smells, now);
        const label = `live=${live}, reverse=${reverse}`;
        if (calls !== 1) violations.push(`${label}: first tick called runSafetyNet ${calls} times`);
        const mainResult = first.evaluations.find((e) => e.smell.id === main.id)?.results?.[0];
        if (mainResult?.measure.quarantine?.action !== 'add') violations.push(`${label}: main smell lost the add decision`);
        const cardResults = first.evaluations.find((e) => e.smell.id === cards.id)?.results;
        if (cardResults?.length !== (live ? 1 : 0)) violations.push(`${label}: wrong repair-card results`);
        if (!live && readFileSync(join(dir, SAFETY_NET_SHADOW_LOG), 'utf8').trim().split('\n').length !== 1) violations.push(`${label}: duplicate shadow decision in add tick`);
        runHealthTick(first.state, probes, smells, now);
        if (calls !== 2) violations.push(`${label}: two ticks called runSafetyNet ${calls} times`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
