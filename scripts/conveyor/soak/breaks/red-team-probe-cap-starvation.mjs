/** Persisted blocked red-team heads must all get a bounded probe turn. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/lib/red-team-dispatch-queue.mjs';
export function probeCapFixPresent(source) {
  return !/\b(?:const|let|var)\s+MAX_PROBES\s*=\s*2\b/.test(source)
    && /\.slice\(0,\s*maxProbeCount\)/.test(source)
    && /const\s+maxProbeCount\s*=\s*probeCap\(maxProbes,\s*log\)/.test(source)
    && /const\s+DEFAULT_MAX_PROBES\s*=\s*6\s*;/.test(source)
    && /const\s+MAX_PROBES_CEILING\s*=\s*50\s*;/.test(source);
}
export default {
  id: 'red-team-probe-cap-starvation',
  title: 'ten blocked red-team heads receive probe turns within two default ticks',
  card: 'red-team probe cap starvation regression',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [PATH] },
  fixPresent(root) {
    try { return probeCapFixPresent(readFileSync(join(root, PATH), 'utf8')); }
    catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const repo = 'example/project', head = 'a'.repeat(40), file = 'queue.json';
    const files = new Map([[file, JSON.stringify(Array.from({ length: 10 }, (_, i) => ({
      key: `${repo}#${i + 1}`, repo, pr: i + 1, head, enqueuedAt: 1, attempts: 0,
      blocked: i % 2 ? 'planner-skip' : 'review-unfinished',
    })))]]);
    try {
      const { createRedTeamDispatchQueue, runWithRedTeamQueue } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
      const open = () => createRedTeamDispatchQueue({ file,
        readFile: path => {
          if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return files.get(path);
        },
        writeFile: (path, data) => files.set(path, data),
        rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
        unlink: path => files.delete(path),
        readLivePr: () => ({ state: 'OPEN', headRefOid: head, comments: [] }),
      });
      const seen = new Set();
      for (let tick = 0; tick < 2; tick++) {
        const queue = open();
        const before = queue.entries();
        await runWithRedTeamQueue({ queue, repo,
          plan: { refusals: before.map(entry => ({ prNumber: entry.pr, kind: 'already-reviewed-head', headSha: entry.head })) },
          rawPrs: before.map(entry => ({ number: entry.pr, state: 'OPEN', headRefOid: entry.head })),
          capacity: { lanes: 0, remainingStarts: 0 }, readNetFiles: () => ({ ok: false }),
          run: ({ plan }) => {
            const ids = plan.refusals.map(row => row.prNumber);
            check(ids.length > 1 && ids.length <= 6, `tick ${tick}: expected multiple probes bounded at six, got ${ids.length}`);
            ids.forEach(pr => seen.add(pr));
            return { rows: ids.map(prNumber => ({ prNumber, action: 'skip', why: 'review-unfinished' })),
              dispatched: [], notStarted: ids.map(prNumber => ({ prNumber, reason: 'review-unfinished' })) };
          },
        });
        check(open().entries().length === 10, 'blocked entries did not survive restart');
      }
      check(seen.size === 10, `only ${seen.size} of ten blocked heads probed within two ticks`);
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
