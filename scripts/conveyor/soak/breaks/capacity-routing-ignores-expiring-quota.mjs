/** Threshold routing can spend Claude while 73% of Codex's quota expires in two hours. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chooseBuilder, PROVIDER_DEFAULTS } from '../../../lib/provider-capacity.mjs';
import { resolveFixExecutorChain } from '../../../lib/fix-executor-chain.mjs';

const now = Date.parse('2026-11-19T12:00:00Z');
export const scenario = { kind: 'fix', fallback: 'claude', settings: { now }, capacities:
  [['codex', 27, 2], ['claude', 10, 120]].map(([provider, usedPercent, hours]) => ({
    provider, known: true, held: false, health: 1, now,
    windows: [{ name: 'seven_day', usedPercent, resetsAt: now + hours * 3600000, lengthHours: 168, source: 'live' }],
  })) };
export const scenarios = [
  { input: scenario, expected: 'codex' },
  ...[95, 99].map(usedPercent => ({ expected: 'claude', input: { ...scenario, capacities: [
    { ...scenario.capacities[0], windows: [{ usedPercent, resetsAt: now + 120 * 3600000 }] },
    { ...scenario.capacities[1], windows: [], known: false },
  ] } })),
  { expected: 'claude', input: { ...scenario, capacities: [
    { ...scenario.capacities[0], held: true }, { ...scenario.capacities[1], windows: [], known: false },
  ] } },
];
// PR #7169: plenty of expiring fix capacity does not authorize CI-heal work.
export const repairScenario = {
  kind: 'ci-heal', env: {}, platform: {}, now,
  repo: { routing: { builder: 'auto' }, providerCapacity: { minimumTiers: { fix: 1, 'ci-heal': 3 },
    providers: PROVIDER_DEFAULTS.providers.map(p => ['codex', 'codex-alt'].includes(p.id)
      ? { ...p, tier: 1, allowedKinds: ['fix'] }
      : p.id === 'claude' ? { ...p, tier: 3, allowedKinds: ['fix', 'ci-heal'] } : p) } },
  capacity: [['codex', 1, 1], ['claude', 80, 120]].map(([provider, usedPercent, hours]) => ({
    provider, known: true, health: 1,
    windows: [{ usedPercent, resetsAt: now + hours * 3600000, lengthHours: 168 }],
  })),
};
export default {
  id: 'capacity-routing-ignores-expiring-quota', title: 'Expiring Codex capacity takes precedence over distant Claude quota',
  card: 'capacity-based provider routing', fixedBy: { sha: 'capacity-routing', where: 'this change', paths: ['scripts/lib/provider-capacity.mjs', 'scripts/lib/fix-executor-chain.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const m = await import(process.argv[1]); const cases = JSON.parse(process.argv[2]); const c = await import(process.argv[3]); const repair = c.resolveFixExecutorChain({ ...JSON.parse(process.argv[4]), quota: () => null, record: () => {} }); process.exit(cases.every(c => m.chooseBuilder(c.input).provider === c.expected) && JSON.stringify(repair.value) === JSON.stringify(["claude"]) ? 0 : 1)',
      pathToFileURL(join(root, 'scripts/lib/provider-capacity.mjs')).href, JSON.stringify(scenarios),
      pathToFileURL(join(root, 'scripts/lib/fix-executor-chain.mjs')).href, JSON.stringify(repairScenario)],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    return probe.status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT;
    const chooser = root ? (await import(pathToFileURL(join(root, 'scripts/lib/provider-capacity.mjs')).href)).chooseBuilder : chooseBuilder;
    const resolveChain = root ? (await import(pathToFileURL(join(root, 'scripts/lib/fix-executor-chain.mjs')).href)).resolveFixExecutorChain : resolveFixExecutorChain;
    const repair = resolveChain({ ...repairScenario, quota: () => null, record: () => {} });
    const violations = scenarios.flatMap(({ input, expected }, index) => chooser(input).provider === expected ? []
      : [`capacity scenario ${index}: expected ${expected}, received ${chooser(input).provider}`]);
    if (JSON.stringify(repair.value) !== JSON.stringify(['claude'])) violations.push(`CI-heal kind/tier restrictions bypassed: ${repair.value}`);
    return { violations };
  },
  judge: report => report.violations,
};
