import { describe, it, expect, vi } from 'vitest';
import { resolveAiRouting } from '../../lib/ai-routing.mjs';
import { defaultRun, redTeamBrief } from '../../lib/brief-red-team.mjs';
import { opusCommand } from '../scheduled-sweep.mjs';
import { buildRestrictedProviderArgv } from '../minimal-context-provider.mjs';
import { makeSummariser, DEFAULTS, MANDATE, SAMPLE_SHAPE, sessionInput } from '../coroner-sample.mjs';
import { fenceUntrusted, FENCED_DATA_RULE } from '../../lib/mandate-fence.mjs';

const env = { WE_CLAUDE_HELPER_MODEL: 'sonnet' };
const resolve = (coordinator = {}) => resolveAiRouting({ env: {}, tool: { helper: { coordinator } },
  platform: {}, accountMap: { accounts: {} }, log: false });
const inherit = resolve();
// Deliberately bypass cascade validation for consumer-side unusable-input tests.
const injected = coordinator => ({ value: { helper: { coordinator, executors: 'inherit' } }, sources: {} });
const providerArgs = { sessionId: 'session', prompt: 'prompt', settingsFile: 'hooks.json' };
const briefArgs = { files: ['scripts/lib/red-team-gate.mjs'], prep: 'prep', acceptance: 'acceptance',
  policy: { maxClasses: 6, timeoutMs: 1000 }, log: false, env };
const rec = { session: 'session' };
async function brief(resolved, extra = {}) {
  const spawn = vi.fn(async () => ({ value: { classes: [] } }));
  await defaultRun({ ...briefArgs, resolved, spawn, ...extra });
  return spawn.mock.calls[0][0];
}
async function coroner(resolved, knobs = DEFAULTS, extra = {}) {
  const spawn = vi.fn(async () => ({ value: {}, costUsd: 0 }));
  const summarise = await makeSummariser(knobs, { env, resolved, spawn, log: false, ...extra });
  await summarise(rec);
  return spawn.mock.calls[0][0];
}
const sites = [
  ['sweep', async (resolved, log = false) => opusCommand({ env, resolved, log }).args],
  ['provider', async (resolved, log = false) => buildRestrictedProviderArgv({ ...providerArgs, env, resolved, log })],
  ['brief', (resolved, log = false) => brief(resolved, { log })],
  ['coroner', (resolved, log = false) => coroner(resolved, DEFAULTS, { log })],
];
const modelOf = output => Array.isArray(output) ? output[output.indexOf('--model') + 1] : output.model;
const effortOf = output => Array.isArray(output) ? output[output.indexOf('--effort') + 1] : output.effort;

describe('helper inherit preserves the complete pre-routing output', () => {
  it('sweep keeps every argv byte and omits effort', () => {
    const { args, briefPath } = opusCommand({ env, resolved: inherit, log: false });
    const root = briefPath.slice(0, -'/skills-src/conveyor/opus-sweep-brief.md'.length);
    expect(args).toEqual(['-p', '--model', 'opus', '--restricted', '--tools', 'Read,Grep,Glob',
      '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch',
      '--permission-mode', 'default', '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', '5', '--add-dir', root]);
  });
  it('provider keeps fresh and resume argv byte-identical', () => {
    const prefix = ['--restricted', '--tools', 'Bash,Edit,Write,Read,Glob,Grep', '--strict-mcp-config',
      '--disable-slash-commands', '--settings', 'hooks.json'];
    expect(buildRestrictedProviderArgv({ ...providerArgs, env, resolved: inherit })).toEqual([
      ...prefix, '--model', 'sonnet', '--effort', 'medium', '-p', '--session-id', 'session', 'prompt']);
    expect(buildRestrictedProviderArgv({ ...providerArgs, env, resolved: inherit, resumeSessionId: 'resume' }))
      .toEqual([...prefix, '--resume', 'resume', 'prompt']);
  });
  it('brief keeps the judge request identical, including omitted model and effort', async () => {
    expect(await brief(inherit)).toEqual({
      mandate: `Find adversarial attack classes against the supplied prep and acceptance. Each class must have a concrete test. Return only {classes:[{attack,test}]}, at most 6 classes. You have no tools.\n${FENCED_DATA_RULE}`,
      input: fenceUntrusted('material', JSON.stringify({ files: briefArgs.files, prep: 'prep', acceptance: 'acceptance' })),
      shape: { type: 'object', additionalProperties: false, required: ['classes'], properties: { classes: {
        type: 'array', items: { type: 'object', additionalProperties: false, required: ['attack', 'test'],
          properties: { attack: { type: 'string' }, test: { type: 'string' } } } } } },
      allowedTools: null, runId: 'brief-red-team', timeoutMs: 1000, retries: 0, log: false,
    });
  });
  it('coroner keeps the judge request identical, using the knob model and effort', async () => {
    expect(await coroner(inherit)).toEqual({ mandate: MANDATE, input: sessionInput(rec), shape: SAMPLE_SHAPE,
      model: 'haiku', effort: 'low', budget: 0.25, runId: 'coroner-sample', lens: 'session' });
  });
});

for (const [name, run] of sites) describe(`${name} helper safety`, () => {
  it('accepts a resolvable Opus alias without lowering the site floor', async () => {
    const output = await run(resolve({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }));
    expect(modelOf(output)).toBe('opus');
    if (name !== 'sweep') expect(effortOf(output)).toBe('high');
  });
  it('refuses an unusable model before any real spawn', async () => {
    await expect(run(resolve({ provider: 'claude', model: 'unknown-model' }))).rejects.toThrow(/aiRouting.helper/);
  });
  it('refuses a valid model on an unsupported provider instead of falling back', async () => {
    await expect(run(resolve({ provider: 'codex', model: 'gpt-6-astra' }))).rejects.toThrow(/requires Claude/);
  });
  it('does not consume account or executor settings', async () => {
    const resolved = injected({ account: 'unusable-account', provider: 'inherit', model: 'inherit', effort: 'inherit' });
    resolved.value.helper.executors = [{ provider: 'codex', model: 'gpt-6-astra' }];
    expect(await run(resolved)).toEqual(await run(inherit));
  });
});

it('logs and ignores lowering model overrides at every site with a higher current tier', async () => {
  for (const [name, run] of sites.filter(([name]) => name !== 'coroner')) {
    const log = vi.fn();
    expect(await run(resolve({ provider: 'claude', model: 'haiku' }), log)).toEqual(await run(inherit, log));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ignoring lowering override'));
  }
  const log = vi.fn();
  const knobs = { ...DEFAULTS, model: 'opus', effort: 'high' };
  expect(await coroner(resolve({ provider: 'claude', model: 'sonnet', effort: 'low' }), knobs, { log }))
    .toEqual(await coroner(inherit, knobs, { log }));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('model sonnet below current opus'));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('effort low below current high'));
});

it('preserves caller effort floors while allowing a model raise', async () => {
  const log = vi.fn();
  const resolved = resolve({ provider: 'claude', model: 'opus', effort: 'low' });
  const argv = buildRestrictedProviderArgv({ ...providerArgs, model: 'sonnet', effort: 'max', env, resolved, log });
  expect(modelOf(argv)).toBe('opus');
  expect(effortOf(argv)).toBe('max');
  const request = await brief(resolved, { log });
  expect(request.model).toBe('opus');
  expect(request).not.toHaveProperty('effort'); // judgeSpawn's medium default stays intact
  expect(log).toHaveBeenCalledWith(expect.stringContaining('effort low below current'));
});

it('keeps the sweep implicit effort unchanged and logs why the override is ignored', () => {
  const log = vi.fn();
  expect(opusCommand({ env, resolved: resolve({ effort: 'max' }), log }))
    .toEqual(opusCommand({ env, resolved: inherit, log: false }));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('implicit CLI effort has no proven floor'));
});

it('reads helper routing from injected environment through the real resolver', () => {
  const routedEnv = { ...env, WE_AI_ROUTING: JSON.stringify({ helper: { coordinator: {
    provider: 'claude', model: 'opus', effort: 'high',
  } } }) };
  const argv = buildRestrictedProviderArgv({ ...providerArgs, env: routedEnv, log: false });
  expect(modelOf(argv)).toBe('opus');
  expect(effortOf(argv)).toBe('high');
});

it('refuses unknown inherited model pins and invalid effort without spawning', async () => {
  expect(() => buildRestrictedProviderArgv({ ...providerArgs, model: 'unknown', env, resolved: inherit })).toThrow(/unknown model/);
  await expect(coroner(inherit, { ...DEFAULTS, model: 'unknown' })).rejects.toThrow(/unknown model/);
  await expect(brief(resolve({ effort: 'unknown' }))).rejects.toThrow(/aiRouting.helper/);
});

describe('helper routing refusals survive real cascade fallback', () => {
  it.each([
    ['model', { provider: 'claude', model: 'unknown-model' }],
    ['effort', { effort: 'unknown' }],
    ['provider', { provider: 'unknown', model: 'sonnet' }],
    ['combination', { provider: 'claude', model: 'gpt-6-astra' }],
  ])('refuses an invalid %s from environment before returning provider argv', (_, coordinator) => {
    const routedEnv = { ...env, WE_AI_ROUTING: JSON.stringify({ helper: { coordinator } }) };
    expect(() => buildRestrictedProviderArgv({ ...providerArgs, env: routedEnv, log: false }))
      .toThrow(/aiRouting.helper/);
  });

  it.each([
    ['unsupported provider', { provider: 'codex', model: 'gpt-6-astra' }],
    ['unknown model', { provider: 'claude', model: 'unknown-model' }],
    ['invalid effort', { effort: 'unknown' }],
  ])('refuses a resumed launch with %s', (_, coordinator) => {
    expect(() => buildRestrictedProviderArgv({ ...providerArgs, resumeSessionId: 'resume',
      env, resolved: resolve(coordinator), log: false })).toThrow(/aiRouting.helper/);
  });

  it.each([{}, { currentModel: 'opus', currentEffort: 'max' }])('preserves inherited resume bytes with persisted settings %j through the environment resolver', (persisted) => {
    expect(buildRestrictedProviderArgv({ ...providerArgs, resumeSessionId: 'resume',
      ...persisted,
      env: { ...env, WE_AI_ROUTING: JSON.stringify({ helper: { coordinator: {
        provider: 'inherit', model: 'inherit', effort: 'inherit',
      } } }) }, log: false })).toEqual([
      '--restricted', '--tools', 'Bash,Edit,Write,Read,Glob,Grep', '--strict-mcp-config',
      '--disable-slash-commands', '--settings', 'hooks.json', '--resume', 'resume', 'prompt',
    ]);
  });

  it.each([
    [{ provider: 'claude', model: 'opus', effort: 'max' }, ['--model', 'opus', '--effort', 'max']],
    [{ provider: 'claude', model: 'opus' }, ['--model', 'opus']],
    [{ effort: 'max' }, ['--effort', 'max']],
  ])('carries validated resume overrides %j through the real environment resolver', (coordinator, flags) => {
    expect(buildRestrictedProviderArgv({ ...providerArgs, resumeSessionId: 'resume',
      currentModel: 'sonnet', currentEffort: 'medium',
      env: { ...env, WE_AI_ROUTING: JSON.stringify({ helper: { coordinator } }) }, log: false }))
      .toEqual([
        '--restricted', '--tools', 'Bash,Edit,Write,Read,Glob,Grep', '--strict-mcp-config',
        '--disable-slash-commands', '--settings', 'hooks.json', ...flags, '--resume', 'resume', 'prompt',
      ]);
  });

  it('omits resume overrides with unknown persisted floors and logs each reason', () => {
    const log = vi.fn();
    const argv = buildRestrictedProviderArgv({ ...providerArgs, resumeSessionId: 'resume',
      model: 'haiku', effort: 'low', env, resolved: resolve({ provider: 'claude', model: 'opus', effort: 'max' }), log });
    expect(argv).toEqual(buildRestrictedProviderArgv({ ...providerArgs, resumeSessionId: 'resume',
      env, resolved: inherit, log: false }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('current model has no proven floor'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('effort has no proven floor'));
  });

  it('raises resume settings over persisted floors even when overrides equal fresh defaults', () => {
    const argv = buildRestrictedProviderArgv({ ...providerArgs, resumeSessionId: 'resume',
      currentModel: 'haiku', currentEffort: 'low', env,
      resolved: resolve({ provider: 'claude', model: 'sonnet', effort: 'medium' }), log: false });
    expect(argv.slice(-7)).toEqual(['--model', 'sonnet', '--effort', 'medium', '--resume', 'resume', 'prompt']);
  });

  it.each([
    [{ currentModel: 'haiku' }, ['--model', 'sonnet']],
    [{ currentEffort: 'low' }, ['--effort', 'high']],
    [{ currentModel: 'sonnet', currentEffort: 'high' }, []],
  ])('checks resume floors independently for %j', (persisted, flags) => {
    const argv = buildRestrictedProviderArgv({ ...providerArgs, resumeSessionId: 'resume', ...persisted,
      env, resolved: resolve({ provider: 'claude', model: 'sonnet', effort: 'high' }), log: false });
    expect(argv).toEqual([
      '--restricted', '--tools', 'Bash,Edit,Write,Read,Glob,Grep', '--strict-mcp-config',
      '--disable-slash-commands', '--settings', 'hooks.json', ...flags, '--resume', 'resume', 'prompt',
    ]);
  });

  it('omits sonnet/high overrides that would lower a persisted opus/max session and logs why', () => {
    const log = vi.fn();
    const argv = buildRestrictedProviderArgv({ ...providerArgs, resumeSessionId: 'resume',
      currentModel: 'opus', currentEffort: 'max', env,
      resolved: resolve({ provider: 'claude', model: 'sonnet', effort: 'high' }), log });
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--effort');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('model sonnet below current opus'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('effort high below current max'));
  });

  it.each([
    ['unsupported provider', { provider: 'codex', model: 'gpt-6-astra' }],
    ['unknown model', { provider: 'claude', model: 'unknown-model' }],
  ])('propagates %s through redTeamBrief rather than returning zero classes', async (_, coordinator) => {
    const run = vi.fn(async args => defaultRun({ ...args, spawn }));
    const spawn = vi.fn(async () => ({ value: { classes: [] } }));
    await expect(redTeamBrief({ ...briefArgs, resolved: resolve(coordinator), run }))
      .rejects.toThrow(/aiRouting.helper/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps ordinary judge failures fail-open through the default runner and real resolver', async () => {
    const spawn = vi.fn(async () => { throw new Error('judge unavailable'); });
    const result = await redTeamBrief({ ...briefArgs, resolved: resolve(),
      run: args => defaultRun({ ...args, spawn }) });
    expect(result).toEqual({ status: 'failed', reason: 'judge unavailable', classes: [] });
    expect(spawn).toHaveBeenCalledOnce();
  });
});
