/** Two launch-guard refusals an hour apart must hold the card before planning, including after restart. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planPrepareSpawns } from '../../tick-core.mjs';
import { resolvePreparePolicy } from '../../prepare-policy-settings.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';
function fixture(now, io, onOffer = () => {}, onDispatch = () => {}) {
  return {
    now: () => now, preparePolicy: () => resolvePreparePolicy(),
    readPrepareRefusals: io.readPrepareRefusals, recordPrepareRefusal: io.recordPrepareRefusal,
    planTick: bk => {
      const picks = planPrepareSpawns({ needsPrepare: [{ num: '5028' }], prepareHeldNums: bk.prepareHeldNums,
        availableLanes: [1], maxConcurrentItemPrepares: 1 }).itemPrepareSpawns;
      onOffer(picks.length); return { decisions: { itemPrepareSpawns: picks }, nextState: {} };
    },
    fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
    killSwitch: () => ({ engaged: false }), listPrepareInFlight: () => [], listPrepareClaims: () => [],
    listPreparePrs: () => [{ number: 91, state: 'OPEN', headRefName: 'lane/5028d-prepare-x' }],
    placePrepareHold: () => {}, releasePrepareHold: () => {},
    acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: () => {},
    dispatch: () => { onDispatch(); return { dispatching: true }; },
  };
}

/** A fresh Node process loads the production adapters and reads only the persisted history. */
export async function loadedTick(root, now) {
  const { runBuildDispatchTick, cliEffects } = await import(pathToFileURL(join(root, DAEMON)).href);
  let offered = 0, dispatched = 0;
  const tick = await runBuildDispatchTick({ live: true,
    effects: { ...fixture(now, cliEffects(), n => { offered += n; }, () => { dispatched++; }), listPreparePrs: () => [] } });
  return { offered, dispatched, planned: tick.prepare.planned,
    held: tick.prepare.skippedRepeatRefusal?.some(r => r.num === '5028' && r.refusals === 2) === true };
}

export async function scenario(root = ROOT) {
  const { runBuildDispatchTick, cliEffects } = await import(pathToFileURL(join(root, DAEMON)).href);
  const coordinationRoot = mkdtempSync(join(tmpdir(), 'prepare-refusal-soak-'));
  const previousRoot = process.env.WE_COORDINATION_ROOT;
  process.env.WE_COORDINATION_ROOT = coordinationRoot;
  let now = Date.parse('2026-11-18T12:00:00Z'), offered = 0, dispatched = 0;
  const start = now;
  try {
    const effects = {
      ...fixture(now, cliEffects(), n => { offered += n; }, () => { dispatched++; }), now: () => now,
    };
    const tick = bookkeeping => runBuildDispatchTick({ live: true, effects, bookkeeping });
    const first = await tick({}); now += 3_600_000;
    const second = await tick(first.nextBookkeeping); now += 3_600_000;
    const refusals = [first, second].map(t => t.prepare.refused.length);
    const initialOffers = offered; offered = 0;
    const continued = await tick(second.nextBookkeeping);
    const heldOffers = offered, heldDispatches = dispatched;
    const reloads = [2, 23, 24].map(hours => {
      const code = `import { loadedTick } from ${JSON.stringify(import.meta.url)}; console.log(JSON.stringify(await loadedTick(process.argv[1], Number(process.argv[2]))));`;
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code, root, String(start + hours * 3_600_000)],
        { env: { ...process.env, WE_COORDINATION_ROOT: coordinationRoot }, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
      if (probe.status !== 0) throw new Error(`loaded refusal tick failed: ${probe.stderr}`);
      return JSON.parse(probe.stdout.trim().split('\n').at(-1));
    });
    effects.listSettledPrepares = () => [{ num: '5028', source: 'run:latest', startedAt: new Date(start).toISOString(), outcome: 'prepare-unstamped' }];
    effects.listPrepareReleases = () => [{ target: '5028', attempt: 'run:latest' }];
    effects.listPreparePrs = () => [];
    const released = await tick(second.nextBookkeeping);
    const etLogs = reloads.map((r, i) => `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto',
      dateStyle: 'short', timeStyle: 'long' }).format(start + [2, 23, 24][i] * 3_600_000)}: loaded #5028 held=${r.held} offered=${r.offered} dispatched=${r.dispatched}`);
    return { refusals, initialOffers, offered: heldOffers, dispatched: heldDispatches,
      held: continued.prepare.skippedRepeatRefusal?.some(r => r.num === '5028' && r.refusals === 2) && reloads.slice(0, 2).every(r => r.held),
      planned: continued.prepare.planned, reloads, etLogs,
      released: released.prepare.launched.some(r => r.num === '5028') };
  } finally {
    if (previousRoot === undefined) delete process.env.WE_COORDINATION_ROOT;
    else process.env.WE_COORDINATION_ROOT = previousRoot;
    rmSync(coordinationRoot, { recursive: true, force: true });
  }
}
export default {
  id: 'prepare-repeat-refusal-readmitted-after-30min',
  title: 'a twice-refused prepare is readmitted after the 30-minute hold instead of staying held for 24h',
  card: 'durable repeat-refusal hold (slice 1)',
  fixedBy: { sha: 'fc590f0', where: 'main', paths: [DAEMON] },
  fixPresent(root) {
    const code = `import { scenario } from ${JSON.stringify(import.meta.url)}; console.log(JSON.stringify(await scenario(process.argv[1])));`;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], { encoding: 'utf8', timeout: 45_000, maxBuffer: 64 * 1024 });
    try { const report = JSON.parse(probe.stdout.trim().split('\n').at(-1)); return probe.status === 0 && report.held === true && this.judge(report).length === 0; }
    catch { return false; }
  },
  run: () => scenario(),
  judge: report => [
    ...(report.refusals?.join(',') === '1,1' && report.initialOffers === 2 ? [] : ['scenario did not exercise two launch-guard refusals']),
    ...(report.offered === 0 && report.planned?.length === 0 && report.dispatched === 0 ? [] : ['twice-refused card planned/admitted again within 24h']),
    ...(report.held === true ? [] : ['observable repeat-refusal skip missing']),
    ...(report.released === true ? [] : ['matching operator release did not lift the repeat-refusal hold']),
    ...(report.reloads?.slice(0, 2).every(r => r.held && r.offered === 0 && r.planned.length === 0 && r.dispatched === 0)
      && report.reloads.length === 3 && report.reloads[2].held === false && report.reloads[2].offered === 1
      ? [] : ['fresh-process reload did not preserve the hold through expiry']),
  ],
};
