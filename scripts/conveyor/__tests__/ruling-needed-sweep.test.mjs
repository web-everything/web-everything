/** @file Live decision boundaries for the ruling label sweep (#5955). All IO is injected. */
import { describe, expect, it, vi } from 'vitest';
import { sweepRulingNeededLabels } from '../ruling-needed-sweep.mjs';
import { defaultReadPr } from '../advisory-label-sweep.mjs';
import { readCompletePrComments } from '../pr-comments-complete.mjs';
import { RULING_NEEDED_LABEL } from '../../lib/ruling-ledger.mjs';
import { H1, repo, record, recordComment, BLOCK } from './ruling-fixtures.mjs';

const pending = recordComment(record({ head: H1, runId: 'run-1' }), 5);
const filler = () => ({ body: 'discussion', author: { login: 'stranger' } });
const live = (extra = {}) => ({ number: 3794, state: 'OPEN', labels: [], headRefOid: H1, comments: [], ...extra });
const provider = () => ({ currentRepo: vi.fn(() => repo), ensureLabel: vi.fn(), setLabels: vi.fn() });

describe('fresh complete ruling-label decisions', () => {
  it('reports a referral at comment 120 without writing the mirror-owned label', () => {
    const p = provider();
    const thread = [...Array.from({ length: 119 }, filler), pending];
    const out = sweepRulingNeededLabels({ repo, provider: p, listPrs: () => [live({ comments: thread.slice(0, 100) })],
      readPr: () => live({ comments: thread }) });
    expect(out).toEqual([{ num: 3794, action: 'add' }]);
    expect(p.ensureLabel).not.toHaveBeenCalled();
    expect(p.setLabels).not.toHaveBeenCalled();
  });
  it('a late ruling cancels an obsolete label addition', () => {
    const p = provider();
    const thread = [pending, ...Array.from({ length: 118 }, filler),
      recordComment(record({ head: H1, runId: 'run-1', rulings: [BLOCK] }), 120)];
    const out = sweepRulingNeededLabels({ repo, provider: p, listPrs: () => [live({ comments: thread.slice(0, 100) })],
      readPr: () => live({ comments: thread }) });
    expect(out).toEqual([]);
    expect(p.ensureLabel).not.toHaveBeenCalled();
    expect(p.setLabels).not.toHaveBeenCalled();
  });
  it.each([
    ['read error', () => { throw new Error('page 2 failed'); }],
    ['non-array comments', () => live({ comments: null })],
    ['closed PR', () => live({ state: 'CLOSED' })],
    ['missing state', () => live({ state: undefined })],
    ['missing labels', () => live({ labels: null })],
    ['malformed labels', () => live({ labels: [{}] })],
    ['missing head', () => live({ headRefOid: '' })],
    ['wrong PR', () => live({ number: 9 })],
  ])('preserves an existing ruling label on %s', (_, readPr) => {
    const p = provider();
    const out = sweepRulingNeededLabels({ repo, provider: p, readPr,
      listPrs: () => [live({ labels: [RULING_NEEDED_LABEL] })] });
    expect(out[0]).toMatchObject({ num: 3794, action: 'skipped', error: expect.stringContaining('live re-read failed') });
    expect(p.ensureLabel).not.toHaveBeenCalled();
    expect(p.setLabels).not.toHaveBeenCalled();
  });
  it('uses the metadata-plus-paginated-thread reader to report drift without label writes', () => {
    const trace = [];
    const p = { currentRepo: () => { trace.push('repo'); return repo; },
      ensureLabel: () => trace.push('ensure'), setLabels: () => trace.push('set') };
    const readPr = (identity) => defaultReadPr({ ...identity,
      exec: (file, args) => { trace.push('state'); expect(args).toContain(repo); expect(args).toContain('3794'); return JSON.stringify(live()); },
      readComments: (number, opts) => readCompletePrComments(number, { ...opts,
        exec: (file, args) => {
          if (args[1] === 'graphql') {
            trace.push('thread-count');
            return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } });
          }
          trace.push('thread');
          expect(args).toContain('--paginate');
          expect(args).toContain(`repos/${repo}/issues/3794/comments`);
          return [pending.body, pending.createdAt, pending.author.login, 'IC_pending'].map((field) => field.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\t', '\\t')).join('\t');
        } }),
    });
    const out = sweepRulingNeededLabels({ provider: p, readPr, listPrs: () => [live()] });
    expect(out).toEqual([{ num: 3794, action: 'add' }]);
    expect(trace).toEqual(['repo', 'state', 'thread', 'thread-count']);
  });
  it('isolates failed reads and retries next tick; dry-run uses the same fresh plan', () => {
    const p = provider();
    let fail = true;
    const readPr = vi.fn(({ number }) => { if (number === 8 && fail) throw new Error('unavailable'); return live({ number, comments: [pending] }); });
    const listPrs = () => [{ number: 8 }, { number: 3794 }];
    const first = sweepRulingNeededLabels({ repo, provider: p, readPr, listPrs, dryRun: true });
    expect(first.map((r) => r.action)).toEqual(['skipped', 'add']);
    expect(p.ensureLabel).not.toHaveBeenCalled();
    expect(p.setLabels).not.toHaveBeenCalled();
    expect(sweepRulingNeededLabels({ repo, provider: p, readPr, listPrs })).toEqual(first);
    fail = false;
    expect(sweepRulingNeededLabels({ repo, provider: p, readPr, listPrs }).every((r) => !r.error)).toBe(true);
    expect(readPr).toHaveBeenCalledTimes(6);
    expect(p.ensureLabel).not.toHaveBeenCalled();
    expect(p.setLabels).not.toHaveBeenCalled();
  });

});
