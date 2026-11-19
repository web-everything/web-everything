import { describe, expect, it } from 'vitest';
import { resolveFixExecutorChain } from '../fix-executor-chain.mjs';
import { chooseFixExecutor } from '../fix-slot-borrow.mjs';

const chainOf = options => resolveFixExecutorChain({ env: {}, platform: {}, repo: { routing: { builder: 'codex' } }, ...options });
const choose = (chain, entry = {}) => chooseFixExecutor({ setting: { value: 'codex-first', source: 'default' },
  launcherAvailable: () => true, chain, ...entry });

describe('aiRouting fix executor chain at the borrow router', () => {
  it('without aiRouting every route is unchanged', () => {
    const base = chainOf();
    expect(chainOf({ aiRouting: undefined })).toEqual(base);
    for (const entry of [{}, { takeover: true }, { round: 3 }, { codexUnproductive: 2 }]) {
      expect(choose(chainOf({ aiRouting: undefined }), entry)).toEqual(choose(base, entry));
    }
  });
  it('an aiRouting chain picks the executor and names itself as the source', () => {
    const picked = choose(chainOf({ aiRouting: ['codex-alt', 'claude'] }));
    expect(picked).toMatchObject({ executor: 'codex', rung: 'codex-alt', source: 'aiRouting' });
  });
  it('aiRouting cannot override the critical decision', () => {
    const chain = chainOf({ aiRouting: ['codex', 'claude'] });
    expect(choose(chain, { takeover: true, critical: true })).toMatchObject({ executor: 'claude' });
    expect(choose(chain, { codexUnproductive: 3, critical: true })).toMatchObject({ executor: 'claude' });
  });
  it('aiRouting cannot override the builder strip', () => {
    const chain = chainOf({ aiRouting: ['codex', 'claude'], repo: { routing: { builder: 'claude' } } });
    expect(chain.value).toEqual(['claude']);
    expect(choose(chain)).toMatchObject({ executor: 'claude' });
  });
  it('a chain that does not end with Claude is dropped', () => {
    expect(chainOf({ aiRouting: ['codex'] })).toEqual(chainOf());
  });
  it('the environment chain keeps precedence over aiRouting', () => {
    const chain = chainOf({ aiRouting: ['codex-alt', 'claude'], env: { WE_FIX_EXECUTOR_FALLBACK_CHAIN: 'codex,claude' } });
    expect(chain).toMatchObject({ value: ['codex', 'claude'], source: 'env' });
  });
  it('explicit fix.executor=claude still wins over any aiRouting chain', () => {
    expect(chooseFixExecutor({ setting: { value: 'claude', source: 'repo' }, chain: chainOf({ aiRouting: ['codex', 'claude'] }) }))
      .toMatchObject({ executor: 'claude' });
  });
});
