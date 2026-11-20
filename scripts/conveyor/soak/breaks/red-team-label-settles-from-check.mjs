/** A pending red-team label must settle to clear when the head's own red-team check is proven clear. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/lib/red-team-status-labels.mjs';
const head = 'a'.repeat(40);

export default {
  id: 'red-team-label-settles-from-check',
  title: 'a clear red-team check on the head swaps red-team:pending to red-team:clear',
  card: 'red-team label stale pending after clear check',
  fixedBy: { sha: 'HEAD', where: SOURCE, paths: [SOURCE] },
  fixPresent(root) {
    const code = `
      try {
        const { planRedTeamStatusLabels } = await import(process.argv[1]);
        const plan = planRedTeamStatusLabels({ repo: 'o/n', pr: 42, head: '${head}', env: {}, labels: ['red-team:pending'],
          comments: [], evidence: {}, checkClear: true });
        process.stdout.write(plan.add === 'red-team:clear' ? 'settled' : 'stale');
      } catch { process.stdout.write('stale'); }
    `;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code, pathToFileURL(join(root, SOURCE)).href], {
      encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return !probe.error && probe.status === 0 && probe.stdout === 'settled';
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { syncRedTeamStatusLabels } = await import(pathToFileURL(join(sourceRoot, SOURCE)).href);
    const violations = [];
    const writes = [];
    const live = { headRefOid: head, labels: ['red-team:pending'] };
    const provider = { ensureLabel() {}, setLabels: (r, p, change) => writes.push(change), readPrState: () => live, readPrFiles: () => null };
    const sync = readCheckClear => syncRedTeamStatusLabels({ repo: 'o/n', pr: 42, head, env: {}, evidence: {}, live, comments: [],
      provider, standingRuling: null, readCheckClear });
    sync(() => true);
    log?.(`clear check writes: ${JSON.stringify(writes)}`);
    if (writes.length !== 1 || writes[0].add !== 'red-team:clear') violations.push('a clear head check left red-team:pending in place');
    writes.length = 0;
    sync(() => false);
    if (writes.some(change => change.add === 'red-team:clear')) violations.push('an unproven check produced red-team:clear');
    return { violations };
  },
  judge: report => report.violations,
};
