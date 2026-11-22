/** BLOCKED must expose the failed required check and its gate finding. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = `
const m = await import(process.argv[1]);
const pr = { statusCheckRollup: [{ __typename: 'CheckRun', name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', summary: '\\n test-gaming\\nsecond line' }] };
console.log(JSON.stringify(m.describeBlockedChecks(pr, ['merge-gate'])));
`;
function probe(root) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE,
    pathToFileURL(join(root, 'scripts/lib/drain-blocked-reason.mjs')).href],
  { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return null; }
}
export default {
  id: 'drain-blocked-reason-names-failed-check',
  title: 'The drain hides the failed required check behind merge state BLOCKED',
  card: 'BLOCKED names the required check and first gate finding',
  fixedBy: { sha: 'pending', where: 'lane/drain-blocked-reason', paths: ['scripts/lib/drain-blocked-reason.mjs', 'scripts/merge-ai-prs.mjs'] },
  fixPresent(root) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { classifySkipReason } = await import(process.argv[1]); process.exit(classifySkipReason('merge state BLOCKED; required check "merge-gate" FAILURE') === 'checks-failed' ? 0 : 1);`,
      pathToFileURL(join(root, 'scripts/lib/drain-skip-reasons.mjs')).href],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    return !result.error && result.status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const p = probe(root);
    return { violations: p?.text === 'required check "merge-gate" FAILURE: test-gaming'
      && p.failed?.length === 1 && p.waiting?.length === 0 ? [] : ['BLOCKED does not name merge-gate FAILURE and its first summary line'] };
  },
  judge(report) { return report.violations; },
};
