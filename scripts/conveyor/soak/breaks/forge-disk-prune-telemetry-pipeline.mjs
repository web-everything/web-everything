/** The real Forge response must survive the client and health cache before a disk/prune alarm can notify. */
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'forge-disk-prune-telemetry-pipeline',
  title: 'Forge disk/prune readings reach a needs-you notification through the shipped telemetry pipeline',
  card: 'PR #6913',
  fixedBy: {sha: 'pending', where: 'lane/forge-disk-prune-smell-r2', paths: [
    'scripts/readiness/forge-exec-run.mjs', 'scripts/readiness/forge-telemetry.mjs', 'scripts/readiness/forge-cache-prune.mjs',
  ]},
  fixPresent(root) {
    try { return readFileSync(join(root, 'scripts/readiness/forge-telemetry.mjs'), 'utf8').includes('diskPrune:1'); }
    catch { return false; }
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || ROOT;
    const load = path => import(pathToFileURL(join(root, path)).href);
    const {createRunner, parseTelemetry, easternTimestamp} = await load('scripts/readiness/forge-exec-run.mjs');
    const {readForgeTelemetry} = await load('scripts/readiness/forge-telemetry.mjs');
    const {checkRemoteHealth} = await load('scripts/readiness/forge-remote-health.mjs');
    const {default: smell} = await load('scripts/conveyor/health-smells/forge-disk-prune.mjs');
    const {emptyHealthState, runHealthTick} = await load('scripts/conveyor/health-watch-core.mjs');
    const now = Date.parse('2026-11-16T06:00:00Z'), violations = [];
    const scratch = await mkdtemp(join(tmpdir(), 'forge-telemetry-soak-'));
    try {
      const prune = {consecutiveRefused: 469, lastRefusal: 'Invalid reserved lock evidence'};
      try { parseTelemetry(JSON.stringify({sampledAtET: easternTimestamp(now), cores: 4, loadPerCore: 0,
        memFreePct: 50, activeRuns: 0, recent: [], diskUsedPct: 100, prune})); }
      catch { return {violations: ['receiving parser rejects the live disk/prune breach sample']}; }
      for (const disk of [35, 100]) {
        const host = join(scratch, String(disk)), receipts = join(host, 'receipts');
        await mkdir(receipts, {recursive: true, mode: 0o700});
        await writeFile(join(receipts, 'forge-cache-prune.json'), JSON.stringify(prune));
        const server = createRunner({testRoot: host, clock: () => now,
          testStatfs: async () => ({blocks: 100, bfree: 100 - disk, bavail: 100 - disk})});
        const exec = (_file, _args, _options, done) => ({stdin: {on() {}, end(input) {
          server.telemetry(JSON.parse(input)).then(value => done(null, JSON.stringify(value)), done);
        }}});
        const healthRoot = join(host, 'remote');
        const checked = await checkRemoteHealth({root: healthRoot, clock: () => now,
          settings: {maxLoadPerCore: 1e9, minFreeRamPct: 0, backoffMs: 1000},
          readTelemetry: options => readForgeTelemetry({...options, exec})});
        if (!checked.ok) { violations.push(`disk ${disk}: health cache rejects the producer response`); continue; }
        const health = JSON.parse(await readFile(join(healthRoot, 'health.json'), 'utf8'));
        const wired = {...smell, evaluate(p, ctx) { return smell.evaluate(p, {...ctx, readForgeHealth: () => health}); }};
        const tick = runHealthTick(emptyHealthState(), {}, [wired], now);
        if (health.telemetry.diskUsedPct !== disk || health.telemetry.prune?.consecutiveRefused !== 469)
          violations.push(`disk ${disk}: producer omits disk/prune readings from the health cache`);
        if (tick.state.episodes['forge-disk-prune::forge-disk-prune']?.escalation?.status !== 'needs-you'
          || tick.plan.filter(p => p.kind === 'notify' && !p.suppressed).length !== 1)
          violations.push(`disk ${disk}: real disk/prune breach produces no needs-you notification`);
      }
      return {violations};
    } finally { await rm(scratch, {recursive: true, force: true}); }
  },
  judge(report) { return report.violations; },
};
