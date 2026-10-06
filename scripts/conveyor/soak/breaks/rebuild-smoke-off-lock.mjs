/**
 * @file breaks/rebuild-smoke-off-lock.mjs — live break, 2026-09-26 09:32 ET (#4075, epic #3383, card 4218). The
 * daemon rebuild's live smoke (`scripts/lib/daemon-live-smoke.mjs`) grew slow once #2691's two extra checks
 * (`reconcile-dry-run`, `dispatch-dry-run`) landed — live: `smoke-slow {"ms":64720, reconcile-dry-run:17234ms,
 * dispatch-dry-run:44701ms}`. `daemon-rebuild.mjs#doRebuild` ran that whole smoke (Step 6) INSIDE the same
 * `withWriteLock` hold as its own `git reset --hard` (Step 5), so every OTHER daemon/process sharing the clone
 * called `acquireRead` during that ~65s window and was refused `writer-active`, logging "read lock refused
 * (writer-active) — skipping this tick" and dispatching nothing — the same class of bug #2625 fixed for the
 * smoke's OWN duration (`skip-unchanged`), but #2625 never moved the smoke OFF the write lock in the first place.
 * A rebuild happens on every `main` move (frequent while the drain lands PRs), so this starved a large share of
 * every daemon's ticks.
 *
 * Fix (4218): `rebuildClone` now runs the WHOLE live smoke against a DISPOSABLE candidate `git worktree`
 * (`materializeCandidate`), never against the clone itself, and holds NO lock at all while it runs — the write
 * lock is only ever taken (briefly) for the fast, final `git reset --hard` AFTER a passing smoke
 * (`finalizeRebuild`). See `scripts/lib/daemon-rebuild.mjs`'s own file header for the full three-phase design.
 *
 * Scenario: real `rebuildClone`, imported from the tree under test, run with an injected `runSmoke` that takes a
 * few real seconds (standing in for the live ~65s) before reporting a pass. WHILE that smoke is still running,
 * this scenario tries a REAL `acquireRead` on the SAME clone, using the real `daemon-clone-lock.mjs` — exactly
 * what a sibling daemon's tick does at the top of every `withSelfSync` cycle. FIXED code: the acquire succeeds
 * at once (never refused) — the write lock is not held during the smoke. PRE-fix shape (the old single-lock
 * `doRebuild`, simulated here directly rather than by reverting a specific sha — see `fixPresent` below): the
 * acquire would be refused `writer-active` for the smoke's whole duration.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';
import { rebuildMechanismSource } from '../rebuild-mechanism-source.mjs';

const SMOKE_MS = 3_000; // stands in for the live ~65s smoke — long enough to observe reliably, short for a test.

export default {
  id: 'rebuild-smoke-off-lock',
  title: "the daemon rebuild's live smoke held the clone's WRITE lock for its whole duration, so every sibling daemon's tick was refused (writer-active) and dispatched nothing",
  card: 'we:backlog/4218 (epic #4075/#3383)',
  fixedBy: {
    sha: '4218-daemon-rebuild-offlock-smoke',
    where: 'lane/4218-daemon-rebuild-offlock-smoke',
    paths: ['scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-live-smoke.mjs', 'scripts/lib/daemon-self-sync.mjs'],
  },
  fixPresent(root) {
    try {
      return /materializeCandidate/.test(rebuildMechanismSource(root));
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    const report = await runSoak({
      name: 'break:rebuild-smoke-off-lock',
      rounds: 1,
      daemons: [], // this scenario drives `rebuildClone` directly (see perRound) — no daemon tick loop needed.
      mainEvery: 0,
      fleet: false,
      log,
      setup(w) {
        // Same isolation `fix-daemon-lock-wait.mjs` uses: left unset, `daemon-clone-lock.mjs#defaultLockRoot`
        // falls back to the REAL `~/.claude/daemon-clone-locks` — never touch that from a soak run.
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
        return {};
      },
      async perRound(w, round, ctx, api) {
        if (round !== 0) return;
        const rebuildModulePath = join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs');
        const lockModulePath = join(w.simCloneRoot, 'scripts/lib/daemon-clone-lock.mjs');
        if (!existsSync(rebuildModulePath)) {
          throw new Error('rebuild-smoke-off-lock: requires scripts/lib/daemon-rebuild.mjs (lands with 4218) — not present on this tree');
        }
        const { rebuildClone } = await import(pathToFileURL(rebuildModulePath).href);
        const { acquireRead, releaseRead } = await import(pathToFileURL(lockModulePath).href);

        // Give the rebuild something real to build: advance origin/main past the clone's current HEAD.
        api.moveMain(w, { 'soak/rebuild-smoke-off-lock.md': '# advance main for rebuild-smoke-off-lock\n' }, 'soak: advance main for rebuild-smoke-off-lock');

        let smokeStarted = false;
        const runSmoke = async () => {
          smokeStarted = true;
          await new Promise((resolve) => { setTimeout(resolve, SMOKE_MS); });
          return { verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'sim-smoke', ok: true, ms: SMOKE_MS }] } };
        };

        const startedAt = Date.now();
        const rebuildPromise = rebuildClone({
          root: w.simCloneRoot, env: w.env, runSmoke, prState: async () => null,
        });

        // Wait until the candidate's smoke has actually started, then, WHILE it is still in flight, try a REAL
        // read-lock acquire on the SAME clone — exactly what a sibling daemon's tick does every cycle.
        const pollDeadline = Date.now() + 10_000;
        while (!smokeStarted && Date.now() < pollDeadline) await new Promise((r) => { setTimeout(r, 20); });
        if (!smokeStarted) throw new Error('rebuild-smoke-off-lock: the injected smoke never started within 10s');

        const acquired = acquireRead(w.simCloneRoot, { lockRoot: w.env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'sim-sibling-daemon' });
        if (acquired.ok) releaseRead(w.simCloneRoot, { lockRoot: w.env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'sim-sibling-daemon' });
        const elapsedAtAcquire = Date.now() - startedAt;
        api.say(`r00 acquireRead ${elapsedAtAcquire}ms into a ${SMOKE_MS}ms smoke: ${acquired.ok ? 'OK — not refused' : `REFUSED (${acquired.reason})`}`);
        if (!acquired.ok) {
          api.violation('writer-active-during-smoke', `a sibling daemon's read-lock acquire was refused (${acquired.reason}) ${elapsedAtAcquire}ms into the candidate's still-running live smoke — the write lock is being held through the smoke`);
        }

        const result = await rebuildPromise;
        api.say(`r00 rebuildClone finished: moved=${result.moved} adopted=${result.adopted} reason=${result.reason ?? ''}`);
        if (!result.adopted) {
          api.violation('rebuild-not-adopted', `rebuildClone did not adopt the new main after a passing smoke: ${JSON.stringify(result)}`);
        }
      },
    });
    return report;
  },
  judge(report) {
    return report.violations
      .filter((v) => ['writer-active-during-smoke', 'rebuild-not-adopted', 'crash'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
