/** Replay maintenance against stale planner candidates and bounded cooldown probes across restarts. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/lib/red-team-dispatch-queue.mjs';
export default {
  id: 'red-team-queue-stale-eviction',
  title: 'terminal red-team PRs stay evicted while planner skips retain bounded probes until replan',
  card: 'red-team queue stale-eviction regression',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [PATH, 'skills-src/conveyor/review-daemon.mjs'] },
  fixPresent: () => true,
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const repo = 'example/project', head = 'a'.repeat(40), file = 'queue.json';
    const files = new Map(), logs = [];
    let at = 1_000_000;
    const candidates = [1, 2, 3, 4, 5, 6].map(pr => ({ pr, head }));
    try {
      const { createRedTeamDispatchQueue } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
      const open = () => createRedTeamDispatchQueue({ file, now: () => at,
        readFile: path => {
          if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return files.get(path);
        },
        writeFile: (path, data) => files.set(path, data),
        rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
        unlink: path => files.delete(path), log: line => logs.push(line),
        readLivePr: ({ pr }) => ({ state: pr === 6 ? 'MERGED' : 'OPEN', headRefOid: head }),
      });
      const queue = open();
      queue.sync(repo, candidates);
      queue.admit(repo, 6);
      queue.settle(repo, { rows: candidates.map(({ pr }) => ({ prNumber: pr, action: 'skip', why: 'superseded acceptance' })) });
      const seen = new Set();
      for (let tick = 0; tick < 3; tick++) {
        const resumed = open();
        resumed.reconcile({ plannerSkipReplanMinutes: 20,
          candidates: candidates.map(candidate => ({ ...candidate, repo })) });
        resumed.sync(repo, candidates); // Stale planner still offers the merged PR.
        check(resumed.entries().length === 5 && resumed.entries().every(entry => entry.pr !== 6),
          'merged PR survived maintenance or was re-enqueued from stale candidates');
        const probes = resumed.admit(repo, 0);
        check(probes.length === 2 && probes.every(entry => entry.blocked === 'planner-skip'),
          'cooldown must admit exactly two worker-free probes with zero runnable capacity');
        probes.forEach(entry => seen.add(entry.pr));
        check(open().entries().every(entry => entry.attempts === 1),
          'admission or restart changed attempts without settlement');
        at += 1_000;
      }
      check(seen.size === 5, 'bounded probes starved a persisted planner skip across restarts');
      at = 1_000_000 + 20 * 60_000;
      const expired = open();
      expired.reconcile({ plannerSkipReplanMinutes: 20 });
      check(expired.entries().every(entry => entry.blocked === undefined && entry.blockedAt === undefined
        && entry.attempts === 1), 'replan did not unblock all entries while preserving attempts');
      check(expired.admit(repo, 0).length === 0, 'replanned runnable entries bypassed zero capacity');
      check(expired.admit(repo, 1).map(entry => entry.pr).join() === '1', 'replan lost FIFO capacity-one admission');
      check(logs.filter(line => line.includes('replan ')).length === 5, 'replan did not log exactly one unblock per entry');
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
