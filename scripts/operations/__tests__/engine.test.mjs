/**
 * @file engine.test.mjs — `advance` over all four step kinds, and the refusals (#3032).
 *
 * THE LOAD-BEARING TEST IN HERE is `the engine's import graph reaches nothing that can act`. Every other
 * claim in this slice — "a judge step declares and does not spawn", "an effect step declares and does not
 * write", "the engine is unit-testable without a process or the network" — rests on the engine having no
 * way to do those things. A behavioural test can only show it did not act THIS time; the static graph check
 * shows it CANNOT, and it fails the moment someone adds `import { spawn } from 'node:child_process'`.
 *
 * The scanner itself now lives in {@link ./import-graph.mjs}, shared with `http-adapter.test.mjs`'s read-only
 * check (#3036) and fixed to skip comments — the copy that used to sit here scanned raw source, so a JSDoc
 * sentence containing `from 'x'` was reported as an import. That over-reports and can only cause a false
 * FAILURE, never a false pass, but it made the scanner unusable on any documented module.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { importGraph } from './import-graph.mjs';
import { advance, advanceWhileRunning, isComplete, projectReads, runStatus, startRun } from '../engine.mjs';
import { createRegistry, op } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { compute, confirm, effect, judge } from '../step-kinds.mjs';
import { newRunRecord } from '../run-record.mjs';
import { FIXTURE_JUDGE_ANSWER, FIXTURE_OP, fixtureRegistry } from '../__fixtures__/fixture-operation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('the engine performs no io — structurally, not by habit', () => {
  it('the engine\'s import graph reaches nothing that can act', () => {
    const { files, external } = importGraph(resolve(HERE, '..', 'engine.mjs'));
    // The whole pure core: the engine, the declaration, the vocabulary, the record (and its job block, #4125).
    expect(files.map((f) => f.split('/').pop())).toEqual(['engine.mjs', 'job-record.mjs', 'registry.mjs', 'run-record.mjs', 'step-kinds.mjs']);
    // No `node:fs`, no `node:child_process`, no `node:http`, no anything.
    expect(external).toEqual([]);
  });

  it('the step vocabulary and the record core are leaves too', () => {
    expect(importGraph(resolve(HERE, '..', 'step-kinds.mjs')).external).toEqual([]);
    expect(importGraph(resolve(HERE, '..', 'run-record.mjs')).external).toEqual([]);
  });

  it('the effect EXECUTOR imports no fs or child_process either — its store and sinks are injected', () => {
    const { external } = importGraph(resolve(HERE, '..', 'effect-executor.mjs'));
    expect(external).toEqual([]);
  });
});

describe('startRun', () => {
  const registry = fixtureRegistry();

  it('produces a record at cursor 0 with the declared shape', () => {
    const run = startRun({ op: FIXTURE_OP, id: 'run-1', input: { pr: 42 }, registry });
    expect(run).toMatchObject({ v: 1, id: 'run-1', op: FIXTURE_OP, cursor: 0, findings: {}, verdict: null, effects: [], pending: null });
    expect(run.input).toEqual({ pr: 42, note: '' }); // the optional field's declared default
  });

  it('refuses an unknown operation', () => {
    expect(() => startRun({ op: 'nope', id: 'run-1', registry })).toThrow(/no operation named "nope"/);
  });

  it('refuses input the declaration does not accept', () => {
    expect(() => startRun({ op: FIXTURE_OP, id: 'run-1', input: {}, registry })).toThrow(/missing required input field `pr`/);
    expect(() => startRun({ op: FIXTURE_OP, id: 'run-1', input: { pr: 42, x: 1 }, registry })).toThrow(/unknown input field `x`/);
    expect(() => startRun({ op: FIXTURE_OP, id: 'run-1', input: { pr: '42' }, registry })).toThrow(/must be a number, got string/);
  });

  it('refuses an unusable run id', () => {
    expect(() => startRun({ op: FIXTURE_OP, id: '../escape', input: { pr: 1 }, registry })).toThrow(/invalid run id/);
  });
});

describe('declared reads are the actual boundary', () => {
  it('a step fn sees ONLY what it declared', () => {
    let seen = null;
    const registry = createRegistry();
    registry.register(op('reads', {
      input: { pr: 'number', secret: 'string' },
      a: compute({ fn: () => 'a-result' }),
      b: compute({ reads: ['input.pr', 'findings.a'], fn: (view) => { seen = view; return 1; } }),
    }));
    let run = startRun({ op: 'reads', id: 'run-reads', input: { pr: 7, secret: 'shh' }, registry });
    run = advanceWhileRunning(run, { registry });
    expect(seen).toEqual({ input: { pr: 7 }, findings: { a: 'a-result' } });
    expect(seen.input.secret).toBeUndefined();
  });

  it('the view is frozen, so a step cannot smuggle state back through it', () => {
    const run = { ...newRunRecord({ id: 'r', op: 'x', input: { pr: 1 } }), findings: { a: { deep: 1 } } };
    const view = projectReads(run, ['input.pr', 'findings.a', 'verdict']);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.input)).toBe(true);
    expect(() => { view.input.pr = 2; }).toThrow();
    expect(view.verdict).toBeNull();
  });

  it('a finding is copied, never aliased — mutating the returned object cannot reach the record', () => {
    const registry = createRegistry();
    const mutable = { n: 1 };
    registry.register(op('alias', { a: compute({ fn: () => mutable }) }));
    const run = advance(startRun({ op: 'alias', id: 'run-alias', registry }), { registry });
    mutable.n = 99;
    expect(run.findings.a).toEqual({ n: 1 });
  });
});

describe('advance over the four kinds', () => {
  const registry = fixtureRegistry();
  const start = () => startRun({ op: FIXTURE_OP, id: 'run-four', input: { pr: 99 }, registry });

  it('compute runs the pure fn and moves the cursor', () => {
    const run = advance(start(), { registry });
    expect(run.cursor).toBe(1);
    expect(run.findings.diff).toContain('pr-99');
    expect(run.pending).toBeNull();
  });

  it('judge SUSPENDS with a request for the #3028 helper and spawns nothing', () => {
    const run = advanceWhileRunning(start(), { registry });
    expect(runStatus(run, { registry })).toBe('awaiting-judge');
    expect(run.cursor).toBe(1); // the cursor does NOT move past a suspended step
    expect(run.pending.request).toMatchObject({ mandate: expect.any(String), input: expect.stringContaining('pr-99'), runId: 'run-four', lens: 'panel' });
    expect(run.pending.request.shape.properties.verdict.enum).toEqual(['accept', 'changes']);
    expect(run.findings.panel).toBeUndefined(); // nothing was judged — only declared
  });

  it('resuming the judge step records the answer and sets the declared verdict', () => {
    let run = advanceWhileRunning(start(), { registry });
    run = advance(run, { registry, resume: { value: FIXTURE_JUDGE_ANSWER } });
    expect(run.findings.panel).toEqual(FIXTURE_JUDGE_ANSWER);
    expect(run.verdict).toEqual(FIXTURE_JUDGE_ANSWER); // verdictFrom: 'panel'
    expect(run.cursor).toBe(2);
  });

  it('confirm SUSPENDS recording what is asked and of whom', () => {
    let run = advanceWhileRunning(start(), { registry });
    run = advanceWhileRunning(run, { registry, resume: { value: FIXTURE_JUDGE_ANSWER } });
    expect(runStatus(run, { registry })).toBe('awaiting-confirm');
    expect(run.pending).toMatchObject({ kind: 'confirm', step: 'humanOk', of: 'operator', options: ['accept', 'changes'] });
    expect(run.pending.asks).toBe('The panel returned "accept". Accept it?');
  });

  it('confirm REFUSES a decision outside its declared options', () => {
    let run = advanceWhileRunning(start(), { registry });
    run = advanceWhileRunning(run, { registry, resume: { value: FIXTURE_JUDGE_ANSWER } });
    expect(() => advance(run, { registry, resume: { value: 'maybe' } }))
      .toThrow(/accepts only "accept" \| "changes" — refusing "maybe"/);
  });

  it('effect DECLARES its effects, applies none, and stays suspended', () => {
    let run = advanceWhileRunning(start(), { registry });
    run = advanceWhileRunning(run, { registry, resume: { value: FIXTURE_JUDGE_ANSWER } });
    run = advanceWhileRunning(run, { registry, resume: { value: 'accept' } });
    expect(runStatus(run, { registry })).toBe('awaiting-effect');
    expect(run.effects.map((e) => [e.key, e.type, e.status])).toEqual([
      ['run-four#3#0', 'comment.post', 'declared'],
      ['run-four#3#1', 'label.swap', 'declared'],
    ]);
    expect(run.effects[1].idempotent).toBe(true);
    expect(run.effects[0].idempotent).toBe(false);
  });

  it('re-declaring the same effect step does not duplicate its entries', () => {
    let run = advanceWhileRunning(start(), { registry });
    run = advanceWhileRunning(run, { registry, resume: { value: FIXTURE_JUDGE_ANSWER } });
    run = advanceWhileRunning(run, { registry, resume: { value: 'accept' } });
    const again = advance({ ...run, pending: null }, { registry });
    expect(again.effects).toHaveLength(2);
  });

  it('an effect step declaring NOTHING resolves in the same call rather than suspending forever', () => {
    const r = createRegistry();
    r.register(op('nothing', { a: effect({ effects: () => [] }) }));
    const run = advance(startRun({ op: 'nothing', id: 'run-none', registry: r }), { registry: r });
    expect(runStatus(run, { registry: r })).toBe('complete');
  });
});

// A `judge` step declares the juror call and the CALLER makes it, so the cost of the spawn exists only out
// there — the resume is the one seam it can travel back through. See `withTelemetry` in the engine.
describe('a judge resume carries what the spawn cost', () => {
  const registry = fixtureRegistry();
  const atJudge = () => advanceWhileRunning(
    startRun({ op: FIXTURE_OP, id: 'run-tel', input: { pr: 7 }, registry }), { registry },
  );
  const SPEND = { costUsd: 0.02, wallMs: 1500, sessionId: 'abc', junk: 'dropped', usage: { input_tokens: 10 } };

  it('records a row on the run, whitelisted, stamped with the step and the declared request', () => {
    const run = advance(atJudge(), { registry, resume: { value: FIXTURE_JUDGE_ANSWER, telemetry: SPEND } });
    expect(run.telemetry).toHaveLength(1);
    expect(run.telemetry[0]).toEqual({
      step: 'panel', stepIndex: 1, costUsd: 0.02, wallMs: 1500, sessionId: 'abc',
      // `lens`/`effort` from the SUSPENDED REQUEST, never the caller's report — the row stays attributable to
      // the declared call. `model` falls back to the request here because this spend row reports none; a
      // reported one WINS, which is #3151's `--model` override (pinned in the next test).
      lens: 'panel', model: 'sonnet', effort: 'medium',
      usage: { input_tokens: 10 },
    });
    // The answer itself is untouched: a declaration must not be able to compute over what it cost.
    expect(run.findings.panel).toEqual(FIXTURE_JUDGE_ANSWER);
  });

  it('takes a REPORTED model over the declared one, and refuses the caller `lens`/`effort` (#3151)', () => {
    // THE ASYMMETRY IS THE TEST. `--model` is the one thing that can legitimately make the spawn differ from
    // the declaration, so a reported model must win or the row lies about which juror judged. A bare `effort`
    // report cannot claim an effective provider tier; `lens` always stays attributable to the declared call.
    // A fixture that reported the SAME values the declaration asks for
    // could not tell the two paths apart, so every field here is deliberately different.
    const run = advance(atJudge(), {
      registry,
      resume: {
        value: FIXTURE_JUDGE_ANSWER,
        telemetry: { ...SPEND, model: 'opus', effort: 'max', lens: 'a-lens-nobody-declared' },
      },
    });
    expect(run.telemetry[0].model).toBe('opus');
    expect(run.telemetry[0].effort).toBe('medium');
    expect(run.telemetry[0].lens).toBe('panel');
  });

  it('records explicit provider effectiveEffort under effort without changing the declared lens or request', () => {
    const suspended = atJudge();
    const request = structuredClone(suspended.pending.request);
    const run = advance(suspended, {
      registry,
      resume: { value: FIXTURE_JUDGE_ANSWER, telemetry: { ...SPEND, effectiveEffort: 'high', effort: 'low', lens: 'other' } },
    });
    expect(run.telemetry[0]).toMatchObject({ effort: 'high', lens: 'panel' });
    expect(run.telemetry[0]).not.toHaveProperty('effectiveEffort');
    expect(suspended.pending.request).toEqual(request);
  });

  it.each([undefined, null, '', ' ', 42, {}, []])('keeps the declared effort when effectiveEffort is unusable: %s', (effectiveEffort) => {
    const run = advance(atJudge(), {
      registry, resume: { value: FIXTURE_JUDGE_ANSWER, telemetry: { ...SPEND, effectiveEffort, effort: 'max' } },
    });
    expect(run.telemetry[0].effort).toBe('medium');
  });

  it('falls back to the declared model when the caller reports an EMPTY one, rather than recording none', () => {
    // `||`, not `??`: an empty string is not a model. Shadowing the declared value with one would leave
    // `normalizeJudgeTelemetry`'s string filter to drop the key entirely — a row worse than either input.
    const run = advance(atJudge(), { registry, resume: { value: FIXTURE_JUDGE_ANSWER, telemetry: { ...SPEND, model: '' } } });
    expect(run.telemetry[0].model).toBe('sonnet');
  });

  it('is optional — a resume without it records nothing and changes nothing', () => {
    const run = advance(atJudge(), { registry, resume: { value: FIXTURE_JUDGE_ANSWER } });
    expect(run.telemetry).toEqual([]);
  });

  it('REFUSES telemetry on a confirm resume — a person answering a question spawns no juror', () => {
    let run = advance(atJudge(), { registry, resume: { value: FIXTURE_JUDGE_ANSWER } });
    run = advanceWhileRunning(run, { registry });
    expect(runStatus(run, { registry })).toBe('awaiting-confirm');
    expect(() => advance(run, { registry, resume: { value: 'accept', telemetry: SPEND } }))
      .toThrow(/a `confirm` resume carries no juror telemetry/);
  });

  it('a record that predates the field still advances — absent is not corrupt', () => {
    const { telemetry, ...legacy } = atJudge();
    expect(telemetry).toEqual([]);
    const run = advance(legacy, { registry, resume: { value: FIXTURE_JUDGE_ANSWER, telemetry: SPEND } });
    expect(run.telemetry).toHaveLength(1);
  });
});

describe('advance is idempotent and never mutates', () => {
  const registry = fixtureRegistry();

  it('returns the record unchanged when suspended with nothing to resume it with', () => {
    const run = advanceWhileRunning(startRun({ op: FIXTURE_OP, id: 'run-idem', input: { pr: 1 }, registry }), { registry });
    expect(advance(run, { registry })).toBe(run);
  });

  it('returns the record unchanged once complete', () => {
    const r = createRegistry();
    r.register(op('one', { a: compute({ fn: () => 1 }) }));
    const done = advance(startRun({ op: 'one', id: 'run-done', registry: r }), { registry: r });
    expect(isComplete(done, { registry: r })).toBe(true);
    expect(advance(done, { registry: r })).toBe(done);
  });

  it('does not mutate the record it was given', () => {
    const run = startRun({ op: FIXTURE_OP, id: 'run-immutable', input: { pr: 1 }, registry });
    const snapshot = JSON.stringify(run);
    advance(run, { registry });
    expect(JSON.stringify(run)).toBe(snapshot);
  });
});

describe('the engine fails closed', () => {
  const registry = fixtureRegistry();

  it('refuses a record that is not a valid run record', () => {
    expect(() => advance({}, { registry })).toThrow(/run record passed to advance is invalid/);
    expect(() => advance({ ...newRunRecord({ id: 'r', op: 'x' }), v: 99 }, { registry })).toThrow(/unsupported run record version 99/);
    expect(() => advance({ ...newRunRecord({ id: 'r', op: 'x' }), cursor: -1 }, { registry })).toThrow(/`cursor` must be a non-negative integer/);
  });

  it('refuses a run naming an operation the registry does not have', () => {
    expect(() => advance(newRunRecord({ id: 'r', op: 'ghost' }), { registry })).toThrow(/no operation named "ghost"/);
  });

  it('refuses a cursor past the end of the declaration', () => {
    const run = { ...startRun({ op: FIXTURE_OP, id: 'run-past', input: { pr: 1 }, registry }), cursor: 9 };
    expect(() => advance(run, { registry })).toThrow(/declares only 4 step\(s\) — the declaration changed under a live run/);
  });

  it('refuses to resume a run whose declaration changed underneath it', () => {
    const suspended = advanceWhileRunning(startRun({ op: FIXTURE_OP, id: 'run-drift', input: { pr: 1 }, registry }), { registry });
    const drifted = createRegistry();
    drifted.register(op(FIXTURE_OP, { input: { pr: 'number' }, somethingElse: compute({ fn: () => 1 }) }));
    expect(() => advance(suspended, { registry: drifted, resume: { value: 1 } }))
      .toThrow(/suspended at step 1 \(`panel`\) but `fixture-review` now has no step there/);
  });

  it('refuses a resume addressed to the wrong step', () => {
    const suspended = advanceWhileRunning(startRun({ op: FIXTURE_OP, id: 'run-wrong', input: { pr: 1 }, registry }), { registry });
    expect(() => advance(suspended, { registry, resume: { step: 'humanOk', value: 1 } }))
      .toThrow(/refusing a resume addressed to `humanOk` — run run-wrong is suspended at `panel`/);
  });

  it('refuses a resume for a run that is not waiting on anything', () => {
    const run = startRun({ op: FIXTURE_OP, id: 'run-nowait', input: { pr: 1 }, registry });
    expect(() => advance(run, { registry, resume: { value: 1 } })).toThrow(/is not suspended — refusing a resume/);
  });

  it('refuses a resume that carries no value', () => {
    const suspended = advanceWhileRunning(startRun({ op: FIXTURE_OP, id: 'run-novalue', input: { pr: 1 }, registry }), { registry });
    expect(() => advance(suspended, { registry, resume: {} })).toThrow(/must carry a `value`/);
  });

  it('refuses to hand-wave an effect step past with a resume value', () => {
    let run = advanceWhileRunning(startRun({ op: FIXTURE_OP, id: 'run-handwave', input: { pr: 1 }, registry }), { registry });
    run = advanceWhileRunning(run, { registry, resume: { value: FIXTURE_JUDGE_ANSWER } });
    run = advanceWhileRunning(run, { registry, resume: { value: 'accept' } });
    expect(() => advance(run, { registry, resume: { value: 'done' } }))
      .toThrow(/resolved by applying its effects through the executor, never by a resume value/);
  });

  it('refuses an unknown step kind even if one somehow reached a declaration', () => {
    // `op()` cannot produce this — the refusal exists so a hand-built declaration cannot make the engine
    // improvise its way through a kind it does not know.
    const forged = Object.freeze({
      name: 'forged', input: {}, verdictFrom: null,
      steps: Object.freeze([Object.freeze({ name: 'a', index: 0, step: Object.freeze({ kind: 'notify', reads: [] }) })]),
      stepNames: Object.freeze(['a']),
    });
    const r = { get: () => forged, has: () => true, names: () => ['forged'] };
    expect(() => advance(newRunRecord({ id: 'run-forged', op: 'forged' }), { registry: r }))
      .toThrow(/unknown step kind "notify" — the vocabulary is closed/);
  });

  it('refuses a judge step whose request is not shaped for the helper', () => {
    const r = createRegistry();
    r.register(op('badjudge', { a: judge({ request: () => ({ mandate: 'm', input: '', shape: {} }) }) }));
    expect(() => advance(startRun({ op: 'badjudge', id: 'run-bj', registry: r }), { registry: r }))
      .toThrow(/must return a non-empty string `input` to judge/);
  });

  it('refuses an effect step that does not return an array', () => {
    const r = createRegistry();
    r.register(op('badeffect', { a: effect({ effects: () => ({ type: 'x' }) }) }));
    expect(() => advance(startRun({ op: 'badeffect', id: 'run-be', registry: r }), { registry: r }))
      .toThrow(/must return an ARRAY of declared effects/);
  });

  it('refuses a declared effect with no type', () => {
    const r = createRegistry();
    r.register(op('notype', { a: effect({ effects: () => [{ payload: 1 }] }) }));
    expect(() => advance(startRun({ op: 'notype', id: 'run-nt', registry: r }), { registry: r }))
      .toThrow(/declared effect #0 with no `type`/);
  });

  it('refuses a confirm step whose question came out empty', () => {
    const r = createRegistry();
    r.register(op('noask', { a: confirm({ asks: () => '  ', of: 'operator' }) }));
    expect(() => advance(startRun({ op: 'noask', id: 'run-na', registry: r }), { registry: r }))
      .toThrow(/produced an empty question/);
  });

  // #3035 — WHO is asked can depend on the run. `review-pr` needs `human` on a gate-self PR and `agent`
  // otherwise, which is a property of the PR the `read` step observed, not of the declaration.
  it('evaluates a FUNCTION `of` over the same projected view as `asks`', () => {
    const r = createRegistry();
    r.register(op('whoasks', {
      input: { gateSelf: 'boolean' },
      a: confirm({ reads: ['input.gateSelf'], asks: 'clear it?', of: (v) => (v.input.gateSelf ? 'human' : 'agent') }),
    }));
    const human = advance(startRun({ op: 'whoasks', id: 'run-wh', input: { gateSelf: true }, registry: r }), { registry: r });
    expect(human.pending.of).toBe('human');
    const agent = advance(startRun({ op: 'whoasks', id: 'run-wa', input: { gateSelf: false }, registry: r }), { registry: r });
    expect(agent.pending.of).toBe('agent');
  });

  it('refuses a confirm step whose `of` came out empty — never records a decision owed by ""', () => {
    const r = createRegistry();
    r.register(op('noof', { a: confirm({ asks: 'clear it?', of: () => '  ' }) }));
    expect(() => advance(startRun({ op: 'noof', id: 'run-no', registry: r }), { registry: r }))
      .toThrow(/produced an empty `of`/);
  });

  it('refuses to loop forever', () => {
    const r = createRegistry();
    const body = { input: {} };
    for (let i = 0; i < 5; i += 1) body[`s${i}`] = compute({ fn: () => i });
    r.register(op('many', body));
    expect(() => advanceWhileRunning(startRun({ op: 'many', id: 'run-many', registry: r }), { registry: r, maxSteps: 2 }))
      .toThrow(/did not settle within 2 steps/);
  });
});

/**
 * AN EFFECT STEP RECORDS WHAT IT PRODUCED (#3082). It was the one kind that wrote no finding, so nothing
 * downstream could see an effect's `result` — `reads:` is rooted at `input|findings|verdict` and there was no
 * finding to read. PR #1186's reviewer built the declaration that gap makes impossible and ran a failing
 * build through it: the run advanced past the failure, the step that existed to react saw nothing, and the
 * human was asked "Land it?".
 */
describe('an effect step writes a finding', () => {
  const decl = (sinkResult, { second = false } = {}) => {
    const r = createRegistry();
    r.register(op('deploy', {
      input: { pr: { type: 'number', required: true } },
      go: effect({
        reads: ['input.pr'],
        effects: () => (second
          ? [{ type: 'start.build', payload: {} }, { type: 'start.build', payload: { again: true } }]
          : [{ type: 'start.build', payload: {} }]),
      }),
      react: compute({ reads: ['findings.go'], fn: (v) => v.findings.go }),
    }));
    return r;
  };

  async function run(registry, sinks, id = 'run-p') {
    const store = createMemoryRunStore();
    let rec = advanceWhileRunning(startRun({ op: 'deploy', id, input: { pr: 7 }, registry }), { registry });
    rec = (await applyPendingEffects(rec, { sinks, store })).run;
    return advanceWhileRunning(rec, { registry });
  }

  // THE PROBE FROM THE REVIEW, which returned "(NOTHING)" before this.
  it('a later step can read what an effect returned', async () => {
    const rec = await run(decl(), { 'start.build': async () => ({ exit: 1, log: 'BUILD FAILED' }) });
    expect(rec.findings.react.effects[0].result).toEqual({ exit: 1, log: 'BUILD FAILED' });
  });

  it('says whether every effect landed, so a reader does not have to work it out', async () => {
    const rec = await run(decl(), { 'start.build': async () => ({ exit: 0 }) });
    expect(rec.findings.go.applied).toBe(true);
    expect(rec.findings.go.effects).toHaveLength(1);
  });

  // KEYED BY ORDINAL, not by type: a step may declare the same type twice, and a type-keyed shape would drop
  // one and lie about which result a reader is looking at.
  it('keeps both results when a step declares the same type twice', async () => {
    let n = 0;
    const rec = await run(decl(null, { second: true }), { 'start.build': async () => ({ n: ++n }) });
    expect(rec.findings.go.effects.map((e) => e.result)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  // Only what a reader can act on. The payload, the idempotency flag and the handle are the executor's
  // bookkeeping, and a step reaching for them would be going around the model rather than through it.
  it('carries the outcome and nothing else', async () => {
    const rec = await run(decl(), { 'start.build': async () => ({ exit: 0 }) });
    expect(Object.keys(rec.findings.go.effects[0]).sort()).toEqual(['error', 'result', 'status', 'type']);
  });

  // A step with nothing to do settles in one call and still records that it did nothing.
  it('records an empty finding for a step that declares no effects', () => {
    const r = createRegistry();
    r.register(op('noop', {
      input: { pr: { type: 'number', required: true } },
      go: effect({ reads: ['input.pr'], effects: () => [] }),
      react: compute({ reads: ['findings.go'], fn: (v) => v.findings.go }),
    }));
    const rec = advanceWhileRunning(startRun({ op: 'noop', id: 'run-n', input: { pr: 7 }, registry: r }), { registry: r });
    expect(rec.findings.go).toEqual({ applied: true, effects: [] });
  });

  // The finding is written on the path a REPLAY takes too — `resolvePending`, not only the declare path.
  it('is written when a half-applied step finishes on a later pass', async () => {
    const registry = decl();
    const store = createMemoryRunStore();
    let rec = advanceWhileRunning(startRun({ op: 'deploy', id: 'run-h', input: { pr: 7 }, registry }), { registry });
    // First pass fails, so the step does not settle and no finding is written yet.
    rec = (await applyPendingEffects(rec, {
      sinks: { 'start.build': async () => { throw Object.assign(new Error('nope'), { notApplied: true }); } },
      store,
    })).run;
    expect(advance(rec, { registry }).findings.go).toBeUndefined();
    // Second pass lands it.
    rec = (await applyPendingEffects(rec, { sinks: { 'start.build': async () => ({ exit: 0 }) }, store })).run;
    expect(advanceWhileRunning(rec, { registry }).findings.go.applied).toBe(true);
  });
});

// ── #3316 — a suspended run names the skill that owns the rest of it ────────────────────────────────────────
//
// THE FAILURE THIS PINS. A session invoked `review-pr` bare, hit its `confirm` suspend, did not know how to
// proceed, and escalated to a human — while `we:skills-src/review/SKILL.md` documented both routes forward the
// whole time. The operation suspended correctly; the record held no pointer from the run to the process it was
// one stop inside. These tests assert the pointer is on the record at every suspend, that it is DECLARED
// rather than special-cased per operation, and — the compatibility half — that an operation declaring none
// produces exactly the record it produced before this field existed.
describe('#3316 a suspend names the skill that owns the rest of the run', () => {
  const SKILL = 'we:skills-src/review/SKILL.md';

  /** One declaration that reaches all three suspends, with or without a declared owner. */
  const decl = ({ ownedBy } = {}) => {
    const r = createRegistry();
    r.register(op('owned', {
      input: { pr: 'number' },
      ...(ownedBy === undefined ? {} : { ownedBy }),
      panel: judge({ reads: ['input.pr'], request: (v) => ({ mandate: 'judge it', input: String(v.input.pr), shape: {} }) }),
      humanOk: confirm({ reads: ['findings.panel'], asks: 'Accept this verdict?', of: 'operator', options: ['accept', 'changes'] }),
      record: effect({ reads: ['findings.humanOk'], effects: () => [{ type: 'ledger.append', payload: {} }] }),
    }));
    return r;
  };

  const start = (registry) => startRun({ op: 'owned', id: 'run-o', input: { pr: 42 }, registry });

  it('the confirm suspend — the one the defect was measured on — carries the pointer on the record', () => {
    const registry = decl({ ownedBy: SKILL });
    let run = advanceWhileRunning(start(registry), { registry });
    run = advanceWhileRunning(run, { registry, resume: { value: { verdict: 'accept' } } });
    expect(runStatus(run, { registry })).toBe('awaiting-confirm');
    expect(run.pending).toMatchObject({ kind: 'confirm', step: 'humanOk', ownedBy: SKILL });
  });

  it('the judge and effect suspends carry it too — every stop, not just the human one', () => {
    const registry = decl({ ownedBy: SKILL });
    const judging = advanceWhileRunning(start(registry), { registry });
    expect(judging.pending).toMatchObject({ kind: 'judge', ownedBy: SKILL });

    const confirming = advanceWhileRunning(judging, { registry, resume: { value: { verdict: 'accept' } } });
    const effecting = advanceWhileRunning(confirming, { registry, resume: { value: 'accept' } });
    expect(effecting.pending).toMatchObject({ kind: 'effect', ownedBy: SKILL });
  });

  // THE COMPATIBILITY CLAIM, asserted rather than assumed. A required field, or an always-present
  // `ownedBy: null`, would have changed the record shape of every operation that legitimately owns no skill.
  it('an operation that declares NO skill produces the identical record — the key is absent, not null', () => {
    const registry = decl();
    const run = advanceWhileRunning(start(registry), { registry });
    expect(runStatus(run, { registry })).toBe('awaiting-judge');
    expect(Object.prototype.hasOwnProperty.call(run.pending, 'ownedBy')).toBe(false);
    expect(Object.keys(run.pending).sort()).toEqual(['kind', 'request', 'step', 'stepIndex']);
  });

  it('a run with no declared owner still completes end to end — the field breaks nothing it does not touch', () => {
    const registry = createRegistry();
    registry.register(op('plain', {
      input: { pr: 'number' },
      double: compute({ reads: ['input.pr'], fn: (v) => v.input.pr * 2 }),
    }));
    const run = advanceWhileRunning(startRun({ op: 'plain', id: 'run-p', input: { pr: 21 }, registry }), { registry });
    expect(isComplete(run, { registry })).toBe(true);
    expect(run.findings.double).toBe(42);
    expect(run.pending).toBe(null);
  });

  // DECLARED, NOT SPECIAL-CASED. The engine names no operation; whatever the declaration says is what rides.
  it('the engine reads the pointer off the declaration and invents nothing', () => {
    const registry = decl({ ownedBy: 'we:skills-src/drain/SKILL.md' });
    expect(advanceWhileRunning(start(registry), { registry }).pending.ownedBy).toBe('we:skills-src/drain/SKILL.md');
  });

  // REFUSED AT REGISTRATION, like every other structural claim about a declaration. A pointer that reads as
  // advice is the dead end this field exists to close, so it never reaches a run record.
  it('refuses a pointer that is not a locus-prefixed path, at registration', () => {
    const build = (ownedBy) => () => op('t', { ownedBy, probe: compute({ reads: [], fn: () => 1 }) });
    expect(build('the review skill')).toThrow(/not a locus-prefixed path/);
    expect(build('skills-src/review/SKILL.md')).toThrow(/not a locus-prefixed path/);
    expect(build('')).toThrow(/must be a locus-prefixed path/);
    expect(build(7)).toThrow(/must be a locus-prefixed path/);
    // Absent is legal, and normalizes to `null` rather than to a guess.
    expect(op('t', { probe: compute({ reads: [], fn: () => 1 }) }).ownedBy).toBe(null);
    expect(op('t', { ownedBy: SKILL, probe: compute({ reads: [], fn: () => 1 }) }).ownedBy).toBe(SKILL);
  });
});
