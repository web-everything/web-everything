import { describe, it, expect } from 'vitest';
import { FIX_EXECUTOR_RUNGS, FIX_EXECUTOR_CHAIN_DEFAULT, resolveFixExecutorChain, pickChainRung } from '../fix-executor-chain.mjs';
import { codexModelSupportsEffort } from '../codex-model-routing.mjs';
const chain = FIX_EXECUTOR_CHAIN_DEFAULT;
const pick = (input = {}) => pickChainRung({ chain, launcherAvailable: () => true, ...input });
describe('fix executor chain', () => {
  it.each([[0,'codex'],[1,'codex'],[2,'codex-alt'],[3,'argon'],[4,'claude'],[9,'claude']])('ordinary u=%s chooses %s', (codexUnproductive, rung) => expect(pick({codexUnproductive}).rung).toBe(rung));
  it.each(['stronger-model','takeover','ruling-not-addressed'])('%s starts on the next rung', trigger => {
    expect(pick({trigger}).rung).toBe('codex-alt');
    expect(pick({trigger, critical:true})).toMatchObject({executor:'claude', reason:'critical work never leaves Claude'});
  });
  it('keeps ordinary critical work on rung zero', () => expect(pick({critical:true}).rung).toBe('codex'));
  it.each([null,'stronger-model','takeover','ruling-not-addressed'])('legacy chain reproduces %s', trigger => {
    for (const codexUnproductive of [0,1,2,3,9]) expect(pick({chain:['codex','claude'],trigger,codexUnproductive}).executor).toBe(trigger || codexUnproductive >= 2 ? 'claude' : 'codex');
  });
  it('skips an unavailable Argon launcher', () => expect(pick({codexUnproductive:3, launcherAvailable:e=>e!=='antigravity'})).toMatchObject({executor:'claude',reason:expect.stringContaining('argon launcher unavailable')}));
  it('uses a supported alternate model and effort', () => {
    const {model,effort} = FIX_EXECUTOR_RUNGS['codex-alt'].policyRoute;
    expect(codexModelSupportsEffort(model,effort)).toBe(true);
    expect(Object.isFrozen(FIX_EXECUTOR_RUNGS['codex-alt'].policyRoute)).toBe(true);
  });
  it('preserves the old reason prefix', () => expect(pick({codexUnproductive:2}).reason).toBe('codex unproductive on this head (2 unproductive runs) → chain rung 2/4 codex-alt'));
});
describe('chain settings cascade', () => {
  const resolve = input => resolveFixExecutorChain({env:{},platform:{},repo:{},...input});
  const layer = fallbackChain => ({fixExecutor:{fallbackChain}});
  it('defaults, then platform, repo, env override', () => {
    expect(resolve({})).toEqual({value:chain,source:'default'});
    expect(resolve({platform:layer(['argon','claude'])})).toEqual({value:['argon','claude'],source:'platform'});
    expect(resolve({platform:layer(['argon','claude']),repo:layer(['codex','claude'])})).toEqual({value:['codex','claude'],source:'repo'});
    for (const raw of ['codex-alt,claude','["codex-alt","claude"]']) expect(resolve({repo:layer(['codex','claude']),env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:raw}})).toEqual({value:['codex-alt','claude'],source:'env'});
  });
  it.each([[],['codex'],['unknown','claude'],['claude','claude'],null,'codex,claude'])('ignores invalid layers %j', raw => {
    expect(resolve({platform:layer(['argon','claude']),repo:layer(raw),env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:'bad'}})).toEqual({value:['argon','claude'],source:'platform'});
  });
});
