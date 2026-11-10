/**
 * @file breaks/daemon-clone-lock-writer-wait-priority.mjs — a writer waiting for the daemon clone lock was
 * displaced by a steady reader stream. While the writer drains one held reader, each fresh reader is refused
 * `writer-active` and, after 3 refusals, claims reader-starvation priority; the writer then backed off
 * `reader-priority` and never moved the clone, however long it had waited.
 *
 * Fix (opt-in, default off): with `WE_DAEMON_CLONE_LOCK_WRITER_WAIT_PRIORITY_MS` above 0, a writer that has waited
 * past that window stops yielding to readers that began starving after its wait began (bounded to a 5 minute
 * window; held reader locks are never broken).
 *
 * Scenario: the REAL lock module from the tree under test, fake clock, a mkdtemp lock root. Reader R holds a slot
 * until t=100s; a fresh reader arrives every 5s and keeps retrying. The writer must acquire once R drains.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

const WINDOW_MS = 8000;

export default {
  id: 'daemon-clone-lock-writer-wait-priority',
  title: 'a writer waiting on the clone lock was displaced by a steady stream of starving readers and never acquired it',
  card: 'lane/clone-lock-writer-priority (focus #22 part 2)',
  fixedBy: {
    sha: 'clone-lock-writer-priority',
    where: 'lane/clone-lock-writer-priority',
    paths: ['scripts/lib/daemon-clone-lock.mjs'],
  },
  fixPresent(root) {
    try {
      return /WE_DAEMON_CLONE_LOCK_WRITER_WAIT_PRIORITY_MS/.test(readFileSync(join(root, 'scripts/lib/daemon-clone-lock.mjs'), 'utf8'));
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:daemon-clone-lock-writer-wait-priority',
      rounds: 1,
      daemons: [],
      mainEvery: 0,
      fleet: false,
      log,
      setup() { return {}; },
      async perRound(w, round, ctx, api) {
        const lock = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-clone-lock.mjs')).href);
        const lockRoot = mkdtempSync(join(tmpdir(), 'soak-clone-lock-'));
        const common = { lockRoot, probe: () => 'alive', leaseMinutes: 1e9, writerClaimTtlMs: 1e12, readerPriorityAfter: 3 };
        const clone = w.simCloneRoot;
        let t = 0;
        lock.acquireRead(clone, { ...common, owner: 'R', readerKey: 'R', nowMs: t });
        let rHeld = true;
        let n = 0;
        const active = [];
        const step = () => {
          if (rHeld && t >= 100_000) { lock.releaseRead(clone, { lockRoot, owner: 'R' }); rHeld = false; }
          if (t % 5000 === 0) {
            n += 1;
            active.push(`S${n}`);
            for (const key of [...active]) {
              if (lock.acquireRead(clone, { ...common, owner: key, readerKey: key, nowMs: t }).ok) active.splice(active.indexOf(key), 1);
            }
          }
        };
        const res = await lock.acquireWrite(clone, {
          ...common, owner: 'W', waitMs: 600_000, pollMs: 1000, now: () => t,
          writerWaitPriorityMs: WINDOW_MS, // the opt-in window above 0 (the env setting on the branch)
          sleep: async (ms) => { t += ms; step(); },
        });
        api.say(`writer ok=${res.ok} reason=${res.reason ?? ''} waited=${t}ms`);
        if (!res.ok) api.violation('writer-displaced-by-reader-stream', `writer gave up ${res.reason} after ${t}ms under a reader stream with the wait-priority window set to ${WINDOW_MS}ms`);
      },
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => ['writer-displaced-by-reader-stream', 'crash'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
