/** Reproduce aged planner skips without invoking the review planner at all. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/lib/red-team-queue-drain.mjs';
export default {
  id: 'red-team-queue-drain',
  title: 'aged planner skips drain independently in age order within live capacity',
  card: 'independent red-team queue drain',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [PATH, 'skills-src/conveyor/review-daemon.mjs'] },
  fixPresent(sourceRoot = ROOT) {
    // Run the behaviour in native Node: existence or a source token cannot prove admission works.
    const script = `import scenario from ${JSON.stringify(import.meta.url)};
      const report = await scenario.run({ sourceRoot: ${JSON.stringify(sourceRoot)} });
      process.exit(report.violations.length ? 1 : 0);`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: sourceRoot, env: { ...process.env, WE_UNDER_TEST: '1' }, timeout: 15_000, maxBuffer: 65536,
    }).status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { drainRedTeamQueue } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
      const { createRedTeamDispatchQueue, runWithRedTeamQueue } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/red-team-dispatch-queue.mjs')).href);
      const { runRedTeamOnSkip } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-red-team-on-skip.mjs')).href);
      const now = 100_000_000, repo = 'example/project', head = 'a'.repeat(40);
      let stored = JSON.stringify([1, 2, 3].map(pr => ({ key: `${repo}#${pr}`, repo, pr, head,
        enqueuedAt: now - pr * 120 * 60_000, attempts: 2, blocked: 'planner-skip' })));
      const queue = createRedTeamDispatchQueue({ file: 'memory', readFile: () => stored, now: () => now,
        writeFile: (_path, value) => { stored = value; }, rename: () => {}, unlink: () => {} });
      const starts = [], alerts = [];
      const capacity = () => ({ lanes: 10, remainingStarts: 10, startsCeiling: 10,
        budget: { live: 2, max: 10, left: 8 } });
      const options = { queue, now: () => now,
        readPrs: () => [1, 2, 3].map(number => ({ number, headRefOid: head, isDraft: false, labels: [], comments: [] })),
        capacity: capacity(), alert: event => alerts.push(event),
        runQueue: input => runWithRedTeamQueue({ ...input, queue,
          floor: { minConcurrent: 3, idlePct: 10 }, readCpuIdlePct: () => 100,
          readLivePr: () => ({ state: 'OPEN', isDraft: false, headRefOid: head }),
          readNetFiles: () => ({ ok: false }),
          run: options => runRedTeamOnSkip({ ...options, now: () => now,
            setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(),
            readEvidence: () => ({ recorded: false, loopPayload: { verdict: { verdict: 'accept' },
              findings: { read: { netBasis: { rev: head } } } } }),
            readStatus: () => null, readWitness: null, readReviewRuns: () => [], syncLabels: () => {},
            dispatch: ({ pr }) => { starts.push(pr); return { jobPid: 1000 + pr }; },
          }),
        }),
      };
      await drainRedTeamQueue(options);
      if (JSON.stringify(starts) !== '[3]') violations.push('oldest skipped entry did not start alone within capacity');
      if (queue.entries().length !== 2) violations.push('dispatch did not settle the shared queue');
      await drainRedTeamQueue({ ...options, capacity: { ...capacity(), budget: { live: 3, max: 10, left: 7 } } });
      if (JSON.stringify(starts) !== '[3]') violations.push('full floor dispatched an extra job');
      if (alerts.length !== 3) violations.push('age alerts missing or repeated for a key/head');
    } catch (error) { violations.push(`scenario failed: ${error.message}`); }
    return { violations };
  },
  judge: report => report.violations,
};
