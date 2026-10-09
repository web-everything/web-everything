/**
 * @file
 * @description Backfill key recovery, append-order safety, and injected IO tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildLedgerEvent, buildVerdictRecord, ledgerEventId, parseLedgerEvents } from '../../lib/verdict-ledger.mjs';
import { deriveReferrals, ledgerFindingKey } from '../../lib/pr-state/referrals.mjs';
import { main, newYorkMidnight, planRawKeyMigration, planRulingBackfill } from '../ledger-backfill-rulings.mjs';

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
const plan = (over = {}) => planRulingBackfill({ homeRows: [ruling()], gitRows: [], openPrs: new Set([7]), since, threadRulings: new Map(), ...over });
const skipped = reason => [{ pr: 7, type: 'ruling', at, reason }];
// The thread entries a posted ruling comment yields: the raw key and the result the operator ruled.
const posted = (row, key = 'raw key') => new Map([[row.pr, [{ key, result: row.ruling }]]]);

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
    const result = plan({ homeRows: [original], threadRulings: new Map([[7, [{ key, result: 'block' }, { key, result: 'block' }]]]) });
    expect(result.append[0].findingKey).toBe(ledgerFindingKey(key));
  });

  it('recovers full whitespace-bearing keys even without truncation', () => {
    const key = ' raw\n\tkey ';
    expect(plan({ threadRulings: new Map([[7, [{ key, result: 'block' }]]]) }).append[0].findingKey).toBe(ledgerFindingKey(key));
  });

  it.each([{ keys: [] }, { keys: ['x'.repeat(210), `${'x'.repeat(209)}y`] }])('skips unresolved or ambiguous truncated keys: $keys', ({ keys }) => {
    expect(plan({ homeRows: [ruling({ findingKey: 'x'.repeat(210) })], threadRulings: new Map([[7, keys.map(key => ({ key, result: 'block' }))]]) }))
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

  it.each([
    ['not-real', 'block', 'raw key'], ['block', 'not-real', 'raw key'], ['card', 'block', 'raw key'],
    ['not-real', 'block', ledgerFindingKey('raw key')], ['block', 'not-real', ledgerFindingKey('raw key')],
  ])('skips a %s ruling superseded by a later git %s ruling for the same finding (%s)', (homeResult, gitResult, gitKey) => {
    const row = ruling({ ruling: homeResult });
    expect(plan({ homeRows: [row], gitRows: [ruling({ ruling: gitResult, findingKey: gitKey, at: late })], threadRulings: posted(row) }))
      .toEqual({ append: [], skipped: skipped('out-of-order') });
  });

  it('keeps a ruling when the later git ruling names a different finding or another PR', () => {
    expect(plan({ gitRows: [ruling({ findingKey: 'other key', at: late })] }).append).toHaveLength(1);
    expect(plan({ gitRows: [ruling({ pr: 8, at: late })] }).append).toHaveLength(1);
  });

  it('keeps a ruling that is later than the git ruling for the same finding', () => {
    expect(plan({ homeRows: [ruling({ at: late })], gitRows: [ruling({ ruling: 'not-real', at: early })], threadRulings: posted(ruling({ at: late })) }).append).toHaveLength(1);
  });

  it('treats an equal-timestamp git ruling for the same finding as already-in-git, never appended', () => {
    expect(plan({ gitRows: [ruling({ ruling: 'not-real' })] })).toEqual({ append: [], skipped: skipped('already-in-git') });
  });

  it.each(['not-real', 'card'])('skips an unposted %s ruling that no thread comment backs', result => {
    const row = ruling({ ruling: result, findingKey: ledgerFindingKey('raw key') });
    expect(plan({ homeRows: [row], threadRulings: new Map() })).toEqual({ append: [], skipped: skipped('unposted') });
    expect(plan({ homeRows: [row], threadRulings: new Map([[7, []]]) })).toEqual({ append: [], skipped: skipped('unposted') });
  });

  it.each([
    ['another finding', { key: 'other', result: 'not-real' }],
    ['a different result for the finding', { key: 'raw key', result: 'block' }],
    ['another PR', null],
  ])('does not let a thread entry for %s back a clearing ruling', (_, entry) => {
    const threadRulings = new Map([[entry ? 7 : 8, [entry ?? { key: 'raw key', result: 'not-real' }]]]);
    expect(plan({ homeRows: [ruling({ ruling: 'not-real' })], threadRulings })).toEqual({ append: [], skipped: skipped('unposted') });
  });

  it('keeps a clearing ruling a thread comment backs, raw or hashed in the home row', () => {
    const threadRulings = new Map([[7, [{ key: 'raw key', result: 'not-real' }]]]);
    expect(plan({ homeRows: [ruling({ ruling: 'not-real' })], threadRulings }).append).toHaveLength(1);
    expect(plan({ homeRows: [ruling({ ruling: 'not-real', findingKey: ledgerFindingKey('raw key') })], threadRulings }).append).toHaveLength(1);
  });

  it('does not require a thread comment for a block ruling', () => {
    expect(plan({ threadRulings: new Map() }).append).toHaveLength(1);
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
    readThreadRulings: vi.fn(() => []), appendGit: vi.fn(rows => ({ ok: true, appended: rows.length })), ...over,
  };
}

describe('main', () => {
  it('dry-runs without appending and reports the plan', async () => {
    const options = io();
    expect(await main(options)).toEqual({ exitCode: 0, results: [{ repo, mode: 'dry-run', candidates: 2, append: 2, skipped: {}, appended: 0 }] });
    expect(options.appendGit).not.toHaveBeenCalled();
    expect(options.readGit).toHaveBeenCalledWith({ board: '/board', repo });
    expect(options.readThreadRulings).toHaveBeenCalledTimes(1);
    expect(options.readThreadRulings).toHaveBeenCalledWith(repo, 7);
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
    expect(options.readThreadRulings).toHaveBeenCalledTimes(1);
    expect(options.readThreadRulings).toHaveBeenCalledWith(repo, 7);
  });

  it('fetches the thread for a hashed clearing ruling and appends only the one a comment backs', async () => {
    const hashedKey = ledgerFindingKey('raw key');
    const options = io({
      apply: true, listOpenPrs: () => [7, 9],
      readHome: () => [ruling({ ruling: 'not-real', findingKey: hashedKey }), ruling({ pr: 9, ruling: 'not-real', findingKey: hashedKey })],
      readThreadRulings: vi.fn((_, pr) => (pr === 7 ? [{ key: 'raw key', result: 'not-real' }] : [])),
    });
    const result = await main(options);
    expect(options.readThreadRulings).toHaveBeenCalledTimes(2);
    expect(result.results[0]).toMatchObject({ append: 1, appended: 1, skipped: { unposted: 1 } });
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
    const options = io({ apply: true, repos: [repo, 'other/repo'], readThreadRulings: () => { throw new Error('comments unavailable'); } });
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

describe('planRawKeyMigration (raw-key ruling rows already on the git store)', () => {
  const twin = (row = ruling(), findingKey = ledgerFindingKey('raw key')) => ({ ...row, findingKey });
  const migrate = (gitRows, threadRulings = new Map()) => planRawKeyMigration({ gitRows, threadRulings });

  it('appends a hashed twin of a raw-key row: same time, source, writer, actor and ruling', () => {
    const raw = ruling({ ruling: 'card' });
    expect(migrate([raw], posted(raw))).toEqual({ append: [twin(raw)], skipped: [], candidates: 1 });
  });

  it('migrated twin closes the hashed referral; the raw row alone does not', () => {
    const open = referral({ findingKeys: [ledgerFindingKey('raw key')], at: early });
    const raw = ruling();
    const rawOnly = deriveReferrals([open, raw]).get(ledgerFindingKey('raw key'));
    const migrated = deriveReferrals([open, raw, ...migrate([open, raw]).append]).get(ledgerFindingKey('raw key'));
    expect([rawOnly.state, migrated.state]).toEqual(['open', 'blocking']);
  });

  it('is idempotent: a second plan over the store with the twin appended adds nothing', () => {
    const raw = ruling();
    const first = migrate([raw]);
    expect(migrate([raw, ...first.append])).toEqual({ append: [], skipped: skipped('already-in-git'), candidates: 1 });
  });

  it('gives the twin the same event id on every run (the store dedupes a racing re-run)', () => {
    const a = migrate([ruling()]).append[0], b = migrate([ruling()]).append[0];
    expect(ledgerEventId(a)).toBe(ledgerEventId(b));
  });

  it('leaves hashed rows and other row types alone', () => {
    expect(migrate([ruling({ findingKey: ledgerFindingKey('k') }), sendBack(), review()])).toEqual({ append: [], skipped: [], candidates: 0 });
  });

  it('does not treat an equal-time hashed ruling with a different result as already migrated, and does not overwrite it', () => {
    expect(migrate([ruling(), twin(ruling({ ruling: 'not-real' }))])).toEqual({ append: [], skipped: skipped('out-of-order'), candidates: 1 });
  });

  it('recovers a truncated raw key from the thread, and skips it when the thread cannot resolve it', () => {
    const key = `${'long '.repeat(60)}end`;
    const raw = ruling({ findingKey: key });
    expect(raw.findingKey.endsWith('…')).toBe(true);
    expect(migrate([raw], new Map([[7, [{ key, result: 'block' }]]])).append[0].findingKey).toBe(ledgerFindingKey(key));
    expect(migrate([raw])).toEqual({ append: [], skipped: skipped('key-truncated-unresolved'), candidates: 1 });
  });

  it.each([referral({ findingKeys: [ledgerFindingKey('raw key')], at: late }), verdict(), ruling({ ruling: 'not-real', at: late })])('skips a twin superseded by a later %#', later => {
    expect(migrate([ruling(), later], posted(ruling({ ruling: 'not-real' }))).skipped).toEqual(skipped('out-of-order'));
  });

  it.each(['not-real', 'card'])('refuses an unbacked raw %s ruling (no thread comment): the raw row is inert, its twin would be live', result => {
    const raw = ruling({ ruling: result });
    expect(migrate([raw])).toEqual({ append: [], skipped: skipped('unposted'), candidates: 1 });
    // A comment for another key, or another result, does not back it either.
    expect(migrate([raw], new Map([[7, [{ key: 'other key', result }, { key: 'raw key', result: result === 'card' ? 'not-real' : 'card' }]]])).skipped).toEqual(skipped('unposted'));
  });

  it.each(['not-real', 'card'])('migrates a raw %s ruling that a thread comment backs (same key and result)', result => {
    const raw = ruling({ ruling: result });
    expect(migrate([raw], posted(raw)).append).toEqual([twin(raw)]);
  });

  it('migrates a raw block ruling without a comment (block only holds, so it is fail-safe)', () => {
    expect(migrate([ruling()]).append).toHaveLength(1);
  });

  it.each([
    ['a hashed ruling with a different result', () => ruling({ ruling: 'not-real', findingKey: ledgerFindingKey('raw key') })],
    ['a later-listed raw ruling with a different result', () => ruling({ ruling: 'not-real' })],
  ])('skips the twin when it ties on time with %s (appending it last would overwrite that ruling)', (_name, other) => {
    const raw = ruling({ ruling: 'block' });
    expect(migrate([raw, other()], posted(raw)).skipped).toContainEqual({ pr: 7, type: 'ruling', at, reason: 'out-of-order' });
  });

  it('preserves the final authoritative ruling when timestamps tie: derived state stays ruled', () => {
    const open = referral({ findingKeys: [ledgerFindingKey('raw key')], at: early });
    const authoritative = ruling({ ruling: 'not-real', findingKey: ledgerFindingKey('raw key') });
    const rows = [open, ruling({ ruling: 'block' }), authoritative];
    const before = deriveReferrals(rows).get(ledgerFindingKey('raw key')).state;
    const after = deriveReferrals([...rows, ...migrate(rows).append]).get(ledgerFindingKey('raw key')).state;
    expect([before, after]).toEqual(['ruled', 'ruled']);
  });

  it('skips a twin that ties on time with a referral or a clearing verdict for the finding', () => {
    expect(migrate([ruling(), referral({ findingKeys: [ledgerFindingKey('raw key')], at })]).skipped).toEqual(skipped('out-of-order'));
    expect(migrate([ruling(), verdict({ at })]).skipped).toEqual(skipped('out-of-order'));
  });

  it('still migrates when an equal-time row is for another finding', () => {
    expect(migrate([ruling(), ruling({ findingKey: ledgerFindingKey('other') , ruling: 'not-real' })]).append).toHaveLength(1);
  });

  it('migrates each raw row of a finding ruled twice: only the latest, which is what the derive ends on', () => {
    const result = migrate([ruling({ ruling: 'block' }), ruling({ ruling: 'not-real', at: late })], posted(ruling({ ruling: 'not-real' })));
    expect(result.append.map(r => [r.ruling, r.at])).toEqual([['not-real', late]]);
    expect(result.skipped).toEqual(skipped('out-of-order'));
  });
});

describe('main --migrate-raw', () => {
  const migrateIo = (over = {}) => io({ migrateRaw: true, readGit: vi.fn(() => ({ status: 'ok', rows: [ruling()] })), ...over });

  it('dry-runs with counts and appends nothing', async () => {
    const options = migrateIo();
    expect(await main(options)).toEqual({ exitCode: 0, results: [{ repo, mode: 'migrate-raw dry-run', candidates: 1, append: 1, skipped: {}, appended: 0 }] });
    expect(options.appendGit).not.toHaveBeenCalled();
    expect(options.readHome).not.toHaveBeenCalled();
    expect(options.readThreadRulings).toHaveBeenCalledWith(repo, 7);
  });

  it('applies the twins in one append; a second run over the result is a no-op', async () => {
    const rows = [ruling()];
    const options = migrateIo({ apply: true, readGit: vi.fn(() => ({ status: 'ok', rows: [...rows] })) });
    const first = await main(options);
    expect(first.results[0]).toMatchObject({ mode: 'migrate-raw apply', append: 1, appended: 1 });
    expect(options.appendGit).toHaveBeenCalledWith([{ ...ruling(), findingKey: ledgerFindingKey('raw key') }], { board: '/board', repo });
    const again = migrateIo({ apply: true, readGit: vi.fn(() => ({ status: 'ok', rows: [...rows, ...options.appendGit.mock.calls[0][0]] })) });
    expect((await main(again)).results[0]).toMatchObject({ append: 0, appended: 0, skipped: { 'already-in-git': 1 } });
    expect(again.appendGit).not.toHaveBeenCalled();
  });

  it('reports an append failure with a non-zero exit', async () => {
    const result = await main(migrateIo({ apply: true, appendGit: vi.fn(() => ({ ok: false, appended: 0, error: 'boom' })) }));
    expect(result).toMatchObject({ exitCode: 1, results: [{ status: 'append-failed', error: 'boom' }] });
  });
});
