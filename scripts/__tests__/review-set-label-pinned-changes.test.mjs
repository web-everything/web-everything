import { afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../lib/verdict-ledger.mjs', async original => ({ ...(await original()), appendVerdict: vi.fn(() => ({ ok: true })) }));
import { runReviewLabelCli } from '../review-set-label.mjs';
import { appendVerdict } from '../lib/verdict-ledger.mjs';
const head = 'a'.repeat(40);
afterEach(() => vi.restoreAllMocks());
function run({ changedAt = Infinity, change = { headRefOid: 'b'.repeat(40) }, pin = head } = {}) {
  let reads = 0;
  const state = { state: 'OPEN', headRefOid: head, headRefName: 'lane/test', baseRefName: 'release',
    labels: ['review:pending'], comments: [], body: '' };
  const provider = { name: 'stub', readPrState: vi.fn(() => (++reads >= changedAt ? { ...state, ...change } : state)),
    setLabels: vi.fn(), postComment: vi.fn(), readComments: () => [] };
  const output = [];
  vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(new Error('exit'), { exitCode: code }); });
  let exit = 0;
  try {
    runReviewLabelCli({ argv: ['7', '--repo=o/n', '--to=changes', `--expect-head=${pin}`],
      defaultActor: 'daemon', usage: 'test', verdictBody: 'Fix the blocked case', provider,
      buildComment: () => 'Fix the blocked case', successResult: () => ({ ok: true }),
      refusalResult: ({ decision }) => ({ error: decision.reason }), signalFix: () => {}, emit: s => output.push(s) });
  } catch (e) { if (e.exitCode !== undefined) exit = e.exitCode; else throw e; }
  return { provider, exit, output: output.join('') };
}
describe('guarded changes through sanctioned CLI', () => {
  it('accepts --expect-head with changes and writes findings and labels', () => {
    const r = run(); expect(r.exit).toBe(0);
    expect(r.provider.postComment).toHaveBeenCalledWith('o/n', '7', 'Fix the blocked case');
    expect(r.provider.setLabels).toHaveBeenCalledTimes(1);
  });
  it('refuses a malformed pin before reading or writing', () => {
    const r = run({ pin: 'bad' }); expect(r.exit).toBe(2);
    expect(r.provider.readPrState).not.toHaveBeenCalled();
  });
  it('refuses a head change before durable ledger/comment/label writes', () => {
    vi.mocked(appendVerdict).mockClear();
    const r = run({ changedAt: 2 }); expect(r.exit).toBe(1);
    expect(appendVerdict).not.toHaveBeenCalled();
    expect(r.provider.postComment).not.toHaveBeenCalled(); expect(r.provider.setLabels).not.toHaveBeenCalled();
  });
  it.each([{ labels: ['review:human'] }, { labels: [] }, { state: 'CLOSED' }, { labels: null }])('refuses changed or incomplete pending evidence %j', change => {
    const r = run({ changedAt: 2, change }); expect(r.exit).toBe(1);
    expect(r.provider.postComment).not.toHaveBeenCalled(); expect(r.provider.setLabels).not.toHaveBeenCalled();
  });
  it('rechecks head before comment and label writes', () => {
    const comment = run({ changedAt: 3 }); expect(comment.exit).toBe(1);
    expect(comment.provider.postComment).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const swap = run({ changedAt: 4 }); expect(swap.exit).toBe(1);
    expect(swap.provider.postComment).toHaveBeenCalledTimes(1); expect(swap.provider.setLabels).not.toHaveBeenCalled();
  });
});
