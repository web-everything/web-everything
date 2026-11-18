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
      const { createRedTeamDispatchQueue, runWithRedTeamQueue } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
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
      runWithRedTeamQueue({ queue: expired, repo,
        plan: { refusals: candidates.map(({ pr }) => ({ prNumber: pr, kind: 'already-reviewed-head', headSha: head })) },
        rawPrs: candidates.map(({ pr }) => ({ number: pr, headRefOid: head })),
        capacity: { lanes: 5, remainingStarts: 0, budget: { left: 5 } },
        floor: { plannerSkipReplanMinutes: 20 }, readNetFiles: () => ({ ok: false }),
        run: options => {
          check(options.plan.refusals.map(row => row.prNumber).join() === '1,2',
            'wrapper bypassed the two-probe bound with expired skips and exhausted capacity');
          check(options.rawPrs.map(pr => pr.number).join() === '1,2',
            'wrapper exposed held planner skips through raw PRs');
          return { notStarted: options.plan.refusals.map(row => ({ prNumber: row.prNumber, reason: 'no review capacity left' })) };
        },
      });
      check(open().entries().filter(entry => entry.blocked === 'planner-skip').length === 3,
        'wrapper must keep the remaining expired skips blocked and probe-eligible');
      check(logs.filter(line => line.includes('replan ')).length === 2,
        'wrapper replanned more than two expired skips in one reconciliation');
      const remaining = open();
      remaining.reconcile({ plannerSkipReplanMinutes: 20 });
      check(remaining.entries().filter(entry => entry.blocked === 'planner-skip').length === 1,
        'next reconciliation did not replan exactly two more expired skips');
      remaining.reconcile({ plannerSkipReplanMinutes: 20 });
      check(remaining.entries().every(entry => entry.blocked === undefined && entry.blockedAt === undefined
        && entry.attempts === 1), 'bounded replan did not eventually unblock all entries while preserving attempts');
      check(remaining.admit(repo, 0).length === 0, 'replanned runnable entries bypassed zero capacity');
      check(remaining.admit(repo, 1).map(entry => entry.pr).join() === '1', 'replan lost FIFO capacity-one admission');
      check(logs.filter(line => line.includes('replan ')).length === 5, 'replan did not log exactly one unblock per entry');
      const before = remaining.entries(), persisted = files.get(file), error = new Error('runner failed');
      let caught;
      try {
        await runWithRedTeamQueue({ queue: remaining, repo,
          plan: { refusals: candidates.map(({ pr }) => ({ prNumber: pr, kind: 'already-reviewed-head', headSha: head })) },
          capacity: { lanes: 1 }, readNetFiles: () => ({ ok: false }),
          readLivePr: ({ pr }) => ({ state: pr === 1 ? 'MERGED' : 'OPEN', headRefOid: 'b'.repeat(40) }),
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
