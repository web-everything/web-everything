/** Critical or escalated repairs once forced a Claude session; they must run Codex directly, Claude only last. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const probeSource = `
const chainMod = await import(process.argv[1]);
const slot = await import(process.argv[2]);
const chain = chainMod.resolveFixExecutorChain({ env: {}, platform: {}, repo: {}, aiRouting: undefined, kind: 'fix', quota: () => null, record: () => {} });
const pick = (entry) => slot.chooseFixExecutor({ chain, launcherAvailable: () => true, ...entry });
const out = {
  critical: pick({ critical: true, strongerModel: true }),
  takeover: pick({ critical: true, takeover: true }),
  exhausted: pick({ critical: false, codexUnproductive: 9, launcherAvailable: (id) => id === 'codex' }),
  mode: chainMod.resolveFixExecutionMode({ env: {}, platform: {}, repo: {}, kind: 'fix' }).mode,
};
console.log(JSON.stringify(out));`;

function probe(root) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probeSource,
    pathToFileURL(join(root, 'scripts/lib/fix-executor-chain.mjs')).href,
    pathToFileURL(join(root, 'scripts/lib/fix-slot-borrow.mjs')).href],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, cwd: root });
  return run.status === 0 ? JSON.parse(run.stdout.trim().split('\n').at(-1)) : null;
}
const violations = (out) => {
  if (!out) return ['probe failed (fix presence is decided by behaviour)'];
  const found = [];
  if (out.critical.executor === 'claude') found.push('critical stronger-model repair launched Claude');
  if (out.takeover.executor === 'claude') found.push('critical takeover launched Claude');
  if (out.exhausted.executor !== 'claude') found.push(`exhausted chain did not reach Claude last: ${out.exhausted.executor}`);
  if (out.mode !== 'direct') found.push(`default invocation mode is ${out.mode}, expected direct`);
  return found;
};
export default {
  id: 'critical-fix-never-forces-claude', title: 'Critical and escalated repairs run Codex directly; Claude is only the last rung',
  card: 'direct executor plan', fixedBy: { sha: 'direct-exec-fix', where: 'this change', paths: ['scripts/lib/fix-executor-chain.mjs', 'scripts/lib/fix-slot-borrow.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) { return violations(probe(root)).length === 0; },
  async run() { return { violations: violations(probe(process.env.SOAK_TREE_ROOT || process.cwd())) }; },
  judge: report => report.violations,
};
