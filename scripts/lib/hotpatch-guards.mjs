/** Read-only admission decisions. Readers throw on incomplete or unreadable evidence. */
import { canonicalAuditEvidence, testWorkflowBound, TEST_CHECK_APP_ID } from '../operations/prototype-load.mjs';
import { resolveCascade } from './policy-cascade.mjs';
import { findAudit, QUESTION_HASH } from '../operations/codex-audit.mjs';
const defaults = Object.freeze({ liveWhen: 'after-receipt-and-audit', auditBar: 'no-pr-introduced-security', receiptSource: 'ci-full-suite', parallel: true });
const result = (outcome, detail) => ({ outcome, detail, ...(outcome === 'pass' ? {} : {
  fallback: 'Wait for complete push, merge_group or workflow_dispatch CI and an own-sha audit; repair or archive evidence exceeding 100 API rows/calls, 2 MiB per API response or 16 MiB per audit ledger, or use the normal merge path.',
}) });
const unknown = () => result('unknown', 'hotpatch-evidence-unreadable');
const complete = (data, key) => Number.isInteger(data?.total_count) && data.total_count >= 0
  && data.total_count <= 100 && Array.isArray(data[key]) && data[key].length === data.total_count;
export function resolveHotpatchKnobs(layers = {}) {
  return resolveCascade({ ...layers, standard: defaults, valid: Object.fromEntries(Object.entries(defaults)
    .map(([key, value]) => [key, v => key === 'parallel' ? typeof v === 'boolean' : v === value])) });
}
export async function receiptGuard(sha, readers) {
  try {
    const data = await readers.checks(sha);
    const workflows = await readers.workflows(sha);
    const plan = await readers.ciPlan(sha);
    if (!complete(data, 'check_runs') || !complete(workflows, 'workflow_runs')
      || !Array.isArray(plan) || !plan.length || plan.length > 64
      || data.check_runs.some(r => !Number.isSafeInteger(r?.id) || !Number.isSafeInteger(r?.check_suite?.id)
        || !Number.isSafeInteger(r?.app?.id) || typeof r.name !== 'string' || !/^[a-f0-9]{40}$/.test(r.head_sha)
        || !['queued', 'in_progress', 'completed'].includes(r.status)
        || (r.status === 'completed' ? typeof r.conclusion !== 'string' : r.conclusion !== null))) return unknown();
    if (workflows.workflow_runs.some(r => !Number.isSafeInteger(r?.check_suite_id) || !/^[a-f0-9]{40}$/.test(r?.head_sha) || typeof r?.path !== 'string')
      || new Set(data.check_runs.map(r => r.id)).size !== data.check_runs.length) return unknown();
    if (data.check_runs.some(r => r.head_sha !== sha)) return unknown();
    const tests = data.check_runs.filter(r => r.head_sha === sha && r.name === 'test');
    if (!tests.length) return result('wait', 'hotpatch-needs-ci-receipt');
    for (const test of tests) {
      if (test.app.id !== TEST_CHECK_APP_ID || !testWorkflowBound({ suiteIds: [test.check_suite.id] }, workflows, sha)) return result('unknown', 'hotpatch-workflow-unbound');
    }
    // PR CI intentionally omits soak execution. Only these full-suite events can supply a receipt.
    // Keep all attempts within those workflows: a failed or pending rerun cannot hide behind an older green.
    const ci = workflows.workflow_runs.filter(r => r.head_sha === sha && r.path === '.github/workflows/ci.yml'
      && ['push', 'merge_group', 'workflow_dispatch'].includes(r.event));
    const suiteIds = new Set(ci.map(r => r.check_suite_id));
    const runs = data.check_runs.filter(r => r.app.id === TEST_CHECK_APP_ID && suiteIds.has(r.check_suite.id));
    // An Actions check with no workflow binding is unknown, rather than silently treated as unrelated.
    if (data.check_runs.some(r => r.app.id === TEST_CHECK_APP_ID
      && !workflows.workflow_runs.some(w => w.check_suite_id === r.check_suite.id && w.head_sha === sha))) return unknown();
    if (runs.some(r => r.status === 'completed' && ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(r.conclusion)))
      return result('fail', 'hotpatch-ci-failed');
    const eligibleTests = tests.filter(r => suiteIds.has(r.check_suite.id));
    if (!eligibleTests.length || ci.some(w => !eligibleTests.some(t => t.check_suite.id === w.check_suite_id))) return result('wait', 'hotpatch-needs-ci-receipt');
    for (const test of eligibleTests) {
      for (const name of ['test', 'smoke', 'daemon-soak', ...plan.map((_, i) => `test-shard (${i + 1})`)]) {
        if (!runs.some(r => r.name === name && r.check_suite.id === test.check_suite.id)) return result('wait', 'hotpatch-needs-ci-receipt');
      }
    }
    // Checks from review/publish workflows and other apps do not attest to test execution.
    for (const check of runs) {
      if (check.status !== 'completed') return result('wait', 'hotpatch-needs-ci-receipt');
      // ci.yml intentionally disables the optional visual job (#2232); required suites still execute below.
      if (check.name === 'visual' && check.conclusion === 'skipped' && check.app.id === TEST_CHECK_APP_ID
        && testWorkflowBound({ suiteIds: [check.check_suite.id] }, workflows, sha)) continue;
      if (check.conclusion !== 'success') return result('fail', 'hotpatch-incomplete-ci-receipt');
    }
    if (await readers.fullSuite(sha, { total_count: ci.length, workflow_runs: ci }) !== true) return result('unknown', 'hotpatch-full-suite-unproven');
    return result('pass', 'hotpatch-ci-receipt');
  } catch { return unknown(); }
}
export async function auditGuard(sha, readers) {
  try {
    const records = await readers.audits(sha), rulings = await readers.ruledWeakened();
    const { now, priorQuestionHashes } = await readers.auditOptions();
    if (!Number.isFinite(now) || !Array.isArray(priorQuestionHashes)) return unknown();
    if (!Array.isArray(records) || !Array.isArray(rulings)) return unknown();
    // No fingerprint argument: only the requested head can contribute canonical evidence.
    const own = records.filter(r => r?.head?.toLowerCase() === sha);
    // Judge each record on its own: an older pass must never conceal unusable newer evidence.
    // A delta-only record (carrying a basis) never stands in for the full own-sha review.
    if (own.some(r => Object.hasOwn(r, 'basis'))) return unknown();
    if (own.some(r => !Array.isArray(r.findings) || r.findings.some(f => typeof f !== 'string')
      || findAudit([r], { head: r.head, base: r.base, questionHash: QUESTION_HASH, now, priorQuestionHashes }) !== r)) return unknown();
    const evidence = canonicalAuditEvidence(own, sha, base => {
      const covered = readers.covers(base, sha);
      if (typeof covered !== 'boolean') throw new Error('unreadable audit base');
      return covered;
    }, null, { now, priorQuestionHashes });
    if (evidence.ok) return result('pass', 'hotpatch-own-sha-audit');
    if (evidence.reason === 'weakened') return rulings.some(r => r?.sha?.toLowerCase() === sha && r.ref === `hotpatch/${sha}`)
      ? result('unknown', 'hotpatch-audit-unverifiable') : result('fail', 'hotpatch-audit-weakened');
    return result('wait', 'hotpatch-needs-own-sha-audit');
  } catch { return unknown(); }
}
export async function ciDefinitionGuard(sha, readers) {
  try {
    const paths = await readers.paths(sha);
    if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p)) return unknown();
    // CI entrypoints transitively import across scripts/, including shared writers, cache
    // hooks and admission/dispatch helpers. Protect the tooling tree, not a filename list
    // of today's direct imports. Such edits must use the normal merge path.
    // The CI import-closure regression also covers build hooks and executable skill helpers;
    // it must stay green before RS-HP-2 wires admission. The guard itself remains IO-free.
    return paths.some(p => /^(?:\.github\/(?:workflows|actions)\/|scripts\/|eleventy\/|skills-src\/(?:conveyor|inspect-agent-health|inspect-codex-transcript)\/|src\/_data\/site\.js$|(?:vitest|playwright|vite)[^/]*\.[^/]+$|package(?:-lock)?\.json$|\.(?:npmrc|nvmrc|node-version|tool-versions|eleventy\.[^/]+)$|tsconfig(?:\.[^/]+)?\.json$)/.test(p))
      ? result('fail', 'hotpatch-ci-definition-change') : result('pass', 'hotpatch-ci-definition-unchanged');
  } catch { return unknown(); }
}
export async function admitHotpatch(sha, readers) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) return result('fail', 'hotpatch-ref-sha-mismatch');
  try {
    const policy = resolveHotpatchKnobs(await readers.settings());
    if (policy.invalid.length) return result('unknown', 'hotpatch-policy-invalid');
    const guards = await Promise.all([receiptGuard(sha, readers), auditGuard(sha, readers), ciDefinitionGuard(sha, readers)]);
    return ['unknown', 'fail', 'wait'].map(outcome => guards.find(g => g.outcome === outcome)).find(Boolean) ?? result('pass', 'hotpatch-admitted');
  } catch { return unknown(); }
}
