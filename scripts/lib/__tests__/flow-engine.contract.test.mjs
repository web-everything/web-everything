import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as engine from '../flow-engine/index.mjs';
import { comparePlans, shadowReviewStep } from '../flow-engine/shadow.mjs';
import { writeReviewJobDone } from '../../operations/review-job-envelope.mjs';
const test = process.env.VITEST ? (await import('vitest')).it : nodeTest;

export function fixture() {
  return { flowType: 'https://everstandards.dev/flow/decision-lifecycle/v0',
    id: 'tag:everstandards.dev,2026-11-22:flow/review/v1', initial: 'judge-convergence',
    keys: { parts: { Subject: { kind: 'subject' }, Visit: { kind: 'visit' } } },
    retry: { maxAttempts: 1, onExhausted: 'parked' },
    guards: { convergence: { classifies: 'stop rule', outcomes: ['accept', 'continue', 'stop', 'unknown'] } },
    states: {
      'judge-convergence': { kind: 'judge', key: 'review:{Subject}:{Visit}', on: [
        { event: 'done', guard: 'convergence', outcome: 'accept', route: 'advance', target: 'accepted' },
        { event: 'done', guard: 'convergence', outcome: 'continue', route: 'advance', target: 'judge-convergence' },
        { event: 'done', guard: 'convergence', outcome: 'stop', route: 'advance', target: 'parked' },
        { event: 'done', guard: 'convergence', outcome: 'unknown', route: 'retry', target: 'judge-convergence' },
      ] }, accepted: { kind: 'final' }, parked: { kind: 'final' },
    } };
}
const projection = flow => ({ flowDigest: flow.digest, seq: 0, records: [], event: 'done', outcome: 'accept', parts: { Subject: 'o/r#7', Visit: 1 } });
const ctx = { repo: 'o/r', pr: 7, head: 'a'.repeat(40), netDiff: 'b'.repeat(64), executorCommit: 'c'.repeat(40), seq: 1, at: '2026-11-22T12:00:00Z', inputs: ['tag:example.org,2026-11-22:verdict/review/1'] };

// Reusable implementation contract: pass only the public FlowEngine slot and a test registrar.
export function flowEngineContract(api, register) {
  register('contract 1: whole validation, RFC 8785 digest and loaded digest pin', () => {
    const def = fixture(), flow = api.load(def);
    assert.equal(api.version, 'FlowEngine/v0');
    assert.equal(flow.digest, createHash('sha256').update(api.canonicalJSON(def)).digest('hex'));
    const reordered = Object.fromEntries(Object.entries(def).reverse());
    assert.equal(api.load(reordered).digest, flow.digest);
    def.states.accepted.kind = 'alien'; // input mutation cannot change loaded definition
    assert.equal(flow.definition.states.accepted.kind, 'final');
    assert.throws(() => api.load(def));
    assert.throws(() => api.plan({ ...flow }, projection(flow)), /loaded definition digest/);
    assert.throws(() => api.plan(flow, { ...projection(flow), flowDigest: 'wrong' }), /digest/);
  });
  register('contract 2: deterministic, pure planning on identical digest and projection@seq', () => {
    const flow = api.load(fixture()), p = projection(flow), before = api.canonicalJSON(p);
    const originalNow = Date.now;
    Date.now = () => { throw Error('clock read'); };
    try { assert.equal(api.canonicalJSON(api.plan(flow, p)), api.canonicalJSON(api.plan(flow, structuredClone(p)))); }
    finally { Date.now = originalNow; }
    assert.equal(api.canonicalJSON(p), before);
    // A final-state projection needs no event and has no next step.
    const record = api.transitionRecord(flow, api.plan(flow, p)[0], ctx);
    assert.deepEqual(api.plan(flow, { ...p, seq: 1, records: [record] }), []);
  });
  register('contract 3 / tier-1: declared key, all four outcomes/routes, unknown never advances; replayable Transition', () => {
    const flow = api.load(fixture()), p = projection(flow);
    assert.deepEqual(api.plan(flow, p), [{ key: 'review:o%2Fr%237:1', from: 'judge-convergence', event: 'done', guard: 'convergence', outcome: 'accept', route: 'advance', to: 'accepted', attempt: 1 }]);
    for (const t of flow.definition.states['judge-convergence'].on) {
      const step = api.plan(flow, { ...p, outcome: t.outcome })[0];
      assert.equal(step.route, t.route); assert.equal(step.to, t.target);
      if (t.outcome === 'unknown') assert.notEqual(step.route, 'advance');
    }
    const record = api.transitionRecord(flow, api.plan(flow, p)[0], ctx);
    assert.equal(record._type, 'https://in-toto.io/Statement/v1');
    assert.equal(record.predicateType, api.predicateType);
    assert.match(record.predicate.executor, /\/blob\/[c]{40}\/scripts\/lib\/flow-v0-interim\/plan.mjs$/);
    assert.deepEqual(record.subject.map(s => s.digest), [{ gitCommit: ctx.head }, { sha256: ctx.netDiff }]);
    assert.equal(record.subject[0].annotations['we.idempotencyKey'], 'tr:o/r#7:1');
    assert.throws(() => api.plan(flow, { ...p, seq: 1, records: [{ ...record, predicate: { ...record.predicate, to: 'parked' } }] }), /replay/);
    assert.throws(() => api.plan(flow, { ...p, seq: 2, records: [record] }), /Incomplete projection/);
    assert.deepEqual(api.plan(flow, { ...p, records: [record] }), api.plan(flow, p)); // seq cutoff
  });
  register('recorded retry permits the next attempt in the same visit through the declared attempt bound', () => {
    const def = fixture(); def.retry.maxAttempts = 3;
    const flow = api.load(def), p = { ...projection(flow), outcome: 'unknown' }, records = [];
    const first = api.plan(flow, p)[0];
    assert.equal(first.attempt, 1);
    records.push(api.transitionRecord(flow, first, ctx));
    const second = api.plan(flow, { ...p, seq: 1, records, attempt: 2 })[0];
    assert.equal(second.key, first.key); assert.equal(second.attempt, 2); assert.equal(second.route, 'retry');
    records.push(api.transitionRecord(flow, second, { ...ctx, seq: 2 }));
    assert.equal(records[1].predicate.attempt, 2);
    const third = api.plan(flow, { ...p, seq: 2, records, attempt: 3, outcome: 'accept' })[0];
    assert.equal(third.key, first.key); assert.equal(third.attempt, 3); assert.equal(third.to, 'accepted');
    const accepted = api.transitionRecord(flow, third, { ...ctx, seq: 3 });
    assert.deepEqual(api.plan(flow, { ...p, seq: 3, records: [...records, accepted] }), []);
    for (const outcome of ['unknown', 'accept']) {
      assert.throws(() => api.plan(flow, { ...p, seq: 2, records, attempt: 4, outcome }), /Retry exhausted: actor must escalate to parked/);
    }
    const retry = api.plan(flow, { ...p, seq: 2, records, attempt: 3 })[0];
    const exhausted = [...records, api.transitionRecord(flow, retry, { ...ctx, seq: 3 })];
    assert.throws(() => api.plan(flow, { ...p, seq: 3, records: exhausted, attempt: 4 }), /Retry exhausted/);
  });
  register('retry replay rejects reused key/attempt and malformed attempts; historical missing attempt means one', () => {
    const def = fixture(); def.retry.maxAttempts = 3;
    const flow = api.load(def), p = { ...projection(flow), outcome: 'unknown' };
    const first = api.transitionRecord(flow, api.plan(flow, p)[0], ctx);
    const historical = structuredClone(first); delete historical.predicate.attempt;
    const resumed = { ...p, seq: 1, records: [historical] };
    assert.equal(api.plan(flow, { ...resumed, attempt: 2 })[0].attempt, 2);
    assert.throws(() => api.plan(flow, resumed), /key\/attempt already recorded/);
    const duplicate = { ...first, predicate: { ...first.predicate, seq: 2 } };
    assert.throws(() => api.plan(flow, { ...p, seq: 2, records: [first, duplicate], attempt: 2 }), /key\/attempt has a second body/);
    for (const attempt of [0, -1, 1.5, null, '2', 4]) {
      const malformed = { ...first, predicate: { ...first.predicate, attempt } };
      assert.throws(() => api.plan(flow, { ...p, seq: 1, records: [malformed], attempt: 2 }), /Invalid replay attempt/);
    }
  });
  register('contract 4: gaps refused whole with core/plug feature loss report; out-of-subset kind refused', () => {
    const def = fixture();
    def.states['judge-convergence'].timeout = {};
    def.compensations = [];
    def.states['judge-convergence'].invoke = { where: 'subflow' };
    def.states.accepted = { kind: 'compound', states: {} };
    assert.throws(() => api.load(def), e => {
      assert.equal(e.lossReport.reportType, 'https://everstandards.dev/core/plug/loss-report/v0.1');
      assert.equal(e.lossReport.status, 'unsupported');
      assert.deepEqual([...new Set(e.lossReport.diagnostics.map(d => d.feature))].sort(), ['compensation', 'nested-states', 'sub-flows', 'timers']);
      assert(e.lossReport.diagnostics.every(d => d.disposition === 'lost' && d.required)); return true;
    });
    const other = fixture(); other.states['judge-convergence'].kind = 'parallel';
    assert.throws(() => api.load(other), /kind/);
  });
  register('contract 5: swap comparison requires canonical byte equality and opens a finding on difference', () => {
    const flow = api.load(fixture()), steps = api.plan(flow, projection(flow));
    const reordered = steps.map(s => Object.fromEntries(Object.entries(s).reverse()));
    assert.deepEqual(comparePlans(steps, reordered), { equal: true, blocksRetirement: false, finding: null });
    assert.deepEqual(comparePlans(steps, [{ ...steps[0], route: 'wait' }]), { equal: false, blocksRetirement: true, finding: 'FlowEngine/v0 plan disagreement' });
  });
}
flowEngineContract(engine, test);

test('lint: structural errors, unresolved target, missing/duplicate outcomes, unknown advance, unreachable/dead ends, retries and keys fail closed', () => {
  const cases = [
    d => { d.extra = true; }, d => { d.states['judge-convergence'].on[0].target = 'absent'; },
    d => { d.states['judge-convergence'].on.pop(); }, d => { d.states['judge-convergence'].on.push(d.states['judge-convergence'].on[0]); },
    d => { d.states['judge-convergence'].on[3].route = 'advance'; },
    d => { d.states.orphan = { kind: 'final' }; }, d => { d.states.accepted = { kind: 'judge', key: 'bad:{Subject}', on: [] }; },
    d => { delete d.retry; }, d => { d.retry.maxAttempts = 0; },
    d => { delete d.keys; }, d => { d.states['judge-convergence'].key = 'cycle:{Subject}'; },
    d => { d.states['judge-convergence'].key = 'key:{Missing}'; }, d => { d.guards.convergence.classifies = '${expression}'; },
    d => { delete d.states['judge-convergence'].on[0].route; },
  ];
  for (const change of cases) { const d = fixture(); change(d); assert.throws(() => engine.load(d), change.toString()); }
});

test('modern flow/definition v0.1 schema and eleven-rule lint; legacy confirm exclusion and silence', () => {
  const d = fixture(); d.flowType = 'https://everstandards.dev/flow/definition/v0.1';
  d.document = { namespace: 'example', name: 'review', version: '1.0.0' };
  d.guards.convergence = { outcomes: d.guards.convergence.outcomes, check: { uri: 'urn:check:convergence', digest: { sha256: 'a'.repeat(64) } } };
  d.states['judge-convergence'].invoke = { where: 'local' };
  d.retry = { limit: { attempt: { count: 1 } }, onExhausted: 'parked' };
  assert.equal(engine.load(d).definition.document.version, '1.0.0');
  delete d.guards.convergence.check; assert.throws(() => engine.load(d), /check/);
  const c = fixture(); c.states['judge-convergence'].kind = 'confirm';
  c.states['judge-convergence'].confirm = { role: 'decider', outcomes: ['approve', 'reject'], excludes: ['preparers'], bindsSubjectVersion: true, onSilence: 'stay-blocked' };
  assert.throws(() => engine.load(c), /confirm|decider|approval/);
  c.states['judge-convergence'].confirm.onSilence = 'approve'; assert.throws(() => engine.load(c), /confirm\/onSilence must be equal to constant/);
});

test('RFC 8785 vectors and invalid I-JSON are refused', () => {
  assert.equal(engine.canonicalJSON({ z: 1e30, a: [4.50, -0, '\u000f'] }), '{"a":[4.5,0,"\\u000f"],"z":1e+30}');
  for (const value of [NaN, undefined, '\ud800', { bad: Infinity }]) assert.throws(() => engine.canonicalJSON(value), /I-JSON/);
});

test('append-only helper preserves existing log and swallows write and serialization errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-log-'));
  try {
    const path = join(dir, 'records.jsonl');
    assert.equal(await engine.appendTransition(path, { n: 1 }), true);
    assert.equal(await engine.appendTransition(path, { n: 2 }), true);
    assert.equal(readFileSync(path, 'utf8'), '{"n":1}\n{"n":2}\n');
    assert.equal(await engine.appendTransition(dir, {}), false);
    assert.equal(await engine.appendTransition(path, { bad: 1n }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shadow appends beside actual outcome, logs disagreement, and closes oversized/unreadable inputs with operator fallback', async () => {
  const def = fixture(), flow = engine.load(def), rows = [], logs = [];
  const input = { definition: def, projection: projection(flow), ctx, logPath: 'records.jsonl' };
  const options = { file: 'fixture', stat: () => ({ size: 1 }), read: () => JSON.stringify(input),
    engine: { ...engine, appendTransition: async (_, row) => { rows.push(row); return true; } }, log: s => logs.push(s) };
  const actual = { repo: ctx.repo, pr: ctx.pr, classified: { verdict: 'accept', loopOutcome: 'converged', outcome: 'auto-cleared' } };
  await shadowReviewStep(actual, options);
  assert.equal(rows.length, 1); assert(logs.some(s => s.includes('"agreement":true')));
  await shadowReviewStep({ ...actual, classified: { outcome: 'parked' } }, options);
  assert(logs.some(s => s.includes('shadow disagreement')));
  const count = rows.length;
  await shadowReviewStep(actual, { ...options, stat: () => ({ size: 262145 }), read: () => { throw Error('must not read oversized'); } });
  assert.equal(rows.length, count); assert(logs.some(s => s.includes('operator must supply a bounded projection')));
  await shadowReviewStep(actual, { ...options, read: () => { throw Error('unreadable'); } });
  assert(logs.some(s => s.includes('unreadable')));
  await shadowReviewStep(actual, { ...options, engine: { load: () => { throw Error('boom'); } }, log: () => { throw Error('logger failure'); } });
  await shadowReviewStep(actual, { file: '', read: () => { throw Error('disabled must do no IO'); } });
});

test('negative: real daemon completion/merge routing is byte-equal with shadow disabled, mutating, throwing or rejecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-completion-'));
  const now = () => ctx.at;
  const classified = { outcome: 'auto-cleared', verdict: 'accept', loopOutcome: 'converged', runId: 'r1' };
  const args = { dir, session: 'review-7', pr: 7, repo: 'o/r', now, classified };
  try {
    const disabled = writeReviewJobDone({ ...args, flowShadow: () => {} });
    for (const flowShadow of [() => { throw Error('sync failure'); }, async () => { throw Error('async failure'); }, value => { value.classified.outcome = 'merge'; }]) {
      assert.deepEqual(writeReviewJobDone({ ...args, flowShadow }), disabled);
    }
    assert.equal(classified.outcome, 'auto-cleared');
    await new Promise(resolve => setImmediate(resolve));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
