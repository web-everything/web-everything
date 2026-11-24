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
  it('critical work runs Codex first and reaches Claude only as the last rung (routing.directExecutorPlan)', () => {
    expect(pick({critical:true})).toMatchObject({executor:'codex',rung:'codex',requiresReview:true});
    expect(pick({critical:true,trigger:'takeover'})).toMatchObject({executor:'codex',rung:'codex-alt'});
    expect(pick({critical:true,codexUnproductive:3})).toMatchObject({rung:'argon'});
    expect(pick({critical:true,codexUnproductive:4})).toMatchObject({executor:'claude',rung:'claude'});
  });
  it('records skipped Gemini before exhausted-chain Claude', () => {
    expect(pick({codexUnproductive:3,launcherAvailable:e=>e!=='antigravity'})).toMatchObject({executor:'claude',reason:expect.stringContaining('gemini skipped: no admitted fix path')});
  });
  it('ignores a retired criticalClaudeFromRung input: critical work follows the ordinary ladder', () => {
    for (const criticalClaudeFromRung of [1, 2, 99]) for (const codexUnproductive of [0, 2, 3]) {
      const { requiresReview, ...decision } = pick({ critical: true, criticalClaudeFromRung, codexUnproductive });
      expect(requiresReview).toBe(true);
      expect(decision).toEqual(pick({ codexUnproductive }));
    }
  });
  it('still skips unavailable launchers for critical work and keeps the review requirement', () => {
    expect(pick({ chain: ['argon', 'codex-alt', 'claude'], critical: true, launcherAvailable: e => e === 'codex' }))
      .toMatchObject({ executor: 'codex', rung: 'codex-alt', requiresReview: true, reason: expect.stringContaining('argon launcher unavailable, fallback') });
  });
  it('keeps non-critical decisions free of the review requirement', () => {
    expect(pick({})).not.toHaveProperty('requiresReview');
    expect(formatFixExecutorLog(chooseFixExecutor({ chain: { value: chain }, launcherAvailable: true }))).toContain('requiresReview=false');
  });
  it.each([{ takeover: true }, { rulingNotAddressed: true }, { mainFix: true }, { strongerModel: true }, { codexUnproductive: 2 }])('critical %j without a chain stays on the Claude-only path', entry => {
    expect(chooseFixExecutor({ ...entry, critical: true, launcherAvailable: true })).toMatchObject({ executor: 'claude', requiresReview: true });
  });
  it('holds critical main-fix work when the chain has no Claude rung instead of routing it to Codex', () => {
    expect(chooseFixExecutor({ chain: { value: ['codex', 'codex-alt'] }, mainFix: true, critical: true, launcherAvailable: true }))
      .toMatchObject({ executor: null, requiresReview: true, reason: expect.stringContaining('main-fix requires Claude') });
  });
  it('reaches Claude through the legacy two-rung chain for critical work once Codex is unproductive', () => {
    expect(pick({ chain: ['codex', 'claude'], critical: true, codexUnproductive: 2 })).toMatchObject({ executor: 'claude', rung: 'claude', requiresReview: true });
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
  it('ignores the retired critical Claude threshold in every layer', () => {
    const retired = { fixExecutor: { criticalClaudeFromRung: 1 } };
    const out = resolve({ platform: retired, repo: retired, env: { WE_FIX_EXECUTOR_CRITICAL_CLAUDE_FROM_RUNG: '1' } });
    expect(out).toEqual({ ...defaults, value: FIX_EXECUTOR_CHAIN_DEFAULT, source: 'default' });
    expect(out).not.toHaveProperty('criticalClaudeFromRung');
  });
  it.each([[['']], [['  ']], [[1]], ['scripts/**'], [{}]])('ignores invalid critical globs %j', raw => {
    expect(resolve({ repo: { fixExecutor: { criticalGlobs: raw } } }).criticalGlobs).toEqual(resolve({}).criticalGlobs);
  });
  it.each([[],['codex'],['unknown','claude'],['claude','claude'],null,'codex,claude'])('ignores invalid layers %j', raw => {
    expect(resolve({platform:layer(['argon','claude']),repo:layer(raw),env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:'bad'}})).toEqual({...defaults,value:['argon','claude'],source:'platform'});
  });
});
