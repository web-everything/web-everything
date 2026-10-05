/**
 * @file breaks/rebuild-finalize-starved.mjs — live break, 2026-09-26 on `wev-review-daemon` (#4044 follow-up,
 * lane fix-rebuild-finalize). The review daemon and the fix daemon share one clone. A rebuild smokes its candidate
 * OFF the lock (4218, 1-4 min live), so the sibling daemon starts a tick (takes a read slot) meanwhile; the
 * finalize then waits 60s for that tick, gives up — "could not take the write lock to finalize <sha> after a
 * passing smoke (reader Mac:<pid> still ticking) — retrying next tick" — and THROWS THE PASS AWAY. The next tick
 * re-plans (main moved: a new candidate sha), re-smokes, and the sibling starts another tick during that smoke.
 * The build lease the failed finalize left on disk also made the sibling log "rebuild-in-progress" for up to 20
 * min. Net: registered overlay fixes (including the fix for the slow review tick) were never adopted.
 *
 * Fix: a passing smoke is recorded as the clone's READY candidate before the finalize lock is tried; the next
 * write-lock holder (a later tick of the mover, or the sibling at its own tick boundary) adopts it without
 * re-smoking, as long as it was verified on the clone's current head (`daemon-rebuild.mjs#matchReadyCandidate`).
 *
 * Scenario: real `rebuildClone` from the tree under test, three rounds. Each round main moves (the live churn),
 * and the injected smoke passes while a "sibling daemon" takes a REAL read slot on the same clone — its long tick
 * — which it holds until the round's rebuild returns (its tick boundary). FIXED: by round 2 the clone adopts a
 * smoke-verified build. PRE-fix: every round smokes a new sha, every finalize is starved, nothing is ever adopted.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';
import { rebuildMechanismSource } from '../rebuild-mechanism-source.mjs';

const ROUNDS = 3;

export default {
  id: 'rebuild-finalize-starved',
  title: 'a reader with long ticks never let a passing rebuild candidate finalize — every pass was thrown away and re-smoked, so overlay fixes were never adopted',
  card: 'lane/fix-rebuild-finalize (#4044 follow-up, epic #4075/#3383)',
  fixedBy: {
    sha: 'fix-rebuild-finalize',
    where: 'lane/fix-rebuild-finalize',
    paths: ['scripts/lib/daemon-rebuild.mjs'],
  },
  fixPresent(root) {
    try {
      return /readReadyCandidate/.test(rebuildMechanismSource(root));
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:rebuild-finalize-starved',
      rounds: ROUNDS,
      daemons: [], // drives `rebuildClone` directly (see perRound) — no daemon tick loop needed.
      mainEvery: 0,
      fleet: false,
      log,
      setup(w) {
        // Never touch the real ~/.claude/daemon-clone-locks from a soak run; short waits stand in for the live 60s.
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
        w.env.WE_DAEMON_REBUILD_LOCK_WAIT_MS = '800';
        w.env.WE_DAEMON_FINALIZE_LOCK_WAIT_MS = '800';
        return { adoptedAt: null, smokes: 0 };
      },
      async perRound(w, round, ctx, api) {
        const rebuildModulePath = join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs');
        if (!existsSync(rebuildModulePath)) throw new Error('rebuild-finalize-starved: scripts/lib/daemon-rebuild.mjs not present on this tree');
        const { rebuildClone } = await import(pathToFileURL(rebuildModulePath).href);
        const { acquireRead, releaseRead } = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-clone-lock.mjs')).href);
        const sibling = { lockRoot: w.env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'sim-sibling-daemon' };

        if (ctx.adoptedAt !== null) return;
        api.moveMain(w, { [`soak/rebuild-finalize-starved-${round}.md`]: `# round ${round}\n` }, `soak: main moves (round ${round})`);

        const runSmoke = async () => {
          ctx.smokes += 1;
          acquireRead(w.simCloneRoot, sibling); // the sibling daemon starts its (long) tick during the smoke
          return { verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'sim-smoke', ok: true, ms: 1 }] } };
        };
        let result;
        try {
          result = await rebuildClone({
            root: w.simCloneRoot, env: w.env, runSmoke, prState: async () => null, log: { error() {}, log() {} },
          });
        } finally {
          releaseRead(w.simCloneRoot, sibling); // the sibling's tick boundary
        }
        api.say(`r${String(round).padStart(2, '0')} rebuild: moved=${!!result.moved} adopted=${!!result.adopted} reason=${result.reason ?? ''} (smokes so far ${ctx.smokes})`);
        if (result.adopted && result.moved) ctx.adoptedAt = round;
        if (round === ROUNDS - 1 && ctx.adoptedAt === null) {
          api.violation('passing-candidate-never-adopted', `${ctx.smokes} passing smoke(s) over ${ROUNDS} rounds, none adopted — every finalize was starved by the sibling's tick and the pass was thrown away`);
        }
      },
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => ['passing-candidate-never-adopted', 'crash'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
