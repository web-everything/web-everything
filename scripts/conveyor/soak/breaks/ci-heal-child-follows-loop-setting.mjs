/**
 * @file breaks/ci-heal-child-follows-loop-setting.mjs — live break, 2026-11-20 ET.
 * CI-red PRs waited 30-49 min for a heal claim because ci-heal only ran inside the fix pass. The ci-heal child loop
 * (async fixer slice C2) heals every ciHeal.intervalSec, but it was spawned once at daemon start from a setting read
 * once: turning `ciHeal.loop` on needed a daemon restart, and turning it off did nothing.
 * FIX — `we:scripts/conveyor/ci-heal-loop.mjs` `createCiHealLoopController`: every daemon tick re-reads
 * `ciHeal.loop`; on starts the child if none runs (never a second one), off stops it with SIGTERM, an unreadable
 * store or a throwing resolver counts as off (fail closed).
 * RED = on does not start exactly one child, a second tick spawns another, off leaves the child alive, an
 *       unreadable store leaves it alive, or a stale retry timer starts a second child.
 * GREEN = on -> one spawn across three ticks; off -> SIGTERM and no current child; unreadable -> stopped.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = `
const loop = await import(process.argv[1]);
const sup = await import(process.argv[2]);
if (typeof loop.createCiHealLoopController !== 'function' || typeof sup.superviseAwaitVerifyLoop !== 'function') { console.log('null'); process.exit(0); }
const rig = (answers) => {
  const kills = []; let spawns = 0; const timers = [];
  const supervisor = sup.superviseAwaitVerifyLoop({
    spawnLoop: () => { spawns += 1; return { pid: spawns, on: () => {}, kill: sig => kills.push(sig) }; },
    log: { error: () => {} }, setTimer: fn => { timers.push(fn); return { unref() {} }; }, now: () => 0 });
  let i = 0;
  const controller = loop.createCiHealLoopController({ supervisor, log: () => {},
    resolve: () => { const a = answers[Math.min(i++, answers.length - 1)]; if (a === 'throw') throw new Error('unreadable'); return a; } });
  return { controller, supervisor, kills, timers, spawns: () => spawns };
};
const on = { enabled: true, source: 'override' }, off = { enabled: false, source: 'override' };
const a = rig([on, on, on]); a.controller.tick(); a.controller.tick(); a.controller.tick();
const b = rig([on, off]); b.controller.tick(); b.controller.tick();
const c = rig([on, 'throw']); c.controller.tick(); c.controller.tick();
const d = rig([off, on]); d.controller.tick(); d.controller.tick(); d.timers.forEach(fn => fn());
console.log(JSON.stringify({
  once: a.spawns(), offKills: b.kills, offCurrent: b.supervisor.current() === null,
  unreadableKills: c.kills, offToOnSpawns: d.spawns(),
}));`;

function probe(root) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE,
    pathToFileURL(join(root, 'scripts/conveyor/ci-heal-loop.mjs')).href,
    pathToFileURL(join(root, 'scripts/conveyor/await-verify-loop.mjs')).href], { encoding: 'utf8', timeout: 30_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { return null; }
}
const violations = o => !o ? ['the ci-heal loop controller is not reachable'] : [
  ...(o.once === 1 ? [] : [`on spawned ${o.once} children across three ticks (want exactly 1)`]),
  ...(JSON.stringify(o.offKills) === '["SIGTERM"]' && o.offCurrent ? [] : [`off did not stop the child gracefully (kills=${o.offKills} current-null=${o.offCurrent})`]),
  ...(JSON.stringify(o.unreadableKills) === '["SIGTERM"]' ? [] : [`an unreadable store did not stop the child (kills=${o.unreadableKills})`]),
  ...(o.offToOnSpawns === 1 ? [] : [`off then on spawned ${o.offToOnSpawns} children (want exactly 1)`]),
];

export default {
  id: 'ci-heal-child-follows-loop-setting',
  title: 'the ci-heal child follows ciHeal.loop live (on starts one, off stops it, unreadable is off)',
  card: 'PR #7248',
  fixedBy: { sha: 'HEAD', where: 'lane/async-c2-ci-heal-wire', paths: ['scripts/conveyor/ci-heal-loop.mjs', 'scripts/conveyor/await-verify-loop.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'] },
  // Presence is decided by behaviour: the controller exists and starts exactly one child for "on".
  fixPresent(root) { const o = probe(root); return !!o && o.once === 1; },
  async run() { return { violations: violations(probe(process.cwd())) }; },
  judge(report) { return report.violations; },
};
