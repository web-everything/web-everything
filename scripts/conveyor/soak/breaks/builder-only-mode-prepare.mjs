/** Builder only-mode: prepares are gated to the runtime list, and an expired list is ignored. */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBuildDispatchTick } from '../../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { readBuildPrioritySettings } from '../../../lib/build-queue.mjs';

const NOW = Date.parse('2026-11-20T18:00:00Z');
const readList = ageHours => readBuildPrioritySettings({ env: {}, read: () => ({}), runtimePath: '/x', now: () => NOW,
  readRuntime: () => JSON.stringify({ ids: ['2'], mode: 'only', setBy: 'soak', ttlHours: 5, at: new Date(NOW - ageHours * 3600e3).toISOString() }) });

async function launched(settings) {
  const rows = ['1', '2'].map(num => ({ num, scope: [`we:scripts/soak/f${num}.mjs`] }));
  const dispatched = [];
  const effects = {
    planTick: () => ({ decisions: { spawnPrepareItems: rows, admission: { queue: rows, cleared: [],
      held: rows.map(r => ({ num: r.num, reason: 'needs-prepare' })) } }, nextState: {} }),
    fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [], killSwitch: () => ({ engaged: false }),
    listHolds: () => [], listPrepareInFlight: () => [], listPrepareClaims: () => [],
    readPrepareStatus: () => ({ preparedDate: null }), readPreparedStamp: () => ({ preparedDate: null }),
    acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: () => ({}), placePrepareHold: () => {},
    dispatch: args => { dispatched.push(args.num); return { dispatching: true, lane: 1 }; },
    readRuntimePriority: () => settings,
  };
  const log = console.error; console.error = () => {};
  try { await runBuildDispatchTick({ live: true, effects }); } finally { console.error = log; }
  return dispatched;
}

export async function replay() {
  const violations = [];
  const only = await launched(readList(1));
  if (only.join() !== '2') violations.push(`only mode prepared off-list ids: ${only.join()}`);
  if ((await launched({ ids: [], only: true, held: true })).length) violations.push('unreadable list did not fail closed');
  const expired = readList(10);
  if (expired.only || !/runtime list expired at .* ET/.test(expired.runtime?.line ?? '')) violations.push('expired list was still applied or not reported');
  return { violations };
}

export default {
  id: 'builder-only-mode-prepare',
  title: 'only mode gates prepare launches; an expired runtime list is ignored',
  card: 'builder readiness blocker',
  fixedBy: { sha: 'HEAD', where: 'builder-only-mode-prepare', paths: [
    'skills-src/conveyor/build-dispatch-daemon.mjs', 'scripts/lib/build-queue.mjs',
  ] },
  fixPresent(root) {
    const target = pathToFileURL(join(root, 'scripts/conveyor/soak/breaks/builder-only-mode-prepare.mjs')).href;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const { replay } = await import(process.argv[1]); const report = await replay(); process.exitCode = report.violations.length ? 1 : 0;',
      target], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return probe.status === 0;
  },
  run: replay,
  judge: report => report.violations,
};
