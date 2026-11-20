/** Replay terminal eviction, live-head re-keying, and rollback across restarts. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/lib/red-team-dispatch-queue.mjs';
export default {
  id: 'red-team-queue-stale-eviction',
  title: 'terminal red-team PRs stay evicted and live-head changes roll back on runner failure',
  card: 'red-team queue stale-eviction regression',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [PATH, 'skills-src/conveyor/review-daemon.mjs'] },
  fixPresent: () => true,
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const repo = 'example/project', head = 'a'.repeat(40), file = 'queue.json';
    const files = new Map();
    const candidates = [1, 2, 3, 4, 5, 6, 7, 8].map(pr => ({ pr, head }));
    try {
      const { createRedTeamDispatchQueue, runWithRedTeamQueue } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
      const open = () => createRedTeamDispatchQueue({ file, now: () => 1_000_000,
        readFile: path => {
          if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return files.get(path);
        },
        writeFile: (path, data) => files.set(path, data),
        rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
        unlink: path => files.delete(path),
        readLivePr: ({ pr }) => ({ state: pr === 7 ? 'MERGED' : pr === 8 ? 'CLOSED' : 'OPEN', comments: [], headRefOid: head }),
      });
      const queue = open();
      queue.sync(repo, candidates);
      queue.admit(repo, 8);
      queue.settle(repo, { rows: candidates.map(({ pr }) => ({ prNumber: pr, action: 'skip', why: 'superseded acceptance' })) });
      const resumed = open();
      resumed.reconcile({ candidates: candidates.map(candidate => ({ ...candidate, repo })) });
      resumed.sync(repo, candidates); // Stale planner still offers terminal PRs.
      check(open().entries().length === 6 && open().entries().every(entry => entry.pr < 7),
        'terminal PR survived maintenance or was re-enqueued from stale candidates');
      const changed = open();
      changed.reconcile({ readLivePr: ({ pr }) => ({ state: 'OPEN', comments: [], headRefOid: pr === 2 ? 'c'.repeat(40) : head }) });
      const rekeyed = open().entries();
      check(rekeyed[1]?.pr === 2 && rekeyed[1].head === 'c'.repeat(40)
        && rekeyed[1].attempts === 0 && rekeyed[1].blocked === undefined,
        'live-head re-key failed to preserve position and reset attempts/block across restart');
      const remaining = open();
      const before = remaining.entries(), persisted = files.get(file), error = new Error('runner failed');
      let caught;
      try {
        await runWithRedTeamQueue({ queue: remaining, repo,
          plan: { refusals: candidates.map(({ pr }) => ({ prNumber: pr, kind: 'already-reviewed-head', headSha: head })) },
          capacity: { lanes: 1 }, readNetFiles: () => ({ ok: false }),
          readLivePr: ({ pr }) => ({ state: pr === 1 ? 'MERGED' : 'OPEN', comments: [], headRefOid: 'b'.repeat(40) }),
          run: async () => { throw error; },
        });
      } catch (failure) { caught = failure; }
      check(caught === error, 'wrapper did not propagate the runner failure');
      check(JSON.stringify(remaining.entries()) === JSON.stringify(before) && files.get(file) === persisted,
        'thrown wrapper runner failed to roll back reconcile head changes and terminal eviction');
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
