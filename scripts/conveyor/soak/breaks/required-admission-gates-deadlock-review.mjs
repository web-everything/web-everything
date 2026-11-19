/** Workflow-edit protection must reach review while real CI failures remain repair work. */
import { HEAD, workflowRow, workflowEvidence } from '../fixtures/workflow-edit-protection.mjs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'required-admission-gates-deadlock-review',
  title: 'workflow-edit protection reaches review and real CI remains repairable',
  card: 'review daemon admission deadlock',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: [
    'scripts/lib/merge-gate-hold-class.mjs',
  ] },
  fixPresent(root) {
    // Probe the target tree's behavior, never a source-string signature of the fix.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import b from ${JSON.stringify(import.meta.url)}; const r = await b.run({ sourceRoot: ${JSON.stringify(root)} }); process.exit(b.judge(r).length ? 1 : 0);`],
    { timeout: 15000, maxBuffer: 65536, encoding: 'utf8' });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { excusePrMergeGateHolds, readMergeGateVerdict } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/merge-gate-hold-class.mjs')).href);
    const requiredChecks = ['test', 'merge-gate', 'review-gate'];
    const violations = [];
    for (const scenario of ['workflow hold', 'real CI failure', 'wrong head', 'unreadable job', 'other failed step']) {
      const evidence = workflowEvidence();
      if (scenario === 'wrong head') evidence.job.head_sha = 'b'.repeat(40);
      if (scenario === 'unreadable job') evidence.job = null;
      if (scenario === 'other failed step') evidence.job.steps[0].conclusion = 'failure';
      const pr = { number: 7106, state: 'OPEN', headRefOid: HEAD, headRefName: 'lane/soak-admission',
        files: [{ path: '.github/workflows/merge-gate.yml' }],
        mergeStateStatus: 'CLEAN', labels: [{ name: 'review:pending' }], comments: [],
        statusCheckRollup: [workflowRow, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'test', status: 'COMPLETED', conclusion: scenario === 'real CI failure' ? 'FAILURE' : 'SUCCESS' }] };
      const prs = excusePrMergeGateHolds([pr], { repo: 'owner/repo', mergeGateSetting: 'on',
        readMergeGateVerdict: args => readMergeGateVerdict({ ...args, cache: new Map(),
          runGh: argv => argv[1].endsWith('/logs') ? evidence.log : JSON.stringify(evidence.job) }) });
      for (const elapsed of [0, 60000, 120000]) {
        const plan = planReconcile({ prs, requiredChecks, agents: [], advisoryReviewOnHumanHandoff: 'on',
          now: Date.parse('2026-11-18T12:00:00Z') + elapsed, reviewTiming: { startAfter: 'ci-green' } });
        const expected = scenario === 'workflow hold' ? 'review' : 'ci-heal';
        const kinds = plan.dispatch.map(row => row.kind);
        log?.(`${elapsed}: ${scenario}, dispatch=${kinds.join(',')}`);
        if (!kinds.includes(expected) || kinds.includes(expected === 'review' ? 'ci-heal' : 'review'))
          violations.push(`${elapsed}: ${scenario} expected ${expected}, got ${kinds.join(',')}`);
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
