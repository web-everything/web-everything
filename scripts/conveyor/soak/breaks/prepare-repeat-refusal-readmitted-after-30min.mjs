/** Two launch-guard refusals an hour apart must hold the card before planning, including after restart. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planPrepareSpawns } from '../../tick-core.mjs';
import { resolvePreparePolicy } from '../../prepare-policy-settings.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';
export async function scenario(root = ROOT) {
  const { runBuildDispatchTick } = await import(pathToFileURL(join(root, DAEMON)).href);
  let now = Date.parse('2026-11-18T12:00:00Z'), rows = [], offered = 0, dispatched = 0;
  const effects = {
    now: () => now, preparePolicy: () => resolvePreparePolicy(),
    readPrepareRefusals: () => rows,
    recordPrepareRefusal: (row, options) => { rows.push({ ...row, at: new Date(options.now).toISOString() }); },
    planTick: bk => {
      const picks = planPrepareSpawns({ needsPrepare: [{ num: '5028' }], prepareHeldNums: bk.prepareHeldNums,
        availableLanes: [1], maxConcurrentItemPrepares: 1 }).itemPrepareSpawns;
      offered += picks.length; return { decisions: { itemPrepareSpawns: picks }, nextState: {} };
    },
    fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
    killSwitch: () => ({ engaged: false }), listPrepareInFlight: () => [], listPrepareClaims: () => [],
    listPreparePrs: () => [{ number: 91, state: 'OPEN', headRefName: 'lane/5028d-prepare-x' }],
    placePrepareHold: () => {}, releasePrepareHold: () => {},
    acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: () => {},
    dispatch: () => { dispatched++; return { dispatching: true }; },
  };
  const tick = bookkeeping => runBuildDispatchTick({ live: true, effects, bookkeeping });
  const first = await tick({}); now += 3_600_000;
  const second = await tick(first.nextBookkeeping); now += 3_600_000;
  const refusals = [first, second].map(t => t.prepare.refused.length);
  const initialOffers = offered; offered = 0;
  const continued = await tick(second.nextBookkeeping), restarted = await tick({});
  now += 21 * 3_600_000;
  const late = await tick({});
  return { refusals, initialOffers, offered, dispatched,
    held: [continued, restarted, late].every(t => t.prepare.skippedRepeatRefusal?.some(r => r.num === '5028' && r.refusals === 2)),
    planned: [continued, restarted, late].flatMap(t => t.prepare.planned) };
}
export default {
  id: 'prepare-repeat-refusal-readmitted-after-30min',
  title: 'a twice-refused prepare is readmitted after the 30-minute hold instead of staying held for 24h',
  card: 'durable repeat-refusal hold (slice 1)',
  fixedBy: { sha: 'fc590f0', where: 'main', paths: [DAEMON] },
  fixPresent(root) {
    const code = `import { scenario } from ${JSON.stringify(import.meta.url)}; console.log(JSON.stringify(await scenario(process.argv[1])));`;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
    try { const report = JSON.parse(probe.stdout); return probe.status === 0 && report.held === true && this.judge(report).length === 0; }
    catch { return false; }
  },
  run: () => scenario(),
  judge: report => [
    ...(report.refusals?.join(',') === '1,1' && report.initialOffers === 2 ? [] : ['scenario did not exercise two launch-guard refusals']),
    ...(report.offered === 0 && report.planned?.length === 0 && report.dispatched === 0 ? [] : ['twice-refused card planned/admitted again within 24h']),
    ...(report.held === true ? [] : ['observable repeat-refusal skip missing']),
  ],
};
