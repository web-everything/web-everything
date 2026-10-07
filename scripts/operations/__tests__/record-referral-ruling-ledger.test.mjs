/**
 * @file record-referral-ruling-ledger.test.mjs — ledger plan slice E1: `record-referral-ruling` appends `ruling`
 *   and `send-back` events to the verdict ledger, additively. The PR comment is still posted exactly as before, and
 *   a ledger write failure follows the F4 write-miss posture (#verdict-ledger-pr-state-store).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord,
} from '../../lib/jury-core.mjs';
import { parseLedgerEvents, verdictLedgerPath } from '../../lib/verdict-ledger.mjs';
import {
  openReferralFindings, planOperatorRuling, recordReferralRulingOperation,
  OPERATOR_RULING_FOLLOW_UP_EFFECT, OPERATOR_RULING_POST_EFFECT, RULING_NEEDED_LABEL,
} from '../record-referral-ruling.mjs';
import { createRecordReferralRulingSinks } from '../record-referral-ruling-io.mjs';

const repo = 'o/r';
const head = 'a'.repeat(40);
const gh = (body, login = 'web-everything') => ({ body, author: { login } });
const f = { summary: 'protected list misses edits', file: 'scripts/x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const seat = 'judgeCorrectnessAdvisory';
const runId = 'review-pr-1';
const reviewer = mandatoryReferralReviewer(runId);
const key = referralFindingKey(seat, f);
const rec = { version: 1, repo, pr: 7, head, runId, reviewer, authorBody: '<!-- authored-by-actor: author -->', attempted: true,
  referrals: [{ key, seat, original: f, finding: normalizeFinding(f) }],
  rulings: [{ id: `${runId}:0`, key, reviewerId: reviewer.id, lens: 'correctness', result: 'block', rationale: 'gap', evidence: ['d'] }] };
const comments = [gh(renderReferralRecord(rec))];
const readCtx = (over = {}) => ({ head, ...openReferralFindings({ comments, repo, pr: 7, head, body: rec.authorBody, cardReadable: () => true }),
  card: null, now: '2026-10-04T14:30:00Z', clearerId: 's', ...over });
const input = (over = {}) => ({ repo, pr: 7, finding: 'all-open', ruling: 'block', actor: 'chalbert', channel: 'chat', reason: 'Fix it', ...over });

/** Run the operation's write step's effects through the real sinks, in order, as the runner would. */
async function drive({ ruling = 'block', card = null, appendEvents, thread = { headRefOid: head, comments: [...comments] }, posts = [], labels = [RULING_NEEDED_LABEL] } = {}) {
  const warnings = [];
  const plan = planOperatorRuling(readCtx({ card }), input({ ruling }));
  const op = recordReferralRulingOperation({ readRulingContext: () => readCtx({ card }) });
  const effects = op.steps.find((x) => x.name === 'write').step.effects({ verdict: plan, input: {} });
  const sinks = createRecordReferralRulingSinks({
    readJson: () => structuredClone(thread),
    post: (_r, _p, body) => { posts.push(body); thread.comments.push(gh(body)); },
    readPr: () => ({ headRefOid: head, labels: labels.map((name) => ({ name })) }),
    runSetLabel: () => '{"ok":true}',
    setLabels: () => {},
    appendEvents, warn: (m) => warnings.push(m), now: () => '2026-10-04T14:31:00Z',
  });
  const results = [];
  for (const e of effects) results.push(await sinks[e.type](e.payload));
  return { results, posts, warnings, plan, effects };
}

describe('ledger plan slice E1: ruling and send-back events', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('a block ruling writes a `ruling` row and a `send-back` row to a real temp ledger, and still posts the comment', async () => {
    dir = mkdtempSync(join(tmpdir(), 'e1-ledger-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
    try {
      const { results, posts, plan } = await drive({ ruling: 'block' });
      expect(posts).toEqual([buildOperatorRulingComment(plan.record)]);
      expect(results[0]).toMatchObject({ posted: true });
      expect(results[1]).toMatchObject({ action: 'send-back', sentBack: true });
      const events = parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8'));
      expect(events.map((e) => e.type)).toEqual(['ruling', 'send-back']);
      expect(events[0]).toMatchObject({ repo, pr: 7, findingKey: key, ruling: 'block', actor: { declared: 'chalbert', channel: 'chat' } });
      expect(events[1]).toMatchObject({ cause: 'block-ruling' });
    } finally { delete process.env.WE_VERDICT_LEDGER_DIR; }
  });

  it('F4: a failed append of a HOLDING block ruling still posts and raises ledger-write-miss', async () => {
    const { results, posts, warnings } = await drive({ ruling: 'block', appendEvents: () => { throw new Error('transport down'); } });
    expect(posts).toHaveLength(1);
    expect(results[0]).toMatchObject({ posted: true, ledgerWriteMiss: true });
    expect(results[1]).toMatchObject({ sentBack: true, ledgerWriteMiss: true });
    expect(warnings.filter((w) => w.startsWith('ledger-write-miss'))).toHaveLength(2);
  });

  it('F4: a failed append of a CLEARING ruling does not clear: nothing is posted, the error is loud', async () => {
    const posts = [];
    const card = { requested: 'x', ref: 'we:backlog/xvm9vbu-follow-up.md', readable: true };
    await expect(drive({ ruling: 'card', card, posts, appendEvents: () => { throw new Error('transport down'); } }))
      .rejects.toThrow(/ledger-write-miss.*does not clear/);
    expect(posts).toEqual([]);
  });

  it('a clearing ruling is recorded BEFORE the comment is posted', async () => {
    const order = [];
    const posts = { push: (b) => order.push('post') };
    await drive({ ruling: 'not-real', appendEvents: (ev) => order.push(`ledger:${ev[0].ruling}`), posts }).catch(() => {});
    expect(order).toEqual(['ledger:not-real', 'post']);
  });
});
