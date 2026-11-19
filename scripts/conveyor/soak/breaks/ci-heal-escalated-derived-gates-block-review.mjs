/** Durable CI escalations must not starve the review that clears derived gate holds. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = 'scripts/conveyor/reconcile-core.mjs';

export async function replay(sourceRoot = ROOT) {
  try {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { planReconcile } = await load(SOURCE);
    const { buildCiHealEscalationComment } = await load('scripts/conveyor/ci-heal-escalation-mark.mjs');
    const head = 'a'.repeat(40);
    const check = (name, conclusion, extra = {}) => ({
      name, status: 'completed', conclusion, head_sha: head, ...extra,
    });
    const plan = planReconcile({
      prs: [{
        number: 7100, state: 'OPEN', headRefName: 'lane/derived-gates', headRefOid: head,
        labels: [{ name: 'review:pending' }], mergeStateStatus: 'CLEAN',
        statusCheckRollup: [check('test', 'success'), check('review-gate', 'failure'),
          check('merge-gate', 'failure')],
        comments: [{ author: { login: 'web-everything' }, body: buildCiHealEscalationComment({
          headSha: head, outcome: 'needs-human', reason: 'durable escalation from an earlier tick',
        }) }],
      }],
      agents: [], now: Date.parse('2026-11-19T12:00:00Z'),
      requiredChecks: ['test', 'review-gate', 'merge-gate'], reviewTiming: { startAfter: 'ci-green' },
    });
    return { violations: plan.dispatch.some(row => row.kind === 'review' && row.prNumber === 7100)
      ? [] : ['ci-heal escalation blocked review with only derived gates red'] };
  } catch (error) { return { violations: [`replay failed: ${error.message}`] }; }
}

export default {
  id: 'ci-heal-escalated-derived-gates-block-review',
  title: 'review clears derived gate holds despite a durable ci-heal escalation',
  card: 'ci-heal escalation derived-gate review deadlock',
  fixedBy: { sha: 'HEAD', where: 'ci-heal-escalated-derived-gates-block-review', paths: [SOURCE] },
  fixPresent(root) {
    // Probe the candidate tree's behavior, never a source-text signature.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { replay } from ${JSON.stringify(import.meta.url)};
       process.exitCode = (await replay(process.argv[1])).violations.length === 0 ? 0 : 1;`, root],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return !result.error && result.status === 0;
  },
  run: ({ sourceRoot = ROOT } = {}) => replay(sourceRoot),
  judge: report => report.violations,
};
