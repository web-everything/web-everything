import { describe, it, expect, vi } from 'vitest';
import { FIX_EXECUTOR_RUNGS, FIX_EXECUTOR_CHAIN_DEFAULT, resolveFixExecutorChain, pickChainRung } from '../fix-executor-chain.mjs';
import { chooseFixExecutor, formatFixExecutorLog } from '../fix-slot-borrow.mjs';
import { codexModelSupportsEffort } from '../codex-model-routing.mjs';
import { readFileSync } from 'node:fs';
const chain = ['codex', 'codex-alt', 'argon', 'claude'];
const pick = (input = {}) => pickChainRung({ chain, launcherAvailable: () => true, ...input });
describe('fix executor chain', () => {
  it.each([[], ['codex'], ['unknown', 'claude'], ['claude', 'claude'], null])('rejects invalid shipped seat mix %j with a frozen fallback', async fixSeatMix => {
    vi.resetModules();
    vi.doMock('node:fs', async original => ({ ...await original(), readFileSync: (path, ...args) => String(path).endsWith('/settings/fix-executor.json')
      ? JSON.stringify({ fixExecutor: { fixSeatMix } }) : readFileSync(path, ...args) }));
    try {
      const { FIX_EXECUTOR_CHAIN_DEFAULT: value } = await import('../fix-executor-chain.mjs');
      expect(value).toEqual(chain);
      expect(Object.isFrozen(value)).toBe(true);
    } finally { vi.doUnmock('node:fs'); vi.resetModules(); }
  });
  it.each([null, 'stronger-model', 'takeover', 'ruling-not-addressed'])('combines %s with failure progress without skipping a rung', trigger => {
    for (const [codexUnproductive, expected] of [[0, trigger ? 'codex-alt' : 'codex'], [1, trigger ? 'codex-alt' : 'codex'], [2, 'codex-alt'], [3, 'argon'], [4, 'claude'], [9, 'claude']]) {
      expect(pick({ trigger, codexUnproductive }).rung).toBe(expected);
    }
  });
  it('includes Gemini in the configured ladder, subject to admission', () => {
    const repo = JSON.parse(readFileSync('scripts/settings/fix-executor.json', 'utf8'));
    expect(FIX_EXECUTOR_CHAIN_DEFAULT).toEqual(['codex', 'codex-alt', 'argon', 'claude']);
    expect(repo.fixExecutor.fixSeatMix).toEqual(['codex', 'codex-alt', 'gemini', 'claude']);
  });
  it.each([[0,'codex'],[1,'codex'],[2,'codex-alt'],[3,'argon'],[4,'claude'],[9,'claude']])('ordinary u=%s chooses %s', (codexUnproductive, rung) => expect(pick({codexUnproductive}).rung).toBe(rung));
  it.each(['stronger-model','takeover','ruling-not-addressed'])('%s starts on the next rung', trigger => {
    expect(pick({trigger}).rung).toBe('codex-alt');
  });
  it.each([null,'stronger-model','takeover','ruling-not-addressed'])('critical %s follows the ordinary ladder and requires review', trigger => {
    for (const codexUnproductive of [0,2,3,4,9]) {
      expect(pick({trigger,critical:true,codexUnproductive})).toMatchObject({...pick({trigger,codexUnproductive}),requiresReview:true});
    }
    expect(formatFixExecutorLog(chooseFixExecutor({chain:{value:chain},critical:true,launcherAvailable:true}))).toContain('requiresReview=true');
  });
  it('records skipped Gemini before exhausted-chain Claude', () => {
    expect(pick({codexUnproductive:3,launcherAvailable:e=>e!=='antigravity'})).toMatchObject({executor:'claude',reason:expect.stringContaining('gemini skipped: no admitted fix path')});
  });
  it.each([null,'stronger-model','takeover','ruling-not-addressed'])('legacy chain reproduces %s', trigger => {
    for (const codexUnproductive of [0,1,2,3,9]) expect(pick({chain:['codex','claude'],trigger,codexUnproductive}).executor).toBe(trigger || codexUnproductive >= 2 ? 'claude' : 'codex');
  });
  it('skips an unavailable Argon launcher', () => expect(pick({codexUnproductive:3, launcherAvailable:e=>e!=='antigravity'})).toMatchObject({executor:'claude',reason:expect.stringContaining('argon launcher unavailable')}));
  it.each([false, true])('refuses an unavailable terminal launcher with critical=%s', critical => {
    for (const trigger of [null, 'stronger-model', 'takeover', 'ruling-not-addressed']) {
      for (const codexUnproductive of [0, 2, 3, 4, 20]) {
        for (const value of [chain, ['codex', 'claude'], ['claude']]) {
          expect(pick({ chain: value, trigger, codexUnproductive, critical, launcherAvailable: () => false }))
            .toMatchObject({ executor: null, rung: null, source: 'capacity', reason: 'no available executor' });
        }
      }
    }
    expect(pick({ chain: ['codex', 'claude'], trigger: 'takeover', critical,
      launcherAvailable: executor => executor !== 'claude' })).toMatchObject({ executor: null, rung: null });
  });
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
  const defaults = {mode:'direct',modeSource:'standard',criticalGlobs:expect.any(Array)};
  it('defaults, then platform, repo, env override', () => {
    expect(resolve({})).toEqual({...defaults,value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'default'});
    expect(resolve({platform:layer(['argon','claude'])})).toEqual({...defaults,value:['argon','claude'],source:'platform'});
    expect(resolve({platform:layer(['argon','claude']),repo:layer(['codex','claude'])})).toEqual({...defaults,value:['codex','claude'],source:'repo'});
    for (const raw of ['codex-alt,claude','["codex-alt","claude"]']) expect(resolve({repo:layer(['codex','claude']),env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:raw}})).toEqual({...defaults,value:['codex-alt','claude'],source:'env'});
  });
  it('defaults to direct and resolves role modes and seat aliases through the cascade', () => {
    expect(resolve({}).mode).toBe('direct');
    const repo = {fixExecutor:{fixSeatMix:['codex-alt','gemini','claude'],executionMode:'wrapped',executionModeByRole:{'ci-heal':'direct'}}};
    expect(resolve({repo})).toMatchObject({value:['codex-alt','argon','claude'],mode:'wrapped',modeSource:'tool'});
    expect(resolve({repo,kind:'ci-heal'}).mode).toBe('direct');
    for (const kind of ['fix','ci-heal']) expect(resolve({repo:{fixExecutor:{executionModeByRole:{[kind]:'wrapped'}}},kind}).mode).toBe('wrapped');
    expect(resolve({repo:{fixExecutor:{executionMode:'invalid'}}}).mode).toBe('direct');
    expect(resolve({env:{WE_FIX_EXECUTOR_EXECUTION_MODE:'wrapped'}})).toMatchObject({mode:'wrapped',modeSource:'env'});
    expect(resolve({repo,env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:'codex,claude'}}).value).toEqual(['codex','claude']);
  });
  it('cascades the explicit critical path list', () => {
    expect(resolve({platform:{fixExecutor:{criticalGlobs:['scripts/land/**']}},repo:{fixExecutor:{criticalGlobs:['scripts/security/**']}}}).criticalGlobs).toEqual(['scripts/security/**']);
    expect(resolve({repo:{fixExecutor:{criticalGlobs:[]}}}).criticalGlobs).toEqual(resolve({}).criticalGlobs);
    expect(resolve({platform:{fixExecutor:{criticalGlobs:['scripts/land/**']}},repo:{fixExecutor:{criticalGlobs:[]}}}).criticalGlobs).toEqual(['scripts/land/**']);
  });
  it.each([[],['codex'],['unknown','claude'],['claude','claude'],null,'codex,claude'])('ignores invalid layers %j', raw => {
    expect(resolve({platform:layer(['argon','claude']),repo:layer(raw),env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:'bad'}})).toEqual({...defaults,value:['argon','claude'],source:'platform'});
  });
});
