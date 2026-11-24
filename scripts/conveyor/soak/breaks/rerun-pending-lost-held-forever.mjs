/**
 * Live we#7431 (2026-11-24): a re-run request was reserved and stayed `pending`; no run was ever observed. Four
 * `ci-timeout-rerun-in-flight` refusal sites held the PR with no deadline. Replay through the real planner.
 */
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'rerun-pending-lost-held-forever',
  title: 'a lost pending re-run marker never holds a PR forever (we#7431)',
  card: 'PR #7431',
  fixedBy: { sha: 'uncommitted', where: 'working tree', paths: ['scripts/conveyor/reconcile-core.mjs', 'scripts/operations/ci-heal-pr-dispatch.mjs'] },
  // Probe all recovery and escalation invariants in a child process.
  fixPresent(root) {
    try {
      const self = pathToFileURL(fileURLToPath(import.meta.url)).href;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(self)}); process.stdout.write(String((await m.scenario(${JSON.stringify(root)})).violations.length === 0));`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
      return out.trim() === 'true';
    } catch { return false; }
  },
  async run({ sourceRoot } = {}) {
    return { violations: (await scenario(sourceRoot)).violations };
  },
  judge(report) { return report.violations; },
};

export async function scenario(sourceRoot) {
  const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
  const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
  const repo = 'org/repo';
  const head = 'ab12cd34'.padEnd(40, '0');
  const now = Date.parse('2026-11-24T22:00:00Z');
  const failed = { name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-11-24T17:55:00Z',
    detailsUrl: `https://github.com/${repo}/actions/runs/123/job/456` };
  const pr = {
    number: 7431, title: 't', headRefOid: head, headRefName: 'lane/x', baseRefName: 'main', isDraft: false, labels: [], comments: [],
    mergeStateStatus: 'BLOCKED', statusCheckRollup: [failed],
    timeoutRetry: { eligible: true, repo, pr: 7431, head, signature: 'timeout', jobs: [{ run: 123, job: 456, attempt: 1 }] },
    timeoutRetryBudget: { confirmed: 0, pending: true, pendingSince: '2026-11-24T17:56:00Z' },
  };
  const out = planReconcile({ prs: [pr], now, requiredChecks: ['test'], reviewTiming: { startAfter: 'ci-green' } });
  const heldForever = out.refusals.some((r) => r.kind === 'ci-timeout-rerun-in-flight');
  const replans = out.dispatch.some((d) => d.kind === 'ci-timeout-rerun' || d.kind === 'ci-heal');
  const violations = [];
  if (heldForever) violations.push('lost pending marker holds the PR as ci-timeout-rerun-in-flight forever');
  if (!replans) violations.push('a lost pending marker produced no re-run or ci-heal dispatch');
  for (const extra of [
    { statusCheckRollup: [failed, { context: 'stuck', state: 'PENDING' }] },
    { rollupIncomplete: true },
  ]) {
    const oldLive = planReconcile({ prs: [{ ...pr, ...extra }], now, requiredChecks: ['test'] });
    if (!oldLive.notes.some(n => n.kind === 'timeout-retry-needs-human')) {
      violations.push('an old live or incomplete rollup silently holds a pending marker');
    }
  }
  // Durable cleanup: the dispatcher must be able to expire the marker (else the planned ci-heal is refused forever).
  try {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const disp = await import(pathToFileURL(join(root, 'scripts/operations/ci-heal-pr-dispatch.mjs')).href);
    const { timeoutKey } = await import(pathToFileURL(join(root, 'scripts/conveyor/timeout-retry-state.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'rerun-lost-'));
    mkdirSync(dir, { recursive: true });
    const target = { run: 123, job: 456, attempt: 1 };
    const evidence = { repo, pr: 7431, head };
    const path = join(dir, `${timeoutKey(evidence)}.json`);
    const observe = () => ({ repo, head, runHead: head, open: true, run: 123, job: 456, jobRun: 123, attempt: 1, status: 'completed', conclusion: 'failure' });
    try {
      for (const reason of [null, 'aged-out', 'pr-closed']) {
        writeFileSync(path, JSON.stringify({ version: 1, evidence, ...(reason ? { retired: { reason } } : {}),
          requests: [{ id: 0, target, status: 'pending', reservedAt: '2026-11-24T17:56:00Z' }] }));
        const result = await disp.runReconcileCiHealDispatch({ root: dir, repo: 'we', now: () => now,
          checkStaleness: () => ({ fresh: true, behind: 0 }),
          reconcile: () => ({ dispatch: [{ kind: 'ci-heal', prNumber: 7431, headRefOid: head }], refusals: [] }),
          flushOwed: () => ({}), flushTimeouts: async () => [], pollAttempts: () => [],
          unsupportedPath: join(dir, 'unsupported'), pickFreeLanes: () => [3], currentBuild: () => null,
          resolveWorkUnit: () => ({ itemNum: null, scope: [] }), salvage: async () => null,
          resolveProfile: () => ({ capabilities: { ciHeal: true }, lanePoolRepo: dir }),
          fixLoop: { killed: () => false, readRows: () => [], append: async () => {} },
          fixConfig: { maxSessions: 3, windowHours: 6, hold: true },
          timeoutHold: args => disp.readTimeoutHold({ ...args, repo, dir }),
          expireLost: args => disp.expireLostPending({ ...args, repo, dir, effects: { observe } }),
          dispatch: planned => ({ pr: planned.pr }),
        });
        if (!reason && (result.dispatched.length !== 1 || disp.readTimeoutHold({ repo, pr: 7431, head, dir }))) {
          violations.push('ci-heal does not expire the lost marker and dispatch through its real wiring');
        } else if (reason && (result.dispatched.length || !result.refusals.some(r => r.kind === 'timeout-retry-needs-human'))) {
          violations.push(`retired ${reason} marker has no operator escalation`);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } catch (error) { violations.push(`dispatcher cannot expire a lost marker: ${error.message}`); }
  return { replans, violations };
}
