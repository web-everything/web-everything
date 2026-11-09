/** R796 IO: all candidate evidence and adoption are serialized by the clone write lock. */
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { resolveDaemonClones } from '../lib/daemon-clones.mjs';
import { withWriteLock } from '../lib/daemon-clone-lock.mjs';
import { readReadyCandidate } from '../lib/daemon-rebuild/state.mjs';
import { readyBuildVerified, finalizeRebuild } from '../lib/daemon-rebuild/adopt.mjs';
import { makeGit, verifyRev, FULL_SHA_RE } from '../lib/daemon-rebuild/shared.mjs';
import { recordedEdgeSha } from '../lib/daemon-rebuild/edge-fetch.mjs';
import { readOverlayState, appendOverlayEvent } from '../lib/daemon-overlays.mjs';
import { REBUILD_ADOPT_OVERRIDE_EFFECT, validateRebuildAdoptOverride } from './rebuild-adopt-override.mjs';

const LABELS = Object.freeze({
  review: 'com.we.review-daemon', fix: 'com.we.fix-dispatch-daemon',
  verify: 'com.we.verify-daemon', build: 'com.we.build-dispatch-daemon', drain: 'com.plateau.drain-daemon',
});

export function resolveRebuildDaemonRoot(daemon, { discover = resolveDaemonClones, env = process.env } = {}) {
  let incomplete = false;
  const rows = discover({ env, onIncomplete: () => { incomplete = true; } });
  const matches = Array.isArray(rows) && Object.hasOwn(LABELS, daemon)
    ? rows.filter(row => Array.isArray(row?.labels) && row.labels.includes(LABELS[daemon])) : [];
  if (incomplete || matches.length !== 1 || typeof matches[0].path !== 'string' || !isAbsolute(matches[0].path)) {
    throw new Error('rebuild-adopt-override: cannot resolve daemon clone; repair incomplete or ambiguous daemon discovery before retrying');
  }
  return matches[0].path;
}

export function createRebuildAdoptOverrideSinks(deps = {}) {
  // Explicitly injected missing verification evidence must refuse, rather than fall back to production IO.
  const { env, stateOpts, log, now, run, resolveRoot, withWriteLock: lock,
    readReadyCandidate: readReady, readOverlayState: readOverlays, verifyBuilt,
    appendOverlayEvent: appendEvent, finalizeRebuild: finalize } = {
    env: process.env, stateOpts: {}, log: console, now: Date.now,
    run: (args, opts) => spawnSync('git', args, { ...opts, encoding: 'utf8', maxBuffer: 1024 * 1024 }),
    resolveRoot: resolveRebuildDaemonRoot, withWriteLock, readReadyCandidate, readOverlayState,
    verifyBuilt: readyBuildVerified, appendOverlayEvent, finalizeRebuild,
    ...deps,
  };
  return { [REBUILD_ADOPT_OVERRIDE_EFFECT]: async raw => {
    const { sha, daemon } = validateRebuildAdoptOverride(raw);
    const root = await resolveRoot(daemon, { env });
    const result = await lock(root, async () => {
      const ready = await readReady(root, { ...env, ...(stateOpts?.env || {}) });
      if (!ready) throw new Error('rebuild-adopt-override: no ready record; wait for a successful rebuild before retrying');
      if (ready.adopt?.finalSha !== sha) throw new Error('rebuild-adopt-override: sha mismatch with ready record');
      const plan = ready.adopt;
      for (const field of ['dropRefs', 'suspects']) {
        if (plan[field] != null && (!Array.isArray(plan[field]) || plan[field].length !== 0)) {
          throw new Error('rebuild-adopt-override: requires a plain verified adopt without dropped or suspect overlays');
        }
      }
      const git = makeGit({ run, cwd: root, env });
      const prevHead = verifyRev(git, 'HEAD');
      const mainTip = verifyRev(git, 'origin/main');
      if (!FULL_SHA_RE.test(prevHead ?? '') || !FULL_SHA_RE.test(mainTip ?? '')) {
        throw new Error('rebuild-adopt-override: unreadable HEAD or origin/main; repair git evidence before retrying');
      }
      const overlays = await readOverlays(root, { env });
      if (overlays?.corrupt !== false || !Array.isArray(overlays.overlays)) {
        throw new Error('rebuild-adopt-override: unreadable overlay approval state; repair it before retrying');
      }
      if (typeof verifyBuilt !== 'function' || await verifyBuilt({
        git, adopt: plan, mainTip, prevHead,
        approvedEdgeShaFor: ref => recordedEdgeSha(overlays.overlays.find(entry => entry?.ref === ref)),
      }) !== true) {
        throw new Error('rebuild-adopt-override: ready build is not verified');
      }
      await appendEvent(root, { kind: 'needs-you', need: 'rebuild-adopt-override', target: sha, daemon }, { env });
      const outcome = await finalize({ root, env, log, run, stateOpts, now, plan, prevHead,
        lease: { token: ready.token ?? null } });
      if (outcome?.adopted !== true) throw new Error('rebuild-adopt-override: finalization did not adopt; inspect rebuild state before retrying');
      return outcome;
    });
    if (result?.ok !== true) throw new Error('rebuild-adopt-override: write lock unavailable; retry after the current holder releases it');
    return result.value;
  } };
}
