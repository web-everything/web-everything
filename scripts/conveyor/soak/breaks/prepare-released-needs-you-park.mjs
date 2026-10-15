/**
 * @file breaks/prepare-released-needs-you-park.mjs — PR #5366 review (round 3): the prepare launch guard read
 * only `releasedAt`/`releasedBy` on the ledger record. A reviewed release lives in the releases store
 * (`{ target, attempt }`), which never writes those fields. So a needs-you card the operator released had its
 * hold dropped, was planned again, and was then refused at launch as `parked needs-you` on every tick.
 *
 * Fix: the launch guard takes the same release set as the settle code and drops a released attempt.
 * The scenario runs the REAL live dispatch tick with a held needs-you record and a matching reviewed release.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';
const GUARD = 'scripts/conveyor/prepare-pr-match.mjs';

export default {
  id: 'prepare-released-needs-you-park',
  title: 'A reviewed release of a needs-you prepare park is ignored at launch, refusing the card forever',
  card: '347 / PR 5366',
  fixedBy: { sha: 'HEAD', where: 'lane/prepare-dup-guard', paths: [DAEMON, GUARD] },
  fixPresent(root) {
    const p = join(root, GUARD);
    return existsSync(p) && readFileSync(p, 'utf8').includes('releasedAttempt(releases, key, latest.attempt)');
  },
  async run() {
    const { runBuildDispatchTick } = await import(resolve(REPO_ROOT, DAEMON));
    const problems = [];
    for (const released of [true, false]) {
      const effects = {
        planTick: () => ({ decisions: { itemPrepareSpawns: [{ num: '5028' }] }, nextState: {} }),
        fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
        killSwitch: () => ({ engaged: false }), listPreparePrs: () => [],
        acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: () => {},
        dispatch: () => ({ dispatching: true }), placePrepareHold: () => {}, releasePrepareHold: () => {},
        listPrepareFailures: () => [{ num: '5028', attempt: 'run x', stage: 'result', cause: 'needs-you',
          held: true, recordedAt: '2026-10-14', holdReason: 'needs-you: decide scope' }],
        listPrepareReleases: () => (released ? [{ target: '5028', attempt: 'run x' }] : []),
      };
      const error = console.error;
      console.error = () => {};
      let tick;
      try { tick = await runBuildDispatchTick({ live: true, effects }); } finally { console.error = error; }
      const launched = tick.prepare.launched.some(r => r.num === '5028');
      if (released && !launched) problems.push(`released needs-you park still refused: ${JSON.stringify(tick.prepare.refused)}`);
      if (!released && launched) problems.push('unreleased needs-you park was launched');
    }
    return { problems };
  },
  judge: report => report.problems,
};
