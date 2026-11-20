/** A serial forty-minute fix tick must not set ci-heal's admission cadence. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCadence, cadenceViolations } from '../ci-heal-cadence-probe.mjs';

export default {
  id: 'ci-heal-own-loop-cadence',
  title: 'ci-heal keeps its two-minute cadence during forty-minute main ticks',
  card: 'ci-heal-own-loop-cadence',
  fixedBy: { sha: 'ci-heal-own-loop', where: 'working tree', paths: ['skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'] },
  // The registry requires a synchronous presence probe. Run the same behavioral observation
  // in a bounded child, without interpreting source markers or executing live daemon IO.
  fixPresent(root) {
    try {
      const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { probeCadence } = await import(pathToFileURL(process.argv[1]).href);
        console.log(JSON.stringify(await probeCadence(process.argv[2])));
      `, join(root, 'scripts/conveyor/soak/ci-heal-cadence-probe.mjs'), root], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 65536, env: { ...process.env, VITEST: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      return cadenceViolations(report).length === 0;
    } catch { return false; }
  },
  async run() {
    return probeCadence(process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url)));
  },
  judge: cadenceViolations,
};
