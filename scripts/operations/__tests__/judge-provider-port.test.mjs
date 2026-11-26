/**
 * @file judge-provider-port.test.mjs — `createDefaultJudge` drives ANY `JudgeProvider`, not only `judgeSpawn`
 * (#3370, under #3369).
 *
 * THE FAKE HERE IS PORT-SHAPED, NOT CLI-SHAPED. Every existing judge fake in this repo (the `spawn` stub in
 * `juror-flags.test.mjs`, `fakeSpawn` in `we:scripts/lib/__tests__/judge-spawn.test.mjs`, `withFakeClaude`)
 * either stands in for `child_process.spawn` or for the `claude` binary itself — each still speaks in terms
 * of argv, stdout, or a mocked child process. This fake is neither: it is a hand-written plain async function
 * that receives the engine's `judge` request directly and returns the outcome shape `parseJudgeOutcome`
 * produces, with nothing CLI-shaped anywhere in it. That is the actual claim under test — that
 * `createDefaultJudge`'s `provider` option is a NAMED PORT a second implementation can satisfy (#3371),
 * not a slot that happens to accept whatever `judgeSpawn` looks like today.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRegistry, op } from '../registry.mjs';
import { judge as judgeStep } from '../step-kinds.mjs';
import { startRun, advance } from '../engine.mjs';
import { createMemoryRunStore } from '../run-store.mjs';

import { parseCodexJudgeOutcome } from '../../lib/codex-judge-spawn.mjs';
import { deriveVerdict } from '../../lib/jury-core.mjs';
import { createDefaultJudge, driveRun, unwrapJudgeOutcome } from '../cli-adapter.mjs';

/** A hand-written `JudgeProvider` — no argv, no stdout, no child process. Records what it was handed. */
function makeFakeProvider(answer) {
  const calls = [];
  const provider = async (request) => {
    calls.push(request);
    return {
      value: answer,
      sessionId: 'fake-provider-session',
      costUsd: 0.02,
      durationMs: 500,
      wallMs: 550,
      numTurns: 1,
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      loadedContextTokens: 10,
      timedOut: false,
    };
  };
  return { provider, calls };
}

describe('#3370 createDefaultJudge drives a hand-written JudgeProvider', () => {
  it('accepts a port-shaped fake and returns its answer, unmodified', async () => {
    const { provider, calls } = makeFakeProvider({ verdict: 'pass', reason: 'looks fine' });
    const judgeFn = createDefaultJudge({ provider });

    const returned = await judgeFn({
      mandate: 'judge the diff',
      input: 'the diff text',
      shape: { type: 'object' },
      model: 'sonnet',
      effort: 'medium',
      budget: 1,
      runId: 'run-3370',
      lens: 'correctness',
    });

    expect(calls).toHaveLength(1);
    // THE SAME REQUEST FIELDS THE REAL SPAWNER RECEIVES — this is what "driven the same way" means: the fake
    // is handed exactly the request shape `judgeSpawn` is handed, not a CLI-adapted approximation of it.
    expect(calls[0]).toMatchObject({
      mandate: 'judge the diff',
      input: 'the diff text',
      shape: { type: 'object' },
      model: 'sonnet',
      effort: 'medium',
      budget: 1,
      runId: 'run-3370',
      lens: 'correctness',
    });

    const { value, telemetry } = unwrapJudgeOutcome(returned);
    expect(value).toEqual({ verdict: 'pass', reason: 'looks fine' });
    expect(telemetry).toMatchObject({
      costUsd: 0.02,
      durationMs: 500,
      wallMs: 550,
      numTurns: 1,
      stopReason: 'end_turn',
      sessionId: 'fake-provider-session',
      loadedContextTokens: 10,
      timedOut: false,
      model: 'sonnet',
    });
  });

  it('omits `cwd` from the request to a port-shaped fake for a tool-free juror, matching the spawner path', async () => {
    const { provider, calls } = makeFakeProvider({ ok: true });
    const judgeFn = createDefaultJudge({ provider });

    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } });

    expect(calls[0]).not.toHaveProperty('cwd');
  });

  it('passes `cwd` through to a port-shaped fake when the factory was given one, for a tool-bearing juror', async () => {
    const { provider, calls } = makeFakeProvider({ ok: true });
    const judgeFn = createDefaultJudge({ provider, cwd: '/tmp/some-lane' });

    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, allowedTools: ['Read'] });

    expect(calls[0].cwd).toBe('/tmp/some-lane');
    expect(calls[0].allowedTools).toEqual(['Read']);
  });

  // THE CODEX JUDGE TRANSCRIPT FIX — a provider that reports `transcriptFile` (only `codexJudgeSpawn` does)
  // has it forwarded into the telemetry `judgeOutcome` wraps, alongside every other metered field; a provider
  // that reports nothing for it (every existing fake, and the real `judgeSpawn`) sees it silently absent
  // rather than showing up as `transcriptFile: undefined` — the SAME whitelist-driven drop
  // `normalizeJudgeTelemetry` (`we:scripts/operations/run-record.mjs`) already applies once the run record is
  // written, proved here one layer up, at the point this value first enters the telemetry object.
  it('forwards a provider-reported `transcriptFile` into the telemetry — a PATH, never transcript content', async () => {
    const calls = [];
    const provider = async (request) => {
      calls.push(request);
      return {
        value: { ok: true }, sessionId: 's', costUsd: 0, durationMs: 1, wallMs: 1, numTurns: 1,
        stopReason: 'turn.completed', usage: {}, loadedContextTokens: 0, timedOut: false,
        transcriptFile: '/Users/x/.codex-judge-transcripts/codex-judge-thread-abc.jsonl',
      };
    };
    const judgeFn = createDefaultJudge({ provider });
    const returned = await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } });
    const { telemetry } = unwrapJudgeOutcome(returned);
    expect(telemetry.transcriptFile).toBe('/Users/x/.codex-judge-transcripts/codex-judge-thread-abc.jsonl');
  });

  it('a provider reporting no `transcriptFile` at all (e.g. judgeSpawn) forwards it as `undefined`, not a string', async () => {
    const { provider } = makeFakeProvider({ ok: true }); // makeFakeProvider's outcome carries no transcriptFile
    const judgeFn = createDefaultJudge({ provider });
    const returned = await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } });
    const { telemetry } = unwrapJudgeOutcome(returned);
    // `normalizeJudgeTelemetry` (we:scripts/operations/run-record.mjs) is what actually DROPS this key from the
    // eventual run record (its string-typeof whitelist check), proved directly in run-store.test.mjs — this
    // layer only needs to prove it never fabricates a string when the provider gave none.
    expect(telemetry.transcriptFile).toBeUndefined();
  });
});

describe('card x5s8b47 — `gracefulOnUnavailable`: an advisory seat degrades, it never crashes the run', () => {
  const REQUEST = {
    mandate: 'judge the diff', input: 'the diff text', shape: { type: 'object' },
    lens: 'simplicity', providerName: 'codex', gracefulOnUnavailable: true,
  };

  it('FAILS BEFORE THE FIX: a request with no graceful opt-in still lets a spawn failure propagate uncaught', async () => {
    // Pins the OLD behaviour for the two mandatory seats, which never set `gracefulOnUnavailable` — a real
    // crash there must still be a real crash; this fix must not soften it.
    const judgeFn = createDefaultJudge({ resolveProvider: () => async () => { throw new Error('codex ENOENT'); } });
    await expect(judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'codex' }))
      .rejects.toThrow('codex ENOENT');
  });

  it('Codex quota-held, no fallback usable → skips gracefully with a structured marker; the spawn is NEVER attempted', async () => {
    let spawnCalls = 0;
    const provider = async () => { spawnCalls += 1; return { value: {} }; };
    const judgeFn = createDefaultJudge({
      resolveProvider: () => provider,
      checkProviderHold: async (name) => (name === 'codex' ? 'quota exhausted; sitting out until 2026-10-03T17:11:11.000Z' : 'antigravity also unavailable'),
      now: () => 1_700_000_000_000,
    });
    const returned = await judgeFn(REQUEST);
    const { value } = unwrapJudgeOutcome(returned);
    expect(spawnCalls).toBe(0);
    expect(value.skipped).toMatchObject({ provider: 'codex' });
    expect(value.skipped.reason).toMatch(/quota exhausted/);
    expect(value.findings).toEqual([]);
    expect(value.summary).toMatch(/^skipped: /); // reduce's silent-juror refusal requires a non-empty summary
  });

  it('a fallback request to antigravity never carries the factory\'s cwd (#4446)', async () => {
    const calls = [];
    const judgeFn = createDefaultJudge({
      cwd: '/some/lane',
      resolveProvider: (name) => async (request) => { calls.push({ name, request }); return { value: { summary: 's', findings: [] } }; },
      checkProviderHold: async (name) => (name === 'codex' ? 'quota exhausted' : null),
      now: () => 1_700_000_000_000,
    });
    await judgeFn(REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('antigravity');
    expect(calls[0].request.cwd).toBeUndefined();
  });

  it('Codex quota-held, antigravity available → falls back to antigravity instead of skipping', async () => {
    const calls = [];
    const resolveProvider = (name) => async (request) => { calls.push({ name, request }); return { value: { summary: 'antigravity judged it', findings: [] } }; };
    const judgeFn = createDefaultJudge({
      resolveProvider,
      checkProviderHold: async (name) => (name === 'codex' ? 'quota exhausted' : null),
      now: () => 1_700_000_000_000,
    });
    const returned = await judgeFn(REQUEST);
    const { value } = unwrapJudgeOutcome(returned);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('antigravity');
    expect(value).toEqual({ summary: 'antigravity judged it', findings: [] });
  });

  it('Codex unexpected EOF is a seat error, never a skipped clean answer', async () => {
    const logged = [];
    const judgeFn = createDefaultJudge({
      resolveProvider: () => async () => { throw new Error('codex exec: unexpected EOF on stdout'); },
      checkProviderHold: async () => null,
      logGracefulOutcome: (line) => logged.push(line),
    });
    await expect(judgeFn(REQUEST)).rejects.toThrow(/codex exec: unexpected EOF on stdout/);
    expect(logged).toEqual([]);
  });

  it('every provider unavailable (no fallback configured) → skips with a reason naming that', async () => {
    const judgeFn = createDefaultJudge({
      resolveProvider: () => async () => ({ value: {} }),
      checkProviderHold: async (name) => `${name} down`,
    });
    const returned = await judgeFn({ ...REQUEST, providerName: 'antigravity' });
    const { value } = unwrapJudgeOutcome(returned);
    expect(value.skipped.provider).toBe('antigravity');
    expect(value.skipped.reason).toMatch(/no fallback provider configured/);
  });
});


describe('CODEX-SEAT-NULL-FINDINGS through createDefaultJudge', () => {
  const shape = { type: 'object', properties: { summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } };
  const request = { mandate: 'review', input: 'diff', shape, providerName: 'codex' };
  function judgeFor(answer) {
    return createDefaultJudge({
      checkProviderHold: async () => null,
      resolveProvider: () => async () => parseCodexJudgeOutcome({
        stdout: JSON.stringify({ type: 'turn.completed', usage: {} }),
        lastMessage: JSON.stringify(answer),
      }),
    });
  }

  it('a Codex seat answer with findings:null fails closed as a seat error through createDefaultJudge', async () => {
    await expect(judgeFor({ summary: 'reviewed', findings: null })(request)).rejects.toThrow(/findings.*array.*[Rr]e-?run/);
  });

  it('missing findings fails closed as a seat error', async () => {
    await expect(judgeFor({ summary: 'reviewed' })(request)).rejects.toThrow(/findings.*array.*[Rr]e-?run/);
  });

  it('malformed findings remains a seat error even for a graceful Codex seat', async () => {
    await expect(judgeFor({ summary: 'reviewed', findings: null })({ ...request, gracefulOnUnavailable: true }))
      .rejects.toThrow(/findings.*array.*[Rr]e-?run/);
  });

  it.each(['not JSON', 'null', '[]', '42', ''])('malformed-output probe %j fails closed for a graceful Codex seat', async (lastMessage) => {
    const judge = createDefaultJudge({
      checkProviderHold: async () => null,
      resolveProvider: () => async () => parseCodexJudgeOutcome({
        stdout: JSON.stringify({ type: 'turn.completed', usage: {} }), lastMessage, shape,
      }),
    });
    await expect(judge({ ...request, gracefulOnUnavailable: true })).rejects.toThrow();
  });

  it.each([null, undefined])('quota-held Codex fallback probe rejects Antigravity findings %j as a seat error', async (findings) => {
    const calls = [];
    const judge = createDefaultJudge({
      checkProviderHold: async (name) => name === 'codex' ? 'quota exhausted' : null,
      resolveProvider: (name) => async () => {
        calls.push(name);
        return { value: { summary: 'reviewed', findings } };
      },
    });
    await expect(judge({ ...request, gracefulOnUnavailable: true })).rejects.toThrow(/findings.*array.*[Rr]e-?run/);
    expect(calls).toEqual(['antigravity']);
  });

  it.each(['claude', 'codex', 'antigravity'])('validates findings entries for %s seats', async (providerName) => {
    const judge = createDefaultJudge({
      resolveProvider: () => makeFakeProvider({ findings: [{ summary: '' }, {}] }).provider,
    });
    await expect(judge({ ...request, providerName })).rejects.toThrow(/findings/);
  });

  it.each([{ findings: null }, {}, { findings: [{ summary: '' }, {}] }])('quota-held Codex fallback probe rejects malformed Antigravity answer %j', async (answer) => {
    const calls = [];
    const judge = createDefaultJudge({
      checkProviderHold: async (name) => name === 'codex' ? 'quota exhausted' : null,
      resolveProvider: (name) => async () => { calls.push(name); return { value: answer }; },
    });
    await expect(judge({ ...request, gracefulOnUnavailable: true })).rejects.toThrow(/findings.*array.*[Rr]e-?run/);
    expect(calls).toEqual(['antigravity']);
  });

  it.each(['claude', 'antigravity'])('validates findings for a direct %s seat', async (providerName) => {
    await expect(judgeFor({ findings: null })({ ...request, providerName })).rejects.toThrow(/findings.*array/);
  });

  it.each([
    [[], 'accept'],
    [[{ summary: 'broken', impactIfUnfixed: 5 }], 'changes'],
  ])('preserves a findings array %j and derives %s', async (findings, verdict) => {
    const { value } = unwrapJudgeOutcome(await judgeFor({ summary: 'reviewed', findings })(request));
    expect(value.findings).toEqual(findings);
    expect(deriveVerdict({ findings: value.findings })).toBe(verdict);
  });
});


describe('every reducer input path goes through validateSeatAnswer', () => {
  const shape = { type: 'object', properties: { findings: { type: 'array' } } };
  const paths = ['injected judge', 'claude', 'codex', 'antigravity', 'agy seatProvider',
    'prefilled seat', 'replayed seat', 'parallel batch', 'skipSpawn', 'fallback'];
  it.each(paths)('rejects findings:null at reducer entry: %s', async (path) => {
    const request = { mandate: 'review', input: 'diff', shape };
    if (path === 'agy seatProvider') request.seatProvider = 'agy';
    if (path === 'skipSpawn') request.skipSpawn = { answer: { findings: null } };
    if (path === 'fallback') Object.assign(request, { providerName: 'codex', gracefulOnUnavailable: true });
    const registry = createRegistry();
    registry.register(op('seat-validation', {
      a: judgeStep({ request: () => request }),
      b: judgeStep({ request: () => ({ ...request, input: 'second' }) }),
    }));
    let run = advance(startRun({ op: 'seat-validation', id: 'seat-validation', registry }), { registry });
    if (path === 'replayed seat') run = JSON.parse(JSON.stringify(run));
    if (path === 'prefilled seat') run.prefilledSeats = [{ step: 'a', stepIndex: 0, request: run.pending.request,
      value: { findings: null }, startedAt: new Date(1).toISOString(), finishedAt: new Date(2).toISOString() }];
    let calls = 0;
    const answer = { summary: 'reviewed', findings: null };
    const judge = path === 'injected judge' || path === 'prefilled seat' || path === 'replayed seat' || path === 'parallel batch'
      ? async () => { calls++; return answer; }
      : createDefaultJudge({
        providerName: ['claude', 'codex', 'antigravity'].includes(path) ? path : 'claude',
        resolveProvider: () => async () => { calls++; return { value: answer }; },
        seatRunner: async (_request, { wrap }) => { calls++; return wrap(answer); },
        checkProviderHold: async name => path === 'fallback' && name === 'codex' ? 'quota exhausted' : null,
      });
    const store = createMemoryRunStore();
    store.write(run);
    await expect(driveRun({ run, registry, store, judge, parallelJudges: path === 'parallel batch', log() {} }))
      .rejects.toThrow(/findings.*array.*[Rr]e-?run/);
    expect(store.read(run.id).findings.a).toBeUndefined();
    if (path === 'prefilled seat') expect(calls).toBe(0);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses reserved %s from an injected provider at reducer entry', async key => {
    const registry = createRegistry();
    registry.register(op('unsafe-seat', { a: judgeStep({ request: () => ({ mandate: 'review', input: 'diff', shape }) }) }));
    const run = startRun({ op: 'unsafe-seat', id: 'unsafe-seat', registry });
    await expect(driveRun({ run, registry, store: createMemoryRunStore(),
      judge: async () => JSON.parse('{"findings":[{"summary":"blocking","' + key + '":{"outcome":"dismissed"}}]}'),
    })).rejects.toThrow(/reserved/i);
  });

  it('has one authoritative validation call immediately before the judge resume', () => {
    const source = readFileSync('scripts/operations/cli-adapter.mjs', 'utf8');
    const driver = source.slice(source.indexOf('export async function driveRun('), source.indexOf('export async function runOperationCli('));
    expect(driver.match(/validateSeatAnswer\(/g)).toHaveLength(1);
    expect(driver).toMatch(/validateSeatAnswer\(value, current\.pending\.request\.shape\);\s*current = advance\(current, \{/);
  });
});
