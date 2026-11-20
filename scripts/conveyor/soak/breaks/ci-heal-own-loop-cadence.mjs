/** Replay slow serial passes and judge only emitted gate timestamps, independent of scheduler state. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export async function cadenceProbe({ root = process.env.SOAK_TREE_ROOT || ROOT, tick } = {}) {
  const { runTickAllRepos } = tick ? {} : await import(pathToFileURL(join(root, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs')).href);
  let time = 0;
  const lines = [];
  const log = line => lines.push(line);
  const empty = () => ({ dispatched: [], applied: [], refusals: [], notes: [], prsByNumber: new Map() });
  // Synchronous on old trees with no boundary hook, serial/awaited when the real daemon supplies one.
  const slow = ({ maybeCiHealSlice } = {}) => {
    let remaining = 16;
    const step = () => {
      while (remaining-- > 0) {
        time += 30000;
        if (maybeCiHealSlice) return Promise.resolve(maybeCiHealSlice()).then(step);
      }
      return empty();
    };
    return step();
  };
  const options = { repos: ['cadence-fixture'], now: () => time, fenceOk: () => true, log,
    fixTick: slow, hungCiTick: slow, mainRedRebaseTick: slow, missingRunTick: slow, promoteDraftTick: slow,
    // This is the existing dispatcher's gate diagnostic, also emitted by old daemon trees.
    ciHealTick: () => { log(`ci-heal-pr-dispatch: gate slice at=${new Date(time).toISOString()}`); return empty(); },
    notesTick: empty, awaitVerifyTick: () => ({ rows: [] }), stuckFixerTick: () => ({ rows: [] }),
    supersedeTick: () => ({ rows: [] }), orphanGuardTick: null,
    budgetRotation: {}, prCursors: {},
  };
  for (let pass = 0; pass < 3; pass++) await (tick ?? runTickAllRepos)(options);
  const timestamps = lines.filter(line => line.includes('ci-heal-pr-dispatch: gate slice'))
    .map(line => Date.parse(line.match(/ at=(\S+)/)?.[1])).filter(Number.isFinite);
  const boundaries = [0, ...timestamps, time];
  const gaps = boundaries.slice(1).map((at, i) => at - boundaries[i]);
  return { lines, timestamps, elapsedMs: time, maxGapMs: Math.max(...gaps) };
}

const b = {
  id: 'ci-heal-own-loop-cadence',
  title: 'ci-heal gate slices continue during forty-minute serial fix-daemon passes',
  card: 'ci-heal-own-loop-cadence',
  fixedBy: { sha: 'working-tree', where: 'cooperative fix-daemon slices', paths: ['skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'] },
  // The registry expects a synchronous predicate. Run the actual daemon fixture in a bounded subprocess,
  // never inspect source markers or ask the slicer whether it considers itself healthy.
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e',
        `import { cadenceProbe } from ${JSON.stringify(import.meta.url)};` +
        " const report = await cadenceProbe({root: process.env.CADENCE_ROOT}); process.stdout.write(JSON.stringify(report));"],
      { env: { ...process.env, VITEST: '1', CADENCE_ROOT: root }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const report = JSON.parse(output);
      return report.elapsedMs === 7200000 && report.timestamps.length >= 48 && report.maxGapMs <= 150000;
    } catch { return false; }
  },
  run: cadenceProbe,
  judge(report) {
    const failures = [];
    if (report.elapsedMs !== 7200000) failures.push('fixture did not exercise two simulated hours');
    if (report.timestamps.length < 48) failures.push('too few logged gate slices');
    if (!(report.maxGapMs <= 150000)) failures.push(`logged gate gap ${report.maxGapMs}ms exceeds 150000ms`);
    return failures;
  },
};
export default b;
