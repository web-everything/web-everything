/**
 * @file breaks/clone-reader-starved.mjs — live break, 2026-10-05 20:18-20:37 ET on `wev-review-daemon`. The review
 * and fix-dispatch daemons share one clone. Each tick starts with a rebuild that reserves the clone's WRITER and then
 * waits (60s, 180s, 900s when "starved", 900s for the overlay loader) for the other's in-flight tick to drain; a
 * waiting writer refuses every NEW read. Main moved every few minutes, so a writer was almost always reserved when
 * the review daemon's tick began: `review-daemon: tick skipped (writer-active) — no repo was read this tick` 11
 * times in a row, and CI-green PRs #4016/#3990 got no review. Nothing tracked the refused reader, so nothing ever
 * yielded to it.
 *
 * Fix: reader fairness in `daemon-clone-lock.mjs` — a refused reader records a starvation claim; once refused
 * `WE_DAEMON_CLONE_LOCK_READER_PRIORITY_AFTER` (default 3) times in a row, a writer still DRAINING (nothing moved
 * yet) backs off with `reader-priority` and no new writer reserves until the reader gets in.
 *
 * Scenario: the REAL lock module from the tree under test, on a scratch lock root. A sibling's long tick holds a
 * read slot throughout; each round a mover reserves the writer and waits for it (short waits stand in for 60s);
 * the review reader tries its read once per round, while the mover is draining. FIXED: the reader gets in within a
 * few rounds. PRE-fix: refused every round — `reader-starved`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

const ROUNDS = 6;

export default {
  id: 'clone-reader-starved',
  title: 'rebuild writers kept re-reserving the shared clone, so the review daemon skipped every tick (writer-active) and CI-green PRs got no review',
  card: 'lane/fix-clone-rebuild-starvation (#4044 follow-up, epic #4075/#3383)',
  fixedBy: {
    sha: 'fix-clone-rebuild-starvation',
    where: 'lane/fix-clone-rebuild-starvation',
    paths: ['scripts/lib/daemon-clone-lock.mjs'],
  },
  fixPresent(root) {
    try {
      return /reader-priority/.test(readFileSync(join(root, 'scripts/lib/daemon-clone-lock.mjs'), 'utf8'));
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:clone-reader-starved',
      rounds: ROUNDS,
      daemons: [], // drives the lock directly (see perRound) — no daemon tick loop needed.
      mainEvery: 0,
      fleet: false,
      log,
      setup(w) {
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock'); // never the real ~/.claude/daemon-clone-locks
        return { readerInAt: null, refusals: 0 };
      },
      async perRound(w, round, ctx, api) {
        if (ctx.readerInAt !== null) return;
        const lock = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-clone-lock.mjs')).href);
        const lockRoot = w.env.WE_DAEMON_CLONE_LOCK_ROOT;
        if (round === 0) lock.acquireRead(w.simCloneRoot, { lockRoot, owner: 'sim-sibling-long-tick' });
        let tried = false;
        const readerTry = () => {
          tried = true;
          const r = lock.acquireRead(w.simCloneRoot, { lockRoot, owner: 'sim-review-daemon', readerKey: 'reader:review-daemon.mjs' });
          if (r.ok) {
            ctx.readerInAt = round;
            lock.releaseRead(w.simCloneRoot, { lockRoot, owner: 'sim-review-daemon' });
          } else ctx.refusals += 1;
          return r;
        };
        const w8 = await lock.acquireWrite(w.simCloneRoot, {
          lockRoot, owner: 'sim-rebuild-mover', waitMs: 300, pollMs: 50,
          sleep: async (ms) => { await new Promise((res) => setTimeout(res, ms)); if (!tried) readerTry(); },
        });
        if (w8.ok) lock.releaseWrite(w.simCloneRoot, { lockRoot, owner: 'sim-rebuild-mover' });
        if (!tried) readerTry();
        api.say(`r${String(round).padStart(2, '0')} mover: ${w8.ok ? 'moved' : w8.reason}; review reader ${ctx.readerInAt === round ? 'READ' : `refused (${ctx.refusals} in a row)`}`);
        if (round === ROUNDS - 1 && ctx.readerInAt === null) {
          api.violation('reader-starved', `the review reader was refused ${ctx.refusals} consecutive time(s) over ${ROUNDS} rounds — no tick ever read the clone`);
        }
      },
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => ['reader-starved', 'crash'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
