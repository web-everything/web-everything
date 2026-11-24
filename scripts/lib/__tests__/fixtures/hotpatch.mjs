import { QUESTION_HASH } from '../../../operations/codex-audit.mjs';
export const HP_SHA = 'a'.repeat(40);
export function hotpatchFixture() {
  const check = (name, id) => ({ name, id, head_sha: HP_SHA, app: { id: 15368 }, check_suite: { id: 7 }, status: 'completed', conclusion: 'success' });
  const data = {
    checks: { total_count: 5, check_runs: [check('test', 10), check('test-shard (1)', 8), check('test-shard (2)', 9), check('smoke', 11), check('daemon-soak', 12)] },
    workflows: { total_count: 1, workflow_runs: [{ check_suite_id: 7, head_sha: HP_SHA, path: '.github/workflows/ci.yml' }] },
    audits: [{ head: HP_SHA, base: 'e'.repeat(40), at: '2026-11-20T12:00:00Z', questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', findings: [] }],
    auditOptions: { now: Date.parse('2026-11-22T12:00:00Z'), priorQuestionHashes: [] },
    fullSuite: true, ruledWeakened: [], paths: [], ciPlan: [{}, {}], settings: {},
  };
  const readers = Object.fromEntries(Object.keys(data).map(k => [k, () => data[k]]));
  readers.covers = () => true;
  return { data, readers };
}
