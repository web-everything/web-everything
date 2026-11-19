/** Decided red-team heads must leave the durable queue despite stale planner candidates. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/lib/red-team-dispatch-queue.mjs';
export default {
  id: 'red-team-queue-verdict-evict',
  title: 'decided red-team heads stay evicted while older and unreadable verdicts stay queued',
  card: 'red-team queue verdict eviction',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [PATH] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import b from ${JSON.stringify(import.meta.url)}; const r = await b.run({ sourceRoot: ${JSON.stringify(root)} }); process.exit(b.judge(r).length ? 1 : 0);`],
    { timeout: 15000, maxBuffer: 65536, encoding: 'utf8', env: { ...process.env, WE_UNDER_TEST: '1' } });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const { createRedTeamDispatchQueue, runWithRedTeamQueue } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
      const repo = 'example/project', head = 'a'.repeat(40), next = 'b'.repeat(40), file = 'queue.json';
      const files = new Map(), logs = [];
      const candidates = [1, 2, 3, 4, 5].map(pr => ({ pr, head }));
      const result = (pr, blocked) => ({ author: { login: 'web-everything' },
        body: `<!-- we:red-team-advisory pr=${pr} rev=${head} -->
Advisory only: recorded result · recorded verdict \`${blocked ? 'changes' : 'accept'}\`.
${blocked ? '1. [**confirmed**] (edge-case, broken) `src/example.mjs:1` — Fix required.' : 'The red team tried to break this change and reported nothing.'}` });
      const readLivePr = ({ pr }) => ({ state: 'OPEN', headRefOid: pr === 3 ? next : head,
        comments: pr === 4 ? null : pr <= 3 ? [result(pr, pr === 2)] : [] });
      const open = () => createRedTeamDispatchQueue({ file, now: () => 1_000_000, readLivePr,
        log: line => logs.push(line),
        readFile: path => {
          if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return files.get(path);
        },
        writeFile: (path, data) => files.set(path, data),
        rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
        unlink: path => files.delete(path),
      });
      open().sync(repo, candidates);
      for (let tick = 0; tick < 3; tick++) {
        const queue = open();
        queue.reconcile();
        queue.sync(repo, candidates); // Stale candidates must never revive a decided head.
        const entries = open().entries();
        check(JSON.stringify(entries.map(entry => entry.pr)) === '[3,4,5]', `tick ${tick}: wrong durable survivors`);
        check(entries.find(entry => entry.pr === 3)?.head === next, `tick ${tick}: older verdict prevented head re-key`);
        await runWithRedTeamQueue({ queue, repo,
          plan: { refusals: candidates.map(({ pr }) => ({ prNumber: pr, kind: 'already-reviewed-head', headSha: head })) },
          rawPrs: candidates.map(({ pr }) => ({ number: pr, headRefOid: head })),
          capacity: { lanes: 1 }, readNetFiles: () => ({ ok: false }),
          run: options => {
            check(JSON.stringify(options.plan.refusals.map(row => row.prNumber)) === '[5]', `tick ${tick}: decided or unreadable head dispatched`);
            return { rows: [], dispatched: [], notStarted: [] };
          },
        });
      }
      check(logs.some(line => line.includes('remove example/project#1: red-team result already on head')), 'clear eviction missing reason');
      check(logs.some(line => line.includes('remove example/project#2: red-team result already on head')), 'blocked eviction missing reason');
      check(logs.some(line => line.includes('red-team verdict evidence unreadable')), 'unreadable verdict missing log');
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
