/**
 * PR #6879 (2026-11-15): the drain's JIT-number push ran merge-gate against stale acceptance.
 * The restamp COMMENT 21s later triggered no push/label event, leaving the gate red for ~100 minutes.
 * Replay the old no-refresh path and the real refresh helper with hermetic gh responses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HELPER = 'scripts/lib/merge-gate-refresh.mjs';
const HEAD = 'a'.repeat(40);
const REPO = 'example/widgets';
const PR = 6879;
const PUSH_AT = Date.parse('2026-11-15T12:00:00Z');
const RESTAMP_AT = PUSH_AT + 21_000;
const failed = { id: 2, name: 'merge-gate', head_sha: HEAD, status: 'completed',
  conclusion: 'failure', started_at: new Date(PUSH_AT).toISOString() };

export default {
  id: 'restamp-comment-does-not-retrigger-merge-gate',
  title: 'PR #6879: a restamp COMMENT after the JIT-number push left merge-gate red for ~100 minutes',
  card: 'PR #6879 (2026-11-15)',
  fixedBy: { sha: 'HEAD', where: 'HEAD', paths: [HELPER] },
  fixPresent(root) {
    const path = join(root, HELPER);
    return existsSync(path) && /export function refreshMergeGateAfterRestamp/.test(readFileSync(path, 'utf8'));
  },
  async run({ sourceRoot = ROOT, refreshGate, log } = {}) {
    const violations = [];
    try {
      const { planGateRefresh, refreshMergeGateAfterRestamp } = await import(pathToFileURL(join(sourceRoot, HELPER)).href);
      const refresh = refreshGate ?? refreshMergeGateAfterRestamp;
      const checkPath = `repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&filter=all&check_name=merge-gate`;
      const unrelatedChecks = Array.from({ length: 100 }, (_, i) => ({ ...failed, id: 100 + i, name: `ci-${i}` }));
      const expectedEdits = [
        ['pr', 'edit', String(PR), '--repo', REPO, '--add-label', 'gate:refresh'],
        ['pr', 'edit', String(PR), '--repo', REPO, '--remove-label', 'gate:refresh'],
      ];
      const labelRead = ['pr', 'view', String(PR), '--repo', REPO, '--json', 'labels'];
      for (const [name, checkRuns, expectedPlan] of [
        ['newest gate failed before restamp', [{ ...failed, id: 1, conclusion: 'success' }, failed], { checkRunId: 2 }],
        ['failed gate beyond the first unfiltered CI page', [...unrelatedChecks, failed], { checkRunId: 2 }],
        ['newest gate succeeded amid unrelated CI history', [failed, ...unrelatedChecks, { ...failed, id: 3, conclusion: 'success' }], null],
        ['newest gate succeeded', [failed, { ...failed, id: 3, conclusion: 'success' }], null],
        ['newest gate belongs to another sha', [failed, { ...failed, id: 3, head_sha: 'b'.repeat(40) }], null],
        ['newest gate began at restamp', [{ ...failed, started_at: new Date(RESTAMP_AT).toISOString() }], null],
        ['unreadable gate timestamp refuses refresh', [{ ...failed, started_at: 'unreadable' }], null],
      ]) {
        const calls = [];
        let labels = [];
        const gh = (command, args) => {
          if (command !== 'gh') throw new Error('unexpected command');
          calls.push(args);
          if (isDeepStrictEqual(args, ['api', checkPath])) {
            const gates = checkRuns.filter(check => check.name === 'merge-gate');
            return JSON.stringify({ total_count: gates.length, check_runs: gates.slice(0, 100) });
          }
          if (isDeepStrictEqual(args, ['api', `repos/${REPO}/pulls/${PR}`])) return JSON.stringify({ head: { sha: HEAD } });
          if (isDeepStrictEqual(args, labelRead)) return JSON.stringify({ labels });
          if (isDeepStrictEqual(args, expectedEdits[0])) { labels = [{ name: 'gate:refresh' }]; return ''; }
          if (isDeepStrictEqual(args, expectedEdits[1])) { labels = []; return ''; }
          if (isDeepStrictEqual(args, ['label', 'create', 'gate:refresh', '--repo', REPO, '--color', 'ededed',
            '--description', 'Refresh merge-gate after acceptance restamp'])) return '';
          throw new Error(`unexpected fake gh args: ${JSON.stringify(args)}`);
        };
        const plan = planGateRefresh({ checkRuns, head: HEAD, restampedAtMs: RESTAMP_AT });
        if (!isDeepStrictEqual(plan, expectedPlan)) violations.push(`${name}: incorrect refresh plan`);
        // BEFORE: posting the acceptance COMMENT alone made no GitHub call to refresh the gate.
        // The injected no-op in the companion test replays that path against the same required labels.
        const result = refresh({ repo: REPO, pr: PR, head: HEAD, restampedAtMs: RESTAMP_AT, gh,
          sleep: () => { throw new Error('unexpected retry'); } });
        const expectedCalls = [['api', checkPath], ...(expectedPlan ? [
          ['api', `repos/${REPO}/pulls/${PR}`],
          labelRead,
          ['label', 'create', 'gate:refresh', '--repo', REPO, '--color', 'ededed',
            '--description', 'Refresh merge-gate after acceptance restamp'],
          expectedEdits[0], labelRead, expectedEdits[1],
        ] : [])];
        if (result?.ok !== true || result.refreshed !== !!expectedPlan || !isDeepStrictEqual(calls, expectedCalls) || labels.length !== 0) {
          violations.push(`${name}: restamp did not issue exactly the required refresh calls`);
        }
        log?.(`${name}: refreshed=${result?.refreshed}; fake gh calls=${calls.length}`);
      }
    } catch (error) { violations.push(`scenario failed: ${error.message}`); }
    return { violations };
  },
  judge: report => report.violations,
};
