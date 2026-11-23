/** Repeated CI-heal ticks must yield to a rebuild's first live writer claim. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

// Exercise the tree under test, rather than inferring fix presence from source text.
export async function probeReaderYield(sourceRoot, root, lockRoot) {
  const locks = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/daemon-clone-lock.mjs')).href);
  const { runCiHealLoopIteration } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/ci-heal-loop.mjs')).href);
  const reader = { lockRoot, owner: locks.defaultOwner(), probe: () => 'alive' };
  const writer = { ...reader, owner: locks.defaultOwner(process.ppid), pid: process.ppid, waitMs: 0, writerPriorityAfter: 1 };
  let reads = 0;
  const previousLockRoot = process.env.WE_DAEMON_CLONE_LOCK_ROOT;
  process.env.WE_DAEMON_CLONE_LOCK_ROOT = lockRoot;
  try {
    if (!locks.acquireRead(root, reader).ok) throw new Error('probe reader not admitted');
    const refused = await locks.acquireWrite(root, writer);
    if (refused.reason !== 'tick-in-progress' || locks.inspectCloneLock(root, reader).writerClaim?.count !== 1) {
      throw new Error('probe did not create a first writer claim');
    }
    locks.releaseRead(root, reader);
    const result = await runCiHealLoopIteration({
      root,
      locks: {
        acquireRead: () => { reads++; return locks.acquireRead(root, { ...reader, writerPriorityAfter: 0 }); },
        releaseRead: () => locks.releaseRead(root, reader), heartbeatRead() {},
      },
      lock: { reserve: () => ({ ok: true }), release() {}, heartbeat() {} },
      dispatchBlock: () => null, ensureAuth() {}, tick: async () => ({}), write() {},
    });
    return result?.exit === 'rebuild-pending' && reads === 0
      && locks.inspectCloneLock(root, reader).readers.length === 0;
  } finally {
    locks.releaseRead(root, reader);
    locks.releaseWrite(root, writer);
    if (previousLockRoot === undefined) delete process.env.WE_DAEMON_CLONE_LOCK_ROOT;
    else process.env.WE_DAEMON_CLONE_LOCK_ROOT = previousLockRoot;
  }
}

export default {
  id: 'rebuild-reader-never-yields',
  title: 'CI-heal yields at its tick boundary after a rebuild gives up on a reader',
  card: 'rebuild reader never yields',
  fixedBy: {
    sha: 'rebuild-reader-never-yields', where: 'reader tick boundary',
    paths: ['scripts/conveyor/ci-heal-loop.mjs', 'scripts/lib/daemon-clone-lock.mjs'],
  },
  fixPresent(root) {
    const temp = mkdtempSync(join(process.env.TMPDIR, 'rebuild-reader-probe-'));
    try {
      const code = `import { probeReaderYield } from ${JSON.stringify(import.meta.url)};
        import { join } from 'node:path';
        process.exit(await probeReaderYield(process.argv[1], join(process.argv[2], 'clone'), join(process.argv[2], 'locks')) ? 0 : 1);`;
      return spawnSync(process.execPath, ['--input-type=module', '-e', code, root, temp], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      }).status === 0;
    }
    catch { return false; }
    finally { rmSync(temp, { recursive: true, force: true }); }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:rebuild-reader-never-yields', rounds: 2, daemons: [], mainEvery: 0, fleet: false, log,
      async perRound(w, round, ctx, api) {
        if (!await probeReaderYield(w.simCloneRoot, w.simCloneRoot, join(w.root, `reader-locks-${round}`))) {
          api.violation('reader-never-yields', 'CI-heal acquired a new read slot despite a live foreign rebuild claim');
        }
      },
    });
  },
  judge: report => report.violations.filter(v => ['reader-never-yields', 'crash', 'bounded', 'isolation'].includes(v.invariant))
    .map(v => `${v.invariant}: ${v.detail}`),
};
