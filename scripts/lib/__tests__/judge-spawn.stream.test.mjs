import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { buildJudgeEnv, judgeSpawn, parseJudgeOutcome, JudgeTimeoutError, JudgeUnparseableError, JudgeBudgetError } from '../judge-spawn.mjs';
import { normalizeJudgeTelemetry } from '../../operations/run-record.mjs';
import { createDefaultJudge, unwrapJudgeOutcome } from '../../operations/cli-adapter.mjs';

const request = { mandate: 'review', input: 'diff', shape: { type: 'object' }, retries: 0 };
const result = { type: 'result', session_id: 'session', structured_output: { verdict: 'accept' },
  total_cost_usd: 0.12, duration_ms: 45, num_turns: 2, usage: { input_tokens: 3 } };
const tool = (command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const jsonl = (events) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

function fake(events, { hang = false, chunks, pid, stderr = 'diagnostic stderr', stderrChunks } = {}) {
  let options;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = pid;
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); });
  const spawnFn = (_cli, _argv, opts) => {
    options = opts;
    queueMicrotask(() => {
      for (const chunk of chunks ?? [jsonl(events)]) child.stdout.write(chunk);
      for (const chunk of stderrChunks ?? [stderr]) child.stderr.write(chunk);
      if (!hang) child.emit('close', 0, null);
    });
    return child;
  };
  return { spawnFn, child, options: () => options };
}

describe('Claude stream diagnostics', () => {
  it('preserves the JSON success contract from the final result event across split chunks', async () => {
    const stream = jsonl([{ type: 'system', session_id: 'init' }, tool('git diff'), result,
      { type: 'system', session_id: 'trailer' }]);
    const f = fake([], { chunks: [stream.slice(0, 17), stream.slice(17, 92), stream.slice(92)] });
    const outcome = await judgeSpawn({ ...request, ...f });
    expect(outcome).toMatchObject({ value: result.structured_output, sessionId: 'session', costUsd: 0.12,
      durationMs: 45, numTurns: 2, usage: result.usage });
    expect(f.options().detached).toBe(true);
    expect(f.options().env).toMatchObject(buildJudgeEnv({}));
  });

  it('fails closed on init and assistant events without a terminal result', () => {
    for (const stdout of [jsonl([{ type: 'system', session_id: 'init' }]), jsonl([tool('git diff')])]) {
      expect(() => parseJudgeOutcome(stdout)).toThrow(/did not emit parseable JSON/);
    }
  });

  it('rejects typeless whole documents and streams without a result event', async () => {
    const typeless = { structured_output: { verdict: 'accept' } };
    for (const stdout of [JSON.stringify(typeless), JSON.stringify(typeless, null, 2),
      jsonl([{ type: 'system' }, typeless]), `warning\n${JSON.stringify(typeless)}\n`,
      jsonl([{ type: 'system' }, tool('git diff')]),
      JSON.stringify({ type: 'assistant', ...typeless }, null, 2)]) {
      await expect(judgeSpawn({ ...request, ...fake([], { chunks: [stdout] }), log: () => {} }))
        .rejects.toBeInstanceOf(JudgeUnparseableError);
    }
  });

  it('preserves legacy JSON result documents, including pretty-printed output', () => {
    for (const spacing of [undefined, 2]) {
      expect(parseJudgeOutcome(JSON.stringify(result, null, spacing)).value).toEqual(result.structured_output);
    }
  });

  it('rejects multiple terminal results even when the final result has a verdict', () => {
    const last = { ...result, structured_output: { verdict: 'reject' } };
    expect(() => parseJudgeOutcome(jsonl([result, last, { type: 'system' }])))
      .toThrow(/did not emit parseable JSON/);
  });

  it.each([
    ['non-JSON trailer', 'incomplete output\n', /did not emit parseable JSON/],
    ['truncated result', '{"type":"result","structured_output":', /did not emit parseable JSON/],
    ['error result', jsonl([{ type: 'result', is_error: true, result: 'terminal failure' }]), /did not emit parseable JSON/],
    ['empty error result', jsonl([{ type: 'result', is_error: true }]), /did not emit parseable JSON/],
    ['missing structured output', jsonl([{ type: 'result' }]), /did not emit parseable JSON/],
    ['invalid structured output', jsonl([{ type: 'result', structured_output: null }]), /did not emit parseable JSON/],
  ])('refuses an earlier verdict after a terminal %s', async (_name, trailer, message) => {
    const stdout = jsonl([result]) + trailer;
    expect(() => parseJudgeOutcome(stdout)).toThrow(message);
    await expect(judgeSpawn({ ...request, ...fake([], { chunks: [stdout] }), log: () => {} }))
      .rejects.toThrow(message);
  });

  it.each([
    { type: 'error', error: 'terminal failure' },
    { type: 'assistant' }, { type: 'user' }, { type: 'stream_event' }, { type: 'unknown' },
    {}, null, [], 42,
    ...['system', 'rate_limit_event'].flatMap(type => [
      { type, is_error: true }, { type, error: { message: 'failed' } },
      { type, subtype: 'error' }, { type, subtype: 'error_during_execution' },
    ]),
  ])('rejects meaningful or error-bearing JSON trailers: %j', async trailer => {
    const events = [result, trailer, { type: 'system' }];
    expect(() => parseJudgeOutcome(jsonl(events))).toThrow(/did not emit parseable JSON/);
    await expect(judgeSpawn({ ...request, ...fake(events), log: () => {} }))
      .rejects.toBeInstanceOf(JudgeUnparseableError);
    expect(() => parseJudgeOutcome(jsonl([...events, result])))
      .toThrow(/did not emit parseable JSON/);
  });

  it('tolerates benign system and rate-limit trailers', () => {
    expect(parseJudgeOutcome(jsonl([result, { type: 'system' },
      { type: 'rate_limit_event', is_error: false, subtype: 'success' }])).value)
      .toEqual(result.structured_output);
  });

  it.each([
    { split: false, json: false }, { split: true, json: false },
    { split: false, json: true }, { split: true, json: true },
  ])('redacts or omits oversized stderr before bounding, including split credentials (%j)', async ({ split, json }) => {
    const limit = 8 * 1024 * 1024;
    const secret = 'private-value-suffix';
    const opener = json ? '{"SECRET_TOKEN":"' : 'SECRET_TOKEN=';
    const closing = json ? '"}' : '';
    const text = `${opener}${'v'.repeat(limit)}${secret}${closing}`;
    const stderrChunks = split
      ? [opener.slice(0, -3), `${opener.slice(-3)}${'v'.repeat(limit)}`, secret + closing] : [text];
    const log = vi.fn();
    const error = await judgeSpawn({ ...request, ...fake([], { stderrChunks }), log }).catch(e => e);
    expect(error).toBeInstanceOf(JudgeUnparseableError);
    const diagnostics = inspect(error, { depth: null }) + JSON.stringify(log.mock.calls);
    expect(diagnostics).not.toContain(secret);
    expect(diagnostics).not.toContain('v'.repeat(100));
    expect(error.stderrTail).toContain('<redacted');
    if (json) expect(error.stderrTail).not.toContain('could not be sanitized');
    else expect(error.stderrTail).toContain('could not be sanitized');
    expect(error.stderrTail).toContain('Rerun with a narrower mandate');
    expect(error.stderrTail.length).toBeLessThanOrEqual(1000);
    expect(normalizeJudgeTelemetry({ telemetry: error.telemetry }).stderrTail).toBe(error.stderrTail);
  });

  it.each([false, true])('redacts and bounds CLI error diagnostics (empty result=%s)', async empty => {
    const secret = 'private-cli-credential';
    const text = `SECRET_TOKEN=${secret} ${'x'.repeat(5000)}`;
    const event = { type: 'result', is_error: true, result: empty ? '' : text,
      session_id: text, metadata: { nested: [text] } };
    const stderr = `${'x'.repeat(5000)} SECRET_TOKEN=${secret}`;
    const error = await judgeSpawn({ ...request, ...fake([event], { stderr }), log: () => {} })
      .catch(e => e);
    expect(error).toBeInstanceOf(Error);
    const diagnostics = inspect(error, { depth: null });
    expect(diagnostics).not.toContain(secret);
    expect(error.message).toContain('<redacted');
    expect(error.message.length).toBeLessThan(1400);
    expect(error.message).toContain(empty ? 'no result text' : 'the juror failed:');
  });

  it('redacts quota failure telemetry as well as the CLI error message', () => {
    const text = "You've hit your weekly limit · resets tomorrow SECRET_TOKEN=private-quota-credential";
    let error;
    try { parseJudgeOutcome(jsonl([{ type: 'result', is_error: true, result: text }])); }
    catch (e) { error = e; }
    expect(error.quota).toBe(true);
    expect(error.telemetry.failureText).toContain('<redacted');
    expect(inspect(error, { depth: null })).not.toContain('private-quota-credential');
  });

  it.each([false, true])('redacts credential tool names and replaces invalid or oversized names (timeout=%s)', async hang => {
    const names = ['ghp_abcdefghijklmnopqrstuvwxyz1234567890', 'sk-abcdefghijklmnop',
      'Bash invalid', 'x'.repeat(41), '', null];
    const events = names.map(name => ({ type: 'assistant', message: {
      content: [{ type: 'tool_use', name, input: { command: 'git status' } }],
    } }));
    const log = vi.fn();
    const error = await judgeSpawn({ ...request, ...fake(events, { hang }), timeoutMs: 10, log }).catch(e => e);
    expect(error).toBeInstanceOf(hang ? JudgeTimeoutError : JudgeUnparseableError);
    expect(error.lastEvents).toEqual(names.map(() => ({ type: 'assistant', tools: ['tool: git status'] })));
    expect(error.lastToolCall).toBe('tool: git status');
    const diagnostics = [error.message, JSON.stringify(error.telemetry), JSON.stringify(error.failedAttempts),
      log.mock.calls.flat().join(' ')].join(' ');
    for (const name of names.filter(Boolean)) expect(diagnostics).not.toContain(name);
  });

  it('preserves tool names within the allowed shape and 40-character bound', async () => {
    const names = ['mcp__tool:read-file.v1', 'x'.repeat(40)];
    const events = names.map(name => ({ type: 'assistant', message: {
      content: [{ type: 'tool_use', name, input: {} }],
    } }));
    const error = await judgeSpawn({ ...request, ...fake(events), log: () => {} }).catch(e => e);
    expect(error.lastEvents).toEqual(names.map(name => ({ type: 'assistant', tools: [`${name}: [input redacted]`] })));
  });

  it.each([false, true])('never exposes truncated tool-use stdout in diagnostics (timeout=%s)', async (hang) => {
    const stdout = JSON.stringify(tool('git diff SECRET_TOKEN=private-value')).slice(0, -4);
    const log = vi.fn();
    const error = await judgeSpawn({ ...request, ...fake([], { hang, chunks: [stdout] }), timeoutMs: 10, log })
      .catch(e => e);
    expect(error).toBeInstanceOf(hang ? JudgeTimeoutError : JudgeUnparseableError);
    expect(error.lastEvents).toEqual([{ type: 'unrecognized' }]);
    expect(error.message).toContain(`stdout ${Buffer.byteLength(stdout)} bytes`);
    expect(error.message).toContain('last events: [{"type":"unrecognized"}]');
    expect([error.message, JSON.stringify(error), JSON.stringify(Object.keys(error).map(key => error[key])),
      inspect(error, { showHidden: false, depth: null }), JSON.stringify(error.lastEvents), JSON.stringify(error.telemetry),
      JSON.stringify(error.failedAttempts), log.mock.calls.flat().join(' ')].join(' '))
      .not.toMatch(/SECRET_TOKEN|private-value/);
    expect(() => parseJudgeOutcome(stdout)).toThrow(/last events: \[{"type":"unrecognized"}\]/);
    try { parseJudgeOutcome(stdout); } catch (e) { expect(e.message).not.toMatch(/SECRET_TOKEN|private-value/); }
  });

  it.each([false, true])('records bounded, redacted last events and last tool on failure (timeout=%s)', async (hang) => {
    const events = [tool('git diff SECRET_TOKEN=private-value https://user:password@example.test')];
    events.push(...Array.from({ length: 60 }, () => ({ type: 'user', text: 'private-output'.repeat(500) })));
    const f = fake(events, { hang });
    const log = vi.fn();
    const error = await judgeSpawn({ ...request, ...f, timeoutMs: 10, log }).catch(e => e);
    expect(error).toBeInstanceOf(hang ? JudgeTimeoutError : JudgeUnparseableError);
    expect(error.lastEvents).toHaveLength(50);
    expect(error.lastToolCall).toBe('Bash: git diff [redacted] [redacted]');
    expect(error.telemetry).toMatchObject({ sessionId: error.sessionId, wallMs: error.wallMs,
      lastEvents: error.lastEvents, lastToolCall: error.lastToolCall });
    expect(normalizeJudgeTelemetry({ telemetry: error.telemetry })).toMatchObject({
      sessionId: error.sessionId, wallMs: error.wallMs, lastEvents: error.lastEvents, lastToolCall: error.lastToolCall });
    expect(error.message.split('\n')[0]).toContain('last tool: Bash: git diff');
    expect(log.mock.calls.flat().join(' ')).toContain('last tool: Bash: git diff');
    expect(JSON.stringify(error.telemetry)).not.toMatch(/private-value|password|private-output/);
    expect(JSON.stringify(error)).not.toMatch(/private-value|password|private-output/);
    for (const key of Object.keys(error)) {
      expect(inspect(error[key], { showHidden: false, depth: null })).not.toMatch(/private-value|password|private-output/);
    }
    expect(inspect(error, { showHidden: false, depth: null })).not.toMatch(/private-value|password|private-output/);
    expect(error.message).not.toMatch(/private-value|password|private-output/);
    expect(JSON.stringify(error.lastEvents).length).toBeLessThan(2000);
    if (!hang) expect(error.failedAttempts[0].lastEvents).toEqual(error.lastEvents);
    else expect(error.partialStderr).toBe('diagnostic stderr');
  });

  it.each([false, true])('redacts stderr before failure messages and enumerable telemetry (timeout=%s)', async hang => {
    const secret = 'private-stderr-credential';
    const stderr = `diagnostic SECRET_TOKEN=${secret}`;
    const error = await judgeSpawn({ ...request, ...fake([tool('git status')], { hang, stderr }),
      timeoutMs: 10, log: () => {} }).catch(e => e);
    expect(error).toBeInstanceOf(hang ? JudgeTimeoutError : JudgeUnparseableError);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(inspect(error, { showHidden: false, depth: null })).not.toContain(secret);
    expect(error.telemetry.stderrTail).toContain('<redacted');
    if (hang) {
      expect(error.partialStderr).toBe(stderr);
      expect(error.partialStdout).toContain('tool_use');
      for (const key of ['partialStdout', 'partialStderr']) {
        expect(Object.getOwnPropertyDescriptor(error, key).enumerable).toBe(false);
      }
    }
  });

  it('redacts constructor metadata and budget diagnostics without mutating caller evidence', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const lastEvents = [{ type: 'assistant', tools: [secret] }];
    const failedAttempts = [{ stderrTail: secret, lastEvents }];
    const errors = [
      new JudgeTimeoutError({ timeoutMs: 10, wallMs: 11, stdout: secret, stderr: secret,
        sessionId: secret, lastEvents, lastToolCall: secret }),
      new JudgeUnparseableError({ attempt: 1, attempts: 1, exitCode: 1, signal: secret,
        stdout: secret, stderr: secret, sessionId: secret, failedAttempts, lastEvents, lastToolCall: secret, reason: secret }),
      new JudgeBudgetError({ budget: 1, costUsd: 1, stopReason: secret, result: secret, stderr: secret }),
    ];
    for (const error of errors) {
      expect(JSON.stringify(error)).not.toContain(secret);
      for (const key of Object.keys(error)) expect(inspect(error[key], { depth: null })).not.toContain(secret);
      expect(inspect(error, { showHidden: false, depth: null })).not.toContain(secret);
    }
    expect(lastEvents[0].tools).toEqual([secret]);
    expect(failedAttempts[0].stderrTail).toBe(secret);
  });

  it('bounds oversized events, reports truncation, and keeps the next result usable', async () => {
    const oversized = JSON.stringify({ type: 'assistant', text: 'x'.repeat(9 * 1024 * 1024) }) + '\n';
    const failed = await judgeSpawn({ ...request, ...fake([], { chunks: [oversized] }), log: () => {} }).catch(e => e);
    expect(failed).toBeInstanceOf(JudgeUnparseableError);
    expect(failed.lastEvents).toEqual([{ type: 'unrecognized', truncated: true }]);
    expect(failed.stdoutBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(failed.message).toContain('did not emit parseable JSON');
    expect(failed.message).toContain('rerun with a narrower mandate');
    const outcome = await judgeSpawn({ ...request, ...fake([], { chunks: [oversized, jsonl([result])] }) });
    expect(outcome.value).toEqual(result.structured_output);
  });

  it('keeps bounded evidence through the graceful caller and the run-record whitelist', async () => {
    const lastEvents = [{ type: 'assistant', tools: ['Bash: git diff'] }];
    const error = new JudgeTimeoutError({ timeoutMs: 10, wallMs: 11, sessionId: 'session', lastEvents,
      lastToolCall: 'Bash: git diff', stdout: jsonl([tool('git diff private-tool-input')]),
      stderr: 'SECRET_TOKEN=private-stderr-input' });
    const judge = createDefaultJudge({ provider: async () => { throw error; },
      checkProviderHold: async () => null, logGracefulOutcome: () => {} });
    const returned = await judge({ ...request, model: 'sonnet', effort: 'high', gracefulOnUnavailable: true });
    const row = normalizeJudgeTelemetry({ telemetry: unwrapJudgeOutcome(returned).telemetry });
    expect(row).toMatchObject({ sessionId: 'session', wallMs: 11, timedOut: true,
      lastEvents, lastToolCall: 'Bash: git diff' });
    expect(JSON.stringify(row)).not.toMatch(/private-tool-input|private-stderr-input|tool_use/);
    expect(row).not.toHaveProperty('partialStdout');
    expect(row).not.toHaveProperty('partialStderr');
    const oversized = normalizeJudgeTelemetry({ telemetry: { lastToolCall: 'x'.repeat(1000),
      lastEvents: Array.from({ length: 80 }, () => ({ type: 'y'.repeat(1000), tools: ['z'.repeat(1000)], raw: 'secret' })) } });
    expect(oversized.lastEvents).toHaveLength(50);
    expect(oversized.lastToolCall).toHaveLength(160);
    expect(oversized.lastEvents[0]).toEqual({ type: 'other', tools: ['z'.repeat(160)] });
  });

  it('falls back to child.kill when the process group cannot be signalled', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
    const f = fake([tool('git status')], { hang: true, pid: 987654321 });
    try {
      await expect(judgeSpawn({ ...request, ...f, timeoutMs: 10, log: () => {} })).rejects.toBeInstanceOf(JudgeTimeoutError);
      expect(kill).toHaveBeenCalledWith(-987654321, 'SIGKILL');
      expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally { kill.mockRestore(); }
  });

  it('kills process-group leftovers on normal close without the child-kill fallback', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const f = fake([result], { pid: 987654321 });
    try {
      const outcome = await judgeSpawn({ ...request, ...f });
      expect(outcome.timedOut).toBe(false);
      expect(kill).toHaveBeenCalledWith(-987654321, 'SIGKILL');
      expect(f.child.kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });
});

describe('Claude non-interactive environment', () => {
  it.each([
    { GIT_SSH: 'custom-ssh' },
    { GIT_SSH: '' },
    { GIT_SSH_COMMAND: '' },
    { GIT_SSH_COMMAND: 'custom-command', GIT_SSH: 'custom-ssh' },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand', GIT_CONFIG_VALUE_0: 'custom-ssh' },
    { GIT_CONFIG_COUNT: '0' },
    { GIT_CONFIG_PARAMETERS: "'core.sshCommand=custom-ssh'" },
    { GIT_CONFIG_PARAMETERS: '' },
  ])('leaves caller SSH settings untouched without injecting a higher-precedence command: %j', async env => {
    const original = { ...env };
    const f = fake([result]);
    await judgeSpawn({ ...request, ...f, env });
    expect(f.options().env).toMatchObject(original);
    expect(f.options().env.GIT_SSH_COMMAND).toBe(original.GIT_SSH_COMMAND);
    expect(env).toEqual(original);
  });

  it('preserves stricter caller Bash timeout bounds in the spawned environment', async () => {
    const env = { BASH_DEFAULT_TIMEOUT_MS: '1000', BASH_MAX_TIMEOUT_MS: '2000' };
    const f = fake([result]);
    await judgeSpawn({ ...request, ...f, env });
    expect(f.options().env).toMatchObject(env);
    expect(env).toEqual({ BASH_DEFAULT_TIMEOUT_MS: '1000', BASH_MAX_TIMEOUT_MS: '2000' });
  });

  it('sanitizes credentials, preserves explicit settings, and caps unbounded Bash timeouts', () => {
    const env = { GH_TOKEN: 'secret', GIT_SSH_COMMAND: 'ssh', GIT_TERMINAL_PROMPT: '1', CI: '0',
      BASH_DEFAULT_TIMEOUT_MS: '9999999', BASH_MAX_TIMEOUT_MS: '9999999', PATH: '/bin' };
    expect(buildJudgeEnv(env)).toMatchObject({ GIT_SSH_COMMAND: 'ssh',
      GIT_TERMINAL_PROMPT: '1', CI: '0', BASH_DEFAULT_TIMEOUT_MS: '300000', BASH_MAX_TIMEOUT_MS: '600000', PATH: '/bin' });
    expect(buildJudgeEnv(env).GH_TOKEN).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('1');
  });

  it.each([
    { GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0', CI: 'true' },
    { GIT_SSH_COMMAND: '', GIT_TERMINAL_PROMPT: '', CI: '' },
  ])('preserves caller Git and CI restrictions in the spawned environment: %j', async env => {
    const original = { ...env };
    const f = fake([result]);
    await judgeSpawn({ ...request, ...f, env });
    expect(f.options().env).toMatchObject(original);
    expect(env).toEqual(original);
  });

  it('defaults absent Git and CI settings to non-interactive values', () => {
    expect(buildJudgeEnv({})).toMatchObject({
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
      GIT_TERMINAL_PROMPT: '0', CI: '1',
    });
  });
});

describe.skipIf(process.platform === 'win32')('real Claude process group cleanup', () => {
  it('leaves no running grandchild after timeout', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'judge-group-'));
    const cli = join(dir, 'fake-cli');
    const pidFile = join(dir, 'grandchild.pid');
    let pid;
    let descendantsClosed;
    const spawnFn = (command, argv, options) => {
      const child = spawn(command, argv, { ...options, stdio: [...options.stdio, 'pipe'] });
      descendantsClosed = once(child.stdio[3], 'close');
      return child;
    };
    try {
      writeFileSync(cli, `#!${process.execPath}\n` +
        `const {spawn} = require('node:child_process');\n` +
        `const {writeFileSync} = require('node:fs');\n` +
        `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', 'ignore', 'ignore', 3]});\n` + // keepalive-helper-ok: fixture grandchild, killed by the timeout under test and in finally
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
        `setInterval(() => {}, 1000);\n`, // keepalive-helper-ok: fixture juror, killed by the timeout under test
        { mode: 0o755 });
      const outcome = await judgeSpawn({ ...request, cli, spawnFn, timeoutMs: 1500, log: () => {} }).catch(e => e);
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(outcome).toBeInstanceOf(JudgeTimeoutError);
      // Both processes hold fd 3 open until death; close proves neither survived.
      expect(descendantsClosed).toBeInstanceOf(Promise);
      await descendantsClosed;
    } finally {
      if (!pid) { try { pid = Number(readFileSync(pidFile, 'utf8')); } catch {} }
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
});
