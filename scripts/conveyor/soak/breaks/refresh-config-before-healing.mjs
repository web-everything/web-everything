/** PR #5624: an unusable first lane must reach recovery and leave later lanes refreshable.
 * Execute the actual refresh and healing orchestration with Git isolated at its I/O boundary.
 * This scenario needs neither network access nor writes to Git metadata.
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'refresh-config-before-healing',
  title: 'refresh config failure cannot bypass corrupt-lane recovery or starve later lanes',
  card: 'we:PR#5624',
  // The launcher creates the repair commit. After later commits, replay with --revert=<repair-sha>.
  fixedBy: { sha: 'HEAD', where: 'lane/overload-guard', paths: ['scripts/lane-pool.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8');
    const refresh = source.match(/function refreshLane\([^]*?\n\}/)?.[0] || '';
    return refresh.indexOf('fetchOriginHealing(') >= 0
      && refresh.indexOf('fetchOriginHealing(') < refresh.indexOf("gitQuiet(['config'");
  },
  async run({ root = REPO_ROOT } = {}) {
    const source = readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8');
    const fn = (name, seams) => {
      const body = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
      if (!body) throw Error(`missing function ${name}`);
      return runInNewContext(`(${body})`, seams);
    };
    const violations = [];
    for (const damage of ['absent .git', 'missing HEAD']) {
      let broken = true; const configured = [];
      const laneDir = (_repo, n) => `/fixture/lane-${n}`;
      const fetchOriginHealing = fn('fetchOriginHealing', {
        laneDir, fetchOriginPruneWithRetry: (dir) => { if (broken && dir.endsWith('lane-1')) throw Error(damage); },
        healSharedStoreFor: () => false, diagnoseLane: () => ({ ok: !broken, problems: [damage] }),
        looksLikeCorruption: () => false, msgOf: (e) => e.message, log: () => {}, healLaneRefs: () => {},
        recloneLane: () => { broken = false; },
      });
      const refresh = fn('refreshLane', {
        laneDir, fetchOriginHealing, gitQuiet: (_args, dir) => {
          if (broken && dir.endsWith('lane-1')) throw Error(damage);
          configured.push(dir);
        },
        liveLease: () => null, ttlMsFromFlags: () => 0, laneHoldRefuses: () => true,
      });
      try { for (const n of [1, 2]) refresh({}, n); }
      catch (e) { violations.push({ invariant: 'recovery-reachable', detail: `${damage}: ${e.message}` }); }
      if (broken || configured.length !== 2) violations.push({ invariant: 'pool-progress', detail: damage });
    }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
