import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as engine from '../flow-engine/index.mjs';
import { comparePlans, shadowReviewStep, resolveFlowShadow } from '../flow-engine/shadow.mjs';
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
      ] }, accepted: { kind: 'final', emits: 'https://everstandards.dev/governance/ruling-record/v0.1' }, parked: { kind: 'final' },
    } };
}
const projection = flow => ({ flowDigest: flow.digest, seq: 0, records: [], event: 'done', outcome: 'accept', parts: { Subject: 'o/r#7', Visit: 1 } });
const ctx = { repo: 'o/r', pr: 7, head: 'a'.repeat(40), netDiff: 'b'.repeat(64), executorCommit: 'c'.repeat(40), seq: 1, at: '2026-11-22T12:00:00Z', inputs: ['tag:example.org,2026-11-22:verdict/review/1'] };

// Reusable implementation contract: pass only the public FlowEngine slot and a test registrar.
export function flowEngineContract(api, register) {
  register('load refuses unknown flowType URIs without falling back to legacy validation', () => {
    for (const flowType of ['urn:unimplemented:flow:v99', 'https://everstandards.dev/flow/definition/v99', 'https://everstandards.dev/flow/decision-lifecycle/v99']) {
      const def = fixture(); def.flowType = flowType;
      assert.throws(() => api.load(def), /flowType/, flowType);
    }
    for (const flowType of ['https://everstandards.dev/flow/decision-lifecycle/v0', 'https://everstandards.dev/flow/decision-lifecycle/v0.1']) {
      const def = fixture(); def.flowType = flowType;
      assert.equal(api.load(def).definition.flowType, flowType);
    }
  });
  register('legacy load requires a governance ruling-record emitter (FLOW-DL-010)', () => {
    for (const flowType of ['https://everstandards.dev/flow/decision-lifecycle/v0', 'https://everstandards.dev/flow/decision-lifecycle/v0.1']) {
      const def = fixture(); def.flowType = flowType;
      delete def.states.accepted.emits;
      assert.throws(() => api.load(def), /FLOW-DL-010/);
      def.states.accepted.emits = 'urn:unrelated:record';
      assert.throws(() => api.load(def), /FLOW-DL-010/);
      for (const version of ['v0', 'v0.1']) {
        def.states.accepted.emits = `https://everstandards.dev/governance/ruling-record/${version}`;
        assert.doesNotThrow(() => api.load(def));
      }
    }
  });
  for (const route of ['wait', 'retry', 'escalate', 'fail']) {
    register(`replay keeps unknown/${route} at its source even when the target is success`, () => {
      const def = fixture(); def.retry.maxAttempts = 3;
      Object.assign(def.states['judge-convergence'].on[3], { route, target: 'accepted' });
      const flow = api.load(def), p = projection(flow);
      const held = api.transitionRecord(flow, api.plan(flow, { ...p, outcome: 'unknown' })[0], ctx);
      const resumed = { ...p, seq: 1, records: [held], attempt: 2 };
      const next = api.plan(flow, resumed);
      assert.equal(next.length, 1, 'non-advance must not complete the flow');
      assert.equal(next[0].from, 'judge-convergence');
      assert.equal(next[0].route, 'advance');
      assert.equal(next[0].to, 'accepted');
      const accepted = api.transitionRecord(flow, next[0], { ...ctx, seq: 2 });
      assert.deepEqual(api.plan(flow, { ...resumed, seq: 2, records: [held, accepted] }), []);
    });
  }
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
    const duplicate = api.transitionRecord(flow, first.predicate, { ...ctx, seq: 2 });
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

test('retry cannot reset its visit, skip attempts or accept after maxAttempts one', () => {
  for (const maxAttempts of [1, 3]) {
    const d = fixture(); d.retry.maxAttempts = maxAttempts;
    const flow = engine.load(d), p = projection(flow);
    const retry = engine.transitionRecord(flow, engine.plan(flow, { ...p, outcome: 'unknown' })[0], ctx);
    const resumed = { ...p, seq: 1, records: [retry] };
    for (const outcome of ['accept', 'unknown']) {
      assert.throws(() => engine.plan(flow, { ...resumed, outcome, parts: { ...p.parts, Visit: 2 } }), /Retry exhausted|Retry continuity/);
      assert.throws(() => engine.plan(flow, { ...resumed, outcome, attempt: 3 }), /Retry exhausted|Retry continuity/);
      assert.throws(() => engine.plan(flow, { ...resumed, outcome, attempt: 2, parts: { ...p.parts, Visit: 2 } }), /Retry exhausted|Retry continuity/);
    }
    if (maxAttempts === 1) assert.throws(() => engine.plan(flow, resumed), /Retry exhausted/);
  }
});

test('replay enforces retry identity and attempt continuity even on success', () => {
  const d = fixture(); d.retry.maxAttempts = 3;
  const flow = engine.load(d), p = projection(flow);
  const first = engine.transitionRecord(flow, engine.plan(flow, { ...p, outcome: 'unknown' })[0], ctx);
  const next = engine.plan(flow, { ...p, seq: 1, records: [first], attempt: 2 })[0];
  for (const change of [{ key: 'review:o%2Fr%237:2', attempt: 1 }, { attempt: 3 }]) {
    const second = engine.transitionRecord(flow, { ...next, ...change }, { ...ctx, seq: 2 });
    assert.throws(() => engine.plan(flow, { ...p, seq: 2, records: [first, second] }), /Retry continuity/);
  }
  const one = engine.load(fixture()), q = projection(one);
  const retry = engine.transitionRecord(one, engine.plan(one, { ...q, outcome: 'unknown' })[0], ctx);
  const success = engine.transitionRecord(one, engine.plan(one, q)[0], { ...ctx, seq: 2 });
  assert.throws(() => engine.plan(one, { ...q, seq: 2, records: [retry, success] }), /second body|Retry exhausted/);
});

test('replay keys must match declared template, encoding, repeated parts and subject', () => {
  const d = fixture(); d.states['judge-convergence'].key += ':{Visit}';
  const flow = engine.load(d), p = projection(flow), step = engine.plan(flow, p)[0];
  for (const key of ['', 'anything', 'other:o%2Fr%237:1:1', 'review:o%2Fr%238:1:1', 'review:o%2fr%237:1:1', 'review:o%2Fr%237:1:2', 'review:%zz:1:1']) {
    const record = engine.transitionRecord(flow, { ...step, key }, ctx);
    assert.throws(() => engine.plan(flow, { ...p, seq: 1, records: [record] }), /replay key/, key);
  }
});

test('replay refuses stripped or malformed statement, subject, versions and evidence', () => {
  const flow = engine.load(fixture()), p = projection(flow);
  const original = engine.transitionRecord(flow, engine.plan(flow, p)[0], ctx);
  const mutations = [
    r => r.predicate, r => { delete r._type; return r; }, r => { r.predicateType = 'urn:other'; return r; },
    r => { r.subject = []; return r; }, r => { r.subject[0].name = 'o/r#8'; return r; },
    r => { r.subject[0].digest.gitCommit = 'bad'; return r; }, r => { r.subject[1].digest.sha256 = 'bad'; return r; },
    r => { r.subject[0].uri = 'https://github.com/o/r/pull/8'; return r; },
    r => { delete r.subject[0].annotations; return r; },
    r => { delete r.predicate.inputs; return r; }, r => { r.predicate.inputs = []; return r; },
    r => { r.predicate.inputs = ['not a reference']; return r; }, r => { r.predicate.inputs = [null]; return r; },
    r => { r.predicate.executor = 'urn:unversioned'; return r; },
  ];
  for (const change of mutations) assert.throws(() => engine.plan(flow, { ...p, seq: 1, records: [change(structuredClone(original))] }), /replay|projection/i, change.toString());
  for (const change of [{ head: 'd'.repeat(40) }, { netDiff: 'e'.repeat(64) }, { repo: 'other/repo', pr: 7 }]) {
    assert.throws(() => engine.plan(flow, { ...p, ...change, seq: 1, records: [original] }), /subject\/version/);
  }
  const continued = engine.transitionRecord(flow, engine.plan(flow, { ...p, outcome: 'continue' })[0], ctx);
  const final = engine.transitionRecord(flow, engine.plan(flow, { ...p, parts: { ...p.parts, Visit: 2 } })[0], { ...ctx, head: 'd'.repeat(40), seq: 2 });
  assert.throws(() => engine.plan(flow, { ...p, seq: 2, records: [continued, final] }), /subject\/version continuity/);
});

function approvalFixture() {
  const d = fixture(), s = d.states['judge-convergence'];
  s.kind = 'confirm'; s.confirm = { role: 'decider', outcomes: ['ratify', 'reject'], excludes: ['author', 'preparers'], bindsSubjectVersion: true, onSilence: 'stay-blocked' };
  d.guards = { 'approval-valid': { classifies: 'approval proof', outcomes: ['pass', 'fail', 'unknown'] } };
  s.on = ['ratify', 'reject'].flatMap(event => ['pass', 'fail', 'unknown'].map(outcome => ({ event: `confirm.${event}`, guard: 'approval-valid', outcome,
    route: outcome === 'pass' ? 'advance' : 'retry', target: outcome === 'pass' ? (event === 'ratify' ? 'accepted' : 'parked') : 'judge-convergence' })));
  return d;
}

test('approval replay requires exact subjectVersion and nonempty evidence references', () => {
  const flow = engine.load(approvalFixture()), p = { ...projection(flow), event: 'confirm.ratify', outcome: 'pass' };
  const step = engine.plan(flow, p)[0];
  const record = engine.transitionRecord(flow, step, ctx);
  assert.deepEqual(engine.plan(flow, { ...p, seq: 1, records: [record] }), []);
  for (const change of [r => { delete r.predicate.subjectVersion; }, r => { r.predicate.subjectVersion = 'd'.repeat(40); }, r => { r.predicate.inputs = []; }]) {
    const invalid = structuredClone(record); change(invalid);
    assert.throws(() => engine.plan(flow, { ...p, seq: 1, records: [invalid] }), /replay/);
  }
});

test('unmodified confirmation plan-to-record-to-replay round trip covers pass, fail and unknown retries', () => {
  const def = approvalFixture(); def.retry.maxAttempts = 3;
  const flow = engine.load(def);
  for (const event of ['confirm.ratify', 'confirm.reject']) {
    for (const outcome of ['pass', 'fail', 'unknown']) {
      const p = { ...projection(flow), event, outcome };
      const record = engine.transitionRecord(flow, engine.plan(flow, p)[0], ctx);
      assert.equal(record.predicate.subjectVersion, ctx.head);
      const resumed = { ...p, seq: 1, records: [record], attempt: 2, outcome: 'pass' };
      const next = engine.plan(flow, resumed);
      if (outcome === 'pass') {
        assert.deepEqual(next, []);
      } else {
        assert.equal(record.predicate.route, 'retry');
        assert.equal(next[0].attempt, 2);
        assert.equal(next[0].key, record.predicate.key);
        const completed = engine.transitionRecord(flow, next[0], { ...ctx, seq: 2 });
        assert.equal(completed.predicate.subjectVersion, ctx.head);
        assert.deepEqual(engine.plan(flow, { ...resumed, seq: 2, records: [record, completed] }), []);
      }
    }
  }
});

test('confirmation producer binds subjectVersion from trusted context over a supplied step value', () => {
  const flow = engine.load(approvalFixture()), p = { ...projection(flow), event: 'confirm.ratify', outcome: 'pass' };
  const record = engine.transitionRecord(flow, { ...engine.plan(flow, p)[0], subjectVersion: 'd'.repeat(40) }, ctx);
  assert.equal(record.predicate.subjectVersion, ctx.head);
  assert.deepEqual(engine.plan(flow, { ...p, seq: 1, records: [record] }), []);
});

test('transitionRecord step cannot overwrite trusted flow digest sequence or context evidence', () => {
  const flow = engine.load(fixture()), p = projection(flow);
  const record = engine.transitionRecord(flow, { ...engine.plan(flow, p)[0], flow: 'forged', flowDigest: { sha256: '0'.repeat(64) }, seq: 999, inputs: [], at: 'bad', executor: 'urn:forged' }, ctx);
  assert.equal(record.predicate.flow, flow.definition.id); assert.deepEqual(record.predicate.flowDigest, { sha256: flow.digest });
  assert.equal(record.predicate.seq, 1); assert.deepEqual(record.predicate.inputs, ctx.inputs); assert.equal(record.predicate.at, ctx.at);
  assert.deepEqual(engine.plan(flow, { ...p, seq: 1, records: [record] }), []);
});

test('key declarations refuse inherited constructor and toString properties', () => {
  for (const name of ['constructor', 'toString']) {
    const d = fixture(); d.states['judge-convergence'].key += `:{${name}}`;
    assert.throws(() => engine.load(d), /not declared in keys.parts/);
  }
});

test('approval fail cannot advance and observer role cannot bypass approval-valid', () => {
  for (const role of ['decider', 'observer']) {
    const d = approvalFixture(); d.states['judge-convergence'].confirm.role = role;
    assert.doesNotThrow(() => engine.load(d));
    const fail = structuredClone(d); fail.states['judge-convergence'].on[1] = { ...fail.states['judge-convergence'].on[1], route: 'advance', target: 'accepted' };
    assert.throws(() => engine.load(fail), /approval-valid/);
    const bypass = structuredClone(d); bypass.guards.other = bypass.guards['approval-valid'];
    for (const t of bypass.states['judge-convergence'].on) t.guard = 'other';
    assert.throws(() => engine.load(bypass), /approval-valid/);
  }
});

function shadowFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'flow-shadow-')), logs = [];
  const actual = { repo: 'o/r', pr: 7, session: 'review-7', completionsDir: dir,
    classified: { head: ctx.head, netDiff: ctx.netDiff, round: 1, runId: 'run-1', outcome: 'bounced', loopOutcome: 'complete' } };
  const options = { env: { WE_PLATFORM_PREFERENCES_FILE: join(dir, 'absent') }, tool: {}, file: join(dir, 'shadow.jsonl'), executorCommit: () => ctx.executorCommit, now: () => ctx.at, log: s => logs.push(s) };
  const done = (round = 1, outcome = 'bounced', loopOutcome = 'complete') => {
    Object.assign(actual.classified, { round, runId: `run-${round}`, outcome, loopOutcome });
    return writeReviewJobDone({ dir, session: actual.session, repo: actual.repo, pr: actual.pr, classified: actual.classified, now: () => ctx.at, flowShadow: () => {} });
  };
  done();
  const logFile = join(dir, 'shadow-6f2f72-7.jsonl');
  return { dir, logFile, actual, options, logs, done, cleanup: () => rmSync(dir, { recursive: true, force: true }), rows: () => readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('shadow settings default, platform, tool, environment override and disabled provenance', async () => {
  const f = shadowFixture();
  try {
    const env = { ...f.options.env, WE_COORDINATION_ROOT: f.dir };
    assert.equal(resolveFlowShadow(env, { tool: {} }).file, join(f.dir, 'flow-v0-shadow.jsonl'));
    assert.equal(resolveFlowShadow(env, { tool: {} }).enabled, true);
    const platform = join(f.dir, 'platform.json');
    writeFileSync(platform, JSON.stringify({ 'reviewLoop.flowShadow': { enabled: false, file: 'platform.jsonl' } }));
    env.WE_PLATFORM_PREFERENCES_FILE = platform;
    let r = resolveFlowShadow(env, { tool: {} });
    assert.equal(r.enabled, false); assert.equal(r.sources.enabled, 'platform');
    r = resolveFlowShadow(env, { tool: { enabled: true, file: 'tool.jsonl' } });
    assert.equal(r.file, 'tool.jsonl'); assert.equal(r.sources.file, 'tool');
    r = resolveFlowShadow({ ...env, WE_FLOW_V0_SHADOW_FILE: 'env.jsonl' }, { tool: { enabled: false } });
    assert.equal(r.file, 'env.jsonl'); assert.equal(r.sources.file, 'env'); assert.equal(r.enabled, false);
    await shadowReviewStep(f.actual, { ...f.options, tool: { enabled: false }, stat: () => { throw Error('disabled performed IO'); } });
    assert(!f.logs.some(s => s.includes('failed'))); assert(f.logs.some(s => s.includes('"enabled":false')));
  } finally { f.cleanup(); }
});

test('shadow derives synthetic completion evidence and appends three contiguous PR rounds with agreement', async () => {
  const f = shadowFixture();
  try {
    for (const round of [1, 2, 3]) {
      f.done(round, round === 3 ? 'auto-cleared' : 'bounced', round === 3 ? 'converged' : 'complete');
      await shadowReviewStep(f.actual, f.options);
    }
    const rows = f.rows();
    assert.deepEqual(rows.map(r => r.predicate.seq), [1, 2, 3]);
    assert.deepEqual(rows.map(r => r.predicate.round), [1, 2, 3]);
    assert(rows.every(r => r.predicate.inputs[0].endsWith('/review-7.json')));
    assert.equal(rows[2].predicate.to, 'accepted');
    assert.equal(f.logs.filter(s => s.includes('"agreement":true')).length, 3);
    await shadowReviewStep(f.actual, f.options);
    assert.equal(f.rows().length, 3); assert(f.logs.some(s => s.includes('already observed')));
  } finally { f.cleanup(); }
});

test('shadow compares route and target, and reports unknown and empty-plan disagreement', async () => {
  for (const change of [{ route: 'wait' }, { to: 'parked' }, null]) {
    const f = shadowFixture();
    try {
      await shadowReviewStep(f.actual, { ...f.options, engine: { ...engine, plan: (flow, p) => change ? [{ ...engine.plan(flow, p)[0], ...change }] : [] } });
      assert(f.logs.some(s => s.includes('"agreement":false'))); assert(f.logs.some(s => s.includes('shadow disagreement')));
    } finally { f.cleanup(); }
  }
  const f = shadowFixture();
  try {
    f.done(1, 'new-word', null); await shadowReviewStep(f.actual, f.options);
    assert(f.logs.some(s => s.includes('"agreement":false')));
  } finally { f.cleanup(); }
});

test('shadow refuses missing required evidence without inventing hashes', async () => {
  for (const missing of ['head', 'netDiff', 'repo', 'session']) {
    const f = shadowFixture();
    try {
      if (missing in f.actual.classified) delete f.actual.classified[missing]; else delete f.actual[missing];
      await shadowReviewStep(f.actual, f.options);
      assert(f.logs.some(s => s.includes('required'))); assert.throws(f.rows);
    } finally { f.cleanup(); }
  }
});

test('shadow refuses regular-file violations and completion aliases without changing completion bytes', async () => {
  for (const kind of ['directory', 'symlink', 'hardlink', 'same']) {
    const f = shadowFixture();
    try {
      const completion = join(f.dir, 'review-7.json'), before = readFileSync(completion, 'utf8');
      if (kind === 'directory') f.options.file = f.dir;
      if (kind === 'symlink') symlinkSync(completion, f.logFile);
      if (kind === 'hardlink') linkSync(completion, f.logFile);
      if (kind === 'same') f.options.file = completion;
      await shadowReviewStep(f.actual, f.options);
      assert.equal(readFileSync(completion, 'utf8'), before);
      assert(f.logs.some(s => s.includes('not a regular file') || s.includes('aliases')));
    } finally { f.cleanup(); }
  }
});

test('shadow bounded log reads close fd, refuse oversized input and name operator fallback', async () => {
  const f = shadowFixture(); let total = 0, closed = false;
  try {
    writeFileSync(f.logFile, '');
    await shadowReviewStep(f.actual, { ...f.options, open: () => 42, close: () => { closed = true; }, read: (_, buffer, offset, length) => {
      const n = Math.min(length, 10000); buffer.fill(32, offset, offset + n); total += n; return n;
    } });
    assert.equal(total, 262145); assert(closed); assert(f.logs.some(s => s.includes('operator must archive')));
  } finally { f.cleanup(); }
});

test('shadow refuses duplicate sequence and concurrent observations', async () => {
  const f = shadowFixture();
  try {
    await Promise.all([shadowReviewStep(f.actual, f.options), shadowReviewStep(f.actual, f.options)]);
    assert.equal(f.rows().length, 1);
    const bytes = readFileSync(f.logFile, 'utf8'); writeFileSync(f.logFile, bytes + bytes);
    f.done(2); await shadowReviewStep(f.actual, f.options);
    assert.equal(readFileSync(f.logFile, 'utf8'), bytes + bytes);
    assert(f.logs.some(s => s.includes('duplicate or noncontiguous')));
  } finally { f.cleanup(); }
});

test('shadow IO, append, engine and logger failures never throw into the tick', async () => {
  const f = shadowFixture();
  try {
    for (const options of [ { executorCommit: () => { throw Error('unreadable HEAD'); } },
      { engine: { ...engine, appendTransition: async () => false } },
      { engine: { ...engine, appendTransition: async () => { throw Error('append rejected'); } } },
      { engine: { load: () => { throw Error('boom'); } }, log: () => { throw Error('logger failure'); } } ]) {
      await shadowReviewStep(f.actual, { ...f.options, ...options });
    }
    assert(f.logs.some(s => s.includes('unreadable HEAD'))); assert(f.logs.some(s => s.includes('append failed; operator'))); assert(f.logs.some(s => s.includes('append rejected')));
  } finally { f.cleanup(); }
});

test('negative: actual completion bytes and return value are identical with real shadow on versus off', async () => {
  const f = shadowFixture();
  try {
    const args = { dir: f.dir, session: 'review-7', pr: 7, repo: 'o/r', classified: f.actual.classified, now: () => ctx.at };
    const off = writeReviewJobDone({ ...args, flowShadow: () => {} });
    const bytes = readFileSync(join(f.dir, 'review-7.json'), 'utf8'); let observation;
    const on = writeReviewJobDone({ ...args, flowShadow: input => { observation = shadowReviewStep(input, f.options); } });
    await observation;
    assert.equal(f.rows().length, 1); assert.equal(JSON.stringify(on), JSON.stringify(off)); assert.equal(readFileSync(join(f.dir, 'review-7.json'), 'utf8'), bytes);
  } finally { f.cleanup(); }
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
