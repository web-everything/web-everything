/**
 * PR #4495 review (2026-10-08, ledger plan slice H, card xqh3tkh): the review-hold step's `ledger` mode — the one mode
 * meant to be fail-closed — released a review three ways. A step that threw returned today's un-held PRs; a ledger
 * with no rows for a PR (or no run on its head) lifted the pause today's reader kept; and a cached read hid a run
 * written since the last tick, so a second review was dispatched on an unchanged head (#3771/#3988).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = 'example/ledger-soak'; // the ledger scope string only; the scenario never touches a real repo
const head = 'a'.repeat(40);
const other = 'b'.repeat(40);
const at = Date.parse('2026-10-08T12:00:00Z');
const oldHold = { kind: 'same-head', head, why: 'review paused: already reviewed on this head' };
const mkPr = (o = {}) => ({ number: 3988, headRefOid: head, headRefName: 'lane/x', body: '', labels: [{ name: 'review:human' }],
  comments: [], statusCheckRollup: [], referralHold: null, blockRuledReferrals: [], ...o });
const LEDGER = { WE_VERDICT_LEDGER_READ_SOURCE_SAME_HEAD_HOLD: 'ledger' };

export default {
  id: 'ledger-mode-holds-fail-open',
  title: 'PR #4495: the review-hold ledger step in `ledger` mode released a review on a thrown step, on a ledger with no rows for the PR, and on a cached read that missed a fresh review run',
  card: '5474 (ledger plan slice H; PR #4495)',
  fixedBy: { sha: 'd6fc13fad4e666082673253e65fd1874a49f1cd6', where: 'lane/ledger-slice-h', paths: ['scripts/conveyor/review-hold-ledger-shadow.mjs', 'scripts/conveyor/reconcile-pass.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/review-hold-ledger-shadow.mjs'), 'utf8').includes('export function failClosedHolds'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const load = rel => import(pathToFileURL(join(root, rel)).href);
    const shadow = await load('scripts/conveyor/review-hold-ledger-shadow.mjs');
    const { enrichPrsWithLedgerHolds } = await load('scripts/conveyor/reconcile-pass.mjs');
    const { buildLedgerEvent, EVENT_TYPES } = await load('scripts/lib/verdict-ledger.mjs');
    const run = (sha, n = 0) => buildLedgerEvent({ type: EVENT_TYPES.REVIEW_RUN, repo, pr: 3988, at: new Date(at - 60_000 + n).toISOString(),
      source: 'soak', headSha: sha, phase: 'completed', posted: false });
    const sources = shadow.resolveReadSources(LEDGER);
    const violations = [];
    shadow.resetLedgerSnapshots();

    const thrown = enrichPrsWithLedgerHolds([mkPr()], { repo, env: LEDGER, log: () => {}, step: () => { throw new Error('boom'); } });
    if (!thrown[0]?.referralHold) violations.push('a step that threw in ledger mode returned the PR un-held (fail-open)');

    for (const [why, events] of [['no rows at all', []], ['rows for another PR only', [{ ...run(head), pr: 1 }]], ['no run on this head', [run(other)]]]) {
      const [out] = shadow.applyLedgerHolds([mkPr({ referralHold: oldHold })], events, { repo, sources, now: at });
      if (!out.referralHold) violations.push(`ledger mode released the pause today's reader keeps on a ledger with ${why}`);
    }

    const rows = [run(other)];
    const opts = { repo, env: LEDGER, needRuling: () => false, journal: () => {}, snapshot: (r, o) => shadow.ledgerSnapshot(r, { ...o, read: () => ({ sync: { status: 'ok', rows: [...rows] } }) }) };
    shadow.ledgerHoldStep([mkPr()], { ...opts, now: at });
    rows.push(run(head, 5)); // the review dispatched on the first tick has completed
    const second = shadow.ledgerHoldStep([mkPr()], { ...opts, now: at + 1000 }).prs[0];
    if (!second.referralHold) violations.push('ledger mode served a cached read that missed a review run written since the last tick: a second review was owed on an unchanged head');
    return { violations };
  },
  judge(report) { return report.violations; },
};
