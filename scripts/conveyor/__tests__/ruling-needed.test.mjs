import { describe, expect, it, vi } from 'vitest';
import { planRulingNeededLabel, sweepRulingNeededLabels } from '../ruling-needed-sweep.mjs';
import { rulingNeededRow } from '../../operations/operator-queue.mjs';
import { runOperatorNotify, notificationFor, itemKey } from '../../operations/operator-notify.mjs';
import { notifyReferralHold } from '../review-referral-hold.mjs';
import { RULING_NEEDED_LABEL } from '../../lib/ruling-ledger.mjs';
import { H1, H2, repo, record, recordComment, BLOCK, SUMMARY } from './ruling-fixtures.mjs';

const parked = (extra = {}) => ({ number: 3794, title: 'policy pointers', headRefOid: H1, labels: [{ name: 'review:human' }],
  comments: [recordComment(record({ head: H1, runId: 'run-1' }), 5)], ...extra });

describe('advisory:ruling-needed label', () => {
  it('goes on a parked PR, stays while it waits, and comes off on a ruling or a new head', () => {
    expect(planRulingNeededLabel(parked()).action).toBe('add');
    const labelled = parked({ labels: [{ name: 'review:human' }, { name: RULING_NEEDED_LABEL }] });
    expect(planRulingNeededLabel(labelled).action).toBe('none');
    const ruled = { ...labelled, comments: [...labelled.comments, recordComment(record({ head: H1, runId: 'run-1', rulings: [BLOCK] }), 9)] };
    expect(planRulingNeededLabel(ruled).action).toBe('remove');
    expect(planRulingNeededLabel({ ...labelled, headRefOid: H2 }).action).toBe('remove');
  });
  it('a PR that never parked is left alone', () => {
    expect(planRulingNeededLabel({ number: 1, headRefOid: H1, labels: [], comments: [] }).action).toBe('none');
  });
  it('sweep creates the label, adds it, never touches review labels, and survives a failing PR', () => {
    const calls = [];
    const provider = { currentRepo: () => repo,
      ensureLabel: (r, name) => calls.push(['ensure', name]),
      setLabels: (r, num, spec) => { calls.push(['set', num, spec]); if (num === 2) throw new Error('boom'); } };
    const out = sweepRulingNeededLabels({ repo, provider, listPrs: () => [parked(), parked({ number: 2 })] });
    expect(calls[0]).toEqual(['ensure', RULING_NEEDED_LABEL]);
    expect(calls[1]).toEqual(['set', 3794, { add: RULING_NEEDED_LABEL }]);
    expect(out.map(r => [r.num, r.action, !!r.error])).toEqual([[3794, 'add', false], [2, 'add', true]]);
    expect(JSON.stringify(calls)).not.toMatch(/review:/);
  });
  it('dry-run writes nothing', () => {
    const provider = { currentRepo: vi.fn(), ensureLabel: vi.fn(), setLabels: vi.fn() };
    sweepRulingNeededLabels({ repo, provider, dryRun: true, listPrs: () => [parked()] });
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
});

describe('needs-you row and push', () => {
  it('the queue row names every finding with its file, the head, and when it began', () => {
    const row = rulingNeededRow(repo, parked());
    expect(row).toMatchObject({ repo, number: 3794, head: H1 });
    expect(row.findings).toEqual([{ file: 'policy/pointer.md', line: 12, summary: SUMMARY, reason: 'pending' }]);
    expect(row.since).toBe(new Date(Date.parse('2026-10-03T08:05:00Z')).toISOString());
  });
  it('no row once ruled', () => {
    expect(rulingNeededRow(repo, parked({ comments: [recordComment(record({ head: H1, runId: 'run-1', rulings: [BLOCK] }), 5)] }))).toBeNull();
  });
  const queue = (head) => ({ ready: [], errors: [], rulingNeeded: [{ repo, number: 3794, title: 'policy pointers', head,
    findings: [{ file: 'policy/pointer.md', line: 12, summary: SUMMARY }] }] });
  const run = async (q, state, notify) => {
    let saved = state;
    const result = await runOperatorNotify({ readQueue: async () => q, readState: async () => saved, writeState: async (s) => { saved = s; }, notify, now: 't' });
    return { result, saved };
  };
  it('pushes once per PR and head, again only for a new head', async () => {
    const notify = vi.fn(async () => ({ ok: true }));
    let { result, saved } = await run(queue(H1), { notified: {} }, notify);
    expect(result.notified).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Ruling needed: web-everything/web-everything#3794' }));
    expect(notify.mock.calls[0][0].body).toMatch(/policy\/pointer\.md/);
    ({ result, saved } = await run(queue(H1), saved, notify));
    expect(result.notified).toHaveLength(0);
    ({ result } = await run(queue(H2), saved, notify));
    expect(result.notified).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('a failed push is retried next pass', async () => {
    const notify = vi.fn(async () => ({ ok: false, error: 'no' }));
    const { result, saved } = await run(queue(H1), { notified: {} }, notify);
    expect(result.failed).toHaveLength(1);
    expect(saved.notified).toEqual({});
  });
  it('keys a ruling per head, distinct from a review-ready row', () => {
    expect(itemKey({ repo, number: 1 })).toBe(`${repo}#1`);
    expect(itemKey({ repo, number: 1, rulingHead: H1 })).toBe(`${repo}#1@aaaaaaaaa:ruling`);
    expect(notificationFor({ repo, number: 1, title: 'x' }).title).toMatch(/^Review needed/);
  });
});

describe('the pause notice on the PR thread', () => {
  it('lists each waiting finding with its file', () => {
    const posted = [];
    const dir = `${process.env.TMPDIR ?? '/tmp'}/ruling-notice-${Date.now()}`;
    notifyReferralHold({ repo, prNumber: 3794, hold: { head: H1, episode: 'ep1', why: 'review paused: 1 referrals need a ruling' },
      comments: parked().comments, dir, post: (b) => posted.push(b), log: () => {} });
    expect(posted[0]).toMatch(/Waiting on your ruling/);
    expect(posted[0]).toMatch(/`policy\/pointer\.md:12`/);
    expect(posted[0]).toMatch(/review-referral-hold: ep1/);
  });
});
