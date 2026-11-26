import { describe, expect, it, vi } from 'vitest';
import { runFastPass } from '../review-fast-pass.mjs';
import { reviewDispatchContext } from '../review-dispatch-context.mjs';
import { checkMainStaleness } from '../main-staleness.mjs';
import { readStackBase } from '../../conveyor/review-stack-base.mjs';

const head = 'a'.repeat(40);
const pr = { number: 12, state: 'OPEN', headRefOid: head, labels: ['review:pending'], statusCheckRollup: [], comments: [] };
const row = { kind: 'review', prNumber: 12, headRefOid: head };
const base = () => ({
  repo: 'f/r', readLastPlan: () => ({ plan: { dispatch: [row] }, rawPrs: [pr], mainSha: 'm', savedAt: 1 }),
  readPr: ({ pending }) => pending ? [] : structuredClone(pr), planOne: () => ({ dispatch: [row], refusals: [] }),
  readAgents: () => [], readJobs: () => [], dispatch: vi.fn(() => ({ mode: 'job' })),
  hostAdmission: () => ({ admitted: true, maxPerTick: 2 }), liveCap: () => 2, acquirableLanes: () => [1], mainSha: () => 'm', now: () => 10,
});

describe('review fast path fails closed', () => {
  it('stale main: failed status evidence is not fresh even when shas match', () => {
    const run = args => args[0] === 'status' ? { status: 1, stdout: '' } : { status: 0, stdout: 'x\n' };
    expect(checkMainStaleness({ strict: true, cleanOnly: true, run })).toEqual({ offline: true });
    const noHead = args => args[0] === 'symbolic-ref' ? { status: 1, stdout: '' } : { status: 0, stdout: 'x\n' };
    expect(checkMainStaleness({ strict: true, cleanOnly: true, run: noHead })).toEqual({ offline: true });
  });
  it('stale main: a dirty or off-base checkout is not fresh even when shas match', () => {
    const dirty = args => args[0] === 'status' ? { status: 0, stdout: ' M x\n' } : { status: 0, stdout: 'main\n' };
    expect(checkMainStaleness({ strict: true, cleanOnly: true, run: dirty })).toEqual({ offline: true });
    const off = args => args[0] === 'symbolic-ref' ? { status: 0, stdout: 'other\n' } : args[0] === 'status' ? { status: 0, stdout: '' } : { status: 0, stdout: 'x\n' };
    expect(checkMainStaleness({ strict: true, cleanOnly: true, run: off })).toEqual({ offline: true });
  });
  it('strict stack lookup refuses an incomplete target record', () => {
    expect(() => readStackBase({ pr: 9, strict: true, settingOn: true, readRefs: () => new Map([[9, { headRefName: 'lane/x' }]]), readLanes: () => new Map() }))
      .toThrow('incomplete');
  });
  it('strict stack lookup refuses a PR with no record', () => {
    expect(() => readStackBase({ pr: 9, strict: true, settingOn: true, readRefs: () => new Map([[1, {}]]), readLanes: () => new Map() })).toThrow();
  });
  it('a lost dispatch lease stops the pass before dispatch', async () => {
    const o = base(); await runFastPass({ ...o, leaseHeld: () => false });
    expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('missing file evidence is high-risk, not an empty scope', () => {
    expect(reviewDispatchContext({ body: '' })).toMatchObject({ careLevel: 'high', scopePaths: [] });
    expect(reviewDispatchContext({ body: '', files: [{ path: 'a' }] }).careLevel).toBeUndefined();
  });
  it.each([[99, undefined], [100, 'high'], [101, 'high']])('file evidence boundary: %i files requires %s care', (count, care) => {
    expect(reviewDispatchContext({ files: Array.from({ length: count }, (_, i) => ({ path: `docs/${i}.md` })) }).careLevel).toBe(care);
  });
  it('a failed file read refuses the PR; a present file list keeps normal routing', async () => {
    const o = base(); o.readPr = ({ pending }) => { if (pending) return []; throw Error('files read failed'); };
    await runFastPass(o);
    expect(o.dispatch).not.toHaveBeenCalled();
    const ok = base(); await runFastPass({ ...ok, readPr: ({ pending }) => pending ? [] : { ...pr, files: [{ path: 'docs/a.md' }] } });
    expect(ok.dispatch.mock.calls[0][0].careLevel).toBeUndefined();
  });
});
