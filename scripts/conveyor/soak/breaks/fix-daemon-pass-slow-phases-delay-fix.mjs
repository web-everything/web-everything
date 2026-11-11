/** LIVE 2026-10-09: an untimed 15.7-minute fix-daemon pass delayed PR #4624's fix, because the slow phases
 *  (stuck-fixers reclaim, ci-heal, promote-draft) ran BEFORE or without bound ahead of the fix dispatch. The fix runs
 *  first in each pass, and ci-heal / promote-draft are time-budgeted: they yield between repos (never mid-repo) and
 *  resume at the first skipped repo on the next pass. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'fix-daemon-pass-slow-phases-delay-fix',
  title: 'A slow stuck-fixers / ci-heal / promote-draft phase delays the fix dispatch of the same fix-daemon pass, with no time budget',
  card: 'fix-daemon pass split: fix first, slow phases time-budgeted (PR #4624 delayed 15.7 min)',
  fixedBy: { sha: 'a109b4e5ed', where: 'lane/fix-daemon-pass-split', paths: ['skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'), 'utf8').includes('resolveFixPassBudgets'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const mod = await import(pathToFileURL(join(root, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs')).href);
    const violations = [];
    const empty = () => ({ dispatched: [], refusals: [] });
    const noop = () => ({ dispatch: [], refusals: [], applied: [] });
    const run = async (extra) => {
      const order = [];
      let time = 0;
      const opts = { repos: ['a', 'b', 'c'], now: () => time,
        fixTick: ({ repo } = {}) => { order.push(`fix:${repo}`); return empty(); },
        ciHealTick: async ({ repo } = {}) => { order.push(`heal:${repo}`); time += 1001; return empty(); },
        promoteDraftTick: () => empty(), hungCiTick: noop, mainRedRebaseTick: noop, missingRunTick: noop,
        notesTick: () => ({ notes: [], prsByNumber: new Map() }), awaitVerifyTick: async () => ({ rows: [] }),
        stuckFixerTick: async () => { order.push('stuck'); return { rows: [] }; },
        budgetRotation: {}, ...extra };
      if (mod.resolveFixPassBudgets) {
        opts.passBudgets = mod.resolveFixPassBudgets({ env: {}, file: { fixPassBudget: { stuckFixersMs: 1000, ciHealMs: 1000, promoteDraftMs: 1000 } } });
      }
      const result = await mod.runTickAllRepos(opts);
      return { order, result };
    };
    const { order, result } = await run({});
    const lastFix = order.map((o, i) => (o.startsWith('fix:') ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
    const firstSlow = order.findIndex((o) => o === 'stuck' || o.startsWith('heal:'));
    if (firstSlow !== -1 && firstSlow < lastFix) violations.push(`a slow phase ran before the fix dispatch finished: ${order.join(' ')}`);
    const healRepos = order.filter((o) => o.startsWith('heal:'));
    if (healRepos.length !== 1) violations.push(`ci-heal ignored its time budget (each repo burns 1001ms of a 1000ms budget; want 1 repo then yield): ${healRepos.join(' ')}`);
    if (JSON.stringify(result.budgets?.['ci-heal']?.skipped) !== JSON.stringify(['b', 'c'])) {
      violations.push(`ci-heal skipped repos not reported: ${JSON.stringify(result.budgets?.['ci-heal'])}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
