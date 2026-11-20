/** Live 2026-11-20: ci-heal ran once per 35-min fix pass, so CI failure to heal start took 30-49 min. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export default {
  id: 'ci-heal-runs-on-own-interval',
  title: 'ci-heal runs on its own short interval and the fix pass no longer runs it inline when the loop is alive',
  card: 'ci-heal-own-cadence',
  fixedBy: { sha: 'uncommitted', where: 'lane/ci-heal-cadence', paths: [
    'scripts/conveyor/ci-heal-loop.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  ] },
  // Behaviour, not markers: the module must exist and clamp an out-of-bounds interval to the 300s default.
  fixPresent(root) {
    const url = pathToFileURL(join(root, 'scripts/conveyor/ci-heal-loop.mjs')).href;
    const code = `import(${JSON.stringify(url)}).then(m=>{const r=m.resolveCiHealInterval({env:{WE_CI_HEAL_INTERVAL_SEC:'5'},settings:{}});process.exit(r.seconds===300?0:1)}).catch(()=>process.exit(2))`;
    return spawnSync(process.execPath, ['-e', code], { cwd: root, timeout: 30000 }).status === 0;
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { runTickAllRepos, buildCliDaemonEffects } = await import(pathToFileURL(join(root, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs')).href);
    const empty = () => ({ dispatched: [], refusals: [], actions: [], notes: [], rows: [] });
    let ciHealCalls = 0;
    const base = { repos: [], fixTick: empty, hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty,
      promoteDraftTick: empty, notesTick: empty, awaitVerifyTick: empty, stuckFixerTick: empty, supersedeTick: empty,
      rulingStandDownTick: empty, authGateOverride: () => ({ paused: false }),
      fixSettings: { skipEmptySteps: false }, reuseReconcilePlan: false, budgetRotation: {}, prCursors: {},
      ciHealTick: () => { ciHealCalls += 1; return empty(); } };
    await runTickAllRepos({ ...base, repos: ['x/y'], ciHealInline: false });
    const inlineCallsWhenLoopAlive = ciHealCalls;
    await runTickAllRepos({ ...base, repos: ['x/y'], ciHealOnly: true });
    const childHealCalls = ciHealCalls - inlineCallsWhenLoopAlive;
    const ciHealLoop = { current: () => ({ pid: 42 }) };
    const effects = buildCliDaemonEffects({ owner: 'soak', ciHealLoop });
    // Exercise the actual tick call site with a recording effect in place of live daemon IO.
    let daemonCiHealInline;
    Function('runTickAllRepos', 'ciHealLoop', 'defaultTagDispatchStatus', 'adoptYieldProbe',
      `return (${effects.tickOnce.toString()})();`)(options => { daemonCiHealInline = options.ciHealInline; }, ciHealLoop, null, undefined);
    return { inlineCallsWhenLoopAlive, childHealCalls, daemonCiHealInline };
  },
  judge: report => [
    ...(report.inlineCallsWhenLoopAlive === 0 ? [] : ['fix pass ran ci-heal inline although the loop owns it']),
    ...(report.childHealCalls === 1 ? [] : ['child pass did not heal']),
    ...(report.daemonCiHealInline === false ? [] : ['real daemon tick did not suppress inline healing for its live child']),
  ],
};
