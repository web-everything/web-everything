/** 2026-11-19: #7106/#7117 stayed BLOCKED after clear-human; label toggles did not rerun merge-gate. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HELPER = 'scripts/lib/stale-gate-update-branch.mjs';
const CHECK_APP = 1;
const head = 'a'.repeat(40);
export default {
  id: 'stale-failed-merge-gate-blocks-drain',
  title: 'cleared BLOCKED PRs need a pinned branch update to rerun stale-failed merge-gate',
  card: 'PR #7106 / #7117 (2026-11-19)',
  fixedBy: { sha: 'HEAD', where: 'HEAD', paths: [HELPER, 'scripts/merge-ai-prs.mjs'] },
  // Presence is static: a behavioral regression must fail the scenario, never select it.fails.
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, HELPER), 'utf8');
      return source.includes('export function planStaleGateUpdateBranch');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, updateBranches } = {}) {
    const violations = [];
    const stateRoot = mkdtempSync(join(tmpdir(), 'soak-stale-gate-'));
    try {
      const { refreshStaleBlockedGates, unlandableStateReason } = await import(pathToFileURL(join(sourceRoot, 'scripts/merge-ai-prs.mjs')).href);
      const update = updateBranches ?? (args => refreshStaleBlockedGates(args.candidates.map(c => ({
        repo: c.repo, num: c.num, headSha: c.head, decision: 'skip', reason: unlandableStateReason('BLOCKED'),
      })), args));
      const writes = [], logs = [];
      let conflict = false;
      const args = { candidates: [7106, 7117, 7118].map(num => ({ repo: 'example/widgets', num, head })),
        max: 2, stateRoot, defaultBranchOf: () => 'main', requiredAppIdOf: () => CHECK_APP,
        fixClaimHeld: () => false, humanSurfaceGuardAllows: () => true, log: line => logs.push(line),
        gh: (_bin, argv) => {
          if (argv[0] === 'pr') return JSON.stringify({ number: Number(argv[2]), headRefOid: head,
            baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED',
            labels: ['ready-to-merge', 'review:accepted', 'red-team:clear'].map(name => ({ name })),
            statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
          if (argv[1] === '-X') {
            writes.push(argv);
            if (conflict) throw new Error('422 merge conflict');
            return '{}';
          }
          return JSON.stringify({ total_count: 2, check_runs: [{ id: 2, name: 'test', head_sha: head, app: { id: 1 },
            status: 'completed', conclusion: 'success' }, { id: 1, name: 'merge-gate', head_sha: head, app: { id: CHECK_APP },
            status: 'completed', conclusion: 'failure' }] });
        } };
      const read = args.gh;
      const rejected = [
        ['other app newer failure', { gate: { conclusion: 'success' }, otherApp: true }],
        ['no required-app run', { gate: { app: { id: 2 } } }],
        ['unknown required app', { requiredAppId: null }],
        ['newest required gate succeeded', { gate: { conclusion: 'success' } }],
        ['newest required gate pending', { gate: { status: 'in_progress', conclusion: null } }],
        ...['CHANGES_REQUESTED', 'REVIEW_REQUIRED', undefined].map(reviewDecision => ['blocked or unreadable review', { reviewDecision }]),
      ];
      for (const [name, evidence] of rejected) {
        update({ ...args, requiredAppIdOf: () => 'requiredAppId' in evidence ? evidence.requiredAppId : CHECK_APP,
          gh: (bin, argv) => {
            if (argv[1] === '-X') return read(bin, argv);
            const result = JSON.parse(read(bin, argv));
            if (argv[0] === 'pr') {
              if ('reviewDecision' in evidence) result.reviewDecision = evidence.reviewDecision;
            } else {
              const gate = result.check_runs.find(c => c.name === 'merge-gate');
              Object.assign(gate, evidence.gate);
              if (evidence.otherApp) result.check_runs.push({ ...gate, id: 99, app: { id: 2 }, conclusion: 'failure' });
              result.total_count = result.check_runs.length;
            }
            return JSON.stringify(result);
          } });
        if (writes.length) violations.push(`${name} authorized a branch update`);
      }
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
      const conflictLogStart = logs.length;
      conflict = true;
      update({ ...args, candidates: args.candidates.slice(2) });
      update({ ...args, candidates: args.candidates.slice(2) });
      if (writes.length !== 3 || logs.slice(conflictLogStart).filter(line => line.includes('stale-gate-update-branch failed:') && line.includes('422')).length !== 1) {
        violations.push('422 was not logged once and retained as attempted');
      }
    } catch (error) { violations.push(`scenario failed: ${error.message}`); }
    finally { rmSync(stateRoot, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
