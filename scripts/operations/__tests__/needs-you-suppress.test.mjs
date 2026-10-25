import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as feed from '../needs-you-feed.mjs';
import { appendDaemonEvent } from '../../lib/daemon-events.mjs';
import { rulingNeeded } from '../../lib/ruling-ledger.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';

// No test may append to the operator's real daemon stream, including runOnce's default emitter.
vi.mock('../../lib/daemon-events.mjs', () => ({ appendDaemonEvent: vi.fn(async () => true) }));

const repo = 'web-everything/web-everything';
const head = 'b'.repeat(40), staleHead = 'a'.repeat(40);
const at = '2026-10-20T12:00:00.000Z';
const detail = 'all confirmed findings already ruled';
const item = (pr = 42, kind = 'ruling-needed') => ({ repo, pr, head: staleHead, kind, reason: 'parked' });
const view = { labels: [{ name: 'advisory:ruling-needed' }], headRefOid: head,
  body: '<!-- authored-by-actor: author -->', createdAt: at };
const viewArgs = pr => ['pr', 'view', String(pr), '--repo', repo, '--json', 'labels,headRefOid,body,createdAt'];
const commentArgs = pr => ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments?per_page=100`];
const event = pr => ({ kind: 'needs-you-suppressed', repo, pr, detail });
const expectOnce = (mock, ...args) => { expect(mock).toHaveBeenCalledTimes(1); expect(mock).toHaveBeenCalledWith(...args); };
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeGh(live = view, pages = [[]]) {
  return vi.fn(async (bin, args) => {
    if (bin !== 'gh') throw new Error('unexpected executable');
    if (JSON.stringify(args) === JSON.stringify(viewArgs(Number(args[2])))) return JSON.stringify(live);
    if (args[0] === 'api' && args[1] === '--paginate' && args[2] === '--slurp'
      && /^repos\/web-everything\/web-everything\/issues\/\d+\/comments\?per_page=100$/.test(args[3])) return JSON.stringify(pages);
    throw new Error(`unexpected gh argv: ${JSON.stringify(args)}`);
  });
}
function options(overrides = {}) {
  return { gh: fakeGh(), cwd: 'fixture-checkout', log: vi.fn(), emitEvent: vi.fn(async () => true),
    lookup: vi.fn(() => null), ...overrides };
}

describe('gateRulingItems: suppress only live findings that already have rulings', () => {
  it('exports the new gate', () => {
    expect(feed.gateRulingItems).toBeTypeOf('function');
  });

  it('drops an all-ruled item, logs the suppression and emits its exact coordination event', async () => {
    const opts = options();
    const { kept } = await feed.gateRulingItems([item()], opts);
    expect(kept).toHaveLength(0);
    expect(opts.lookup).toHaveBeenCalledTimes(1);
    expect(opts.log).toHaveBeenCalledWith(`needs-you-feed ${repo}#42 needs-you-suppressed: ${detail}`);
    expectOnce(opts.emitEvent, event(42));
  });

  it('passes LIVE head, labels, body, creation time and every mapped comment page to lookup', async () => {
    const pages = [[{ user: { login: 'web-everything' }, body: 'first page', created_at: at }],
      [{ user: { login: 'chalbert' }, body: 'later ruling', created_at: at }, { created_at: at }]];
    const opts = options({ gh: fakeGh(view, pages) });
    await feed.gateRulingItems([item()], opts);
    expect(opts.gh).toHaveBeenCalledTimes(2);
    expect(opts.gh).toHaveBeenNthCalledWith(1, 'gh', viewArgs(42), expect.objectContaining({
      cwd: opts.cwd, encoding: 'utf8', timeout: expect.any(Number), killSignal: 'SIGKILL', maxBuffer: expect.any(Number),
    }));
    expect(opts.gh).toHaveBeenNthCalledWith(2, 'gh', commentArgs(42), expect.objectContaining({ cwd: opts.cwd }));
    expectOnce(opts.lookup, expect.objectContaining({
      number: 42, ...view, comments: [
        { author: { login: 'web-everything' }, body: 'first page', createdAt: at },
        { author: { login: 'chalbert' }, body: 'later ruling', createdAt: at },
        { author: { login: '' }, body: '', createdAt: at },
      ],
    }));
  });

  it('keeps a partially ruled item when lookup returns any pending findings and emits nothing', async () => {
    const original = item();
    const opts = options({ lookup: vi.fn(() => ({ findings: [{ key: 'still-pending', reason: 'pending' }] })) });
    const { kept } = await feed.gateRulingItems([original], opts);
    expect(kept).toEqual([original]);
    expect(opts.lookup).toHaveBeenCalledTimes(1);
    expect(opts.emitEvent).not.toHaveBeenCalled();
  });

  it.each(['needs-you', 'at-round-limit', 'escalated', 'stood-down'])('keeps %s without any live IO or event', async kind => {
    const original = item(42, kind), opts = options();
    const { kept } = await feed.gateRulingItems([original], opts);
    expect(kept).toEqual([original]);
    expect(opts.gh).not.toHaveBeenCalled();
    expect(opts.lookup).not.toHaveBeenCalled();
    expect(opts.emitEvent).not.toHaveBeenCalled();
  });

  it.each(['view fails', 'comments fail', 'invalid JSON', 'missing head', 'invalid comment pages'])(
    'fails closed to KEEP with no event when the live PR is unreadable: %s', async failure => {
      const original = item();
      const gh = fakeGh(failure === 'missing head' ? { ...view, headRefOid: '' } : view,
        failure === 'invalid comment pages' ? {} : [[]]);
      if (failure === 'view fails') gh.mockRejectedValueOnce(new Error('unreadable PR'));
      if (failure === 'invalid JSON') gh.mockResolvedValueOnce('{');
      if (failure === 'comments fail') gh.mockResolvedValueOnce(JSON.stringify(view)).mockRejectedValueOnce(new Error('comments unavailable'));
      const opts = options({ gh });
      const { kept } = await feed.gateRulingItems([original], opts);
      expect(kept).toEqual([original]);
      expect(opts.lookup).not.toHaveBeenCalled();
      expect(opts.emitEvent).not.toHaveBeenCalled();
    });

  it('fails closed to KEEP when lookup throws, without emitting a suppression event', async () => {
    const original = item(), opts = options({ lookup: vi.fn(() => { throw new Error('ledger unreadable'); }) });
    const { kept } = await feed.gateRulingItems([original], opts);
    expect(kept).toEqual([original]);
    expect(opts.lookup).toHaveBeenCalledTimes(1);
    expect(opts.emitEvent).not.toHaveBeenCalled();
  });

  it('keeps every item without IO when the deadline has already expired', async () => {
    const originals = [item(), item(43)], opts = options({ deadlineMs: -1 });
    const { kept } = await feed.gateRulingItems(originals, opts);
    expect(kept).toEqual(originals);
    expect(opts.gh).not.toHaveBeenCalled();
    expect(opts.lookup).not.toHaveBeenCalled();
    expect(opts.emitEvent).not.toHaveBeenCalled();
  });

  it('keeps the unjudged overflow with an operator-visible deadline fallback when a batch exhausts its budget', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const originals = Array.from({ length: 8 }, (_, i) => item(42 + i));
    const opts = options({ deadlineMs: 1, concurrency: 1, lookup: vi.fn(() => {
      clock.mockReturnValue(1002);
      return null;
    }) });
    const { kept } = await feed.gateRulingItems(originals, opts);
    expect(kept).toEqual(originals.slice(1));
    expect(opts.gh).toHaveBeenCalledTimes(2);
    expect(opts.lookup).toHaveBeenCalledTimes(1);
    expectOnce(opts.emitEvent, event(42));
    expect(opts.log.mock.calls.some(([line]) => /deadline.*keeping/i.test(line))).toBe(true);
  });

  it('bounds live reads to the requested concurrency across a larger batch', async () => {
    const baseGh = fakeGh();
    let active = 0, peak = 0;
    const gh = vi.fn(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        return await baseGh(...args);
      } finally { active--; }
    });
    const opts = options({ gh, concurrency: 2 });
    const { kept } = await feed.gateRulingItems(Array.from({ length: 8 }, (_, i) => item(42 + i)), opts);
    expect(kept).toHaveLength(0);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(2);
    expect(gh).toHaveBeenCalledTimes(16);
    expect(opts.lookup).toHaveBeenCalledTimes(8);
    expect(opts.emitEvent).toHaveBeenCalledTimes(8);
  });

  it.each(['throws', 'rejects', 'returns false'])('still suppresses when emitEvent %s', async failure => {
    const emitEvent = vi.fn(failure === 'throws' ? () => { throw new Error('disk unavailable'); }
      : failure === 'rejects' ? async () => { throw new Error('disk unavailable'); } : async () => false);
    const opts = options({ emitEvent });
    const { kept } = await feed.gateRulingItems([item()], opts);
    expect(kept).toHaveLength(0);
    expectOnce(emitEvent, event(42));
  });

  it('preserves survivor order and the report incomplete flag', async () => {
    const originals = Object.assign([item(41, 'stood-down'), item(), item(43), item(44, 'escalated')], { incomplete: true });
    const opts = options({ lookup: vi.fn(pr => pr.number === 42 ? null : { findings: [{ key: 'pending' }] }) });
    const { kept } = await feed.gateRulingItems(originals, opts);
    expect([...kept]).toEqual([originals[0], originals[2], originals[3]]);
    expect(kept.incomplete).toBe(true);
    expectOnce(opts.emitEvent, event(42));
  });
});

describe('runOnce liveGate ruling suppression', () => {
  it('does not publish an already-ruled alert to the feed file, while retaining another alert', async () => {
    const root = mkdtempSync(join(process.env.TMPDIR, 'needs-you-suppress-'));
    roots.push(root);
    const path = join(root, 'needs-you-events.jsonl');
    writeFileSync(path, '');
    const original = { file: 'policy/pointer.md', line: 12, summary: 'policy pointer missing from the standards manifest',
      verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const runId = 'needs-you-suppression', reviewer = mandatoryReferralReviewer(runId);
    const key = referralFindingKey('judge', original);
    const record = { version: 1, repo, pr: 42, head, runId, reviewer, authorBody: view.body, attempted: true,
      referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }], rulings: [] };
    const ruled = { ...record, rulings: [{ id: 'ruled', key, reviewerId: reviewer.id, lens: reviewer.lens,
      result: 'not-real', rationale: 'verified existing manifest entry', evidence: ['manifest entry exists'] }] };
    const comments = [record, ruled].map(r => ({ user: { login: 'web-everything' }, body: renderReferralRecord(r), created_at: at }));
    const asPr = rows => ({ number: 42, ...view, comments: rows.map(c => ({ author: { login: c.user.login }, body: c.body, createdAt: c.created_at })) });
    // Prove the fixture actually transitions from pending to ruled using the real ledger.
    expect(rulingNeeded(asPr(comments.slice(0, 1)))?.findings).toHaveLength(1);
    expect(rulingNeeded(asPr(comments))).toBeNull();
    const report = { ready: [], rulingNeeded: [{ repo, number: 42, head: staleHead }],
      stoodDown: [{ repo, number: 43, head, reason: 'operator answer still needed' }] };
    const exec = vi.fn(async () => JSON.stringify(report));
    const gh = fakeGh(view, [[comments[0]], [comments[1]]]);
    const settings = feed.resolveSettings({ env: {}, home: root, file: { path, allowPrimary: true } });
    const result = await feed.runOnce({ exec, gh, home: root, checkoutRoot: root, settings,
      env: {}, now: new Date(at), log: vi.fn(), liveGate: true });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(result.lines).toHaveLength(1);
    expect(result.openKeys).toEqual([`${repo}#43@${head}:stood-down`]);
    expect(feed.replay({ path })).toEqual([expect.objectContaining({ pr: 43, kind: 'stood-down' })]);
    expect(readFileSync(path, 'utf8')).not.toContain('ruling-needed');
    expect(existsSync(feed.sidecarsOf(path).state)).toBe(true);
    expect(JSON.parse(readFileSync(feed.sidecarsOf(path).state, 'utf8')).openKeys).toEqual(result.openKeys);
    expectOnce(appendDaemonEvent, event(42));
  });
});
