/** PR #5983: non-ISO shadow deadlines must never enable live clearance. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const head = 'a'.repeat(40), prior = 'b'.repeat(40);
const bot = body => ({ author: { login: 'web-everything' }, body });

export default {
  id: 'delegated-invalid-shadow-deadline',
  title: 'malformed shadow deadlines stay in shadow across reconcile ticks and restart',
  card: 'PR #5983 non-ISO shadow deadline',
  fixedBy: { sha: 'pending', where: 'lane/r130-delegated-sweep', paths: ['scripts/conveyor/delegated-clearance-sweep.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/delegated-clearance-sweep.mjs'), 'utf8')
      .includes('const deadline = parseShadowDeadline(setting.shadowUntil);');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { sweepReviewHoldLabels } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/review-hold-reconcile.mjs')).href);
    const violations = [];
    for (const basis of ['R11', 'pre-approved']) {
      for (const deadline of ['0', '1', '10/25/2026', '2026-10-25T00:00:00', '2026-02-30T00:00:00Z']) {
        const p = { number: 5925, headRefOid: head, mergeable: 'MERGEABLE',
          labels: ['review:human', 'advisory:accepted', 'red-team:clear'],
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          comments: [bot('**Verdict:** human review required\n**Advisory outcome:** `accept`\n'
            + `Net basis: \`${prior}..${head}\``),
          bot(`<!-- we:red-team-advisory pr=5925 rev=${head} -->\nNo confirmed breaks.`)],
        };
        let state = { observed: {}, memo: {} }, writes = 0;
        const delegatedClearance = {
          setting: { shadowUntil: deadline },
          readState: () => state, writeState: next => { state = structuredClone(next); },
          readNetFiles: () => ['scripts/example.mjs'], shape: () => ({ humanRequired: false }),
          readPreApprovals: () => basis === 'R11' ? [] : [{ repo: 'o/r', pr: p.number,
            rulingId: 'R122', operatorQuote: 'Approved with no head movement', approvedHead: head,
            conditions: { redTeamClear: true, accepted: true, allowedHeadMove: 'none' },
            voidIf: 'new-confirmed-correctness-or-security-break' }],
          readPr: () => p, emit: () => {}, runLabel: () => { writes++; return { ok: true }; },
        };
        const tick = () => sweepReviewHoldLabels({ repo: 'o/r', listPrs: () => [p], provider: {},
          readComments: () => p.comments, settings: { referralDefault: 'operator' },
          now: () => Date.parse('2026-10-26T00:00:00Z'), delegatedClearance });
        if (!tick().some(r => r.delegated === 'would-approve')) violations.push(`${basis}/${deadline}: missing shadow decision`);
        state = JSON.parse(JSON.stringify(state));
        tick();
        if (writes !== 0) violations.push(`${basis}/${deadline}: malformed deadline caused ${writes} live writes`);
        // Explicit operator correction must allow this same persisted shadow memo to go live.
        delegatedClearance.setting = { shadowUntil: '2026-10-25T00:00:00Z' };
        if (!tick().some(r => r.delegated === 'auto-approved') || writes !== 1) {
          violations.push(`${basis}/${deadline}: corrected ISO deadline did not clear exactly once`);
        }
      }
    }
    log?.(`delegated invalid shadow deadline: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
