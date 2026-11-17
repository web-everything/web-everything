import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolveAiRouting } from '../ai-routing.mjs';
import { resolveOperationRoute as operationRoute, DEFAULT_ROUTING_POLICY } from '../dispatch-routing-policy.mjs';
import { resolveCodexTaskRoute as codexRoute } from '../codex-task-route.mjs';
import { buildCodexJudgeArgv, codexJudgeSpawn, resolveJudgeRoutingInput } from '../codex-judge-spawn.mjs';
import { createDefaultJudge } from '../../operations/cli-adapter.mjs';

const state = vi.hoisted(() => ({ tool: {}, policy: null, throwing: false, operation: vi.fn(), codex: vi.fn(), route: vi.fn(), aiResolution: vi.fn() }));
vi.mock('../codex-task-route.mjs', async original => {
  const actual = await original();
  return { ...actual, resolveCodexTaskRoute: options => {
    state.route(options);
    return actual.resolveCodexTaskRoute(options);
  } };
});
vi.mock('../ai-routing.mjs', async original => {
  const actual = await original();
  return { ...actual, resolveAiRouting: options => {
    state.aiResolution(options);
    if (state.throwing) throw new Error('unreadable');
    return actual.resolveAiRouting({ ...options, tool: state.tool, platform: {}, accountMap: { accounts: {} } });
  } };
});
vi.mock('../dispatch-routing-policy-io.mjs', async original => {
  const actual = await original();
  const pure = await import('../dispatch-routing-policy.mjs');
  return { ...actual, resolveOperationRoute: options => {
    state.operation(options);
    return pure.resolveOperationRoute({ ...options, policy: state.policy ?? pure.DEFAULT_ROUTING_POLICY, operatorKeys: [] });
  } };
});
vi.mock('../codex-usage-ledger.mjs', () => ({ withCodexUsage: (_meta, run) => run() }));
const env = {};
const paths = { schemaFile: 'scratch/schema.json', outputLastMessageFile: 'scratch/last-message.txt', cwd: 'scratch' };
const setting = { judge: { coordinator: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' } } };
const operationPolicy = (effort = 'high') => ({ ...DEFAULT_ROUTING_POLICY,
  operations: { ...DEFAULT_ROUTING_POLICY.operations, judge: { provider: 'codex', model: 'gpt-6-astra', effort, fallback: [] } } });
const snapshot = tool => resolveAiRouting({ tool, platform: {}, env, accountMap: { accounts: {} }, log: false });
const baseline = pins => codexRoute({ kind: 'review', env, log: false, ...pins });
const request = { mandate: 'Judge the material', input: 'material', shape: { type: 'object' } };
async function spawn(pins = {}) {
  return codexJudgeSpawn({ ...request, env, log: false, ...pins, timeoutMs: 0,
    mkTempDir: () => 'scratch', writeFile: () => {}, readFile: () => '{"ok":true}', removeFile: () => {},
    persistTranscript: () => null, recordScorecard: () => {},
    spawnFn: (_cli, argv) => {
      state.codex(argv);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = new EventEmitter(); child.stdin.end = () => { child.stdout.emit('data', '{"type":"turn.completed"}\n'); child.emit('close', 0); };
      return child;
    } });
}
async function operation(pins = {}) {
  const provider = vi.fn(async () => ({ value: { ok: true } }));
  await createDefaultJudge({ resolveProvider: () => provider })({ ...request, ...pins });
  return provider.mock.calls[0][0];
}
beforeEach(() => { state.tool = {}; state.policy = null; state.throwing = false; vi.clearAllMocks(); });

describe('judge aiRouting consumers', () => {
  it.each([{}, { judge: { coordinator: { provider: 'inherit', model: 'inherit', effort: 'inherit', account: 'inherit' }, executors: 'inherit' } }])(
    'unset/inherit keeps operation routes, both Codex argv sites and logs unchanged: %j', async tool => {
      state.tool = tool;
      const log = vi.fn();
      expect(resolveJudgeRoutingInput({ resolve: () => snapshot(tool), log })).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
      const expected = operationRoute({ operation: 'judge', available: ['claude', 'codex', 'antigravity'], policy: DEFAULT_ROUTING_POLICY });
      expect(expected).toBeNull();
      const call = await operation();
      expect(state.operation.mock.calls).toEqual([[{ operation: 'judge', taskType: undefined, available: ['claude', 'codex', 'antigravity'] }]]);
      expect(call.model).toBeUndefined();
      const argv = buildCodexJudgeArgv({ ...paths, route: baseline() });
      state.route.mockClear();
      expect(buildCodexJudgeArgv({ ...paths, env })).toEqual(argv);
      expect(state.route).toHaveBeenCalledTimes(1);
      expect(state.route.mock.calls[0][0]).not.toHaveProperty('aiRouting');
      state.route.mockClear();
      expect((await spawn()).argv).toEqual(argv);
      expect(state.route).toHaveBeenCalledTimes(1);
      expect(state.route.mock.calls[0][0]).not.toHaveProperty('aiRouting');
    });
  it('a set coordinator reaches the operation resolver and both Codex sites', async () => {
    state.tool = setting;
    state.policy = operationPolicy('medium');
    const call = await operation();
    expect(state.operation).toHaveBeenCalledTimes(2);
    expect(state.operation.mock.calls[0][0]).not.toHaveProperty('aiRouting');
    expect(state.operation.mock.calls[1][0].aiRouting).toEqual(setting.judge.coordinator);
    const route = operationRoute({ operation: 'judge', policy: state.policy, operatorKeys: [], aiRouting: setting.judge.coordinator });
    expect(call).toMatchObject({ model: route.model, effort: route.effort });
    const routeEnv = { WE_CODEX_MODEL_BY_TASK: JSON.stringify({ review: { model: 'gpt-6-astra', effort: 'medium' } }) };
    const expected = buildCodexJudgeArgv({ ...paths, route: codexRoute({ kind: 'review', env: routeEnv, log: false, aiRouting: setting.judge.coordinator }) });
    expect(buildCodexJudgeArgv({ ...paths, env: routeEnv })).toEqual(expected);
    expect((await spawn({ env: routeEnv })).argv).toEqual(expected);
    expect(expected).toContain('gpt-6-astra');
    expect(expected).toContain('model_reasoning_effort=high');
  });
  it.each([
    { mandatoryLens: true },
    { care: 'high' },
    { mandatoryLens: true, care: 'high' },
  ])('operation strength requirements skip Luna/low settings entirely: %j', async pins => {
    state.policy = operationPolicy();
    const expected = await operation(pins);
    state.operation.mockClear();
    state.tool = { judge: { coordinator: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' } } };
    state.throwing = true;
    state.aiResolution.mockClear();
    const resolve = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await operation(pins)).toEqual(expected);
      expect(state.operation).toHaveBeenCalledTimes(1);
      expect(state.operation.mock.calls[0][0]).not.toHaveProperty('aiRouting');
      expect(state.aiResolution).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    } finally { resolve.mockRestore(); }
  });
  it.each([
    ['codex', 'gpt-6-luna', 'low'],
    ['codex', 'gpt-6-luna', 'high'],
    ['codex', 'gpt-6-astra', 'low'],
    ['claude', 'claude-opus-5-5', 'high'],
  ])('operation retains baseline against changed provider/model or lower effort: %s/%s/%s', async (provider, model, effort) => {
    state.policy = operationPolicy();
    const expected = await operation();
    state.operation.mockClear();
    state.tool = { judge: { coordinator: { provider, model, effort } } };
    expect(await operation()).toEqual(expected);
    expect(state.operation).toHaveBeenCalledTimes(2);
  });
  it('operation preserves inherited baseline when settings introduce a concrete route', async () => {
    const expected = await operation();
    state.operation.mockClear();
    state.tool = setting;
    expect(await operation()).toEqual(expected);
    expect(state.operation).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['gpt-6-luna', 'low'],
    ['gpt-6-luna', 'high'],
    ['gpt-6-astra', 'low'],
    ['gpt-6-astra', 'high'],
  ])('preserves Astra/high without mandatoryLens/care for %s/%s, including downstream requests', async (model, effort) => {
    const routeEnv = { WE_CODEX_MODEL_BY_TASK: JSON.stringify({ review: { model: 'gpt-6-astra', effort: 'high' } }) };
    state.tool = { judge: { coordinator: { provider: 'codex', model, effort } } };
    const expected = buildCodexJudgeArgv({ ...paths, route: baseline({ env: routeEnv }) });
    expect(expected).toContain('gpt-6-astra');
    expect(expected).toContain('model_reasoning_effort=high');
    expect(buildCodexJudgeArgv({ ...paths, env: routeEnv })).toEqual(expected);
    expect((await spawn({ env: routeEnv })).argv).toEqual(expected);
    expect((await spawn({ env: routeEnv, repo: 'owner/repo', pr: 123, lens: 'referral-reverify' })).argv).toEqual(expected);
  });
  it.each([
    { mandatoryLens: true },
    { care: 'high' },
    { mandatoryLens: true, care: 'high' },
  ])('strength requirements preserve both Codex routes against Luna/low: %j', async pins => {
    const expected = buildCodexJudgeArgv({ ...paths, env, ...pins });
    expect((await spawn(pins)).argv).toEqual(expected);
    state.tool = { judge: { coordinator: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' } } };
    state.throwing = true;
    state.aiResolution.mockClear();
    state.route.mockClear();
    expect(buildCodexJudgeArgv({ ...paths, env, ...pins })).toEqual(expected);
    expect(state.route).toHaveBeenCalledTimes(1);
    expect(state.aiResolution).not.toHaveBeenCalled();
    state.route.mockClear();
    expect((await spawn(pins)).argv).toEqual(expected);
    expect(state.route).toHaveBeenCalledTimes(1);
    expect(state.aiResolution).not.toHaveBeenCalled();
  });
  it('unsupported routed effort falls back at both quiet Codex sites with one diagnostic each', async () => {
    const routeEnv = { WE_CODEX_MODEL_BY_TASK: JSON.stringify({ review: { model: 'gpt-6-astra', effort: 'ultra' } }) };
    const expected = buildCodexJudgeArgv({ ...paths, route: baseline({ env: routeEnv }) });
    state.tool = { judge: { coordinator: { provider: 'codex', model: 'gpt-6-luna' } } };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(buildCodexJudgeArgv({ ...paths, env: routeEnv })).toEqual(expected);
      expect(log.mock.calls).toEqual([[expect.stringMatching(/^ai-routing judge: resolver failed, using inherit: Codex model gpt-6-luna does not support effort ultra;/)]]);
      log.mockClear();
      expect((await spawn({ env: routeEnv })).argv).toEqual(expected);
      expect(log.mock.calls).toEqual([[expect.stringMatching(/^ai-routing judge: resolver failed, using inherit: Codex model gpt-6-luna does not support effort ultra;/)]]);
    } finally { log.mockRestore(); }
  });
  it('a downstream operation resolver failure retains the baseline and logs once', async () => {
    state.policy = operationPolicy('ultra');
    const expected = await operation();
    state.operation.mockClear();
    state.aiResolution.mockClear();
    state.tool = { judge: { coordinator: { provider: 'claude', model: 'claude-opus-5-5' } } };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await operation()).toEqual(expected);
      expect(state.operation).toHaveBeenCalledTimes(2);
      expect(state.aiResolution).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.filter(([line]) => line.startsWith('ai-routing judge: resolver failed'))).toEqual([
        [expect.stringMatching(/^ai-routing judge: resolver failed, using inherit: routing policy: unknown effort "ultra" for claude/)],
      ]);
    } finally { log.mockRestore(); }
  });
  it.each(['accepted', 'rejected'])('%s set values log the selected Codex route and invalid diagnostics only once', async kind => {
    state.tool = kind === 'accepted' ? setting : { judge: { coordinator: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' } } };
    const log = vi.fn();
    const routeEnv = { WE_CODEX_MODEL_BY_TASK: JSON.stringify({ review: { model: 'gpt-6-astra', effort: 'medium', bogus: true } }) };
    await spawn({ env: routeEnv, log });
    expect(log.mock.calls.filter(([line]) => line.startsWith('codex-route · kind='))).toEqual([
      [expect.stringContaining(kind === 'accepted' ? 'effort=high (aiRouting)' : 'effort=medium (env)')],
    ]);
    expect(log.mock.calls.filter(([line]) => line.startsWith('codex-route · invalid:'))).toHaveLength(1);
  });
  it('a downstream Codex failure with logging enabled emits one fallback and one baseline route', async () => {
    const routeEnv = { WE_CODEX_MODEL_BY_TASK: JSON.stringify({ review: { model: 'gpt-6-astra', effort: 'ultra' } }) };
    state.tool = { judge: { coordinator: { provider: 'codex', model: 'gpt-6-luna' } } };
    const log = vi.fn();
    const expected = buildCodexJudgeArgv({ ...paths, route: baseline({ env: routeEnv }) });
    expect((await spawn({ env: routeEnv, log })).argv).toEqual(expected);
    expect(log.mock.calls.filter(([line]) => line.startsWith('ai-routing judge: resolver failed'))).toHaveLength(1);
    expect(log.mock.calls.filter(([line]) => line.startsWith('codex-route · kind='))).toEqual([
      [expect.stringContaining('model=gpt-6-astra (env) effort=ultra (env)')],
    ]);
  });
  it('baseline resolver failures stay fatal and do not read optional settings', async () => {
    const routeEnv = { WE_CODEX_MODEL_BY_TASK: JSON.stringify({ review: { model: 'gpt-6-luna', effort: 'ultra' } }) };
    state.tool = setting;
    expect(() => buildCodexJudgeArgv({ ...paths, env: routeEnv })).toThrow(/does not support effort ultra/);
    await expect(spawn({ env: routeEnv })).rejects.toThrow(/does not support effort ultra/);
    state.policy = operationPolicy('nonsense');
    await expect(operation()).rejects.toThrow(/unknown effort/);
    expect(state.aiResolution).not.toHaveBeenCalled();
    expect(state.codex).not.toHaveBeenCalled();
  });
  it('explicit model/effort and provider pins outrank aiRouting', async () => {
    state.tool = setting;
    const pins = { model: 'gpt-6.1-sol', effort: 'medium' };
    const expected = buildCodexJudgeArgv({ ...paths, route: baseline(pins) });
    expect(buildCodexJudgeArgv({ ...paths, env, ...pins })).toEqual(expected);
    expect((await spawn(pins)).argv).toEqual(expected);
    await operation({ providerName: 'claude', model: 'sonnet', effort: 'low' });
    expect(state.operation).not.toHaveBeenCalled();
    await operation({ model: 'sonnet' });
    expect(state.operation.mock.calls[0][0].aiRouting).toBeUndefined();
    await operation({ effort: 'low' });
    expect(state.operation.mock.calls[1][0].aiRouting).toBeUndefined();
  });
  it.each(['throwing', 'invalid'])('%s settings fall back at every wired resolver site', async kind => {
    state.throwing = kind === 'throwing';
    state.tool = { judge: { coordinator: { provider: 'unknown', model: '--bad', effort: 'nonsense' } } };
    expect(resolveJudgeRoutingInput({ env, log: false })).toBeUndefined();
    expect((await operation()).model).toBeUndefined();
    const expected = buildCodexJudgeArgv({ ...paths, route: baseline() });
    expect(buildCodexJudgeArgv({ ...paths, env })).toEqual(expected);
    expect((await spawn()).argv).toEqual(expected);
  });
  it('inherit emits no new logs even when the injected resolver produces provenance', () => {
    const log = vi.fn();
    expect(resolveJudgeRoutingInput({ log, resolve: ({ log: emit }) => { emit('inherit provenance'); return snapshot({}); } })).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
  it('forwards invalid and ignored diagnostics on inherit without provenance', () => {
    const log = vi.fn();
    const resolve = ({ log: emit }) => {
      emit('inherit provenance');
      emit('INVALID coordinator setting');
      emit('coordinator setting ignored');
      return snapshot({});
    };
    expect(resolveJudgeRoutingInput({ log, resolve })).toBeUndefined();
    expect(log.mock.calls).toEqual([['INVALID coordinator setting'], ['coordinator setting ignored']]);
  });
  it('logs one inherit fallback diagnostic when the resolver throws', () => {
    const log = vi.fn();
    state.throwing = true;
    expect(resolveJudgeRoutingInput({ env, log })).toBeUndefined();
    expect(log.mock.calls).toEqual([['ai-routing judge: resolver failed, using inherit: unreadable']]);
  });
  it('both quiet Codex sites report resolver failure and retain the baseline route', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      state.throwing = true;
      const expected = buildCodexJudgeArgv({ ...paths, route: baseline() });
      expect(buildCodexJudgeArgv({ ...paths, env })).toEqual(expected);
      expect((await spawn()).argv).toEqual(expected);
      expect(log.mock.calls).toEqual([
        ['ai-routing judge: resolver failed, using inherit: unreadable'],
        ['ai-routing judge: resolver failed, using inherit: unreadable'],
      ]);
    } finally {
      log.mockRestore();
    }
  });
  it.each(['inherit', 'set', 'invalid', 'throwing'])('log:false emits only resolver failure diagnostics: %s', kind => {
    state.tool = kind === 'set' ? setting : {};
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const resolve = ({ log: emit }) => {
        expect(emit).toBe(false);
        if (kind === 'throwing') throw new Error('unreadable');
        if (emit !== false) emit('invalid coordinator setting ignored');
        return snapshot(state.tool);
      };
      expect(resolveJudgeRoutingInput({ log: false, resolve })).toEqual(kind === 'set' ? setting.judge.coordinator : undefined);
      if (kind === 'throwing') {
        expect(log.mock.calls).toEqual([['ai-routing judge: resolver failed, using inherit: unreadable']]);
      } else {
        expect(log).not.toHaveBeenCalled();
      }
    } finally {
      log.mockRestore();
    }
  });
  it('keeps model validation and tool-free guards after routing', async () => {
    state.tool = setting;
    state.policy = operationPolicy('medium');
    expect(() => buildCodexJudgeArgv({ ...paths, env, model: '--bad' })).toThrow();
    await expect(spawn({ allowedTools: ['Read'] })).rejects.toThrow();
    await expect(operation({ allowedTools: ['Read'] })).rejects.toThrow(/TOOL-BEARING/);
    expect(state.codex).not.toHaveBeenCalled();
  });
  it('documents Claude helper non-consumers and downstream Codex consumers', () => {
    // resolveClaudeHelperRoute has no aiRouting input: leave these defaults unchanged.
    for (const [file, count] of [['judge-spawn.mjs', 2], ['judge-panel.mjs', 1]]) {
      const source = readFileSync(`scripts/lib/${file}`, 'utf8');
      expect(source.match(/model = resolveClaudeHelperRoute\(\).model/g)).toHaveLength(count);
    }
    for (const file of ['scripts/lib/jury-core.mjs', 'scripts/conveyor/referral-reverify.mjs']) {
      expect(readFileSync(file, 'utf8')).toMatch(/await codexJudgeSpawn\(/);
    }
  });
});
