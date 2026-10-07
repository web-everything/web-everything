/**
 * @file breaks/daemon-version-switch-mid-tick.mjs — card 89 S5. Before versioned daemon checkouts, a clone rebuild
 * rewrote the tree a 10-minute tick was reading, so rebuilds and ticks took turns on a lock and starved each other
 * (live: `read lock refused|starved|tick-in-progress|concurrent-mover`). A versioned clone switches an atomic
 * `current` pointer instead: the tick that is running finishes on the folder it started on (pinned), and the NEXT
 * tick runs the new one. Neither side ever takes the clone's read or write lock.
 *
 * Scenario (in-process, virtual time — the tick is "10 minutes" because it is held on a gate, not on a timer):
 * a tick starts on version v1, a switch to v2 lands while it is held, the tick finishes, then a second tick runs.
 * Violations: the held tick saw a different folder after the switch, the next tick did not run v2, a pin leaked,
 * or the read lock was acquired at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TREE = fileURLToPath(new URL('../../../..', import.meta.url));

export default {
  id: 'daemon-version-switch-mid-tick',
  title: 'a rebuild moving a daemon clone mid-tick (lock fight) instead of a versioned atomic switch the running tick never sees',
  card: 'we:backlog/89 S5',
  fixedBy: { sha: 'card-89-s5', where: 'lane/card-89-s5', paths: ['scripts/lib/daemon-version-runtime.mjs', 'scripts/lib/daemon-self-sync.mjs'] },
  fixPresent(root) {
    try {
      return existsSync(join(root, 'scripts/lib/daemon-version-runtime.mjs'))
        && /versionedTick/.test(readFileSync(join(root, 'scripts/lib/daemon-self-sync.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run() {
    const violations = [];
    const v = (invariant, detail) => violations.push({ invariant, detail, daemon: 'soak', tick: 0 });
    let withSelfSync;
    try { ({ withSelfSync } = await import(join(TREE, 'scripts/lib/daemon-self-sync.mjs'))); } catch (e) { v('crash', String(e?.message ?? e)); return { violations }; }
    const tickContext = {};
    const pins = [];
    let reads = 0;
    let cur = { id: 'v1', dir: '/h/d/versions/v1', sha: 'a' };
    const seen = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    let first = true;
    const w = withSelfSync({
      tickOnce: async () => {
        seen.push(tickContext.tickRoot);
        if (first) { first = false; await gate; seen.push(tickContext.tickRoot); }
        return 'ok';
      },
    }, {
      root: '/h/d/versions/v1', env: {}, onRestart: () => 'restarted', log: { error() {} }, tickContext,
      versions: { name: 'd', clone: '/ws/d', home: '/h', dir: '/h/d', settings: {} },
      versionApi: { currentVersion: () => cur, pin: async ({ id }) => { pins.push(id); return { status: 'pinned' }; }, unpin: async ({ id }) => pins.splice(pins.indexOf(id), 1) },
      rebuild: async () => ({ moved: false, reason: 'up-to-date' }), readHead: () => 'a',
      acquireRead: () => { reads += 1; return { ok: true }; }, releaseRead() {}, readState: () => ({}),
      importClosure: () => new Set(), diffFiles: () => [], entries: ['/h/d/versions/v1/x.mjs'],
    });
    if (!w || typeof w.tickOnce !== 'function') { v('crash', 'withSelfSync returned no tickOnce'); return { violations }; }
    const running = w.tickOnce();
    while (seen.length < 1) await new Promise((r) => { setImmediate(r); });
    cur = { id: 'v2', dir: '/h/d/versions/v2', sha: 'b' }; // the switch lands mid-tick
    release();
    await running;
    if (seen[0] !== '/h/d/versions/v1' || seen[1] !== '/h/d/versions/v1') v('tick-saw-switch', `the running tick saw ${seen.join(' then ')}; it must finish on v1`);
    await w.tickOnce();
    if (seen[2] !== '/h/d/versions/v2') v('next-tick-stale', `the next tick ran from ${seen[2]}; it must run the new version v2`);
    if (pins.length) v('pin-leaked', `pins left behind: ${pins.join(',')}`);
    if (reads) v('read-lock-taken', `the versioned path acquired the clone read lock ${reads} time(s)`);
    return { violations };
  },
  judge(report) {
    return report.violations.map((x) => `${x.daemon} tick ${x.tick}: [${x.invariant}] ${x.detail}`);
  },
};
