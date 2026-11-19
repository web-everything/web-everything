/** Live #6911: gh 2.104 refuses escape-coded job logs; unreadable evidence must retain a bounded repair owner. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** R1035 send-back on #7028: unknown step ownership must not spend a builder repair attempt. */
export async function runUnattributedBuilderRecovery() {
  const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
  const { cliRecoverBuilderDrafts } = await import(pathToFileURL(join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs')).href);
  const { CONSTELLATION_REPOS } = await import(pathToFileURL(join(root, 'scripts/lib/constellation-repos.mjs')).href);
  const stateRoot = mkdtempSync(join(tmpdir(), 'builder-unattributed-soak-'));
  // Builder recovery accepts WE-owned heads only; use its registry without hard-coding the slug.
  const repo = CONSTELLATION_REPOS.we.slug, ref = 'lane/4502-delivery';
  const effects = [], violations = [];
  const io = {
    stateRoot,
    store: { list: () => ['dispatch-lane-soak'], read: () => ({ effects: [{
      type: 'conveyor.dispatch-delivery-agent', handle: 'pid:99999', status: 'applied',
      payload: { launchKind: 'build', num: '4502' }, result: { pr: 3033 },
    }] }) },
    isPidAlive: () => false, listAgents: () => [], mergeGateSetting: 'off',
    api: path => {
      if (path.startsWith('pulls/')) return { draft: true, state: 'open', head: { ref, sha: 'abc', repo: { full_name: repo } } };
      if (path === 'commits/abc') return { commit: { committer: { date: '2026-09-30T01:00:00Z' } } };
      if (path === 'actions/jobs/456') return {}; // API read succeeds, attribution metadata is absent.
      if (path.startsWith('commits/abc/check-runs?')) return { check_runs: [{ id: 2, name: 'test', conclusion: 'failure',
        output: { summary: 'No error detail published by the check.' },
        details_url: `https://github.com/${repo}/actions/runs/123/job/456` }] };
      throw new Error(`unexpected endpoint: ${path}`);
    },
    paged: () => [],
    gh: args => {
      if (args[0] === 'api') return '2026-09-30T01:00:01Z FAIL passing-step-fixture.test.mjs';
      effects.push(args[0]);
    },
    freeLanes: () => { effects.push('freeLanes'); return [8]; },
    reserve: () => { effects.push('reserve'); return { ok: true }; },
    release: () => effects.push('release'),
    dispatch: async () => { effects.push('dispatch'); return { agentId: 'pid:321' }; },
  };
  try {
    const result = await cliRecoverBuilderDrafts({ allowResume: true,
      rawOpenPrs: [{ repo: 'we', prs: [{ number: 3033, isDraft: true, headRefName: ref }] }] }, io);
    if (result.length !== 1 || result[0].action !== 'unattributed'
      || result[0].reason !== 'no-attributable-failure-evidence') violations.push(`expected unattributed: ${JSON.stringify(result)}`);
    if (effects.length) violations.push(`unattributed evidence caused effects: ${effects.join(', ')}`);
    if (readdirSync(stateRoot).length) violations.push('unattributed evidence wrote repair state');
    return { violations, result, effects };
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
}

export default {
  id: 'gh-log-escape-sequences-block-ci-heal',
  title: 'gh 2.104 exits 1 reading CI job logs that contain terminal escape sequences, so failure evidence reads as unknown and no CI-heal or fixer is ever dispatched',
  card: 'gh log-read bug (live #6911)',
  fixedBy: {
    sha: 'f04378bda55b3be901169f4e9a377a336530357d',
    where: 'lane/gh-ci-log-escape-sequences',
    paths: ['scripts/lib/gh-ci-log.mjs', 'scripts/conveyor/reconcile-pass.mjs', 'scripts/conveyor/reconcile-core.mjs',
      'scripts/conveyor/reconcile-fix-dispatch.mjs', 'scripts/conveyor/fix-context-pack.mjs'],
  },
  fixPresent(root) {
    return existsSync(join(root, 'scripts/lib/gh-ci-log.mjs'))
      && readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('log-unreadable');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const pass = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const repo = 'o/r', head = 'a'.repeat(40), prNumber = 6911;
    const url = `https://github.com/${repo}/actions/runs/100/job/1`;
    const ghError = 'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway';
    const reads = [], pauses = [];
    const data = {
      [`repos/${repo}/pulls/${prNumber}`]: { state: 'open', head: { sha: head }, base: { sha: 'b'.repeat(40) }, changed_files: 1 },
      [`repos/${repo}/pulls/${prNumber}/files?per_page=100&page=1`]: [{ filename: 'unit.test.mjs' }],
      [`repos/${repo}/commits/${head}/check-runs?per_page=100&page=1&filter=latest`]: { total_count: 1,
        check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', details_url: url }] },
      [`repos/${repo}/commits/${head}/status`]: { total_count: 0 },
      [`repos/${repo}/actions/jobs/1`]: { id: 1, run_id: 100, head_sha: head, run_attempt: 1,
        name: 'test', status: 'completed', conclusion: 'failure', runner_name: 'runner',
        steps: [{ name: 'Run tests', status: 'completed', conclusion: 'failure' }] },
      [`repos/${repo}/actions/runs/100`]: { id: 100, head_sha: head, run_attempt: 1,
        path: '.github/workflows/ci.yml', repository: { full_name: repo } },
    };
    const exec = (command, args) => {
      const path = args.at(-1);
      reads.push({ command, args });
      if (command !== 'gh' || args[0] !== 'api') throw new Error(`unexpected command: ${command}`);
      if (path === `repos/${repo}/actions/jobs/1/logs`) {
        throw Object.assign(new Error(ghError), { status: 1, stderr: ghError });
      }
      if (!Object.hasOwn(data, path)) throw new Error(`unexpected endpoint: ${path}`);
      return JSON.stringify(data[path]);
    };
    // A bounced real-red PR with no current-head verdict joining CI and review repair: ordinary ci-heal is owed.
    const pr = { number: prNumber, state: 'OPEN', headRefOid: head, headRefName: 'lane/ci-log-fix', isDraft: false,
      mergeStateStatus: 'CLEAN', aheadByOnMain: 0, labels: [{ name: 'review:changes' }],
      comments: [{ body: '🔁 human review — changes requested\n\nFix the failing test.' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: url }] };
    const enriched = pass.enrichPrsWithTimeoutEvidence([pr], { repo, enabled: true,
      readBudget: () => ({ confirmed: 0, pending: false }),
      read: (input, opts) => pass.readTimeoutEvidence(input, { ...opts, exec, sleep: ms => pauses.push(ms) }) });
    const evidence = enriched[0].timeoutRetry;
    const plan = planReconcile({ prs: enriched, agents: [], durableCounts: {}, requiredChecks: ['test'],
      now: Date.parse('2026-11-17T18:00:00Z') });
    const violations = [];
    if (!plan.dispatch.some(row => row.prNumber === prNumber && row.kind === 'ci-heal')) {
      violations.push(`no ci-heal planned for PR #${prNumber}; evidence: ${JSON.stringify(evidence)}; refusals: ${JSON.stringify(plan.refusals)}`);
    }
    if (evidence?.reason !== 'log-unreadable' || evidence.unknown || evidence.eligible !== false) {
      violations.push(`log refusal is not typed log-unreadable: ${JSON.stringify(evidence)}`);
    }
    if (plan.refusals.some(row => row.prNumber === prNumber && row.kind === 'timeout-evidence-unknown')) {
      violations.push('escape-sequence log refusal silently blocks repair as timeout-evidence-unknown');
    }
    if (plan.dispatch.some(row => row.prNumber === prNumber && row.kind === 'ci-timeout-rerun')) {
      violations.push('unreadable logs authorized a timeout rerun without failure evidence');
    }
    if (reads.filter(({ args }) => args.at(-1).endsWith('/logs')).length !== 1 || pauses.length) {
      violations.push('escape-sequence refusal did not make exactly one log read without timeout retries');
    }
    const builderRecovery = await runUnattributedBuilderRecovery();
    violations.push(...builderRecovery.violations);
    return { violations, evidence, plan, reads, pauses, builderRecovery };
  },
  judge(report) { return report.violations; },
};
