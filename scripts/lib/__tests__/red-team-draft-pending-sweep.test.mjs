import { describe, it, expect, vi } from 'vitest';
import { sweepDraftPendingLabels } from '../red-team-draft-pending-sweep.mjs';
const repo = 'o/r';
const row = (extra = {}) => ({ number: 7, isDraft: true, headRefOid: 'abc', labels: ['red-team:pending'], ...extra });
function fixture(fresh = row({ state: 'OPEN' })) {
  const provider = { readPrState: vi.fn(() => fresh), setLabels: vi.fn() };
  const log = vi.fn();
  return { provider, log, sweep: (extra = {}) => sweepDraftPendingLabels({ repo, rawPrs: [row()], provider, log, ...extra }) };
}
describe('sweepDraftPendingLabels', () => {
  it('removes only pending, never blocked or clear, and never adds any label', () => {
    const f = fixture(row({ state: 'OPEN', labels: [{ name: 'red-team:pending' }, 'red-team:blocked', 'red-team:clear'] }));
    expect(f.sweep()).toEqual({ dropped: [7], skipped: [], errors: [] });
    expect(f.provider.readPrState).toHaveBeenCalledWith(repo, 7);
    expect(f.provider.setLabels.mock.calls).toEqual([[repo, 7, { remove: ['red-team:pending'] }]]);
  });
  it.each([false, undefined, null, 1])('non-strict draft %s keeps label without a read', isDraft => {
    const f = fixture(); f.sweep({ rawPrs: [row({ isDraft })] });
    expect(f.provider.readPrState).not.toHaveBeenCalled();
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it.each([
    ['not draft', { isDraft: false }], ['unknown draft', { isDraft: undefined }],
    ['head moved', { headRefOid: 'def' }], ['closed', { state: 'CLOSED' }],
    ['missing pending', { labels: ['red-team:blocked'] }], ['unreadable labels', { labels: undefined }],
  ])('fresh re-read %s fails closed without writing', (_why, extra) => {
    const f = fixture(row({ state: 'OPEN', ...extra }));
    expect(f.sweep().skipped).toEqual([{ pr: 7, why: expect.any(String) }]);
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it('skips queue-owned keys and rows without pending', () => {
    const f = fixture(); f.sweep({ skipKeys: new Set(['o/r#7']) });
    f.sweep({ rawPrs: [row({ labels: [] })] });
    expect(f.provider.readPrState).not.toHaveBeenCalled();
  });
  it.each(['readPrState', 'setLabels'])('provider %s throw is logged without escaping and later PRs continue', method => {
    const f = fixture(); f.provider[method].mockImplementationOnce(() => { throw new Error('unreadable'); });
    const result = f.sweep({ rawPrs: [row(), row({ number: 8 })] });
    expect(result.errors).toEqual([{ pr: 7, why: 'unreadable' }]);
    expect(result.dropped).toEqual([8]); expect(f.log).toHaveBeenCalled();
  });
  it('respects the max cap on reads even when fresh evidence prevents removal', () => {
    const f = fixture(row({ state: 'CLOSED' }));
    f.sweep({ rawPrs: Array.from({ length: 8 }, (_, i) => row({ number: i + 1 })) });
    expect(f.provider.readPrState).toHaveBeenCalledTimes(5);
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it('respects a custom max and zero', () => {
    const f = fixture(); f.sweep({ max: 0 }); expect(f.provider.readPrState).not.toHaveBeenCalled();
    f.sweep({ max: 1, rawPrs: [row(), row({ number: 8 })] });
    expect(f.provider.readPrState).toHaveBeenCalledTimes(1);
  });
});
