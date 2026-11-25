/** With the external build cap at 0 (builds paused) the daemon must not launch prepare runs: each would be refused at start. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planPrepareSpawns } from '../../tick-core.mjs';
import { resolvePreparePolicy } from '../../prepare-policy-settings.mjs';
import { BUILD_DISPATCH_POLICY } from '../../build-dispatch-policy.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';

function effectsFor(now, onDispatch) {
  return {
    now: () => now, preparePolicy: () => resolvePreparePolicy(),
    planTick: bk => ({ decisions: { itemPrepareSpawns: planPrepareSpawns({ needsPrepare: [{ num: '5028' }],
      prepareHeldNums: bk.prepareHeldNums, availableLanes: [1], maxConcurrentItemPrepares: 1 }).itemPrepareSpawns }, nextState: {} }),
    fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
    killSwitch: () => ({ engaged: false }), listPrepareInFlight: () => [], listPrepareClaims: () => [],
    listPreparePrs: () => [], placePrepareHold: () => {}, releasePrepareHold: () => {},
    acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: () => {},
    dispatch: () => { onDispatch(); return { dispatching: true }; },
  };
}

export async function scenario(root = ROOT) {
  const { runBuildDispatchTick } = await import(pathToFileURL(join(root, DAEMON)).href);
  const coordinationRoot = mkdtempSync(join(tmpdir(), 'prepare-cap-zero-soak-'));
  const previousRoot = process.env.WE_COORDINATION_ROOT;
  process.env.WE_COORDINATION_ROOT = coordinationRoot;
  try {
    let zeroDispatches = 0, positiveDispatches = 0;
    const zero = await runBuildDispatchTick({ live: true, policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentExternalBuilds: 0 },
      effects: effectsFor(Date.parse('2026-11-25T13:00:00Z'), () => { zeroDispatches++; }) });
    await runBuildDispatchTick({ live: true, policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentExternalBuilds: 4 },
      effects: effectsFor(Date.parse('2026-11-25T13:00:00Z'), () => { positiveDispatches++; }) });
    return { zeroDispatches, positiveDispatches, skipReason: zero.prepare.skippedExternalZero?.reason ?? null };
  } finally {
    if (previousRoot === undefined) delete process.env.WE_COORDINATION_ROOT;
    else process.env.WE_COORDINATION_ROOT = previousRoot;
    rmSync(coordinationRoot, { recursive: true, force: true });
  }
}

export default {
  id: 'prepare-launched-while-external-cap-zero',
  title: 'a prepare is launched while the external build cap is 0 and is refused at start (prepare-unstamped)',
  card: 'STRATEGY-SELECTOR S2.3',
  fixedBy: { sha: 'pending', where: 'lane/strategy-s23-prepare-cap-zero', paths: [DAEMON] },
  fixPresent(root) {
    const code = `import { scenario } from ${JSON.stringify(import.meta.url)}; console.log(JSON.stringify(await scenario(process.argv[1])));`;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], { encoding: 'utf8', timeout: 45_000, maxBuffer: 64 * 1024 });
    try { return probe.status === 0 && this.judge(JSON.parse(probe.stdout.trim().split('\n').at(-1))).length === 0; }
    catch { return false; }
  },
  run: () => scenario(),
  judge: report => [
    ...(report.zeroDispatches === 0 ? [] : ['prepare launched with external cap 0']),
    ...(report.skipReason === 'external concurrency 0' ? [] : ['reasoned skip "external concurrency 0" missing']),
    ...(report.positiveDispatches === 1 ? [] : ['positive cap no longer launches the prepare']),
  ],
};
