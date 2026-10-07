/**
 * @file judge-provider-selection.test.mjs — `--provider`/`providerName` WIRING (#xqa9ttq/#3383), proving
 * `resolveJudgeProvider`/`createDefaultJudge` actually reach the Codex and Antigravity providers and the
 * schema transform (Codex only), not merely that they are importable beside `cli-adapter.mjs`.
 *
 * `codex-judge-spawn.mjs` and `antigravity-judge-spawn.mjs` are MOCKED AT THE MODULE BOUNDARY (the same
 * sanctioned seam `we:scripts/lib/__tests__/nnn-collision-heal.wiring.test.mjs` uses) because
 * `resolveJudgeProvider`'s `'codex'`/`'antigravity'` branches call the real spawn functions directly — there is
 * no injection point at that layer, by design: the injection seam for a TEST is `createDefaultJudge({
 * provider })`, which every other judge test in this repo already uses to substitute a port-shaped fake without
 * touching a real CLI. This file is the one place that instead proves the RESOLUTION itself — the string
 * `'codex'`/`'antigravity'` actually reaching its own spawn function, and the Codex shape actually being
 * transformed before it gets there — is real code, not a docstring's claim about it.
 */


// `importOriginal` keeps `requireAllProperties`/`stripNulls` REAL — `resolveJudgeProvider`'s 'codex' branch
// imports both from this same module (see `cli-adapter.mjs`'s own import comment on why: NOT from
// `jury-core.mjs`, a real import-graph regression that broke the ephemeral-clone CLI tests), and the whole
// point of the second test below is proving the transform ACTUALLY ran on the shape `codexJudgeSpawn` received.
import { describe, it, test, expect, mock } from 'bun:test';
const codexJudgeSpawnCalls = [];
const __actual0 = { ...(await import('../../../../scripts/lib/codex-judge-spawn.mjs')) };
mock.module('../../../../scripts/lib/codex-judge-spawn.mjs', () => {
  const actual = __actual0;
  return {
    ...actual,
    codexJudgeSpawn: async (request) => {
      codexJudgeSpawnCalls.push(request);
      return {
        value: { ok: true }, sessionId: 'codex-sess', costUsd: 0, durationMs: 1, wallMs: 1, numTurns: 1,
        stopReason: 'turn.completed', usage: {}, loadedContextTokens: 0, timedOut: false, argv: [],
      };
    },
  };
});

// #3383 — SAME SEAM, for `antigravityJudgeSpawn`. `importOriginal` keeps `ANTIGRAVITY_MODEL` (and every other
// real export) untouched; only the spawn function itself is replaced with a recording stub.
const antigravityJudgeSpawnCalls = [];
const __actual1 = { ...(await import('../../../../scripts/lib/antigravity-judge-spawn.mjs')) };
mock.module('../../../../scripts/lib/antigravity-judge-spawn.mjs', () => {
  const actual = __actual1;
  return {
    ...actual,
    antigravityJudgeSpawn: async (request) => {
      antigravityJudgeSpawnCalls.push(request);
      return {
        value: { fromAntigravity: true }, sessionId: 'agy-sess', costUsd: 0, durationMs: 1, wallMs: 1,
        numTurns: 1, stopReason: 'SUCCESS', usage: {}, loadedContextTokens: 0, timedOut: false, argv: [],
      };
    },
  };
});

// `judgeSpawn` ITSELF WOULD SPAWN A REAL `claude` PROCESS if left un-mocked and reached by "defaults to claude"
// below — this repo's own judge tests always substitute it via `createDefaultJudge({ provider })`, and this is
// the one file that deliberately does NOT use that seam (see file header), so it has to stub the module
// instead. `importOriginal` keeps every other export (the classes, the constants) real; only `judgeSpawn` is
// replaced, and it is replaced with a RECORDING stub, never left calling through to the real one.
const claudeJudgeSpawnCalls = [];
const __actual2 = { ...(await import('../../../../scripts/lib/judge-spawn.mjs')) };
mock.module('../../../../scripts/lib/judge-spawn.mjs', () => {
  const actual = __actual2;
  return {
    ...actual,
    judgeSpawn: async (request) => {
      claudeJudgeSpawnCalls.push(request);
      return {
        value: { fromClaude: true }, sessionId: 'claude-sess', costUsd: 0.01, durationMs: 1, wallMs: 1,
        numTurns: 1, stopReason: 'tool_use', usage: {}, loadedContextTokens: 0, timedOut: false, argv: [],
      };
    },
  };
});

const { createDefaultJudge, resolveJudgeProvider, JUDGE_PROVIDER_NAMES, unwrapJudgeOutcome } = await import('../../../../scripts/operations/cli-adapter.mjs');
const { judgeSpawn } = await import('../../../../scripts/lib/judge-spawn.mjs');
const { buildReviewJudgeRequest, buildReviewAdvisoryJudgeRequest, DEFAULT_LENS } = await import('../../../../scripts/operations/review-pr.mjs');

describe('JUDGE_PROVIDER_NAMES', () => {
  it('is exactly claude, codex, antigravity — additive, claude first/default', () => {
    expect(JUDGE_PROVIDER_NAMES).toEqual(['claude', 'codex', 'antigravity']);
  });
});

describe('resolveJudgeProvider', () => {
  it('resolves \'claude\' (and null/undefined) to the real judgeSpawn, unchanged', () => {
    expect(resolveJudgeProvider('claude')).toBe(judgeSpawn);
    expect(resolveJudgeProvider(null)).toBe(judgeSpawn);
    expect(resolveJudgeProvider(undefined)).toBe(judgeSpawn);
  });

  it('refuses an unrecognised name', () => {
    expect(() => resolveJudgeProvider('gemini')).toThrow(/unknown judge provider/);
  });

  it('\'codex\' resolves to a function that calls the real codexJudgeSpawn with a TRANSFORMED shape', async () => {
    const provider = resolveJudgeProvider('codex');
    expect(provider).not.toBe(judgeSpawn);
    codexJudgeSpawnCalls.length = 0;
    await provider({
      mandate: 'm', input: 'i',
      shape: { type: 'object', properties: { summary: { type: 'string' }, file: { type: 'string' } }, required: ['summary'] },
    });
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    // THE TRANSFORM ACTUALLY RAN (#3371 probes 3/4) — every property is now required.
    expect(codexJudgeSpawnCalls[0].shape.required).toEqual(['summary', 'file']);
    expect(codexJudgeSpawnCalls[0].shape.properties.file.type).toEqual(['string', 'null']);
  });

  // #3383 — the fifth seat's provider.
  it('\'antigravity\' resolves to a function that calls the real antigravityJudgeSpawn with the shape UNTRANSFORMED', async () => {
    const provider = resolveJudgeProvider('antigravity');
    expect(provider).not.toBe(judgeSpawn);
    antigravityJudgeSpawnCalls.length = 0;
    const shape = { type: 'object', properties: { summary: { type: 'string' }, file: { type: 'string' } }, required: ['summary'] };
    await provider({ mandate: 'm', input: 'i', shape });
    expect(antigravityJudgeSpawnCalls).toHaveLength(1);
    // NO TRANSFORM — `agy` accepts this repo's optional-property shapes as-is (antigravity-judge-spawn.mjs's
    // own header, item 3), so the shape reaches it byte-identical to what the caller passed.
    expect(antigravityJudgeSpawnCalls[0].shape).toBe(shape);
  });

  it('\'antigravity\' pins the model default (ANTIGRAVITY_MODEL), an explicit request.model still wins', async () => {
    const provider = resolveJudgeProvider('antigravity');
    antigravityJudgeSpawnCalls.length = 0;
    await provider({ mandate: 'm', input: 'i', shape: { type: 'object' } });
    expect(antigravityJudgeSpawnCalls[0].model).toBe('gemini-3.1-pro');
    antigravityJudgeSpawnCalls.length = 0;
    await provider({ mandate: 'm', input: 'i', shape: { type: 'object' }, model: 'gemini-3.8-flash-low' });
    expect(antigravityJudgeSpawnCalls[0].model).toBe('gemini-3.8-flash-low');
  });
});

describe('createDefaultJudge — providerName selection end to end (no injected provider stub)', () => {
  it('defaults to claude — reaches the (mocked) judgeSpawn, never codexJudgeSpawn', async () => {
    claudeJudgeSpawnCalls.length = 0;
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({});
    const returned = await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } });
    expect(claudeJudgeSpawnCalls).toHaveLength(1);
    expect(codexJudgeSpawnCalls).toHaveLength(0);
    expect(unwrapJudgeOutcome(returned).value).toEqual({ fromClaude: true });
  });

  it('providerName: \'codex\' reaches the mocked codexJudgeSpawn, with a transformed shape, and returns its answer', async () => {
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ providerName: 'codex' });
    const returned = await judgeFn({
      mandate: 'm', input: 'i',
      shape: { type: 'object', properties: { a: { type: 'string' } } },
      runId: 'run-1', lens: 'correctness',
    });
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    expect(codexJudgeSpawnCalls[0].shape.required).toEqual(['a']);
    const { value, telemetry } = unwrapJudgeOutcome(returned);
    expect(value).toEqual({ ok: true });
    expect(telemetry.sessionId).toBe('codex-sess');
    expect(telemetry.costUsd).toBe(0);
  });

  it('an explicit `provider` function OVERRIDES `providerName` — the existing test-injection seam is untouched', async () => {
    codexJudgeSpawnCalls.length = 0;
    const calls = [];
    const stub = async (req) => { calls.push(req); return { value: { stubbed: true } }; };
    const judgeFn = createDefaultJudge({ providerName: 'codex', provider: stub });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } });
    expect(calls).toHaveLength(1);
    expect(codexJudgeSpawnCalls).toHaveLength(0); // the mocked codex provider was never reached
  });

  it('refuses providerName: \'codex\' combined with a TOOL-BEARING request — tool-free panelist only (#3581)', async () => {
    const judgeFn = createDefaultJudge({ providerName: 'codex' });
    await expect(judgeFn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, allowedTools: ['Read'], cwd: '/tmp/x',
    })).rejects.toThrow(/TOOL-FREE panelist only/);
  });

  it('providerName: \'codex\' with an EXPLICITLY EMPTY allowedTools array is tool-free, not tool-bearing (PR #2115 review: [] is truthy in JS)', async () => {
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ providerName: 'codex' });
    const returned = await judgeFn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, allowedTools: [],
    });
    expect(returned).toBeDefined();
    expect(codexJudgeSpawnCalls).toHaveLength(1);
  });

  it('the SAME empty allowedTools array stays REFUSED for the default claude provider - the codex normalisation must not weaken the shared guard', async () => {
    const judgeFn = createDefaultJudge({ provider: async () => ({ value: {}, costUsd: 0 }) });
    await expect(judgeFn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, allowedTools: [], cwd: '/tmp/x',
    })).rejects.toThrow(/non-empty array/);
  });

  // PR #2115 human review (CONFIRMED, correctness): the two tests above only ever pass a SYNTHETIC tool-free or
  // hand-built tool-bearing request — neither proves anything about `review-pr.mjs`'s REAL judge steps, which
  // are `review-pr`'s only current caller of this dispatch's `--judge-provider`/`--provider` threading
  // (`we:scripts/operations/review-dispatch.mjs`). `buildReviewJudgeRequest` is the actual recipe those steps
  // use, and it is UNCONDITIONALLY tool-bearing (`REVIEW_JUROR_TOOLS`, by ratified design — see its own header).
  // This drives THAT real request, not a stand-in, to pin down the actual, intended outcome: `--provider=codex`
  // can never reach a real `review-pr` judge step today.
  it('the REAL review-pr.mjs judge request (not a synthetic stand-in) is refused for providerName: \'codex\'', async () => {
    const judgeFn = createDefaultJudge({ providerName: 'codex', cwd: '/tmp/x' });
    const read = {
      repo: 'o/r', pr: 1, title: 't', body: '', netChangedFiles: ['a.mjs'], diffText: 'diff',
    };
    const request = buildReviewJudgeRequest({ read, lens: DEFAULT_LENS });
    expect(request.allowedTools).toBeTruthy();
    await expect(judgeFn(request)).rejects.toThrow(/TOOL-FREE panelist only/);
  });

  // #3383 — the fifth seat's provider, same coverage shape as the codex seat's above.
  it('providerName: \'antigravity\' reaches the mocked antigravityJudgeSpawn and returns its answer', async () => {
    antigravityJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ providerName: 'antigravity' });
    const returned = await judgeFn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, runId: 'run-1', lens: 'antigravity-review',
    });
    expect(antigravityJudgeSpawnCalls).toHaveLength(1);
    const { value, telemetry } = unwrapJudgeOutcome(returned);
    expect(value).toEqual({ fromAntigravity: true });
    expect(telemetry.sessionId).toBe('agy-sess');
    expect(telemetry.costUsd).toBe(0);
  });

  it('refuses providerName: \'antigravity\' combined with a TOOL-BEARING request — tool-free panelist only (#3383)', async () => {
    const judgeFn = createDefaultJudge({ providerName: 'antigravity' });
    await expect(judgeFn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, allowedTools: ['Read'], cwd: '/tmp/x',
    })).rejects.toThrow(/TOOL-FREE panelist only/);
  });
});

// ── #xqa9ttq round 2 — THE PER-REQUEST `providerName` OVERRIDE (review-pr's opt-in `judgeAdvisory` seat) ──────
describe('createDefaultJudge — a REQUEST-level `providerName` overrides the factory\'s own', () => {
  it('a factory bound to claude (the default) still reaches codex when ONE request pins its own providerName', async () => {
    claudeJudgeSpawnCalls.length = 0;
    codexJudgeSpawnCalls.length = 0;
    // No `providerName` at the FACTORY at all — this is the shape review-pr's SAME judge factory instance is
    // in for its two existing (unmodified) seats: whatever `--provider`/env resolved, default `claude`.
    const judgeFn = createDefaultJudge({});
    const returned = await judgeFn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'codex',
    });
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    expect(claudeJudgeSpawnCalls).toHaveLength(0);
    expect(unwrapJudgeOutcome(returned).value).toEqual({ ok: true });
  });

  it('a SIBLING call through the SAME judge function, with no providerName, still reaches claude — one factory, two providers', async () => {
    claudeJudgeSpawnCalls.length = 0;
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({});
    await judgeFn({ mandate: 'm1', input: 'i1', shape: { type: 'object' }, providerName: 'codex' });
    await judgeFn({ mandate: 'm2', input: 'i2', shape: { type: 'object' } });
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    expect(claudeJudgeSpawnCalls).toHaveLength(1);
  });

  it('refuses an unrecognised request-level providerName', async () => {
    const judgeFn = createDefaultJudge({});
    await expect(judgeFn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'gemini',
    })).rejects.toThrow(/unknown judge provider/);
  });

  it('also refuses a request-level providerName: codex combined with allowedTools (not only the factory-level case)', async () => {
    const judgeFn = createDefaultJudge({}); // factory default stays `claude`
    await expect(judgeFn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'codex', allowedTools: ['Read'], cwd: '/tmp/x',
    })).rejects.toThrow(/TOOL-FREE panelist only/);
  });

  it('an explicit factory-level `provider` stub WINS when the request carries no providerName of its own (unchanged)', async () => {
    const calls = [];
    const stub = async (req) => { calls.push(req); return { value: { stubbed: true } }; };
    const judgeFn = createDefaultJudge({ provider: stub, providerName: 'codex' });
    codexJudgeSpawnCalls.length = 0;
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } });
    expect(calls).toHaveLength(1);
    expect(codexJudgeSpawnCalls).toHaveLength(0);
  });

  it('a REQUEST-level providerName resolves via the real resolver even when an unrelated `provider` stub is bound at the factory', async () => {
    // The stub at the factory level was injected for a DIFFERENT seat's test; a request that pins its own
    // provider must not be silently intercepted by it.
    codexJudgeSpawnCalls.length = 0;
    const calls = [];
    const stub = async (req) => { calls.push(req); return { value: { stubbed: true } }; };
    const judgeFn = createDefaultJudge({ provider: stub }); // stub wins when request has no providerName
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'codex' });
    expect(calls).toHaveLength(0);
    expect(codexJudgeSpawnCalls).toHaveLength(1);
  });

  // #3383 — THREE opt-in seats (codex third/fourth, antigravity fifth) can now coexist on ONE run; proves the
  // per-request override reaches each provider independently with no cross-seat collision.
  it('sibling calls through the SAME judge function reach claude, codex, AND antigravity with no collision', async () => {
    claudeJudgeSpawnCalls.length = 0;
    codexJudgeSpawnCalls.length = 0;
    antigravityJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({});
    await judgeFn({ mandate: 'm1', input: 'i1', shape: { type: 'object' } });
    await judgeFn({ mandate: 'm2', input: 'i2', shape: { type: 'object' }, providerName: 'codex' });
    await judgeFn({ mandate: 'm3', input: 'i3', shape: { type: 'object' }, providerName: 'antigravity' });
    expect(claudeJudgeSpawnCalls).toHaveLength(1);
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    expect(antigravityJudgeSpawnCalls).toHaveLength(1);
  });

  // #3383 mechanical-dispatcher Gap 2 root-cause regression test — THE exact shape `review-pr.mjs`'s three
  // optional advisory seats build (`buildReviewAdvisoryJudgeRequest`/`buildReviewCorrectnessAdvisoryJudgeRequest`/
  // `buildReviewAntigravityJudgeRequest`, none of which include a `model` key at all) and the exact factory shape
  // `run.mjs`'s real CLI wiring builds when the operator names no `--model` override (`createDefaultJudge({})`,
  // no `model` at all — NOT `createDefaultJudge({ model: 'opus' })`, which the two tests above already cover).
  // Confirmed live: a real end-to-end `review-pr` run over PR #2178, before this fix, threw "run-scorecard-
  // store: refusing to append an invalid scorecard: - `model` is required" for every one of the three optional
  // seats — `codexJudgeSpawn`/`antigravityJudgeSpawn` were reached with `model: undefined`, not merely absent,
  // because `createDefaultJudge` used to write `model: effective.model` as an unconditional OWN property, which
  // survives past `resolveJudgeProvider`'s own `{ model: CODEX_MODEL, ...request }` default-via-spread (a spread
  // does not skip an explicit `undefined` key the way a destructured default parameter does).
  it('a request that OMITS `model` entirely (review-pr\'s real advisory-seat shape) still reaches each provider '
    + 'with ITS OWN pinned default, never `undefined`', async () => {
    codexJudgeSpawnCalls.length = 0;
    antigravityJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({}); // no factory-level `model` override either — the real CLI default
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'codex' });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'antigravity' });
    expect(codexJudgeSpawnCalls[0].model).toBe('gpt-6-astra');
    expect(antigravityJudgeSpawnCalls[0].model).toBe('gemini-3.1-pro');
  });

  it('an injectable `resolveProvider` lets a test substitute BOTH providers without the module-mock seam', async () => {
    const seen = [];
    const resolveProvider = (name) => async (req) => { seen.push({ name, req }); return { value: { via: name } }; };
    const judgeFn = createDefaultJudge({ resolveProvider });
    const a = await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } }); // factory default: claude
    const b = await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'codex' });
    expect(unwrapJudgeOutcome(a).value).toEqual({ via: 'claude' });
    expect(unwrapJudgeOutcome(b).value).toEqual({ via: 'codex' });
    expect(seen.map((s) => s.name)).toEqual(['claude', 'codex']);
  });

  it('the operator\'s `--model` override never reaches a request whose EFFECTIVE provider is codex — the seat '
    + 'falls back to codex\'s OWN pinned default (CODEX_MODEL), never `undefined` (#3383 Gap 2 root-cause fix)', async () => {
    codexJudgeSpawnCalls.length = 0;
    // The factory carries an operator `--model` override (as `run.mjs`'s CLI wiring would, for the seat(s)
    // the operator is actually steering) — a request pinned to codex must never receive it.
    const judgeFn = createDefaultJudge({ model: 'opus' });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'codex' });
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    // FIXED (#3383 Gap 2 root cause, confirmed live against PR #2178): this used to assert `.toBeUndefined()`,
    // which was the BUG's own signature, not the intended contract — `createDefaultJudge` wrote an explicit
    // `model: undefined` OWN property onto the object handed to `resolveJudgeProvider('codex')`'s wrapper,
    // whose own `{ model: CODEX_MODEL, ...request }` spread does not skip an explicit `undefined` key, so the
    // seat's pinned default was silently overwritten with `undefined` — which then made every advisory-seat
    // scorecard row fail `run-scorecard-store.mjs`'s `model` requirement, never recording. The real invariant
    // this test is actually for is narrower: the operator's Claude override ('opus') must not leak onto a
    // codex-pinned request — codex's OWN default model is exactly what SHOULD reach it instead.
    expect(codexJudgeSpawnCalls[0].model).toBe('gpt-6-astra');
    expect(codexJudgeSpawnCalls[0].model).not.toBe('opus');
  });

  it('…while an ordinary claude-provider request still gets the operator\'s `--model` override, unchanged', async () => {
    claudeJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ model: 'opus' });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } });
    expect(claudeJudgeSpawnCalls).toHaveLength(1);
    expect(claudeJudgeSpawnCalls[0].model).toBe('opus');
  });

  // #3383 — same exclusion, for the fifth seat's provider. Same fix as the codex test above: the seat's OWN
  // pinned default (ANTIGRAVITY_MODEL) is the correct outcome, not `undefined`.
  it('the operator\'s `--model` override never reaches a request whose EFFECTIVE provider is antigravity — the '
    + 'seat falls back to its OWN pinned default (ANTIGRAVITY_MODEL), never `undefined` (#3383 Gap 2 fix)', async () => {
    antigravityJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ model: 'opus' });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'antigravity' });
    expect(antigravityJudgeSpawnCalls).toHaveLength(1);
    expect(antigravityJudgeSpawnCalls[0].model).toBe('gemini-3.1-pro');
    expect(antigravityJudgeSpawnCalls[0].model).not.toBe('opus');
  });
});

describe('createDefaultJudge - a codex-routed request never carries the lane cwd or a Claude model name (PR #2117 review)', () => {
  it('a request pinned to codex never receives the factory\'s lane cwd', async () => {
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ cwd: '/some/lane' });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'codex' });
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    expect(codexJudgeSpawnCalls[0].cwd).toBeUndefined();
  });

  it('a request pinned to antigravity (tool-free) never receives the factory\'s lane cwd either (#4446)', async () => {
    antigravityJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ cwd: '/some/lane' });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'antigravity' });
    expect(antigravityJudgeSpawnCalls).toHaveLength(1);
    expect(antigravityJudgeSpawnCalls[0].cwd).toBeUndefined();
  });

  it('a factory whose OWN provider is codex never receives the lane cwd either', async () => {
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ providerName: 'codex', cwd: '/some/lane' });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } });
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    expect(codexJudgeSpawnCalls[0].cwd).toBeUndefined();
  });

  it('the CLAUDE provider still receives the factory\'s cwd (the fix is codex-only)', async () => {
    const calls = [];
    const stub = async (req) => { calls.push(req); return { value: {}, costUsd: 0 }; };
    const judgeFn = createDefaultJudge({ cwd: '/some/lane', provider: stub });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe('/some/lane');
  });

  it('a request\'s OWN Claude model name is stripped before it reaches codex', async () => {
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ providerName: 'codex' });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, model: 'sonnet' });
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    // #3907 port: the stripped request falls back to codex's OWN pinned default (CODEX_MODEL), never the
    // Claude name — the same contract as the #3383 Gap 2 test above.
    expect(codexJudgeSpawnCalls[0].model).toBe('gpt-6-astra');
  });

  it('a request pinned to codex is stripped of its own model even when the factory default is claude', async () => {
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({});
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, providerName: 'codex', model: 'sonnet' });
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    // #3907 port: the stripped request falls back to codex's OWN pinned default (CODEX_MODEL), never the
    // Claude name — the same contract as the #3383 Gap 2 test above.
    expect(codexJudgeSpawnCalls[0].model).toBe('gpt-6-astra');
  });

  it('the claude provider still receives the request\'s model (the strip is codex-only)', async () => {
    const calls = [];
    const stub = async (req) => { calls.push(req); return { value: {}, costUsd: 0 }; };
    const judgeFn = createDefaultJudge({ provider: stub });
    await judgeFn({ mandate: 'm', input: 'i', shape: { type: 'object' }, model: 'sonnet' });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('sonnet');
  });
});

describe('createDefaultJudge - the REAL review-pr requests route correctly through ONE factory (PR #2117 review: dispatch/`--provider=codex` composed path)', () => {
  const read = { repo: 'o/r', pr: 1, title: 't', body: '', netChangedFiles: ['a.mjs'], diffText: 'diff' };

  it('a mandatory (tool-bearing) seat goes to the claude provider WITH its lane cwd and tools; the advisory seat goes to codex with NO tools, NO cwd, NO Claude model', async () => {
    const claudeCalls = [];
    const claudeStub = async (req) => { claudeCalls.push(req); return { value: {}, costUsd: 0 }; };
    const judgeFn = createDefaultJudge({ cwd: '/some/lane', provider: claudeStub });

    await judgeFn(buildReviewJudgeRequest({ read, lens: DEFAULT_LENS }));
    expect(claudeCalls).toHaveLength(1);
    expect(Array.isArray(claudeCalls[0].allowedTools)).toBe(true);
    expect(claudeCalls[0].allowedTools.length).toBeGreaterThan(0);
    expect(claudeCalls[0].cwd).toBe('/some/lane');

    codexJudgeSpawnCalls.length = 0;
    await judgeFn(buildReviewAdvisoryJudgeRequest({ read }));
    expect(claudeCalls).toHaveLength(1);
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    expect(codexJudgeSpawnCalls[0].allowedTools).toBeUndefined();
    expect(codexJudgeSpawnCalls[0].cwd).toBeUndefined();
    // #3907 port: the stripped request falls back to codex's OWN pinned default (CODEX_MODEL), never the
    // Claude name — the same contract as the #3383 Gap 2 test above.
    expect(codexJudgeSpawnCalls[0].model).toBe('gpt-6-astra');
  });

  it('`--provider=codex` for the whole run (factory providerName codex) is refused at the first tool-bearing seat - exactly why review-dispatch refuses it', async () => {
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ providerName: 'codex', cwd: '/some/lane' });
    await expect(judgeFn(buildReviewJudgeRequest({ read, lens: DEFAULT_LENS }))).rejects.toThrow(/TOOL-FREE panelist only/);
    expect(codexJudgeSpawnCalls).toHaveLength(0);
  });

  it('the opt-in advisory seat still runs on codex under the same whole-run `--provider=codex` factory', async () => {
    codexJudgeSpawnCalls.length = 0;
    const judgeFn = createDefaultJudge({ providerName: 'codex', cwd: '/some/lane' });
    await expect(judgeFn(buildReviewAdvisoryJudgeRequest({ read }))).resolves.toBeDefined();
    expect(codexJudgeSpawnCalls).toHaveLength(1);
    expect(codexJudgeSpawnCalls[0].cwd).toBeUndefined();
  });
});


