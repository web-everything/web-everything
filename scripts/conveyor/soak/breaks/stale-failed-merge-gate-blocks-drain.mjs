/** 2026-11-19: #7106/#7117 stayed BLOCKED after clear-human; label toggles did not rerun merge-gate. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HELPER = 'scripts/lib/stale-gate-update-branch.mjs';
const head = 'a'.repeat(40);
export default {
  id: 'stale-failed-merge-gate-blocks-drain',
  title: 'cleared BLOCKED PRs need a pinned branch update to rerun stale-failed merge-gate',
  card: 'PR #7106 / #7117 (2026-11-19)',
  fixedBy: { sha: 'HEAD', where: 'HEAD', paths: [HELPER, 'scripts/merge-ai-prs.mjs'] },
  // Probe behaviour in the target checkout, rather than matching a function name or source string.
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { default: b } = await import(${JSON.stringify(import.meta.url)}); const r = await b.run({ sourceRoot: process.argv[1] }); process.exit(b.judge(r).length ? 1 : 0);`, root],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    return probe.status === 0;
  },
  async run({ sourceRoot = ROOT, updateBranches } = {}) {
    const violations = [];
    const stateRoot = mkdtempSync(join(tmpdir(), 'soak-stale-gate-'));
    try {
      const { isRequiredCheckGreen, refreshStaleBlockedGates, unlandableStateReason } = await import(pathToFileURL(join(sourceRoot, 'scripts/merge-ai-prs.mjs')).href);
      const update = updateBranches ?? (args => refreshStaleBlockedGates(args.candidates.map(c => ({
        repo: c.repo, num: c.num, headSha: c.head, decision: 'skip', reason: unlandableStateReason('BLOCKED'),
      })), args));
      const writes = [], logs = [];
      let conflict = false;
      const args = { candidates: [7106, 7117, 7118].map(num => ({ repo: 'example/widgets', num, head })),
        max: 2, stateRoot, defaultBranchOf: () => 'main', requiredChecksOf: () => ['test', 'merge-gate'],
        isRequiredCheckGreen, fixClaimHeld: () => false, humanSurfaceGuardAllows: () => true, log: line => logs.push(line),
        gh: (_bin, argv) => {
          if (argv[0] === 'pr') return JSON.stringify({ number: Number(argv[2]), headRefOid: head,
            baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
            labels: ['ready-to-merge', 'review:accepted', 'red-team:clear'].map(name => ({ name })),
            statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
          if (argv[1] === '-X') {
            writes.push(argv);
            if (conflict) throw new Error('422 merge conflict');
            return '{}';
          }
          return JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: 'merge-gate', head_sha: head,
            status: 'completed', conclusion: 'failure' }] });
        } };
      for (const humanSurfaceGuardAllows of [() => false, () => undefined,
        () => { throw new Error('approval proof unreadable'); }]) {
        const logStart = logs.length;
        update({ ...args, humanSurfaceGuardAllows });
        if (writes.length || !logs.slice(logStart).some(line => line.includes('skipped; inspect and update branch manually'))) {
          violations.push('held or unreadable human-surface approval did not block branch updates with a skip reason');
        }
      }
      update(args);
      if (writes.length !== 2 || writes.some(a => a[2] !== 'PUT' || a.at(-1) !== `expected_head_sha=${head}`)) {
        violations.push('stale-failed gate was not repaired with two pinned branch updates');
      }
      update({ ...args, candidates: args.candidates.slice(0, 2) });
      if (writes.length !== 2) violations.push('same head retried on a later drain pass');
      conflict = true;
      update({ ...args, candidates: args.candidates.slice(2) });
      update({ ...args, candidates: args.candidates.slice(2) });
      if (writes.length !== 3 || !logs.some(line => line.includes('stale-gate-update-branch failed:'))) {
        violations.push('422 was not logged once and retained as attempted');
      }
    } catch (error) { violations.push(`scenario failed: ${error.message}`); }
    finally { rmSync(stateRoot, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
