/** The shipped producer and parser must carry disk/prune evidence into an actual health tick. */
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'forge-disk-prune-telemetry-pipeline',
  title: 'Forge telemetry producer and receiving parser deliver disk/prune needs-you notifications',
  card: 'PR #6913',
  fixedBy: {sha: 'pending', where: 'lane/forge-disk-prune-smell-r2', paths: [
    'scripts/readiness/forge-exec-run.mjs', 'scripts/readiness/forge-cache-prune.mjs',
  ]},
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/readiness/forge-exec-run.mjs'), 'utf8').includes('value.diskUsedPct =');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || ROOT;
    const load = path => import(pathToFileURL(join(root, path)).href);
    const {createRunner} = await load('scripts/readiness/forge-exec-run.mjs');
    const prune = await load('scripts/readiness/forge-cache-prune.mjs');
    const {readForgeTelemetry} = await load('scripts/readiness/forge-telemetry.mjs');
    const {checkRemoteHealth, remoteHealthFile} = await load('scripts/readiness/forge-remote-health.mjs');
    const {default: smell} = await load('scripts/conveyor/health-smells/forge-disk-prune.mjs');
    const {emptyHealthState, runHealthTick} = await load('scripts/conveyor/health-watch-core.mjs');
    const tmp = await mkdtemp(join(tmpdir(), 'forge-pipeline-soak-'));
    const violations = [], now = Date.parse('2026-11-16T05:00:00Z');
    try {
      for (const kind of ['disk', 'prune', 'disk-cache-full']) {
        const testRoot = join(tmp, kind), receipts = join(testRoot, 'receipts'), remote = join(testRoot, 'remote');
        await mkdir(receipts, {recursive: true, mode: 0o700});
        await mkdir(remote);
        if (kind === 'disk-cache-full') await mkdir(join(receipts, 'telemetry.json'));
        // When replayed on the broken tree there is no result writer: the real
        // producer still runs and must demonstrate the missing-notification break.
        if (kind === 'prune' && prune.recordPruneResult) {
          for (let i = 0; i < 3; i++) await prune.recordPruneResult(receipts, 'Invalid reserved lock evidence');
        }
        const runner = createRunner({testRoot, testPath: '/usr/bin:/bin', clock: () => now,
          testDiskStat: async () => ({blocks: 100, bfree: kind.startsWith('disk') ? 0 : 65, bavail: kind.startsWith('disk') ? 0 : 65})});
        const readTelemetry = () => readForgeTelemetry({exec: (_command, _argv, _options, callback) => {
          runner.telemetry().then(value => callback(null, JSON.stringify(value)), callback);
          return {};
        }});
        const health = await checkRemoteHealth({root: remote, clock: () => now, readTelemetry,
          settings: {maxLoadPerCore: 1e6, minFreeRamPct: 0, backoffMs: 1}});
        if (!health.ok) { violations.push(`${kind}: receiving parser rejected producer telemetry (${health.reason})`); continue; }
        const cached = JSON.parse(await readFile(remoteHealthFile(remote), 'utf8'));
        const wired = {...smell, evaluate: (probes, ctx) => smell.evaluate(probes, {...ctx, readForgeHealth: () => cached})};
        const tick = runHealthTick(emptyHealthState(), {}, [wired], now);
        if (tick.state.episodes['forge-disk-prune::forge-disk-prune']?.escalation?.status !== 'needs-you'
          || tick.plan.filter(p => p.kind === 'notify' && !p.suppressed).length !== 1) {
          violations.push(`${kind}: shipped telemetry pipeline produced no needs-you notification`);
        }
      }
    } finally { await rm(tmp, {recursive: true, force: true}); }
    return {violations};
  },
  judge(report) {return report.violations;},
};
