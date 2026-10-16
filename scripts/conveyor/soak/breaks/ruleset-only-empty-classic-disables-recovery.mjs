/** PR #5404: an empty classic subset must not disable ruleset-only missing-run recovery. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = 'scripts/conveyor/ci-red-recovery-watch.mjs';
const REPO = 'ruleset-fixture/example';
const done = name => ({ __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' });

export default {
  id: 'ruleset-only-empty-classic-disables-recovery',
  title: 'Ruleset-only protection with an empty classic subset still recovers an absent required run',
  card: '#5962 / PR #5404',
  fixedBy: { sha: 'HEAD', where: 'lane/5962-shared-required-checks-cache', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('Ruleset-only protection is not an empty required set');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { defaultReadRequiredContexts, defaultReadAttributedRequiredChecks, sweepMissingRunRecovery } =
      await import(pathToFileURL(join(root, SOURCE)).href);
    const { getRequiredStatusChecks, readRequiredStatusChecksDetailed } =
      await import(pathToFileURL(join(root, 'scripts/lib/required-status-checks.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'ruleset-only-recovery-'));
    const reports = [];
    let reads = 0;
    try {
      const cachePath = join(dir, 'checks.json');
      const now = Date.parse('2026-10-15T19:00:00Z');
      const readChecks = options => readRequiredStatusChecksDetailed({ ...options, gh: args => {
        reads++;
        if (args.at(-1).includes('/rules/branches/')) return JSON.stringify([
          { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }, { context: 'merge-gate' }] } },
        ]);
        return JSON.stringify({ protected: true, protection: { enabled: false } });
      } });
      for (const source of ['live', 'cache', 'stale-cache']) {
        const readRequiredChecks = options => getRequiredStatusChecks({ ...options, cachePath,
          now: source === 'stale-cache' ? now + 2_000 : now, ttlMs: 1_000,
          readChecks: source === 'stale-cache' ? () => { throw new Error('offline'); } : readChecks,
        });
        const shared = readRequiredChecks({ repo: REPO });
        for (const [baseRefName, mergeable, rollup, expected] of [
          ['main', 'MERGEABLE', [done('test')], 1],
          ['main', 'MERGEABLE', [], 1],
          ['main', 'MERGEABLE', [done('test'), done('merge-gate')], 0],
          ['lane/parent', 'MERGEABLE', [done('test')], 0],
          [undefined, 'MERGEABLE', [done('test')], 0],
          ['main', 'CONFLICTING', [done('test')], 0],
        ]) {
          let triggered = 0;
          const result = sweepMissingRunRecovery({
            repo: REPO, apply: true, mainRuns: [], now,
            readOpenPrs: () => [{ number: 5404, headRefName: 'lane/ruleset-only', headRefOid: 'ruleset-head',
              baseRefName, mergeable, statusCheckRollup: rollup }],
            readRequiredContexts: options => defaultReadRequiredContexts({ ...options, readRequiredChecks }),
            readAttributedRequiredChecks: options => defaultReadAttributedRequiredChecks({ ...options, readRequiredChecks }),
            readDeclaredContexts: () => null,
            readHeadCommittedAt: () => '2026-10-14T00:00:00Z', readComments: () => [],
            trigger: () => { triggered++; return { ok: true, action: 'pull-request-push' }; },
            restack: () => { throw new Error('healthy stack must not restack'); },
            postComment: () => {}, clearLabel: () => true,
          });
          reports.push({ source, baseRefName, mergeable, reported: rollup.map(c => c.name), expected,
            dispatches: result.dispatch.length, triggered, checks: shared.checks, classic: shared.classic });
        }
      }
      return { reports, reads };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge({ reports, reads }) {
    return [
      ...(reads !== 2 ? [`expected one rules + branch read, got ${reads}`] : []),
      ...reports.filter(r => r.dispatches !== r.expected || r.triggered !== r.expected)
        .map(r => `${r.source}/${r.baseRefName}/${r.mergeable} reported=${r.reported}: expected ${r.expected} recovery, got ${r.dispatches}`),
    ];
  },
};
