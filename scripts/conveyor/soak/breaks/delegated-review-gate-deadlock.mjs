/** PR #5983: the review hold's own failing check must not deadlock delegated clearance. */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const head = 'a'.repeat(40), prior = 'b'.repeat(40);
const bot = body => ({ author: { login: 'web-everything' }, body });
const held = () => ({ number: 5925, headRefOid: head, mergeable: 'MERGEABLE',
  labels: ['review:human', 'advisory:accepted', 'red-team:clear'],
  statusCheckRollup: [
    { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
  ],
  comments: [bot('**Verdict:** human review required\n**Advisory outcome:** `accept`\n'
    + `Net basis: \`${prior}..${head}\``),
  bot(`<!-- we:red-team-advisory pr=5925 rev=${head} -->\nNo confirmed breaks.`)],
});

export default {
  id: 'delegated-review-gate-deadlock',
  title: 'delegated clearance escapes the review-gate hold while real CI failures stay held',
  card: 'PR #5983 review-gate clearance deadlock',
  fixedBy: { sha: 'pending', where: 'lane/r130-delegated-sweep', paths: ['scripts/conveyor/delegated-clearance-sweep.mjs'] },
  fixPresent(root) {
    // Probe behavior independently of the scenario judge, against the requested source tree.
    const url = pathToFileURL(join(root, 'scripts/conveyor/delegated-clearance-sweep.mjs')).href;
    return execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { planDelegatedClearance } from ${JSON.stringify(url)};
       process.stdout.write(String(planDelegatedClearance([${JSON.stringify(held())}]).length));`],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }).trim() === '1';
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { sweepReviewHoldLabels } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/review-hold-reconcile.mjs')).href);
    const violations = [];
    for (const mode of ['shadow', 'live', 'pre-approved', 'failed-ci', 'fresh-failed-ci', 'hold-only']) {
      const p = held();
      if (mode === 'failed-ci') p.statusCheckRollup[0].conclusion = 'FAILURE';
      if (mode === 'hold-only') p.statusCheckRollup.shift();
      let state = { observed: {}, memo: {} }, writes = 0;
      const delegatedClearance = {
        setting: { shadowUntil: mode === 'shadow' ? '' : '2026-10-25T00:00:00Z' },
        readState: () => state, writeState: next => { state = structuredClone(next); },
        readNetFiles: () => ['scripts/example.mjs'], shape: () => ({ humanRequired: false }),
        readPreApprovals: () => mode === 'pre-approved' ? [{ repo: 'o/r', pr: p.number,
          rulingId: 'R122', operatorQuote: 'Approved subject to accepted review and clear red team',
          conditions: { redTeamClear: true, accepted: true, allowedHeadMove: 'none' },
          voidIf: 'new-confirmed-correctness-or-security-break' }] : [],
        readPr: () => ({ ...p, statusCheckRollup: mode === 'fresh-failed-ci'
          ? [...p.statusCheckRollup, { context: 'test-extra', state: 'FAILURE' }] : p.statusCheckRollup }),
        emit: () => {}, runLabel: () => { writes++; return { ok: true }; },
      };
      const results = sweepReviewHoldLabels({ repo: 'o/r', listPrs: () => [p], provider: {},
        readComments: () => p.comments, settings: { referralDefault: 'operator' },
        now: () => Date.parse('2026-10-26T00:00:00Z'), delegatedClearance });
      const eligible = ['shadow', 'live', 'pre-approved'].includes(mode);
      const expected = mode === 'shadow' ? 'would-approve' : 'auto-approved';
      if (eligible && !results.some(r => r.num === p.number && r.delegated === expected)) violations.push(`${mode}: no ${expected}`);
      if (writes !== (eligible && mode !== 'shadow' ? 1 : 0)) violations.push(`${mode}: unexpected clearance writes ${writes}`);
      if (mode === 'fresh-failed-ci' && !results.some(r => r.delegated === 'aborted')) violations.push('fresh CI failure did not abort');
    }
    log?.(`delegated review-gate deadlock: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
