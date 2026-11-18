import { GATE_IDS } from '../../../lib/merge-gate-inventory.mjs';

export const HEAD = 'a'.repeat(40);
// PR 7106's rollup transport shape: job identity lives in detailsUrl, with no id.
export const workflowRow = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE',
  detailsUrl: 'https://github.com/owner/repo/actions/runs/7106/job/123' };
export function workflowEvidence() {
  const hold = { status: 'hold', reason: `human-only: the diff at ${HEAD.slice(0, 9)} touches .github/workflows/merge-gate.yml — workflow files decide the required checks, so only a clear-human ceremony at this exact head can accept it` };
  const mismatch = `running workflow .github/workflows/merge-gate.yml at ${HEAD.slice(0, 9)} differs from main's — a PR may not change the gate that judges it`;
  return {
    job: { name: 'merge-gate', head_sha: HEAD, status: 'completed', conclusion: 'failure',
      steps: [{ name: 'Install', status: 'completed', conclusion: 'success' },
        { name: "Evaluate the drain's merge gates", status: 'completed', conclusion: 'failure' }] },
    log: [`merge-gate: workflow self-check — FAIL: ${mismatch}`, '#7106: HOLD',
      ...GATE_IDS.map(id => `  ${id === 'review-acceptance' ? hold.status : 'pass'}  ${id}  ${id === 'review-acceptance' ? hold.reason : 'ok'}`),
      `merge-gate: HOLD — workflow self-check failed — fail closed: ${mismatch}; held`].join('\n'),
  };
}
