/** PR #5983: a shadow memo must not hide a replacement ruling's initial head. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const head = 'a'.repeat(40), moved = 'b'.repeat(40);
const bot = body => ({ author: { login: 'web-everything' }, body });
const held = rev => ({ number: 5925, headRefOid: rev, mergeable: 'MERGEABLE',
  labels: ['review:human', 'advisory:accepted', 'red-team:clear'],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  comments: [bot('**Verdict:** human review required\n**Advisory outcome:** `accept`\n'
    + `Net basis: \`${'c'.repeat(40)}..${rev}\``),
  bot(`<!-- we:red-team-advisory pr=5925 rev=${rev} -->\nNo confirmed breaks.`)],
});

export default {
  id: 'delegated-replacement-ruling',
  title: 'replacement rulings retain the head observed behind an earlier shadow memo',
  card: 'PR #5983 replacement ruling shadow memo',
  fixedBy: { sha: 'pending', where: 'lane/r130-delegated-sweep', paths: ['scripts/conveyor/delegated-clearance-sweep.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/delegated-clearance-sweep.mjs'), 'utf8')
      .includes('Observe ruling baselines before head-keyed memo suppression.');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { sweepReviewHoldLabels } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/review-hold-reconcile.mjs')).href);
    const violations = [];
    for (const origin of ['replacement', 'new-after-R11']) {
      let p = held(head), state = { observed: {}, memo: {} }, writes = 0, movementReads = 0;
      const approval = { repo: 'o/r', pr: p.number, rulingId: 'R122', operatorQuote: 'Approved with card-only movement',
        conditions: { redTeamClear: true, accepted: true, allowedHeadMove: 'card-only' },
        voidIf: 'new-confirmed-correctness-or-security-break' };
      let approvals = origin === 'replacement' ? [approval] : [];
      const delegatedClearance = {
        setting: {}, readState: () => structuredClone(state), writeState: next => { state = structuredClone(next); },
        readPreApprovals: () => approvals, readNetFiles: () => ['scripts/example.mjs'],
        shape: () => ({ humanRequired: false }), readPr: () => p,
        readMovedFiles: ({ approvedHead }) => {
          movementReads++;
          if (approvedHead !== head) violations.push(`${origin}: wrong movement baseline`);
          return ['backlog/123-card.md', 'src/unreviewed.js'];
        },
        emit: () => {}, runLabel: () => { writes++; return { ok: true }; },
      };
      const tick = () => sweepReviewHoldLabels({ repo: 'o/r', listPrs: () => [p], provider: {},
        readComments: () => p.comments, settings: { referralDefault: 'operator' },
        now: () => Date.parse('2026-10-26T00:00:00Z'), delegatedClearance });
      if (!tick().some(r => r.delegated === 'would-approve')) violations.push(`${origin}: missing initial shadow decision`);
      approvals = [{ ...approval, rulingId: 'R131' }];
      tick();
      if (state.observed['o/r#5925:R131'] !== head) violations.push(`${origin}: replacement baseline not observed`);
      // Reload persisted state, advance the PR, then enable live clearance.
      state = JSON.parse(JSON.stringify(state));
      p = held(moved);
      delegatedClearance.setting = { shadowUntil: '2026-10-25T00:00:00Z' };
      const results = tick();
      if (state.observed['o/r#5925:R131'] !== head) violations.push(`${origin}: replacement baseline changed after push`);
      if (movementReads !== 1) violations.push(`${origin}: movement restriction was bypassed`);
      if (writes || results.some(r => r.delegated === 'auto-approved')) violations.push(`${origin}: unreviewed code was cleared`);
    }
    log?.(`delegated replacement ruling: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
