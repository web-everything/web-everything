/**
 * @file breaks/prepare-stamped-needs-you-park.mjs — PR #5366 review (round 4): the prepare launch guard parked on a
 * needs-you record that was `completed`. An operator resolves a needs-you card by stamping it on main by hand; the
 * daemon sees the stamp and completes the record. When main later moves and the stamp goes stale, tick-core offers
 * a `prepare-stale` re-prepare, and the guard refused it as `parked needs-you` on every tick, with nothing telling
 * the operator why (the needs-you list shows only `held && !completed` records).
 *
 * Fix: the guard parks only on `held && !completed`, the same view the needs-you list uses.
 * The scenario runs the REAL live dispatch tick for a stamped card whose needs-you record is held or completed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';
const GUARD = 'scripts/conveyor/prepare-pr-match.mjs';

export default {
  id: 'prepare-stamped-needs-you-park',
  title: 'A needs-you card resolved by a hand stamp is refused at launch forever when it goes stale',
  card: '347 / PR 5366',
  fixedBy: { sha: '40cdd857b', where: 'lane/prepare-dup-guard', paths: [GUARD] },
  fixPresent(root) {
    const p = join(root, GUARD);
    return existsSync(p) && readFileSync(p, 'utf8').includes('latest.held === true && latest.completed !== true');
  },
  async run() {
    const { runBuildDispatchTick } = await import(resolve(REPO_ROOT, DAEMON));
    const problems = [];
    for (const completed of [true, false]) {
      const effects = {
        planTick: () => ({ decisions: { itemPrepareSpawns: [{ num: '5028' }] }, nextState: {} }),
        fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
        killSwitch: () => ({ engaged: false }), listPreparePrs: () => [],
        acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: () => {},
        dispatch: () => ({ dispatching: true }), placePrepareHold: () => {}, releasePrepareHold: () => {},
        readPreparedStamp: () => ({ preparedDate: '2026-09-01', preparedAgainstSha: 'aaaa1111' }),
        listPrepareFailures: () => [{ num: '5028', attempt: 'run x', stage: 'result', cause: 'needs-you',
          held: true, completed, recordedAt: '2026-08-30', holdReason: 'needs-you: decide scope' }],
      };
      const error = console.error;
      console.error = () => {};
      let tick;
      try { tick = await runBuildDispatchTick({ live: true, effects }); } finally { console.error = error; }
      const launched = tick.prepare.launched.some(r => r.num === '5028');
      if (completed && !launched) problems.push(`stamp-completed needs-you park still refused: ${JSON.stringify(tick.prepare.refused)}`);
      if (!completed && launched) problems.push('held needs-you park was launched');
    }
    return { problems };
  },
  judge: report => report.problems,
};
