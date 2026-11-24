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
      sweepDraftPendingLabels({ repo, rawPrs: rows, provider, hasRecordedRun: () => false });
      const prs = writes.map(write => write.pr);
      const only = write => !write.change.add && JSON.stringify(write.change.remove) === '["red-team:pending"]';
      if (!writes.some(write => write.pr === 1 && only(write))) violations.push('parked draft kept its stale pending label');
      for (const pr of [2, 3]) if (prs.includes(pr)) violations.push(`PR ${pr} lost pending without a confirmed draft`);
      if (writes.some(write => !only(write))) violations.push('sweep wrote something other than removing pending (clear must never be granted)');
      // A draft with a recorded or unreadable red-team run keeps its label.
      const kept = [];
      sweepDraftPendingLabels({ repo, rawPrs: rows.slice(0, 1), hasRecordedRun: () => true,
        provider: { ...provider, setLabels: (_r, pr) => kept.push(pr) } });
      if (kept.length) violations.push('draft with a recorded red-team run lost pending');
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
