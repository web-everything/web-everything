/**
 * @file
 * @description Backfill key recovery, append-order safety, and injected IO tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildLedgerEvent, buildVerdictRecord, parseLedgerEvents } from '../../lib/verdict-ledger.mjs';
import { ledgerFindingKey } from '../../lib/pr-state/referrals.mjs';
import { main, newYorkMidnight, planRulingBackfill } from '../ledger-backfill-rulings.mjs';

const repo = 'o/r';
const since = '2026-10-08T04:00:00.000Z';
const early = '2026-10-08T05:00:00.000Z';
const at = '2026-10-08T06:00:00.000Z';
const late = '2026-10-08T07:00:00.000Z';
const head = 'a'.repeat(40), nextHead = 'b'.repeat(40);
const base = { repo, pr: 7, at, source: 'operator', writer: 'writer', declaredActor: 'human', session: 'session', channel: 'chat' };
const event = (type, payload = {}) => buildLedgerEvent({ ...base, type, ...payload });
const ruling = (payload = {}) => event('ruling', { findingKey: 'raw key', ruling: 'block', ...payload });
const sendBack = (payload = {}) => event('send-back', { cause: 'block-ruling', ...payload });
const review = (payload = {}) => event('review-run', { headSha: head, phase: 'completed', at: late, ...payload });
const referral = (payload = {}) => event('referral', { headSha: head, findingKeys: ['raw key'], at: late, ...payload });
const verdict = (payload = {}) => parseLedgerEvents(JSON.stringify(buildVerdictRecord({ ...base, headSha: head, verdict: 'accepted', at: late, ...payload })))[0];
const plan = (over = {}) => planRulingBackfill({ homeRows: [ruling()], gitRows: [], openPrs: new Set([7]), since, threadKeys: new Map(), ...over });
const skipped = reason => [{ pr: 7, type: 'ruling', at, reason }];

describe('planRulingBackfill', () => {
  it('hashes raw keys and preserves source, actor, writer, timestamp and ruling', () => {
    const original = ruling();
    expect(plan()).toEqual({ append: [{ ...original, findingKey: ledgerFindingKey('raw key') }], skipped: [] });
  });

  it('recovers truncated keys with exact whitespace collapse and duplicate thread entries', () => {
    const key = `  a\n\t${'long '.repeat(60)}end  `;
    const original = ruling({ findingKey: key });
    expect(original.findingKey).toHaveLength(200);
    expect(original.findingKey.endsWith('…')).toBe(true);
    const result = plan({ homeRows: [original], threadKeys: new Map([[7, [key, key]]]) });
    expect(result.append[0].findingKey).toBe(ledgerFindingKey(key));
  });

  it('recovers full whitespace-bearing keys even without truncation', () => {
    const key = ' raw\n\tkey ';
    expect(plan({ threadKeys: new Map([[7, [key]]]) }).append[0].findingKey).toBe(ledgerFindingKey(key));
  });

  it.each([{ keys: [] }, { keys: ['x'.repeat(210), `${'x'.repeat(209)}y`] }])('skips unresolved or ambiguous truncated keys: $keys', ({ keys }) => {
    expect(plan({ homeRows: [ruling({ findingKey: 'x'.repeat(210) })], threadKeys: new Map([[7, keys]]) }))
      .toEqual({ append: [], skipped: skipped('key-truncated-unresolved') });
  });

  it('keeps an already hashed key', () => {
    const row = ruling({ findingKey: ledgerFindingKey('full raw') });
    expect(plan({ homeRows: [row] }).append).toEqual([row]);
  });

  it.each(['raw key', ledgerFindingKey('raw key')])('deduplicates git key %s', findingKey => {
    expect(plan({ gitRows: [ruling({ findingKey })] })).toEqual({ append: [], skipped: skipped('already-in-git') });
  });

  it('deduplicates planned rulings and send-backs but retains distinct causes and times', () => {
    const result = plan({ homeRows: [ruling(), ruling(), sendBack(), sendBack(), sendBack({ cause: 'changes' }), ruling({ at: late })] });
    expect(result.append.map(r => [r.type, r.at, r.cause])).toEqual([
      ['ruling', at, undefined], ['send-back', at, 'block-ruling'], ['send-back', at, 'changes'], ['ruling', late, undefined],
    ]);
    expect(result.skipped.map(r => r.reason)).toEqual(['already-in-git', 'already-in-git']);
    expect(plan({ homeRows: [sendBack()], gitRows: [sendBack()] }).skipped[0].reason).toBe('already-in-git');
  });

  it('excludes closed PRs, older rows and other event types, and sorts candidates', () => {
    const result = plan({ homeRows: [sendBack({ at: late }), ruling({ pr: 8 }), ruling({ at: '2026-10-07T23:00:00Z' }), review(), ruling({ at: since })] });
    expect(result.append.map(r => r.at)).toEqual([since, late]);
    expect(result.skipped).toEqual([]);
  });

  it.each([referral(), referral({ findingKeys: [ledgerFindingKey('raw key')] }), verdict()])('skips a ruling superseded by $type', row => {
    expect(plan({ gitRows: [row] })).toEqual({ append: [], skipped: skipped('out-of-order') });
  });

  it.each([review(), referral({ findingKeys: ['unrelated'] }), verdict({ verdict: 'changes' }), verdict({ pr: 8 }), referral({ at })])('allows unrelated or non-later rows: %j', row => {
    expect(plan({ gitRows: [row] }).append).toHaveLength(1);
  });

  it('skips a send-back when a later row witnesses another head', () => {
    expect(plan({ homeRows: [sendBack()], gitRows: [verdict({ at: early }), review({ headSha: nextHead })] }))
      .toEqual({ append: [], skipped: [{ pr: 7, type: 'send-back', at, reason: 'out-of-order' }] });
  });

  it.each([
    [], [review({ at: early }), review()],
    [verdict({ at: early }), review({ headSha: head.slice(0, 7) })],
    [review({ at: early }), { ...review(), headSha: 'invalid' }],
    [review({ at: early }), { ...review(), headSha: 1234567 }],
    [review({ at: early }), review({ pr: 8, headSha: nextHead })],
    [{ ...verdict({ at: early }), coverage: undefined, headSha: head }, review()],
  ].map(rows => ({ rows })))('keeps send-backs with equal heads or no witnesses: $rows', ({ rows }) => {
    expect(plan({ homeRows: [sendBack()], gitRows: rows }).append).toEqual([sendBack()]);
  });

  it('treats a newly witnessed head as different from unknown', () => {
    expect(plan({ homeRows: [sendBack()], gitRows: [review()] }).skipped[0].reason).toBe('out-of-order');
  });

  it('uses append order, not timestamp order, for the last head witness', () => {
    expect(plan({ homeRows: [sendBack()], gitRows: [review({ headSha: nextHead }), verdict({ at: early })] }).append).toEqual([sendBack()]);
  });
});

function io(over = {}) {
  return {
    repos: [repo], since,
    readHome: vi.fn(() => [ruling(), sendBack()]), resolveBoard: vi.fn(() => '/board'),
    readGit: vi.fn(() => ({ status: 'ok', rows: [] })), listOpenPrs: vi.fn(() => [7]),
    readThreadKeys: vi.fn(() => []), appendGit: vi.fn(rows => ({ ok: true, appended: rows.length })), ...over,
  };
}

describe('main', () => {
  it('dry-runs without appending and reports the plan', async () => {
    const options = io();
    expect(await main(options)).toEqual({ exitCode: 0, results: [{ repo, mode: 'dry-run', candidates: 2, append: 2, skipped: {}, appended: 0 }] });
    expect(options.appendGit).not.toHaveBeenCalled();
    expect(options.readGit).toHaveBeenCalledWith({ board: '/board', repo });
    expect(options.readThreadKeys).toHaveBeenCalledTimes(1);
    expect(options.readThreadKeys).toHaveBeenCalledWith(repo, 7);
  });

  it('applies once with all planned rows', async () => {
    const options = io({ apply: true });
    const result = await main(options);
    expect(options.appendGit).toHaveBeenCalledTimes(1);
    expect(options.appendGit).toHaveBeenCalledWith(plan({ homeRows: options.readHome() }).append, { board: '/board', repo });
    expect(result.results[0]).toMatchObject({ mode: 'apply', appended: 2 });
    expect(result.exitCode).toBe(0);
  });

  it('fetches thread keys only once per eligible raw-key PR', async () => {
    const options = io({ readHome: () => [ruling(), ruling({ at: late }), ruling({ pr: 8 }), ruling({ at: '2026-10-07T00:00:00Z' }), ruling({ pr: 9, findingKey: ledgerFindingKey('key') }), sendBack({ pr: 10 })], listOpenPrs: () => [7, 9, 10] });
    await main(options);
    expect(options.readThreadKeys).toHaveBeenCalledTimes(1);
    expect(options.readThreadKeys).toHaveBeenCalledWith(repo, 7);
  });

  it('does not append an empty plan and aggregates skipped reasons', async () => {
    const options = io({ apply: true, readGit: () => ({ status: 'ok', rows: [ruling(), sendBack()] }) });
    expect((await main(options)).results[0]).toMatchObject({ append: 0, skipped: { 'already-in-git': 2 } });
    expect(options.appendGit).not.toHaveBeenCalled();
  });

  it('refuses unreadable git history', async () => {
    const options = io({ apply: true, readGit: () => ({ status: 'unreadable', reason: 'fetch failed' }) });
    expect(await main(options)).toMatchObject({ exitCode: 1, results: [{ status: 'unreadable', error: 'fetch failed', appended: 0 }] });
    expect(options.appendGit).not.toHaveBeenCalled();
    expect(options.listOpenPrs).not.toHaveBeenCalled();
  });

  it('reports no-board without reading git', async () => {
    const options = io({ apply: true, resolveBoard: () => null });
    expect((await main(options)).results[0].status).toBe('no-board');
    expect(options.readGit).not.toHaveBeenCalled();
    expect(options.appendGit).not.toHaveBeenCalled();
  });

  it('reports append failures with exit code 1', async () => {
    const options = io({ apply: true, appendGit: vi.fn(() => ({ ok: false, appended: 0, error: 'push failed' })) });
    expect(await main(options)).toMatchObject({ exitCode: 1, results: [{ status: 'append-failed', error: 'push failed', appended: 0 }] });
  });

  it('fails closed on a thread read error and continues other repos', async () => {
    const options = io({ apply: true, repos: [repo, 'other/repo'], readThreadKeys: () => { throw new Error('comments unavailable'); } });
    const result = await main(options);
    expect(result.exitCode).toBe(1);
    expect(result.results.map(r => r.status)).toEqual(['error', 'error']);
    expect(options.appendGit).not.toHaveBeenCalled();
  });

  it('rejects an invalid since before IO', async () => {
    const options = io({ since: 'invalid' });
    await expect(main(options)).rejects.toThrow('Invalid --since');
    expect(options.readHome).not.toHaveBeenCalled();
  });
});

describe('New York midnight', () => {
  it.each([
    ['2026-01-15T12:00:00Z', '2026-01-15T05:00:00.000Z'],
    ['2026-07-15T12:00:00Z', '2026-07-15T04:00:00.000Z'],
    ['2026-03-08T12:00:00Z', '2026-03-08T05:00:00.000Z'],
    ['2026-11-01T12:00:00Z', '2026-11-01T04:00:00.000Z'],
    ['2026-10-08T02:00:00Z', '2026-10-07T04:00:00.000Z'],
  ])('resolves %s to %s', (now, expected) => {
    expect(newYorkMidnight(new Date(now))).toBe(expected);
  });
});
