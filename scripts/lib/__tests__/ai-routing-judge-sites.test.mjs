import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolveAiRouting } from '../ai-routing.mjs';
import { resolveOperationRoute as operationRoute, DEFAULT_ROUTING_POLICY } from '../dispatch-routing-policy.mjs';
import { resolveCodexTaskRoute as codexRoute } from '../codex-task-route.mjs';
import { buildCodexJudgeArgv, codexJudgeSpawn, resolveJudgeRoutingInput } from '../codex-judge-spawn.mjs';
import { createDefaultJudge } from '../../operations/cli-adapter.mjs';

const state = vi.hoisted(() => ({ tool: {}, throwing: false, operation: vi.fn(), codex: vi.fn() }));
vi.mock('../ai-routing.mjs', async original => {
  const actual = await original();
  return { ...actual, resolveAiRouting: options => {
    if (state.throwing) throw new Error('unreadable');
    return actual.resolveAiRouting({ ...options, tool: state.tool, platform: {}, accountMap: { accounts: {} } });
  } };
});
vi.mock('../dispatch-routing-policy-io.mjs', async original => {
  const actual = await original();
  const pure = await import('../dispatch-routing-policy.mjs');
  return { ...actual, resolveOperationRoute: options => {
    state.operation(options);
    return pure.resolveOperationRoute({ ...options, policy: pure.DEFAULT_ROUTING_POLICY, operatorKeys: [] });
  } };
});
vi.mock('../codex-usage-ledger.mjs', () => ({ withCodexUsage: (_meta, run) => run() }));
const env = {};
const paths = { schemaFile: 'scratch/schema.json', outputLastMessageFile: 'scratch/last-message.txt', cwd: 'scratch' };
const setting = { judge: { coordinator: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' } } };
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
beforeEach(() => { state.tool = {}; state.throwing = false; vi.clearAllMocks(); });

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
      expect(state.operation.mock.calls[0][0].aiRouting).toBeUndefined();
      expect(call.model).toBeUndefined();
      const argv = buildCodexJudgeArgv({ ...paths, route: baseline() });
      expect(buildCodexJudgeArgv({ ...paths, env })).toEqual(argv);
      expect((await spawn()).argv).toEqual(argv);
    });
  it('a set coordinator reaches the operation resolver and both Codex sites', async () => {
    state.tool = setting;
    const call = await operation();
    expect(state.operation.mock.calls[0][0].aiRouting).toEqual(setting.judge.coordinator);
    const route = operationRoute({ operation: 'judge', policy: DEFAULT_ROUTING_POLICY, operatorKeys: [], aiRouting: setting.judge.coordinator });
    expect(call).toMatchObject({ model: route.model, effort: route.effort });
    const expected = buildCodexJudgeArgv({ ...paths, route: codexRoute({ kind: 'review', env, log: false, aiRouting: setting.judge.coordinator }) });
    expect(buildCodexJudgeArgv({ ...paths, env })).toEqual(expected);
    expect((await spawn()).argv).toEqual(expected);
    expect(expected).toContain('gpt-6-astra');
  });
  it.each([
    { mandatoryLens: true },
    { care: 'high' },
    { mandatoryLens: true, care: 'high' },
  ])('strength requirements preserve both Codex routes against Luna/low: %j', async pins => {
    const expected = buildCodexJudgeArgv({ ...paths, env, ...pins });
    expect((await spawn(pins)).argv).toEqual(expected);
    state.tool = { judge: { coordinator: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' } } };
    expect(buildCodexJudgeArgv({ ...paths, env, ...pins })).toEqual(expected);
    expect((await spawn(pins)).argv).toEqual(expected);
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
  it.each(['invalid', 'throwing'])('log:false keeps %s resolver failures silent', kind => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const resolve = ({ log: emit }) => {
        expect(emit).toBe(false);
        if (kind === 'throwing') throw new Error('unreadable');
        if (emit !== false) emit('invalid coordinator setting ignored');
        return snapshot({});
      };
      expect(resolveJudgeRoutingInput({ log: false, resolve })).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it('keeps model validation and tool-free guards after routing', async () => {
    state.tool = setting;
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
