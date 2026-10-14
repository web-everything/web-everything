import { describe, it, expect, vi } from 'vitest';
import { planHumanSurfaceRepark, buildHumanSurfaceReparkComment, sweepHumanSurfaceRepark } from '../human-surface-repark.mjs';
import { buildClearedHumanMarker, buildReviewedShaMarker } from '../../lib/review-escalation.mjs';

const head = 'a'.repeat(40);
const labels = ['review:accepted', 'ready-to-merge'];
const clearance = sha => ({ author: { login: 'web-everything' }, body: `${buildReviewedShaMarker(sha)}\n${buildClearedHumanMarker('operator')}` });
const plan = extra => planHumanSurfaceRepark({ currentLabels: labels, files: ['.github/workflows/ci.yml'], headSha: head, comments: [], surfaces: 'narrow', ...extra });

describe('human surface re-park plan', () => {
  it.each(['.github/workflows/ci.yml', 'scripts/lib/github-auth-policy.mjs'])('parks %s', file => {
    const p = plan({ files: [file] });
    expect(p.repark).toBe(true);
    expect(p.decision.addLabel).toBe('review:human');
    expect(p.decision.removeLabels).toContain('review:accepted');
    expect(p.decision.removeLabels).not.toContain('ready-to-merge');
  });
  it.each([
    { files: ['src/example.js'] },
    { currentLabels: [...labels, 'review:human'] },
    { currentLabels: [...labels, 'review:held-mechanical'] },
    { currentLabels: ['review:pending'] },
    { comments: [clearance(head.toUpperCase())] },
  ])('leaves ineligible or cleared PR alone: %j', extra => expect(plan(extra).repark).toBe(false));
  it('leaves older clearances to carry-forward', () => {
    expect(plan({ comments: [clearance('b'.repeat(40))] })).toEqual({ repark: false, reason: 'older human clearance — left to the accept carry-forward / drain' });
  });
  it('preserves changes', () => expect(plan({ currentLabels: [...labels, 'review:changes'] }).decision.removeLabels).not.toContain('review:changes'));
  it('names the head, hits and recovery ceremony', () => {
    const body = buildHumanSurfaceReparkComment({ headSha: head, hits: plan().hits });
    for (const s of [head, head.slice(0, 9), '.github/workflows/ci.yml', 'workflow', 'review:accepted', 'review-set-label.mjs --to=clear-human']) expect(body).toContain(s);
  });
});

function fixture(overrides = {}) {
  const calls = [];
  const state = { state: 'OPEN', headRefOid: head, labels };
  const provider = {
    readPrState: vi.fn(() => state), readPrFiles: () => ['.github/workflows/ci.yml'],
    postComment: (...args) => calls.push(['comment', ...args]), setLabels: (...args) => calls.push(['labels', ...args]),
    ...overrides,
  };
  const run = extra => sweepHumanSurfaceRepark({ repo: 'o/n', listPrs: () => [{ number: 7, labels }], provider, readComments: () => [], resolveSurfaces: () => 'narrow', ...extra });
  return { calls, provider, run, state };
}
describe('human surface re-park sweep', () => {
  it('comments before changing labels', () => {
    const f = fixture();
    expect(f.run()).toEqual([{ num: 7, repark: 'reparked', head, files: ['.github/workflows/ci.yml'] }]);
    expect(f.calls.map(c => c[0])).toEqual(['comment', 'labels']);
    expect(f.calls[1][3]).toEqual({ add: 'review:human', remove: ['review:accepted'] });
  });
  it('skips a moved head', () => {
    const f = fixture();
    f.provider.readPrState.mockReturnValueOnce(f.state).mockReturnValueOnce({ ...f.state, headRefOid: 'b'.repeat(40) });
    expect(f.run()).toEqual([{ num: 7, skipped: 'head moved during read' }]);
    expect(f.calls).toEqual([]);
  });
  it('skips read failures', () => {
    const f = fixture({ readPrFiles: () => { throw new Error('offline'); } });
    expect(f.run()).toEqual([{ num: 7, skipped: 'live re-read failed: offline' }]);
    expect(f.calls).toEqual([]);
  });
  it('uses fresh labels after the second read', () => {
    const f = fixture();
    f.provider.readPrState.mockReturnValueOnce(f.state).mockReturnValueOnce({ ...f.state, labels: [...labels, 'review:human'] });
    expect(f.run()).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it('skips incomplete comments', () => {
    const f = fixture();
    expect(f.run({ readComments: () => null })).toEqual([{ num: 7, skipped: 'live re-read failed: comments read returned no array' }]);
    expect(f.calls).toEqual([]);
  });
  it('does not write in dry-run', () => {
    const f = fixture();
    expect(f.run({ dryRun: true })[0].repark).toBe('would-repark');
    expect(f.calls).toEqual([]);
  });
  it('does not change labels after a failed comment', () => {
    const f = fixture({ postComment: () => { throw new Error('offline'); } });
    expect(f.run()[0].error).toBe('offline');
    expect(f.calls).toEqual([]);
  });
});
