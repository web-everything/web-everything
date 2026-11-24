import { describe, it, expect } from 'vitest';
import { FIX_EXECUTOR_RUNGS, FIX_EXECUTOR_CHAIN_DEFAULT, resolveFixExecutorChain, resolveFixCriticalGlobs, pickChainRung } from '../fix-executor-chain.mjs';
import { chooseFixExecutor, formatFixExecutorLog } from '../fix-slot-borrow.mjs';
import { codexModelSupportsEffort } from '../codex-model-routing.mjs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import micromatch from 'micromatch';
const chain = ['codex', 'codex-alt', 'argon', 'claude'];
const pick = (input = {}) => pickChainRung({ chain, launcherAvailable: () => true, ...input });
// Native ESM in a fresh process exercises initialization, including the circular borrow import.
function probeSettings(contents, error) {
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const { contents, error } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      // Exercise executor settings independently of the shipped auto-capacity routing policy.
      // An absent builder retains the declared reader's fail-closed handling of read errors.
      if (String(path).endsWith('/settings/routing.json')) return '{}';
      if (!String(path).endsWith('/settings/fix-executor.json')) return read(path, ...args);
      if (error) throw Object.assign(new Error('settings unavailable'), { code: error });
      return contents;
    };
    syncBuiltinESMExports();
    // Use a filesystem URL: the parent test's DOM URL base can be http://localhost.
    const module = await import(${JSON.stringify(pathToFileURL('scripts/lib/fix-executor-chain.mjs').href)});
    const options = { env: {}, platform: {}, capacity: [], quota: () => null, record: () => {} };
    console.log(JSON.stringify({
      value: module.FIX_EXECUTOR_CHAIN_DEFAULT,
      frozen: Object.isFrozen(module.FIX_EXECUTOR_CHAIN_DEFAULT),
      roles: module.resolveRepairExecutorChains({ ...options, repo: {} }),
      declaredRoles: module.resolveRepairExecutorChains(options),
    }));
  `], { input: JSON.stringify({ contents, error }), encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    env: { ...process.env, WE_POLICY_CASCADE_LOG: '0' } });
  expect(probe.error).toBeUndefined();
  expect(probe.status, probe.stderr).toBe(0);
  return JSON.parse(probe.stdout);
}
describe('fix executor chain', () => {
  it.each([
    ['missing file', undefined, 'ENOENT'],
    ['unreadable file', undefined, 'EACCES', ['argon', 'claude']],
    ['invalid JSON', '{', undefined, ['argon', 'claude']],
    ['empty file', '', undefined, ['argon', 'claude']],
    ['empty object', '{}'],
    ['null document', 'null', undefined, ['argon', 'claude']],
    ['array document', '[]', undefined, ['argon', 'claude']],
    ['scalar document', 'false', undefined, ['argon', 'claude']],
    ['null namespace', '{"fixExecutor":null}'],
    ['scalar namespace', '{"fixExecutor":false}'],
    ['array namespace', '{"fixExecutor":[]}'],
    ['empty namespace', '{"fixExecutor":{}}'],
    ['invalid values', '{"fixExecutor":{"fixSeatMix":false,"criticalGlobs":[null]}}'],
    ['non-string rung', '{"fixExecutor":{"fixSeatMix":[{"toString":null},"claude"]}}'],
    ['empty critical list', '{"fixExecutor":{"criticalGlobs":[]}}'],
    ['blank critical glob', '{"fixExecutor":{"criticalGlobs":[" "]}}'],
    ['scalar critical list', '{"fixExecutor":{"criticalGlobs":"scripts/**"}}'],
  ])('imports and resolves both repair roles with %s', (_label, contents, error, declaredChain = chain) => {
    const { value, frozen, roles, declaredRoles } = probeSettings(contents, error);
    expect(value).toEqual(chain);
    expect(frozen).toBe(true);
    for (const kind of ['fix', 'ci-heal']) {
      expect(roles[kind]).toMatchObject({ value: chain, mode: 'direct', criticalGlobs: ['**'] });
      // Read/parse errors reserve Codex; a missing file or invalid executor leaf uses defaults.
      expect(declaredRoles[kind]).toMatchObject({ value: declaredChain, mode: 'direct', criticalGlobs: ['**'] });
      for (const path of ['scripts/lib/fix-executor-chain.mjs', '.env', '.github/workflows/check.yml']) {
        expect(micromatch.isMatch(path, roles[kind].criticalGlobs, { nocase: true, dot: true })).toBe(true);
      }
    }
  });
  it('preserves valid shipped settings during native initialization', () => {
    const fixExecutor = { fixSeatMix: ['codex-alt', 'gemini', 'claude'], criticalGlobs: ['scripts/security/**'] };
    const { value, roles, declaredRoles } = probeSettings(JSON.stringify({ fixExecutor }));
    expect(value).toEqual(['codex-alt', 'argon', 'claude']);
    expect(roles.fix.criticalGlobs).toEqual(fixExecutor.criticalGlobs);
    expect(roles['ci-heal'].criticalGlobs).toEqual(fixExecutor.criticalGlobs);
    for (const kind of ['fix', 'ci-heal']) {
      expect(declaredRoles[kind]).toMatchObject({ value, mode: 'direct', criticalGlobs: fixExecutor.criticalGlobs });
    }
  });
  it.each(['fix', 'ci-heal'])('%s with auto routing and no capacity refuses an executor', kind => {
    const resolved = resolveFixExecutorChain({ env: {}, platform: {}, repo: { routing: { builder: 'auto' } },
      kind, capacity: [], quota: () => null, record: () => {} });
    expect(resolved).toMatchObject({ value: [], source: 'default+capacity', mode: 'direct' });
    expect(pickChainRung({ chain: resolved.value })).toMatchObject({ executor: null, rung: null,
      reason: expect.stringContaining('no eligible capacity') });
  });
  it.each([[], ['codex'], ['unknown', 'claude'], ['claude', 'claude'], null].map(value => [value]))('rejects invalid shipped seat mix %j with a frozen fallback', fixSeatMix => {
    const { value, frozen } = probeSettings(JSON.stringify({ fixExecutor: { fixSeatMix } }));
    expect(value).toEqual(chain);
    expect(frozen).toBe(true);
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
  it('logs the chosen rung and its provenance through chooseFixExecutor', () => {
    const decision = chooseFixExecutor({chain:{value:chain,source:'repo'},critical:true,launcherAvailable:true});
    expect(decision).toMatchObject({executor:'codex',rung:'codex',provider:'codex',source:'repo',requiresReview:true});
    expect(formatFixExecutorLog(decision)).toContain('rung=codex');
    expect(formatFixExecutorLog(decision)).toContain('requiresReview=true');
    expect(formatFixExecutorLog(decision)).toContain('source repo');
    const alt = chooseFixExecutor({chain:{value:chain,source:'env'},critical:true,strongerModel:true,launcherAvailable:true});
    expect(alt).toMatchObject({rung:'codex-alt',source:'env',policyRoute:{model:'gpt-6-astra',effort:'high'}});
    expect(formatFixExecutorLog(alt)).toContain('rung=codex-alt model=gpt-6-astra effort=high');
  });
  it('skips an unavailable launcher before the critical path applies', () => {
    expect(pick({chain:['argon','codex-alt','claude'],critical:true,launcherAvailable:executor=>executor==='codex'})).toMatchObject({
      executor:'codex',rung:'codex-alt',requiresReview:true,reason:expect.stringContaining('argon launcher unavailable, fallback')});
    expect(pick({critical:true,launcherAvailable:()=>false})).toMatchObject({executor:'claude',rung:'claude',requiresReview:true});
  });
  it('keeps Claude-only paths outside the chain on Claude when critical', () => {
    for (const entry of [{takeover:true},{rulingNotAddressed:true},{mainFix:true},{strongerModel:true},{codexUnproductive:2}]) {
      expect(chooseFixExecutor({...entry,critical:true,launcherAvailable:true}).executor).toBe('claude');
    }
    expect(chooseFixExecutor({chain:{value:chain},mainFix:true,critical:true,launcherAvailable:true}).executor).toBe('claude');
  });
  it('follows directExecutorPlan for critical work with two unproductive runs, not a threshold', () => {
    const critical = pick({critical:true,codexUnproductive:2});
    expect(critical).toMatchObject({...pick({codexUnproductive:2}),requiresReview:true});
    expect(critical).toMatchObject({executor:'codex',rung:'codex-alt'});
    expect(pick({critical:true,codexUnproductive:3})).toMatchObject({executor:'antigravity',rung:'argon'});
    expect(pick({critical:true,codexUnproductive:4})).toMatchObject({executor:'claude',rung:'claude'});
  });
  it('resolves the explicit critical path list through the default, platform and repo cascade', () => {
    const globs = input => resolveFixCriticalGlobs({env:{},platform:{},repo:{},...input});
    const shipped = globs({});
    expect(shipped).toEqual(JSON.parse(readFileSync('scripts/settings/fix-executor.json','utf8')).fixExecutor.criticalGlobs);
    expect(globs({platform:{fixExecutor:{criticalGlobs:['scripts/land/**']}}})).toEqual(['scripts/land/**']);
    expect(globs({platform:{fixExecutor:{criticalGlobs:['scripts/land/**']}},repo:{fixExecutor:{criticalGlobs:['scripts/security/**']}}})).toEqual(['scripts/security/**']);
    for (const bad of [[],[''],['  '],[1],'scripts/**',null]) expect(globs({repo:{fixExecutor:{criticalGlobs:bad}}})).toEqual(shipped);
    expect(globs({env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:'claude'},repo:{fixExecutor:{criticalGlobs:['x/**']}}})).toEqual(['x/**']);
  });
  it('records skipped Gemini before exhausted-chain Claude', () => {
    expect(pick({codexUnproductive:3,launcherAvailable:e=>e!=='antigravity'})).toMatchObject({executor:'claude',reason:expect.stringContaining('gemini skipped: no admitted fix path')});
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
  it.each([[],['codex'],['unknown','claude'],['claude','claude'],null,'codex,claude'])('ignores invalid layers %j', raw => {
    expect(resolve({platform:layer(['argon','claude']),repo:layer(raw),env:{WE_FIX_EXECUTOR_FALLBACK_CHAIN:'bad'}})).toEqual({...defaults,value:['argon','claude'],source:'platform'});
  });
});
