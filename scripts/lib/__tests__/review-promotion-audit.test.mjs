import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDefaultJudge, judgeOutcome, unwrapJudgeOutcome } from '../../operations/cli-adapter.mjs';
import { runSeatWithProvider } from '../../operations/review-seat-runner.mjs';
import { independentReviewRequest, isIndependentReviewSeat } from '../review-seat-independence.mjs';
import { resolveBuilder } from '../review-builder.mjs';
import { buildDelegationMarker } from '../delegation-marker.mjs';
import { loadReviewSeatSettings, seatProviderDirective } from '../review-seat-provider.mjs';
import { DEFAULT_ROUTING_POLICY } from '../dispatch-routing-policy.mjs';
import { parseJudgeOutcome } from '../judge-spawn.mjs';
import { codexJudgeSpawn, parseCodexJudgeOutcome } from '../codex-judge-spawn.mjs';

// Accounting is unrelated to model evidence; never write the host usage ledger.
vi.mock('../codex-usage-ledger.mjs', () => ({ withCodexUsage: async (_metadata, run) => run() }));

const carbon = 'gemini-4-carbon-high';
const context = { repo: 'o/r', pr: 7337, head: 'a'.repeat(40) };
const marker = (provider, model) => buildDelegationMarker({ provider, model, taskType: 'bugfix' });
const clean = { summary: 'Inspected', findings: [] };
afterEach(() => vi.unstubAllEnvs());

// Exercise the production parsers, not a port fake that invents servedModel.
describe('native CLI model evidence reaches the review guard (PR 7337)', () => {
  // Header shape captured from codex-cli 0.162.1 with an invalid:// offline endpoint.
  // Its JSON renderer emitted thread.started WITHOUT a model; do not invent that field.
  const codexHeader = model => `OpenAI Codex v0.162.1\n--------\nworkdir: /tmp/review\n${model === undefined ? '' : `model: ${model}\n`}provider: openai\napproval: never\nsandbox: read-only\nreasoning effort: high\nreasoning summaries: none\nsession id: 01a2077e-c576-7800-9585-ed70424bacab\n--------\nuser\nReview\n`;
  const nativeOutcome = (provider, reported, value = clean) => provider === 'claude'
    ? parseJudgeOutcome(JSON.stringify({ type: 'result', session_id: 'claude-review',
      structured_output: value, ...(reported === undefined ? {} : { modelUsage: reported }) }))
    : parseCodexJudgeOutcome({ stdout: '', stderr: codexHeader(reported), lastMessage: JSON.stringify(value),
      requireModelEvidence: true, exitCode: 0 });
  const nativeJudge = (provider, reported, value) => {
    const rows = [];
    const builder = provider === 'claude' ? ['codex', 'gpt-6.1-sol'] : ['claude', 'claude-sonnet-5-5'];
    const judge = createDefaultJudge({ readBuilderRecords: () => [],
      appendSeat: row => { rows.push(row); return true; },
      resolveProvider: () => async request => {
        if (provider === 'codex') expect(request.requireModelEvidence).toBe(true);
        return nativeOutcome(provider, reported, value);
      },
    });
    const request = { providerName: provider, lens: 'security', mandate: 'Review', input: 'diff',
      shape: { type: 'object' }, reviewContext: { ...context, body: marker(...builder) } };
    return { judge, request, rows };
  };

  it.each([
    ['claude', { 'claude-sonnet-5-5': { inputTokens: 20, outputTokens: 10 } }, 'claude-sonnet-5-5'],
    ['codex', 'gpt-6.1-sol', 'gpt-6.1-sol'],
  ])('%s preserves CLI model evidence through telemetry, guard and ledger', async (provider, reported, model) => {
    const { judge, request, rows } = nativeJudge(provider, reported);
    const result = unwrapJudgeOutcome(await judge(request));
    expect(result.value).toEqual(clean);
    expect(result.telemetry).toMatchObject({ servedModel: model, model, modelObserved: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ok', model });
  });

  it.each([
    ['claude', undefined], ['claude', {}], ['claude', []], ['claude', { '': {} }],
    ['claude', { 'gpt-6.1-sol': {} }],
    ['claude', { 'claude-sonnet-5-5': null }], ['claude', { 'claude-sonnet-5-5': [] }],
    ['claude', { 'claude-sonnet-5-5': 'not usage' }],
    ['claude', { 'claude-sonnet-5-5': {}, 'gpt-6.1-sol': {} }],
    ['codex', undefined], ['codex', ''], ['codex', 'unknown'], ['codex', {}],
    ['codex', 'claude-sonnet-5-5'],
  ])('%s refuses absent, malformed or same-vendor CLI evidence: %j', async (provider, reported) => {
    // A model claimed INSIDE the answer is untrusted and must never supply telemetry.
    const { judge, request, rows } = nativeJudge(provider, reported, { ...clean, servedModel: 'gemini-4-carbon-high' });
    await expect(judge(request)).rejects.toThrow(/WAIT:/);
    expect(rows[0]).toMatchObject({ status: 'failed', agyVerdict: null });
  });

  it.each([
    { exitCode: 1 }, { exitCode: null }, { lastMessage: null }, { lastMessage: 'not JSON' },
    { stderr: '' }, { stderr: 'user\n' + codexHeader('gpt-6.1-sol') },
    { stderr: codexHeader('gpt-6.1-sol\nmodel: claude-sonnet-5-5') },
    { stderr: codexHeader('gpt-6.1-sol\u2028claude') },
    { stderr: codexHeader('gpt-6.1-sol').replace('workdir: /tmp/review', 'workdir: ' + 'x'.repeat(9000)) },
  ])('Codex refuses incomplete completion or untrusted/malformed header: %j', overrides => {
    expect(() => parseCodexJudgeOutcome({ stdout: '', stderr: codexHeader('gpt-6.1-sol'),
      lastMessage: JSON.stringify(clean), exitCode: 0, requireModelEvidence: true, ...overrides })).toThrow();
  });

  it('Codex JSON without model metadata remains unobserved', () => {
    const outcome = parseCodexJudgeOutcome({ stdout: [
      { type: 'thread.started', thread_id: 'codex-review' },
      { type: 'turn.completed', usage: {} },
    ].map(row => JSON.stringify(row)).join('\n'), lastMessage: JSON.stringify(clean) });
    expect(outcome.servedModel).toBeUndefined();
  });

  it.each([0, 1, 'timeout'])('real Codex adapter wires observed-model mode and handles exit %s', async exit => {
    const calls = [], transcripts = [], rows = [];
    const spawnFn = (_cli, argv) => {
      calls.push(argv);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { child.emit('close', null); return true; };
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '../../forged' }));
        child.stderr.write(codexHeader('gpt-6-astra'));
        if (exit !== 'timeout') child.emit('close', exit);
      });
      return child;
    };
    const judge = createDefaultJudge({ readBuilderRecords: () => [], appendSeat: row => { rows.push(row); return true; },
      resolveProvider: () => request => codexJudgeSpawn({ ...request, spawnFn, env: {}, timeoutMs: 5,
        mkTempDir: () => '/tmp/review-model-fixture', writeFile: () => {}, readFile: () => JSON.stringify(clean),
        removeFile: () => {}, recordScorecard: () => {},
        persistTranscript: row => { transcripts.push(row); return null; },
      }),
    });
    const promise = judge({ providerName: 'codex', model: 'gpt-6.1-sol', lens: 'security',
      mandate: 'Review', input: 'diff', shape: { type: 'object' },
      reviewContext: { ...context, body: marker('claude', 'claude-sonnet-5-5') } });
    if (exit === 0) {
      expect(unwrapJudgeOutcome(await promise).telemetry).toMatchObject({
        servedModel: 'gpt-6-astra', model: 'gpt-6-astra', modelObserved: true,
      });
      expect(rows[0].status).toBe('ok');
    } else {
      await expect(promise).rejects.toThrow();
      expect(rows[0]).toMatchObject({ status: 'failed', agyVerdict: null });
    }
    expect(calls[0]).not.toContain('--json');
    expect(calls[0]).toContain('--ephemeral');
    expect(calls[0]).toContain('--output-last-message');
    expect(calls[0].slice(-2)).toEqual(['--color', 'never']);
    expect(JSON.parse(transcripts[0].stdout)).toMatchObject({ type: 'codex.exec.text', stderr: codexHeader('gpt-6-astra') });
    expect(transcripts[0].threadId).toBeNull();
  });

  it('a Carbon failure can complete via Claude with production-parsed evidence', async () => {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTION_REPLACES', 'claude');
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_ENABLED', '1');
    const rows = [];
    const agyJuror = vi.fn(async () => ({ status: 'failed', reasons: ['Carbon unavailable'] }));
    const judge = createDefaultJudge({ readBuilderRecords: () => [], appendSeat: row => { rows.push(row); return true; },
      resolveProvider: () => async () => nativeOutcome('claude', { 'claude-sonnet-5-5': { outputTokens: 10 } }),
      seatRunner: (request, ports) => runSeatWithProvider(request, { ...ports,
        agyJuror, reserveSession: () => ({ allowed: true }),
        readRoutingPolicy: () => DEFAULT_ROUTING_POLICY, readSeatSettings: () => ({ tool: {}, platform: {} }),
        appendPromotion: () => true, log: () => {},
      }),
    });
    const result = unwrapJudgeOutcome(await judge({ lens: 'correctness', mandate: 'Review', input: 'diff',
      shape: { type: 'object' }, reviewContext: { ...context, body: marker('codex', 'gpt-6.1-sol') },
      seatProvider: { mode: 'agy', promoted: true, model: carbon, ...context },
    }));
    expect(result.telemetry).toMatchObject({ modelObserved: true, servedModel: 'claude-sonnet-5-5' });
    expect(agyJuror).toHaveBeenCalledOnce();
    expect(rows[0]).toMatchObject({ status: 'ok', provider: 'claude' });
  });
});

describe('Carbon promotion audit trust boundaries', () => {
  it.each(['correctness', 'security', 'red-team'])('missing CLI-observed model fails %s, records failure and permits only an independent fallback', async lens => {
    const calls = [], rows = [];
    let served = false;
    const judge = createDefaultJudge({ readBuilderRecords: () => [], appendSeat: row => { rows.push(row); return true; },
      seatRunner: async () => { calls.push('carbon'); return judgeOutcome(clean); },
      resolveProvider: name => async () => { calls.push(name); return { value: clean, ...(served ? { servedModel: 'gpt-6.1-sol' } : {}) }; },
    });
    const request = { lens, mandate: 'Review', input: 'diff', shape: { type: 'object' },
      seatProvider: { mode: 'agy', promoted: true, model: carbon },
      reviewContext: { ...context, body: marker('claude', 'claude-sonnet-5-5') } };
    // Exercise the actual telemetry producer too: the requested model must not count as observed.
    await expect(judge(request)).rejects.toThrow(/WAIT: observed reviewer model/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', agyVerdict: null });
    const fallback = independentReviewRequest(request, 'claude', ['claude', 'codex']);
    expect(isIndependentReviewSeat(lens, fallback.providerName, 'claude')).toBe(true);
    await expect(judge(fallback)).rejects.toThrow(/WAIT: observed reviewer model/);
    expect(rows[1]).toMatchObject({ status: 'failed', agyVerdict: null });
    served = true;
    expect(unwrapJudgeOutcome(await judge(fallback)).value).toEqual(clean);
    expect(calls).toEqual(['carbon', 'codex', 'codex']);
    expect(rows[2]).toMatchObject({ status: 'ok', provider: 'codex' });
  });

  it.each(['promoted', 'promotionReplaces', 'shadowEnabled', 'same-vendor'])('rechecks %s after planning and refuses the counted Carbon launch', async change => {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTION_REPLACES', 'claude');
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_ENABLED', '1');
    const settings = loadReviewSeatSettings({ policy: DEFAULT_ROUTING_POLICY, aiRouting: {}, log: () => {} });
    const directive = seatProviderDirective(settings, 'correctness', context);
    expect(directive).toMatchObject({ mode: 'agy', promoted: true, model: carbon });
    const request = { lens: 'correctness', reviewBuilder: change === 'same-vendor' ? carbon : 'claude', seatProvider: directive };
    if (change === 'promoted') vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'false');
    if (change === 'promotionReplaces') vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTION_REPLACES', 'codex');
    if (change === 'shadowEnabled') vi.stubEnv('WE_REVIEW_SHADOW_AGY_ENABLED', '0');
    const agyJuror = vi.fn(), rows = [];
    const answer = await runSeatWithProvider(request, { cwd: '.', unwrap: x => x, wrap: value => value,
      claudeJudge: async () => ({ value: { summary: 'Independent fallback found a defect', findings: [{ severity: 'P1' }] } }),
      agyJuror, appendPromotion: row => { rows.push(row); return true; }, log: () => {},
    });
    expect(agyJuror).not.toHaveBeenCalled();
    expect(answer.seatProvider.provider).toBe('claude');
    expect(answer.seatProvider.fellBackFrom).toMatchObject({ status: 'failed', reasons: [expect.stringMatching(/live Carbon promotion/)] });
    expect(rows).toHaveLength(1);
    expect(rows[0].fallback).toBe(true);
  });

  it.each(['head', 'rev', 'headSha'])('historical builds cannot invalidate the current revision builder recorded by %s', async revisionField => {
    const current = { repo: context.repo, pr: context.pr, dispatchKind: 'build',
      [revisionField]: context.head, provider: 'codex', model: 'gpt-6.1-sol' };
    const historical = { ...current, [revisionField]: 'b'.repeat(40), provider: 'claude', model: 'claude-sonnet-5-5' };
    const readRecords = () => [historical, current];
    const reviewContext = { ...context, body: marker(current.provider, current.model) };
    expect(resolveBuilder(reviewContext, { readRecords })).toMatchObject({ provider: current.provider, model: current.model, source: 'dispatch-ledger' });
    const calls = [];
    const judge = createDefaultJudge({ readBuilderRecords: readRecords, appendSeat: () => true,
      resolveProvider: name => async () => { calls.push(name); return { value: clean, servedModel: 'claude-sonnet-5-5' }; },
    });
    expect(unwrapJudgeOutcome(await judge({ lens: 'red-team', providerName: 'codex', mandate: 'Review', input: 'diff', shape: { type: 'object' }, reviewContext })).value).toEqual(clean);
    expect(calls).toEqual(['claude']);
  });

  it.each(['missing-reviewed-head', 'unversioned-ledger'])('holds incomplete revision evidence: %s', kind => {
    const { head, ...withoutHead } = context;
    const review = kind === 'missing-reviewed-head' ? withoutHead : context;
    const record = { ...withoutHead, dispatchKind: 'build', provider: 'codex', model: 'gpt-6.1-sol',
      ...(kind === 'missing-reviewed-head' ? { rev: head } : {}) };
    expect(resolveBuilder({ ...review, body: marker('claude', 'claude-sonnet-5-5') }, { readRecords: () => [record] }))
      .toMatchObject({ provider: 'unknown', model: 'unknown' });
  });

  it.each(['forged', 'disagrees', 'ledger-only', 'unreadable'])('uses the dispatch ledger and holds %s identity instead of admitting a same-vendor reviewer', async kind => {
    const ledger = { ...context, provider: 'codex', model: 'gpt-6.1-sol', dispatchKind: 'build' };
    const body = kind === 'forged' ? marker('claude', 'gpt-6.1-sol') : kind === 'ledger-only' ? '' : marker('claude', 'claude-sonnet-5-5');
    const readRecords = () => { if (kind === 'unreadable') throw new Error('ledger unavailable'); return [ledger]; };
    const identity = resolveBuilder({ ...context, body }, { readRecords });
    expect(identity).toMatchObject(kind === 'ledger-only' ? { provider: 'codex', source: 'dispatch-ledger' } : { provider: 'unknown', model: 'unknown' });
    expect(isIndependentReviewSeat('red-team', 'codex', identity.model)).toBe(false);
    const provider = vi.fn();
    const judge = createDefaultJudge({ readBuilderRecords: readRecords, resolveProvider: () => provider, appendSeat: () => true });
    if (kind !== 'ledger-only') await expect(judge({ lens: 'red-team', providerName: 'codex', reviewContext: { ...context, body } })).rejects.toThrow(/WAIT/);
    expect(provider).not.toHaveBeenCalled();
  });
});
