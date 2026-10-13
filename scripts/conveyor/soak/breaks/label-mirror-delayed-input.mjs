/** PR #5083: a delayed observation re-held a cleared PR, and backward pages lost a same-second addition. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'label-mirror-delayed-input',
  title: 'Label mirror respects clear-human during a pass and connection order across timeline pages',
  card: '5649 (PR #5083)',
  fixedBy: { sha: 'HEAD', where: 'lane/5649-ledger-k-approvals-label-input', paths: ['scripts/conveyor/pr-label-mirror.mjs', 'scripts/lib/verdict-ledger.mjs', 'scripts/lib/pr-state/holds/label-input.mjs'] },
  fixPresent(root) {
    const src = readFileSync(join(root, 'scripts/conveyor/pr-label-mirror.mjs'), 'utf8');
    return src.includes('items.unshift(') && src.includes('clearanceBaseline');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const load = (rel) => import(pathToFileURL(join(root, rel)).href);
    const { runMirrorApply, readLabelTimeline, planLabelInputRows } = await load('scripts/conveyor/pr-label-mirror.mjs');
    const { buildVerdictRecord, buildLedgerEvent } = await load('scripts/lib/verdict-ledger.mjs');
    const { buildDerivedRows } = await load('scripts/review-ledger-check.mjs');
    const { derivePrState } = await load('scripts/lib/pr-state.mjs');
    const repo = 'example/mirror-soak', pr = 7, head = 'a'.repeat(40);
    const facts = { repo, pr, headSha: head, head: { sha: head }, checks: [], requiredChecks: [], probeErrors: [], now: Date.parse('2026-10-12T13:00:00Z') };
    const verdict = (value, at) => ({ type: 'verdict', ...buildVerdictRecord({ repo, pr, verdict: value, at, reason: 'soak', headSha: head, declaredActor: 'op', session: 'soak', channel: 'chat', source: 'review-set-label' }) });
    const violations = [];
    // The critical window is INSIDE the append, after the mirror's last ledger read.
    for (const sameSecond of [false, true]) {
      const rows = [verdict('human', '2026-10-12T10:00:00Z')];
      const clear = () => {
        rows.push(verdict('clear-human', '2026-10-12T12:00:00.100Z'));
        rows.push(buildLedgerEvent({ type: 'approval', repo, pr, at: '2026-10-12T12:00:00.100Z', source: 'review-set-label', approval: 'clear-human' }));
      };
      if (sameSecond) clear();
      const items = sameSecond
        ? [{ id: 'removal', label: 'review:human', change: 'removed', actor: 'mirror', createdAt: '2026-10-12T12:00:00Z' },
          { id: 'addition', label: 'review:human', change: 'added', actor: 'operator', createdAt: '2026-10-12T12:00:00Z' }]
        : [{ id: 'historical', label: 'review:human', change: 'added', actor: 'operator', createdAt: '2026-10-12T11:00:00Z' }];
      const out = await runMirrorApply({ repo, selfLogin: 'mirror',
        listPrs: () => [{ number: pr, labels: ['review:human'] }],
        readEvents: async () => ({ status: 'ok', rows: [...rows] }),
        buildRows: o => buildDerivedRows({ ...o, readFacts: () => facts }),
        readFacts: () => facts, readTimeline: async () => ({ status: 'ok', items }),
        appendRow: async row => { if (!sameSecond) clear(); rows.push(row); return { ok: true }; },
        addLabel: async () => { violations.push('unexpected label write'); },
      });
      const held = derivePrState(rows, facts, {}).holds.some(h => h.code === 'label-input:review:human');
      if (out.failures.length || out.rowsAppended.length !== 1 || held !== sameSecond) {
        violations.push(sameSecond ? 'same-second readdition was discarded' : 'clearance inside append resurrected hold');
      }
    }
    // Exercise both a finished label swap and labels still lagging behind the approval append.
    for (const [swap, approval] of [[true, true], [false, true], [false, false]]) {
      const rows = [verdict('human', '2026-10-12T10:00:00Z')];
      let labels = ['review:human'], writes = 0;
      const out = await runMirrorApply({
        repo, listPrs: () => [{ number: pr, labels: [...labels] }], selfLogin: 'mirror',
        readEvents: async () => ({ status: 'ok', rows: [...rows] }),
        buildRows: (o) => buildDerivedRows({ ...o, readFacts: () => facts }),
        readFacts: () => facts,
        readTimeline: async () => {
          rows.push(verdict('clear-human', '2026-10-12T12:00:00Z'));
          if (approval) rows.push(buildLedgerEvent({ type: 'approval', repo, pr, at: '2026-10-12T12:00:00Z', source: 'review-set-label', approval: 'clear-human' }));
          if (swap) labels = ['review:accepted'];
          return { status: 'ok', items: [{ label: 'review:human', change: 'added', actor: 'operator', actorType: 'User', createdAt: '2026-10-12T10:00:00Z' }] };
        },
        appendRow: async (row) => { writes += 1; rows.push(row); return { ok: true }; },
        addLabel: async () => { writes += 1; },
      });
      if (out.failures.length || writes || !derivePrState(rows, facts, {}).clears) violations.push(`delayed addition resurrected the cleared hold (label swap=${swap}, approval=${approval})`);
    }
    const node = (change, label, at) => ({ __typename: change === 'added' ? 'LabeledEvent' : 'UnlabeledEvent', createdAt: at, label: { name: label }, actor: { __typename: 'User', login: 'operator' } });
    const chronological = [node('added', 'review:human', '2026-10-12T09:00:00Z'), node('removed', 'review:human', '2026-10-12T10:00:00Z'), node('added', 'review:human', '2026-10-12T10:00:00Z'), ...Array.from({ length: 99 }, () => node('added', 'bug', '2026-10-12T11:00:00Z'))];
    let page = 0;
    const timeline = await readLabelTimeline({ repo, pr, read: () => JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
      nodes: page++ === 0 ? chronological.slice(2) : chronological.slice(0, 2), pageInfo: { hasPreviousPage: page === 1, startCursor: 'older' },
    } } } } }) });
    const planned = planLabelInputRows({ repo, pr, items: timeline.items, liveLabels: ['review:human'], selfLogin: 'mirror' });
    if (timeline.status !== 'ok' || planned.length !== 1 || planned[0].change !== 'added') violations.push('older same-second removal displaced the latest addition across pages');
    return { violations };
  },
  judge(report) { return report.violations; },
};
