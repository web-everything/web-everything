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
import { buildLedgerEvent, parseLedgerEvents, verdictLedgerPath } from '../../lib/verdict-ledger.mjs';
import {
  openReferralFindings, planOperatorRuling, recordReferralRulingOperation,
  OPERATOR_RULING_FOLLOW_UP_EFFECT, OPERATOR_RULING_POST_EFFECT, RULING_NEEDED_LABEL,
} from '../record-referral-ruling.mjs';
import { appendLedgerEvents, createRecordReferralRulingSinks } from '../record-referral-ruling-io.mjs';
import { ledgerFindingKey } from '../../lib/pr-state/referrals.mjs';
import { registerLedgerStore } from '../../lib/verdict-ledger-store.mjs';

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
      expect(events[0]).toMatchObject({ repo, pr: 7, findingKey: ledgerFindingKey(key), ruling: 'block', actor: { declared: 'chalbert', channel: 'chat' } });
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

  it('a batch of CLEARING rulings stops at the first miss: later rows are not written, nothing is posted', async () => {
    const posts = [];
    const attempted = [];
    const sinks = createRecordReferralRulingSinks({
      readJson: () => ({ headRefOid: head, comments: [] }), post: (_r, _p, b) => posts.push(b),
      appendEvents: (list) => { attempted.push(...list.map((e) => e.findingKey)); throw new Error('transport down'); },
      warn: () => {}, now: () => '2026-10-04T14:31:00Z',
    });
    await expect(sinks[OPERATOR_RULING_POST_EFFECT]({ repo, pr: 7, head, body: 'b', actor: 'a', channel: 'chat',
      rulings: [{ key: 'k1', result: 'card' }, { key: 'k2', result: 'not-real' }] })).rejects.toThrow(/does not clear/);
    expect(attempted).toEqual([ledgerFindingKey('k1')]);
    expect(posts).toEqual([]);
  });

  it('a clearing ruling is recorded BEFORE the comment is posted', async () => {
    const order = [];
    const posts = { push: (b) => order.push('post') };
    await drive({ ruling: 'not-real', appendEvents: (ev) => order.push(`ledger:${ev[0].ruling}`), posts }).catch(() => {});
    expect(order).toEqual(['ledger:not-real', 'post']);
  });

  it('the ruling row names the finding by the SAME hashed key the referral row uses, never the raw key', async () => {
    const seen = [];
    await drive({ ruling: 'block', appendEvents: (ev) => { seen.push(...ev); } });
    const row = seen.find((e) => e.type === 'ruling');
    expect(row.findingKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.findingKey).toBe(ledgerFindingKey(key));
    expect(row.findingKey).not.toBe(key);
  });
});

describe('the default writer reaches the shared git store (slice H shadow: no ruling rows on ops/review-requests)', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
  const rows = () => [
    buildLedgerEvent({ type: 'ruling', repo, pr: 7, at: '2026-10-04T14:31:00Z', source: 'record-referral-ruling', declaredActor: 'chalbert', channel: 'chat', findingKey: ledgerFindingKey(key), ruling: 'not-real' }),
    buildLedgerEvent({ type: 'send-back', repo, pr: 7, at: '2026-10-04T14:31:01Z', source: 'record-referral-ruling', declaredActor: 'chalbert', channel: 'chat', cause: 'block-ruling' }),
  ];

  it('every ruling and send-back event is appended to the git store AND the home file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'e1-git-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
    try {
      const git = [];
      await appendLedgerEvents(rows(), { store: 'dual', board: dir, gitAppend: ({ records }) => { git.push(...records); return { rows: records.length, duplicates: 0 }; } });
      expect(git.map((r) => r.type)).toEqual(['ruling', 'send-back']);
      expect(git[0]).toMatchObject({ findingKey: ledgerFindingKey(key), ruling: 'not-real' });
      expect(parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8')).map((e) => e.type)).toEqual(['ruling', 'send-back']);
    } finally { delete process.env.WE_VERDICT_LEDGER_DIR; }
  });

  it('a git miss throws, so the caller applies F4 (a clearing ruling then does not clear)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'e1-git-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
    try {
      await expect(appendLedgerEvents(rows().slice(0, 1), { store: 'dual', board: dir, warn: () => {},
        gitAppend: () => { throw new Error('push rejected'); } })).rejects.toThrow(/push rejected|refused/);
      await expect(appendLedgerEvents(rows().slice(1), { store: 'dual', board: dir, warn: () => {},
        gitAppend: () => { throw new Error('push rejected'); } })).rejects.toThrow(/git store write missed/);
    } finally { delete process.env.WE_VERDICT_LEDGER_DIR; }
  });

  const holdingRows = (n) => Array.from({ length: n }, (_, i) => buildLedgerEvent({ type: 'ruling', repo, pr: 7, at: `2026-10-04T14:31:0${i}Z`,
    source: 'record-referral-ruling', declaredActor: 'chalbert', channel: 'chat', findingKey: ledgerFindingKey(`${key}-${i}`), ruling: 'block' }));

  it('a git miss on the FIRST event of a batch still writes every other event (home rows kept), then throws one aggregate error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'e1-git-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
    try {
      const attempts = [];
      let calls = 0;
      await expect(appendLedgerEvents(holdingRows(3), { store: 'dual', board: dir, warn: () => {},
        gitAppend: ({ records }) => { attempts.push(...records); if (calls++ === 0) throw new Error('push rejected'); return { rows: records.length, duplicates: 0 }; } }))
        .rejects.toThrow(/1 of 3 ledger events failed.*push rejected/);
      expect(attempts).toHaveLength(3);
      expect(parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8')).map((e) => e.findingKey))
        .toEqual(holdingRows(3).map((e) => e.findingKey));
    } finally { delete process.env.WE_VERDICT_LEDGER_DIR; }
  });

  it('a refused row does not stop the rest of the batch either', async () => {
    dir = mkdtempSync(join(tmpdir(), 'e1-git-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
    try {
      const [a, b] = holdingRows(2);
      await expect(appendLedgerEvents([{ ...a, type: 'not-a-type' }, b], { store: 'home' })).rejects.toThrow(/1 of 2 ledger events failed.*refused/);
      expect(parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8')).map((e) => e.findingKey)).toEqual([b.findingKey]);
    } finally { delete process.env.WE_VERDICT_LEDGER_DIR; }
  });

  it('writes through a registered ASYNC store (appendVerdict would refuse a plugged store)', async () => {
    const stored = [];
    registerLedgerStore({
      name: 'async-ruling-store',
      capabilities: { durable: true, shared: true, ordering: 'total', singleWriter: 'push-race-retry' },
      append: async (r) => { stored.push(...r); return { ok: true, appended: r.length }; },
      read: async () => ({ status: 'ok', rows: stored }),
    });
    await appendLedgerEvents(holdingRows(2), { store: 'async-ruling-store', env: {}, warn: () => {} });
    expect(stored.map((r) => r.findingKey)).toEqual(holdingRows(2).map((e) => e.findingKey));
  });

  it('with NO store named, a ruling still reaches both the home file and the git store (the default is dual)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'e1-git-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
    try {
      const git = [];
      // `env: {}` is the production shape: no store named, not under test. Only the transport seams are injected.
      await appendLedgerEvents(rows(), { env: {}, board: dir, warn: () => {},
        gitAppend: ({ records }) => { git.push(...records); return { rows: records.length, duplicates: 0 }; } });
      expect(git.map((r) => r.type)).toEqual(['ruling', 'send-back']);
      expect(parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8')).map((e) => e.type)).toEqual(['ruling', 'send-back']);
    } finally { delete process.env.WE_VERDICT_LEDGER_DIR; }
  });
});
