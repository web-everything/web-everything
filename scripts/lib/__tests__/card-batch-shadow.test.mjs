// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveWidenMode, loadWidenMode, describeWouldBatch, emitWouldBatch } from '../card-batch-shadow.mjs';

const none = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };

describe('cardBatchWiden.mode cascade', () => {
  it('standard is off', () => {
    expect(resolveWidenMode({ platform: undefined, repo: undefined, env: {} })).toEqual({ mode: 'off', source: 'standard', invalid: [] });
  });
  it('the repo layer is read from the supplied fixture', () => {
    expect(loadWidenMode({ env: {}, read: none, repo: { mode: 'shadow' } })).toMatchObject({ mode: 'shadow', source: 'repo' });
  });
  it('platform < repo < env; an invalid value is ignored and named', () => {
    expect(resolveWidenMode({ platform: { mode: 'on' }, repo: { mode: 'shadow' }, env: { WE_CARD_BATCH_WIDEN: 'off' } }))
      .toEqual({ mode: 'off', source: 'env', invalid: [] });
    expect(resolveWidenMode({ platform: { mode: 'on' }, repo: { mode: 'maybe' } }))
      .toEqual({ mode: 'on', source: 'platform', invalid: ['repo.mode'] });
  });
});

describe('describeWouldBatch', () => {
  const widen = { mode: 'shadow', source: 'repo', invalid: [] };
  it('names the cards it would batch together and the source', () => {
    const line = describeWouldBatch({ widen, cards: ['6700', '5360', '5360'], paths: ['backlog/a.md', 'backlog/raised-by/5360/b.md'] });
    expect(line).toContain('would batch #6700 with #5360');
    expect(line).toContain('source repo');
    expect(line).toContain('2 path(s)');
  });
  it('is silent when off or when no card is involved', () => {
    expect(describeWouldBatch({ widen: { mode: 'off', source: 'standard' }, cards: ['1'] })).toBeNull();
    expect(describeWouldBatch({ widen, cards: [] })).toBeNull();
  });
  it('on is reported as logging only', () => {
    expect(describeWouldBatch({ widen: { mode: 'on', source: 'env' }, cards: ['1'] })).toContain('on is not built yet');
  });
});

describe('emitWouldBatch never throws', () => {
  const widen = () => ({ mode: 'shadow', source: 'repo', invalid: [] });
  it('writes one line when a card is involved', () => {
    const out = [];
    expect(emitWouldBatch({ loadWiden: widen, cards: ['1', '2'], paths: ['a'], write: (l) => out.push(l) })).toBe(true);
    expect(out).toHaveLength(1);
  });
  it('swallows a throwing loader, a throwing writer and missing arguments', () => {
    expect(emitWouldBatch({ loadWiden: () => { throw new Error('x'); }, cards: ['1'], write: () => {} })).toBe(false);
    expect(emitWouldBatch({ loadWiden: widen, cards: ['1'], write: () => { throw new Error('y'); } })).toBe(false);
    expect(emitWouldBatch()).toBe(false);
  });
  it('writes nothing when off', () => {
    const out = [];
    expect(emitWouldBatch({ loadWiden: () => ({ mode: 'off', source: 'env' }), cards: ['1'], write: (l) => out.push(l) })).toBe(false);
    expect(out).toEqual([]);
  });
});
