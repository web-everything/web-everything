/** A parked draft must lose a stale red-team:pending label, and a non-draft must never lose it (never treated as clear). */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/lib/red-team-draft-pending-sweep.mjs';
export default {
  id: 'red-team-draft-stale-pending',
  title: 'stale pending leaves parked drafts only; ready, unknown-draft and blocked PRs keep their labels',
  card: 'REDTEAM-STUCK-PENDING',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [PATH] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import b from ${JSON.stringify(import.meta.url)}; const r = await b.run({ sourceRoot: ${JSON.stringify(root)} }); process.exit(b.judge(r).length ? 1 : 0);`],
    { timeout: 15000, maxBuffer: 65536, encoding: 'utf8', env: { ...process.env, WE_UNDER_TEST: '1' } });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { sweepDraftPendingLabels } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
      const head = 'a'.repeat(40), repo = 'example/project';
      const rows = [
        { number: 1, isDraft: true, headRefOid: head, labels: [{ name: 'red-team:pending' }] },
        { number: 2, isDraft: false, headRefOid: head, labels: [{ name: 'red-team:pending' }] },
        { number: 3, headRefOid: head, labels: [{ name: 'red-team:pending' }] },
        { number: 4, isDraft: true, headRefOid: head, labels: [{ name: 'red-team:pending' }, { name: 'red-team:blocked' }] },
      ];
      const writes = [];
      const provider = {
        readPrState: (_repo, pr) => ({ state: 'OPEN', isDraft: rows.find(row => row.number === pr).isDraft, headRefOid: head,
          labels: rows.find(row => row.number === pr).labels }),
        setLabels: (_repo, pr, change) => writes.push({ pr, change }),
      };
      sweepDraftPendingLabels({ repo, rawPrs: rows, provider });
      const prs = writes.map(write => write.pr);
      if (!prs.includes(1)) violations.push('parked draft kept its stale pending label');
      for (const pr of [2, 3]) if (prs.includes(pr)) violations.push(`PR ${pr} lost pending without a confirmed draft`);
      if (writes.some(write => write.change.add)) violations.push('sweep added a label (clear must never be granted)');
      if (writes.some(write => write.pr === 4 && write.change.remove?.some(name => name !== 'red-team:pending'))) violations.push('sweep removed a non-pending label');
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
