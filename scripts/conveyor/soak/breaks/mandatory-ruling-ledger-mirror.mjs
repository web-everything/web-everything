/** PR #5550: settled mandatory findings raised ruling-needed because their rulings were absent
 * from the verdict ledger, or arrived before the first referral. Exercise the real sinks and
 * mirror over an in-memory forge/store; no git, network, reviewer process or label side effects.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Shared by the settled-ruling replay and the forced-drift isolation probe.
export function mirrorFixtureOptions({ repo, pr, rows, facts, labels, writes, append, buildDerivedRows }) {
  return { repo, selfLogin: 'mirror',
    listPrs: () => [{ number: pr, labels: [...labels].map(name => ({ name })) }],
    readEvents: async () => ({ status: 'ok', rows: [...rows] }),
    buildRows: o => buildDerivedRows({ ...o, readFacts: () => facts }), readFacts: () => facts,
    readTimeline: async () => ({ status: 'ok', items: [] }), appendRow: async row => append(row),
    addLabel: async (_repo, _pr, name) => { labels.add(name); writes.push(name); },
    setRulingLabel: async (_repo, _pr, wanted) => {
      const name = 'advisory:ruling-needed';
      if (wanted) { labels.add(name); writes.push(name); }
      else labels.delete(name);
    },
  };
}

export default {
  id: 'mandatory-ruling-ledger-mirror',
  title: 'settled mandatory rulings survive the delayed referral and repeated label-mirror passes',
  card: '5647 / PR #5550 post-accept red team',
  fixedBy: { sha: 'pending', where: 'lane/ruling-needed-writer', paths: [
    'scripts/operations/review-pr-io.mjs', 'scripts/lib/pr-state/referrals.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/operations/review-pr-io.mjs'), 'utf8').includes('mandatory-ruling:')
      && readFileSync(join(root, 'scripts/lib/pr-state/referrals.mjs'), 'utf8').includes('const earlyRulings = new Map()')
      && readFileSync(join(root, 'scripts/lib/pr-state/referrals.mjs'), 'utf8').includes('REFERRAL_RETIRED_CHANNEL');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const load = rel => import(pathToFileURL(join(root, rel)).href);
    const { createReviewPrSinks } = await load('scripts/operations/review-pr-io.mjs');
    const { REVIEW_EFFECTS } = await load('scripts/operations/review-pr.mjs');
    const { buildLedgerEvent, buildVerdictRecord } = await load('scripts/lib/verdict-ledger.mjs');
    const { referralFindingKey } = await load('scripts/lib/jury-core.mjs');
    const { ledgerFindingKey, deriveReferrals } = await load('scripts/lib/pr-state/referrals.mjs');
    const { runMirrorApply } = await load('scripts/conveyor/pr-label-mirror.mjs');
    const { buildDerivedRows } = await load('scripts/review-ledger-check.mjs');
    const violations = [];
    const repo = 'example/ruling-mirror', pr = 7, head = 'a'.repeat(40);
    const at = '2026-10-18T01:34:42Z';
    for (const mode of ['mandatory', 'early-operator']) {
      for (const result of ['not-real', 'card', 'block']) {
        const rows = [], labels = new Set(), writes = [];
        const state = { headRefOid: head, body: '<!-- authored-by-actor: author -->', comments: [], labels: ['review:pending'] };
        const referral = { seat: 'judgeCorrectnessAdvisory', original: {
          summary: 'settled finding', file: 'x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken',
        } };
        const key = referralFindingKey(referral.seat, referral.original);
        const append = row => { if (!rows.some(r => r.id === row.id)) rows.push(row); return { ok: true }; };
        const provider = {
          readPrState: () => structuredClone(state),
          postComment: (_repo, _pr, body) => state.comments.push({ id: `c-${state.comments.length}`, body, author: { login: 'web-everything' } }),
          editComment: (id, body) => { state.comments.find(c => c.id === id).body = body; },
          setLabels: (_repo, _pr, plan) => { state.labels = [...state.labels.filter(l => !(plan.remove ?? []).includes(l)), plan.add]; },
        };
        const sinks = createReviewPrSinks({ root, labelProvider: provider, mirrorReferral: () => {},
          postComment: provider.postComment, readLabels: () => [...state.labels], setLabels: provider.setLabels,
          readChangedLines: () => new Set(),
          runNode: () => { throw new Error('unexpected node process in isolated soak'); },
          appendLedgerRow: append, cardReadable: () => true, out: () => {},
          referralJudge: async request => ({ sessionId: request.sessionId, value: { rulings: [{
            key, result, rationale: 'checked pinned diff', evidence: ['diff:x'], card: result === 'card' ? 'we:backlog/7-filed.md' : '',
          }] } }),
        });
        if (mode === 'mandatory') {
          const payload = { read: { repo, pr, title: 'review', body: state.body,
            netBasis: { rev: head }, netChangedFiles: ['x.mjs'], diffText: '+ change' }, referrals: [referral] };
          for (let retry = 0; retry < 2; retry++) {
            const settled = await sinks[REVIEW_EFFECTS.MANDATORY_REFERRALS](payload, { runId: 'soak-ruling-mirror' });
            if (settled.pending.length) violations.push(`${mode}/${result}: mandatory sink did not settle: ${settled.pending}`);
          }
          if (rows.filter(r => r.type === 'ruling').length !== 1) violations.push(`${mode}/${result}: expected one replay-safe ruling row`);
        } else {
          rows.push(buildLedgerEvent({ type: 'ruling', repo, pr, at, source: 'record-referral-ruling', findingKey: ledgerFindingKey(key), ruling: result }));
        }
        // This is review-pr's actual final sink, which runs after the public comment can be ruled on.
        const ledgerPayload = { repo, pr, headSha: head, referralKeys: [key], posted: true,
          syncMandatoryRulings: mode === 'mandatory' };
        await sinks[REVIEW_EFFECTS.LEDGER_EVENTS](ledgerPayload, { key: `${mode}/${result}/ledger` });
        if (mode === 'mandatory') {
          await sinks[REVIEW_EFFECTS.MANDATORY_REFERRALS]({ read: { repo, pr, title: 'review', body: state.body,
            netBasis: { rev: head }, netChangedFiles: ['x.mjs'], diffText: '+ change' }, referrals: [referral] }, { runId: 'soak-next-review' });
          await sinks[REVIEW_EFFECTS.LEDGER_EVENTS](ledgerPayload, { key: `${mode}/${result}/next-ledger` });
        }
        if (deriveReferrals(rows).get(ledgerFindingKey(key))?.state !== (result === 'block' ? 'blocking' : 'ruled')) {
          violations.push(`${mode}/${result}: delayed referral lost the recorded ruling`);
        }
        rows.push({ type: 'verdict', ...buildVerdictRecord({ repo, pr, at, verdict: 'accepted', headSha: head, source: 'review-set-label', reason: 'same-head accept' }) });
        const facts = { state: 'OPEN', isDraft: false, headSha: head, head: { sha: head }, labels: [], checks: [],
          requiredChecks: [{ name: 'test', state: 'green' }], probeErrors: [], sessions: [], handoffs: [], refusals: [] };
        for (let pass = 0; pass < 2; pass++) {
          const out = await runMirrorApply(mirrorFixtureOptions({ repo, pr, rows, facts, labels, writes, append, buildDerivedRows }));
          if (out.failures.length) violations.push(`${mode}/${result}: mirror failed: ${JSON.stringify(out.failures)}`);
        }
        if (writes.includes('advisory:ruling-needed') || (result !== 'block' && writes.includes('review:human'))) {
          violations.push(`${mode}/${result}: settled finding requested false labels: ${writes.join(', ')}`);
        }
      }
    }
    // Round 3: a disabled seat's retired finding, and an operator block that lands while the sync appends.
    const { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, renderReferralRecord } = await load('scripts/lib/jury-core.mjs');
    for (const mode of ['retired', 'operator-race']) {
      const rows = [], labels = new Set(), writes = [];
      const state = { headRefOid: head, body: '<!-- authored-by-actor: author -->', comments: [], labels: ['review:pending'] };
      const seat = mode === 'retired' ? 'judgeAntigravityReview' : 'judgeCorrectnessAdvisory';
      const referrals = [0, 1].slice(0, mode === 'retired' ? 1 : 2).map(i => {
        const original = { summary: `finding ${i}`, file: 'x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
        return { seat, original, finding: normalizeFinding(original), key: referralFindingKey(seat, original) };
      });
      const record = { version: 1, repo, pr, head, runId: 'soak-earlier', reviewer: mandatoryReferralReviewer('soak-earlier'),
        authorBody: state.body, attempted: true, referrals, rulings: [] };
      if (mode === 'operator-race') record.rulings = referrals.map((f, i) => ({ id: `r${i + 1}`, key: f.key,
        reviewerId: record.reviewer.id, lens: record.reviewer.lens, result: 'not-real', rationale: 'checked', evidence: ['diff:x'] }));
      state.comments.push({ id: 'c-record', body: renderReferralRecord(record), author: { login: 'web-everything' } });
      let raced = false;
      const append = row => {
        if (!rows.some(r => r.id === row.id)) rows.push(row);
        if (mode === 'operator-race' && row.type === 'ruling' && !raced) {
          raced = true;
          state.comments.push({ id: 'c-operator', author: { login: 'chalbert' }, body: buildOperatorRulingComment({
            version: 1, repo, pr, head, actor: 'chalbert', channel: 'soak', reason: 'still broken', at, clearerId: '',
            rulings: [{ runId: record.runId, key: referrals[1].key, result: 'block', supersedes: ['r2'] }] }) });
          rows.push(buildLedgerEvent({ type: 'ruling', repo, pr, at, source: 'record-referral-ruling',
            findingKey: ledgerFindingKey(referrals[1].key), ruling: 'block' }));
        }
        return { ok: true };
      };
      const provider = {
        readPrState: () => structuredClone(state),
        postComment: (_repo, _pr, body) => state.comments.push({ id: `c-${state.comments.length}`, body, author: { login: 'web-everything' } }),
        editComment: (id, body) => { state.comments.find(c => c.id === id).body = body; },
        setLabels: (_repo, _pr, plan) => { state.labels = [...state.labels.filter(l => !(plan.remove ?? []).includes(l)), plan.add]; },
      };
      const sinks = createReviewPrSinks({ root, labelProvider: provider, mirrorReferral: () => {},
        postComment: provider.postComment, readLabels: () => [...state.labels], setLabels: provider.setLabels,
        readChangedLines: () => new Set(), appendLedgerRow: append, cardReadable: () => true, out: () => {},
        env: mode === 'retired' ? { REVIEW_PR_ANTIGRAVITY_REVIEW: '0', WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' } : {},
        runNode: () => { throw new Error('unexpected node process in isolated soak'); },
        referralJudge: async () => { throw new Error('no mandatory reviewer expected'); } });
      const ledgerPayload = { repo, pr, headSha: head, referralKeys: referrals.map(f => f.key), posted: true, syncMandatoryRulings: true };
      await sinks[REVIEW_EFFECTS.LEDGER_EVENTS](ledgerPayload, { key: `${mode}/ledger` });
      await sinks[REVIEW_EFFECTS.MANDATORY_REFERRALS]({ read: { repo, pr, title: 'review', body: state.body,
        netBasis: { rev: head }, netChangedFiles: ['x.mjs'], diffText: '+ change' }, referrals: [] }, { runId: `soak-${mode}` });
      rows.push({ type: 'verdict', ...buildVerdictRecord({ repo, pr, at, verdict: 'accepted', headSha: head, source: 'review-set-label', reason: 'same-head accept' }) });
      const facts = { state: 'OPEN', isDraft: false, headSha: head, head: { sha: head }, labels: [], checks: [],
        requiredChecks: [{ name: 'test', state: 'green' }], probeErrors: [], sessions: [], handoffs: [], refusals: [] };
      const out = await runMirrorApply(mirrorFixtureOptions({ repo, pr, rows, facts, labels, writes, append, buildDerivedRows }));
      if (out.failures.length) violations.push(`${mode}: mirror failed: ${JSON.stringify(out.failures)}`);
      const derived = deriveReferrals(rows);
      if (mode === 'retired' && (writes.includes('advisory:ruling-needed') || writes.includes('review:human'))) {
        violations.push(`retired: a retired finding requested false labels: ${writes.join(', ')}`);
      }
      if (mode === 'operator-race' && derived.get(ledgerFindingKey(referrals[1].key))?.state !== 'blocking') {
        violations.push('operator-race: a stale clearance overtook the operator block in the ledger');
      }
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
