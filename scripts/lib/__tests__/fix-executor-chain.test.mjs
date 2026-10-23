import { describe, it, expect } from 'vitest';
import { FIX_EXECUTOR_RUNGS, FIX_EXECUTOR_CHAIN_DEFAULT, resolveFixExecutorChain, pickChainRung } from '../fix-executor-chain.mjs';
import { chooseFixExecutor, formatFixExecutorLog } from '../fix-slot-borrow.mjs';
import { codexModelSupportsEffort } from '../codex-model-routing.mjs';
import { readFileSync } from 'node:fs';
const chain = ['codex', 'codex-alt', 'argon', 'claude'];
const pick = (input = {}) => pickChainRung({ chain, launcherAvailable: () => true, ...input });
describe('fix executor chain', () => {
  it.each([null, 'stronger-model', 'takeover', 'ruling-not-addressed'])('combines %s with failure progress without skipping a rung', trigger => {
    for (const [codexUnproductive, expected] of [[0, trigger ? 'codex-alt' : 'codex'], [1, trigger ? 'codex-alt' : 'codex'], [2, 'codex-alt'], [3, 'argon'], [4, 'claude'], [9, 'claude']]) {
      expect(pick({ trigger, codexUnproductive }).rung).toBe(expected);
    }
  });
  it('excludes the unconfined Argon worker from both shipped defaults', () => {
    const repo = JSON.parse(readFileSync('scripts/settings/fix-executor.json', 'utf8'));
    expect(FIX_EXECUTOR_CHAIN_DEFAULT).toEqual(['codex', 'codex-alt', 'claude']);
    expect(repo.fixExecutor.fallbackChain).toEqual(['codex', 'codex-alt', 'claude']);
    expect(repo.fixExecutor.criticalClaudeFromRung).toBe(2);
  });
  it.each([[0,'codex'],[1,'codex'],[2,'codex-alt'],[3,'argon'],[4,'claude'],[9,'claude']])('ordinary u=%s chooses %s', (codexUnproductive, rung) => expect(pick({codexUnproductive}).rung).toBe(rung));
  it.each(['stronger-model','takeover','ruling-not-addressed'])('%s starts on the next rung', trigger => {
    expect(pick({trigger}).rung).toBe('codex-alt');
  });
  it.each(['takeover','ruling-not-addressed'])('critical %s stays on Claude regardless of the threshold', trigger => {
    for (const criticalClaudeFromRung of [undefined, 1, 2, 99]) {
      for (const codexUnproductive of [0, 3, 9]) {
        expect(pick({trigger,critical:true,criticalClaudeFromRung,codexUnproductive,criticalSource:'env'}))
          .toEqual({executor:'claude',rung:'claude',reason:'critical work never leaves Claude',source:'default'});
      }
    }
  });
  it('keeps critical stronger-model work on codex-alt below the threshold', () => {
    expect(pick({trigger:'stronger-model', critical:true})).toMatchObject({executor:'codex', rung:'codex-alt',
      reason:expect.stringContaining('; critical work stays on codex-alt below criticalClaudeFromRung=2 (source=default)')});
  });
  it('keeps ordinary critical work on rung zero', () => expect(pick({critical:true})).toMatchObject({rung:'codex',
    reason:expect.stringContaining('; critical work stays on codex below criticalClaudeFromRung=2 (source=default)')}));
  it('keeps critical work with two unproductive runs at index one on codex-alt', () => {
    expect(pick({chain:FIX_EXECUTOR_CHAIN_DEFAULT,critical:true,codexUnproductive:2})).toMatchObject({rung:'codex-alt',executor:'codex'});
  });
  it('sends critical work at index two to Claude', () => {
    for (const value of [FIX_EXECUTOR_CHAIN_DEFAULT, chain]) expect(pick({chain:value,critical:true,codexUnproductive:3}))
      .toMatchObject({executor:'claude',rung:'claude',reason:'critical work reaches Claude from rung 2 (criticalClaudeFromRung=2, source=default)'});
  });
  it.each([null,'stronger-model','takeover','ruling-not-addressed'])('threshold one restores critical %s escalation', trigger => {
    expect(pick({critical:true,trigger,codexUnproductive:2,criticalClaudeFromRung:1,criticalSource:'env'})).toMatchObject({executor:'claude',
      reason:trigger === 'takeover' || trigger === 'ruling-not-addressed' ? 'critical work never leaves Claude'
        : 'critical work reaches Claude from rung 1 (criticalClaudeFromRung=1, source=env)'});
  });
  it('passes threshold and provenance through chooseFixExecutor and its log', () => {
    const resolved = {value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'repo',criticalClaudeFromRung:1,criticalClaudeFromRungSource:'env'};
    const input = {chain:resolved,critical:true,strongerModel:true,launcherAvailable:true};
    const escalated = chooseFixExecutor(input);
    expect(escalated).toMatchObject({executor:'claude',reason:'critical work reaches Claude from rung 1 (criticalClaudeFromRung=1, source=env)'});
    expect(formatFixExecutorLog(escalated)).toContain('criticalClaudeFromRung=1, source=env');
    const stayed = chooseFixExecutor({...input,chain:{...resolved,criticalClaudeFromRung:2}});
    expect(stayed).toMatchObject({rung:'codex-alt',executor:'codex',policyRoute:{model:'gpt-6-astra',effort:'high'}});
    expect(formatFixExecutorLog(stayed)).toContain('critical work stays on codex-alt below criticalClaudeFromRung=2 (source=env)');
  });
  it('preserves Claude-only paths outside the chain', () => {
    for (const entry of [{takeover:true},{rulingNotAddressed:true},{mainFix:true},{strongerModel:true},{codexUnproductive:2}]) {
      expect(chooseFixExecutor({...entry,critical:true,launcherAvailable:true}).executor).toBe('claude');
    }
    expect(chooseFixExecutor({chain:{value:chain},mainFix:true,critical:true,launcherAvailable:true}).executor).toBe('claude');
  });
  it('still skips unavailable launchers before applying the critical threshold', () => {
    expect(pick({critical:true,trigger:'stronger-model',launcherAvailable:()=>false})).toMatchObject({executor:'claude'});
  });
  it('honors thresholds beyond the chain while retaining its Claude fallback', () => {
    expect(pick({critical:true,criticalClaudeFromRung:99,codexUnproductive:9})).toMatchObject({executor:'claude',
      reason:expect.stringContaining('chain exhausted')});
  });
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
  const defaults = {criticalClaudeFromRung:2,criticalClaudeFromRungSource:'default'};
  it('defaults, then platform, repo, env override', () => {
    expect(resolve({})).toEqual({...defaults,value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'default'});
    expect(resolve({platform:layer(['argon','claude'])})).toEqual({...defaults,value:['argon','claude'],source:'platform'});
    expect(resolve({platform:layer(['argon','claude']),repo:layer(['codex','claude'])})).toEqual({...defaults,value:['codex','claude'],source:'repo'});
    for (const raw of ['codex-alt,claude','["codex-alt","claude"]']) expect(resolve({repo:layer(['codex','claude']),env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:raw}})).toEqual({...defaults,value:['codex-alt','claude'],source:'env'});
  });
  it('resolves the critical threshold independently through default, platform, repo and env', () => {
    const input = {platform:{fixExecutor:{criticalClaudeFromRung:3}},repo:{},env:{}};
    expect(resolve({})).toEqual({...defaults,value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'default'});
    expect(resolve(input)).toEqual({value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'default',criticalClaudeFromRung:3,criticalClaudeFromRungSource:'platform'});
    input.repo = {fixExecutor:{criticalClaudeFromRung:1}};
    expect(resolve(input)).toEqual({value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'default',criticalClaudeFromRung:1,criticalClaudeFromRungSource:'repo'});
    input.env.WE_FIX_EXECUTOR_CRITICAL_CLAUDE_FROM_RUNG = '4';
    expect(resolve(input)).toEqual({value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'default',criticalClaudeFromRung:4,criticalClaudeFromRungSource:'env'});
  });
  it.each([0,-1,1.5,null,true,'1',[],{}, {nested:1},Number.MAX_SAFE_INTEGER+1])('ignores invalid critical threshold layers %j', raw => {
    expect(resolve({platform:{fixExecutor:{criticalClaudeFromRung:raw}}})).toEqual({...defaults,value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'default'});
    expect(resolve({platform:{fixExecutor:{criticalClaudeFromRung:3}},repo:{fixExecutor:{criticalClaudeFromRung:raw}}}))
      .toEqual({value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'default',criticalClaudeFromRung:3,criticalClaudeFromRungSource:'platform'});
  });
  it.each(['',' ','0','-1','1.5','1e2','2junk','Infinity','9007199254740992'])('ignores invalid critical threshold env %j', raw => {
    expect(resolve({repo:{fixExecutor:{criticalClaudeFromRung:1}},env:{WE_FIX_EXECUTOR_CRITICAL_CLAUDE_FROM_RUNG:raw}}))
      .toEqual({value:FIX_EXECUTOR_CHAIN_DEFAULT,source:'default',criticalClaudeFromRung:1,criticalClaudeFromRungSource:'repo'});
  });
  it.each([[],['codex'],['unknown','claude'],['claude','claude'],null,'codex,claude'])('ignores invalid layers %j', raw => {
    expect(resolve({platform:layer(['argon','claude']),repo:layer(raw),env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:'bad'}})).toEqual({...defaults,value:['argon','claude'],source:'platform'});
  });
});
