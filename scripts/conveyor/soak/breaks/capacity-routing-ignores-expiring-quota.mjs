/** Threshold routing can spend Claude while 73% of Codex's quota expires in two hours. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chooseBuilder } from '../../../lib/provider-capacity.mjs';

const now = Date.parse('2026-11-19T12:00:00Z');
export const scenario = { kind: 'fix', fallback: 'claude', settings: { now }, capacities:
  [['codex', 27, 2], ['claude', 10, 120]].map(([provider, usedPercent, hours]) => ({
    provider, known: true, held: false, health: 1, now,
    windows: [{ name: 'seven_day', usedPercent, resetsAt: now + hours * 3600000, lengthHours: 168, source: 'live' }],
  })) };
export default {
  id: 'capacity-routing-ignores-expiring-quota', title: 'Expiring Codex capacity takes precedence over distant Claude quota',
  card: 'capacity-based provider routing', fixedBy: { sha: 'capacity-routing', where: 'this change', paths: ['scripts/lib/provider-capacity.mjs'] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const m = await import(process.argv[1]); const s = JSON.parse(process.argv[2]); process.exit(m.chooseBuilder(s).provider === "codex" ? 0 : 1)',
      pathToFileURL(join(root, 'scripts/lib/provider-capacity.mjs')).href, JSON.stringify(scenario)],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    return probe.status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT;
    const chooser = root ? (await import(pathToFileURL(join(root, 'scripts/lib/provider-capacity.mjs')).href)).chooseBuilder : chooseBuilder;
    return { violations: chooser(scenario).provider === 'codex' ? [] : ['73% unused Codex quota expires in two hours while work goes elsewhere'] };
  },
  judge: report => report.violations,
};
