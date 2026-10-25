import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createJobStore } from '../daemon-jobs-runtime.mjs';
import { defineJobKind } from '../daemon-jobs.mjs';
import { isValidRunId } from '../../operations/run-record.mjs';
import { withFileLock } from '../atomic-json-file.mjs';
import { enqueueItemTask, taskIdentity, taskTupleLockId, createRecordingFacts, validateTaskPlan, runItemTask } from '../daemon-item-tasks.mjs';

let dir, store;
const kindDef = defineJobKind({ kind: 'fix', entry: 'job.mjs' });
const identity = (seq = 1, repo = 'owner/repo') => ({ kind: 'fix', repo, item: 12, seq });
const options = (seq = 1, repo) => ({ store, kindDef, ...identity(seq, repo), codeSha: 'abc', acting: true, resourceKind: 'build', policyOptions: { platform: null, env: {} } });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'item-tasks-')); store = createJobStore(dir); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('readonly-tree enqueue requires a codeSha to pin its snapshot', () => {
  for (const codeSha of [undefined, null, '']) {
    expect(() => enqueueItemTask({ ...options(), codeSha })).toThrow(/codeSha.*pin its snapshot/);
    expect(store.list().records).toHaveLength(0);
  }
  expect(enqueueItemTask(options()).job.task.seq).toBe(1);
});

it('enqueue refuses an identity kind that mismatches kindDef.kind', () => {
  expect(() => enqueueItemTask({ ...options(), kind: 'review' })).toThrow(/kind must match kindDef/);
  expect(store.list().records).toHaveLength(0);
});

it.each([undefined, null, '', 'invented', 'a'.repeat(1000)])('enqueue refuses undeclared resourceKind %s before persisting', resourceKind => {
  expect(() => enqueueItemTask({ ...options(), resourceKind })).toThrow(/resourceKind must be declared in RESOURCE_POLICY_KINDS.*correct resourceKind before rescheduling/);
  expect(store.list().records).toHaveLength(0);
  expect(enqueueItemTask(options()).job.task.resourceKind).toBe('build');
});

it('tuple exclusion is per kind: the same repo and item admit different kinds', () => {
  const first = enqueueItemTask(options());
  const review = { ...options(), kind: 'review', kindDef: defineJobKind({ kind: 'review', entry: 'job.mjs' }) };
  const second = enqueueItemTask(review);
  expect(second.job.task).toMatchObject({ repo: first.job.task.repo, item: first.job.task.item, kind: 'review' });
  expect(second.id).not.toBe(first.id);
  expect(store.list().records).toHaveLength(2);
  expect(() => enqueueItemTask({ ...review, seq: 2 })).toThrow(/active tuple/);
  expect(() => enqueueItemTask(options(2))).toThrow(/active tuple/);
});

it('tuple exclusion spans sequences and fails closed on corrupt records', async () => {
  for (const state of ['queued', 'backoff', 'launching', 'running']) {
    const first = enqueueItemTask(options());
    expect(isValidRunId(first.id)).toBe(true);
    expect(first.job.task.id).toBe('fix:owner/repo:12:1');
    store.update(first.id, r => ({ ...r, job: { ...r.job, status: state === 'backoff' ? 'queued' : state,
      handle: state === 'running' ? 'host:123:start' : null,
      nextAttemptAt: state === 'backoff' ? '2099-01-01T00:00:00Z' : null } }));
    expect(() => enqueueItemTask(options(2))).toThrow(/active tuple/);
    store.update(first.id, r => ({ ...r, job: { ...r.job, status: 'succeeded' } }));
    const next = enqueueItemTask(options(2));
    expect(next.id).not.toBe(first.id);
    rmSync(dir, { recursive: true });
  }
  enqueueItemTask(options());
  expect(enqueueItemTask(options(1, 'other/repo')).job.task.repo).toBe('other/repo');
  for (const bad of [{ repo: '../escape' }, { seq: 0 }, { item: 1.2 }, { kind: 'bad:kind' }, { repo: 'a'.repeat(1000) }]) {
    expect(() => taskIdentity({ ...identity(), ...bad })).toThrow(/identity/);
  }
  writeFileSync(join(dir, 'broken.json'), '{');
  expect(() => enqueueItemTask(options(3, 'third/repo'))).toThrow(/corrupt.*broken.*repair/);
  expect(store.list().records).toHaveLength(2);
  rmSync(join(dir, 'broken.json'));
  withFileLock(join(dir, `${taskTupleLockId(identity(1, 'third/repo'))}.lock`), () => {
    expect(() => enqueueItemTask({ ...options(3, 'third/repo'), lockOptions: { timeoutMs: 0 } })).toThrow(/timed out.*repair/);
    expect(store.list().records).toHaveLength(2);
  });
  // Independent processes exercise the actual tuple-lock/read/create boundary.
  const script = `import { createJobStore } from './scripts/lib/daemon-jobs-runtime.mjs';
    import { enqueueItemTask } from './scripts/lib/daemon-item-tasks.mjs';
    const o = JSON.parse(process.argv[1]); o.store = createJobStore(o.dir);
    try { enqueueItemTask(o); process.stdout.write('created'); }
    catch(e) { if (!e.message.includes('active tuple')) throw e; process.stdout.write('held'); }`;
  const run = seq => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ ...options(seq, 'race/repo'), store: undefined, dir })]);
    let out = '', err = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err)));
  });
  expect((await Promise.all([run(1), run(2)])).sort()).toEqual(['created', 'held']);
  const existing = store.list().records[0];
  writeFileSync(join(dir, `${existing.id}.json`), JSON.stringify({ ...existing, job: { ...existing.job, task: { ...existing.job.task, seq: 0 } } }));
  expect(() => enqueueItemTask(options(5, 'last/repo'))).toThrow(/corrupt.*repair/);
  expect(store.list().records.some(r => r.job.task.repo === 'last/repo')).toBe(false);
});

const snapshot = () => ({ identity: { repo: 'owner/repo', item: 12 }, observedAt: 1000, source: 'live-pr', complete: true,
  data: { pull: { head: { sha: 'abc' } }, open: true } });
const factsFor = (value = snapshot()) => createRecordingFacts({ load: () => value, expectedIdentity: { repo: 'owner/repo', item: 12 }, now: 1100, snapshotMaxAgeMs: 200 });
const effect = () => ({ name: 'dispatch', inputs: ['pull.head.sha'], fences: ['pull.head.sha'], appliedProbe: 'worker-run', precondition: 'none' });

it.each(['__proto__', 'constructor', 'prototype'])('freezeData rejects the prototype-pollution key %s in snapshots and plans', key => {
  const unsafe = JSON.parse(`{"${key}":{"polluted":true}}`);
  const facts = factsFor({ ...snapshot(), data: { nested: unsafe } });
  expect(facts.outcome).toBe('deferred-read');
  expect(() => validateTaskPlan({ facts, effects: [] })).toThrow(/deferred-read/);
  const valid = factsFor();
  valid.read('pull.head.sha');
  expect(() => validateTaskPlan({ facts: valid, effects: [{ ...effect(), precondition: unsafe }] })).toThrow(/plan must be serializable: unsafe data key/);
});

it.each(['__proto__', 'constructor', 'prototype'])('fieldPath rejects the prototype-pollution segment %s in reads, inputs and fences', key => {
  for (const path of [key, `pull.${key}.sha`]) {
    const facts = factsFor();
    expect(facts.outcome).toBe('ready');
    expect(() => facts.read(path)).toThrow(/deferred-read/);
    expect(facts.outcome).toBe('deferred-read');
    expect(() => validateTaskPlan({ facts, effects: [] })).toThrow(/deferred-read/);
    for (const field of ['inputs', 'fences']) {
      const valid = factsFor();
      valid.read('pull.head.sha');
      expect(() => validateTaskPlan({ facts: valid, effects: [{ ...effect(), [field]: [path] }] })).toThrow(/declared inputs and fences required/);
    }
  }
});

it('planning records nested reads and rejects incomplete effect declarations', () => {
  const facts = factsFor();
  expect(facts.read('pull.head.sha')).toBe('abc');
  expect(facts.recordedReads).toEqual([{ path: 'pull.head.sha', source: 'live-pr', observedAt: 1000, age: 100 }]);
  const plan = validateTaskPlan({ facts, effects: [effect()] });
  expect(Object.isFrozen(plan.effects[0].inputs)).toBe(true);
  for (const change of [{ name: '' }, { name: undefined }, { appliedProbe: undefined }, { precondition: undefined }, { inputs: ['open'] }, { fences: [] },
    { precondition: {} }, { precondition: { check: () => true } }, { name: 'a'.repeat(65) }]) {
    expect(() => validateTaskPlan({ facts, effects: [{ ...effect(), ...change }] })).toThrow(/plan/);
  }
  expect(() => validateTaskPlan({ facts, effects: [effect(), effect()] })).toThrow(/unique/);
  facts.read('open');
  expect(() => validateTaskPlan({ facts, effects: [effect()] })).toThrow(/unfenced/);
  const objectFacts = factsFor();
  expect(Object.isFrozen(objectFacts.read('pull').head)).toBe(true);
  const discovery = factsFor({ ...snapshot(), source: 'discovery' });
  discovery.read('pull.head.sha');
  expect(() => validateTaskPlan({ facts: discovery, effects: [effect()] })).toThrow(/live-pr/);
  expect(() => validateTaskPlan({ facts: { outcome: 'ready', recordedReads: [] }, effects: [effect()] })).toThrow(/deferred-read/);
});

it('unreadable facts defer and incomplete comments cannot authorize effects', async () => {
  for (const change of [null, { ...snapshot(), observedAt: 1 }, { ...snapshot(), observedAt: 1200 },
    { ...snapshot(), identity: { repo: 'other/repo', item: 12 } }, { ...snapshot(), complete: false },
    { ...snapshot(), data: undefined }]) {
    const facts = factsFor(change);
    expect(facts.outcome).toBe('deferred-read');
    expect(() => validateTaskPlan({ facts, effects: [effect()] })).toThrow(/deferred-read/);
  }
  const throwing = createRecordingFacts({ load: () => { throw new Error('torn JSON'); }, expectedIdentity: {}, now: 1100, snapshotMaxAgeMs: 200 });
  expect(throwing.outcome).toBe('deferred-read');
  const missing = factsFor();
  expect(() => missing.read('pull.missing')).toThrow(/deferred-read/);
  expect(missing.outcome).toBe('deferred-read');
  expect(() => validateTaskPlan({ facts: missing, effects: [effect()] })).toThrow(/deferred-read/);
  const path = join(dir, 'input.json');
  writeFileSync(path, '{"identity":');
  const torn = createRecordingFacts({ load: () => JSON.parse(readFileSync(path, 'utf8')),
    expectedIdentity: snapshot().identity, now: 1100, snapshotMaxAgeMs: 200 });
  expect(torn.outcome).toBe('deferred-read');
  expect(() => torn.read('open')).toThrow(/deferred-read/);
  for (const value of [null, { ...snapshot(), complete: false }, { ...snapshot(), source: 'cached-thread' }]) {
    const h = taskHarness(); h.args.read = () => factsFor(value);
    expect((await runItemTask(h.args)).outcome).toBe('deferred-read');
    expect(h.calls).not.toContain('act');
  }
  const cached = taskHarness();
  cached.args.read = () => factsFor({ ...snapshot(), data: { comments: [] } });
  cached.args.plan = f => { f.read('comments'); return []; };
  expect((await runItemTask(cached.args)).outcome).toBe('deferred-read');
  expect(cached.calls).toEqual([]);
  for (const thread of [undefined, { source: 'cached-thread', complete: true }, { source: 'live-thread', complete: false }]) {
    const h = taskHarness([{ ...effect(), name: 'comment', appliedProbe: 'live-marker' }]);
    h.args.effects.probe = () => ({ applied: false, thread });
    expect((await runItemTask(h.args)).outcome).toBe('failed'); expect(h.calls).not.toContain('act');
  }
});

it('task enqueue persists policy provenance and refuses invalid cascade layers', () => {
  const first = enqueueItemTask(options());
  expect(first.job.task.timeoutMs).toBe(300000);
  expect(first.job.task.sources.timeoutMs).toBe('standard');
  for (const layer of ['standard', 'platform', 'tool', 'envValues']) {
    expect(() => enqueueItemTask({ ...options(2, 'policy/repo'), policyOptions: { platform: null, env: {}, [layer]: { timeoutMs: -1 } } })).toThrow(/policy refused/);
    for (const value of [500, [500]]) {
      expect(() => enqueueItemTask({ ...options(2, 'policy/repo'), policyOptions: { platform: null, env: {}, [layer]: value } })).toThrow(/policy refused/);
    }
  }
  expect(store.list().records).toHaveLength(1);
  expect(() => enqueueItemTask({ ...options(2, 'policy/repo'), policyOptions: {
    platform: null, env: {}, standard: { timeoutMs: 300000, snapshotMaxAgeMs: -1 },
  } })).toThrow(/policy refused/);
  const next = enqueueItemTask({ ...options(2, 'policy/repo'), policyOptions: { platform: null, env: {}, tool: { timeoutMs: 500 } } });
  expect(next.job.task.sources.timeoutMs).toBe('tool');
  expect(next.job.task.timeoutMs).toBe(500);
});


const executionEffect = () => ({ ...effect(), appliedProbe: 'live-head' });

// A guarded in-memory record port models the child/store CAS without filesystem or GitHub IO.
function taskHarness(effects = [executionEffect()]) {
  let record = { job: { status: 'running', handle: 'host:1:start', attempts: 3,
    task: { ...taskIdentity(identity()), failureCount: 0 } } };
  const calls = [], logs = [], runs = new Map();
  const h = { calls, logs, runs, get record() { return record; },
    mutate: fn => { record = fn(record); } };
  h.args = {
    task: taskIdentity(identity()), attempt: 3, handle: 'host:1:start',
    record: { read: () => structuredClone(record), update: fn => { record = fn(structuredClone(record)); return record; } },
    read: () => factsFor(), plan: facts => { facts.read('pull.head.sha'); return effects; },
    claim: { acquire: async () => 'claim-token', assert: async () => true, release: async () => calls.push('release') },
    effects: {
      probe: async ({ gh }) => gh.read(() => { calls.push('probe'); return { applied: false }; }),
      fence: async ({ gh }) => gh.read(() => { calls.push('fence'); return factsFor(); }),
      act: async ({ effectId, gh, precondition }) => gh.write(() => {
        calls.push('act');
        expect(record.job.task.execution.effects[effectId]).toMatchObject({ status: 'intent', precondition });
        return { receipt: effectId };
      }),
    },
    runStore: { find: async id => { calls.push('run-store'); return runs.get(id) ?? null; } },
    budgets: { read: 100, write: 100 }, now: (() => { let n = 0; return () => ++n; })(),
    timing: entry => logs.push(entry),
  };
  return h;
}

it('task outcomes preserve launch identity and charge only failed attempts', async () => {
  for (const outcome of ['acted', 'nothing-owed', 'superseded', 'deferred-claim-held', 'deferred-read', 'failed']) {
    const h = taskHarness();
    if (outcome === 'nothing-owed') h.args.plan = () => [];
    if (outcome === 'superseded') h.args.claim.assert = () => false;
    if (outcome === 'deferred-claim-held') h.args.claim.acquire = () => null;
    if (outcome === 'deferred-read') h.args.read = () => factsFor(null);
    if (outcome === 'failed') h.args.effects.probe = () => { throw Error('probe unavailable'); };
    expect((await runItemTask(h.args)).outcome).toBe(outcome);
    expect((await runItemTask(h.args)).outcome).toBe(outcome);
    expect(h.record.job.attempts).toBe(3);
    expect(h.record.job.task.failureCount).toBe(outcome === 'failed' ? 1 : 0);
    expect(h.logs).toHaveLength(1);
    if (outcome === 'deferred-claim-held') expect(h.calls).toEqual([]);
  }
  const h = taskHarness();
  h.mutate(r => ({ ...r, job: { ...r.job, attempts: 4 } }));
  expect((await runItemTask(h.args)).outcome).toBe('superseded');
  expect(h.calls).toEqual([]);
  for (const change of [{ handle: 'another:2:start' }, { status: 'succeeded' }]) {
    const stale = taskHarness(); stale.mutate(r => ({ ...r, job: { ...r.job, ...change } }));
    expect((await runItemTask(stale.args)).outcome).toBe('superseded'); expect(stale.calls).toEqual([]);
  }
});

it('superseded launches during planning or claim acquisition cannot start either probe port', async () => {
  for (const boundary of ['plan', 'claim']) {
    for (const appliedProbe of ['live-head', 'worker-run']) {
      const h = taskHarness([{ ...executionEffect(), appliedProbe }]);
      const supersede = () => h.mutate(r => ({ ...r, job: { ...r.job, attempts: 4 } }));
      if (boundary === 'plan') {
        const plan = h.args.plan;
        h.args.plan = async facts => {
          const declarations = plan(facts);
          await Promise.resolve();
          supersede();
          return declarations;
        };
      } else {
        h.args.claim.acquire = async () => {
          await Promise.resolve();
          supersede();
          return 'claim-token';
        };
      }
      const result = await runItemTask(h.args);
      expect(result.outcome).toBe('superseded');
      expect(h.calls).toEqual(['release']);
      expect(result.gh).toEqual({ read: 0, write: 0 });
      expect(h.record.job.task.failureCount).toBe(0);
      expect(h.record.job.task.execution).toBeUndefined();
    }
  }
});

const effectRows = [
  ['dispatch', 'worker-run', 'none'], ['promote', 'live-ready', 'none'],
  ['label', 'live-label', 'none'], ['comment', 'live-marker', 'none'],
  ['push', 'remote-head', { lease: 'abc' }], ['merge', 'merged', { matchHeadCommit: 'abc' }],
];
it.each(effectRows)('resume probes act-before-mark for every declared effect kind', async (name, appliedProbe, precondition) => {
  const e = { ...executionEffect(), name, appliedProbe, precondition };
  const h = taskHarness([e]); let applied = false, acts = 0;
  const update = h.args.record.update;
  h.args.record.update = fn => {
    const candidate = fn(structuredClone(h.record));
    if (candidate.job.task.execution?.effects[`${h.args.task.id}:${name}`]?.status === 'applied' && !applied) {
      applied = true; throw Error('crash after act before mark');
    }
    return update(() => candidate);
  };
  h.args.effects.act = async ({ effectId }) => { acts++; h.runs.set(effectId, { status: 'done' }); return { receipt: 'written' }; };
  h.args.effects.probe = async ({ gh }) => gh.read(() => ({ applied: acts > 0, evidence: { receipt: 'observed' }, thread: { source: 'live-thread', complete: true } }));
  expect((await runItemTask(h.args)).outcome).toBe('failed');
  // A new launch sees an incomplete intent, including if the new planner owes nothing.
  h.mutate(r => ({ ...r, job: { ...r.job, attempts: 4 } })); h.args.attempt = 4;
  h.args.plan = () => [];
  h.args.read = () => factsFor({ ...snapshot(), data: { pull: { head: { sha: 'changed-by-effect' } } } });
  h.args.effects.fence = () => { throw Error('positive probe must precede fence'); };
  const result = await runItemTask(h.args);
  expect(result.outcome).toBe('acted'); expect(acts).toBe(1);
  expect(result.effects[0]).toMatchObject({ effectId: `${h.args.task.id}:${name}`, status: 'applied', inputs: { 'pull.head.sha': 'abc' } });
  if (name === 'dispatch') { expect(result.gh.read).toBe(0); expect(h.calls).toContain('run-store'); }
});

it('live fence rejects merged drafted and changed inputs before act', async () => {
  const values = { head: 'abc', base: 'base', open: true, draft: false, labels: ['review:ok'], checks: ['green'], review: 7, withdrawal: false, marker: 1, claim: 'ours' };
  for (const key of Object.keys(values)) {
    const h = taskHarness([{ ...executionEffect(), inputs: Object.keys(values), fences: Object.keys(values) }]);
    h.args.read = () => factsFor({ ...snapshot(), data: values });
    h.args.plan = f => { Object.keys(values).forEach(k => f.read(k)); return [{ ...executionEffect(), inputs: Object.keys(values), fences: Object.keys(values) }]; };
    h.args.effects.fence = () => factsFor({ ...snapshot(), data: { ...values, [key]: null } });
    expect((await runItemTask(h.args)).outcome).toBe('superseded'); expect(h.calls).not.toContain('act');
  }
  const h = taskHarness([executionEffect(), { ...executionEffect(), name: 'later' }]); let assertions = 0;
  h.args.claim.assert = () => ++assertions <= 2;
  expect((await runItemTask(h.args)).outcome).toBe('superseded');
  expect(Object.values(h.record.job.task.execution.effects)[0].status).toBe('applied');
  expect(h.calls.filter(c => c === 'act')).toHaveLength(1);
  const boundary = taskHarness(); let checks = 0;
  boundary.args.claim.assert = () => ++checks === 1;
  expect((await runItemTask(boundary.args)).outcome).toBe('superseded');
  expect(boundary.calls).not.toContain('act');
  const suspended = taskHarness(); let claimChecks = 0, signalAssertion, resumeAssertion;
  const assertionPending = new Promise(resolve => { signalAssertion = resolve; });
  const assertionResumed = new Promise(resolve => { resumeAssertion = resolve; });
  suspended.args.claim.assert = async () => {
    if (++claimChecks === 2) {
      signalAssertion();
      await assertionResumed;
    }
    return true;
  };
  const running = runItemTask(suspended.args);
  await assertionPending;
  suspended.mutate(r => ({ ...r, job: { ...r.job, attempts: 4 } }));
  resumeAssertion();
  const superseded = await running;
  expect(superseded.outcome).toBe('superseded');
  expect(suspended.calls).not.toContain('act');
  expect(superseded.gh.write).toBe(0);
  expect(suspended.record.job.task.failureCount).toBe(0);
  expect(Object.values(suspended.record.job.task.execution.effects)[0].status).toBe('intent');

  for (const invalid of [null, { ...snapshot(), complete: false }, { ...snapshot(), observedAt: 1 }]) {
    const unreadable = taskHarness(); unreadable.args.effects.fence = () => factsFor(invalid);
    expect((await runItemTask(unreadable.args)).outcome).toBe('deferred-read');
    expect(unreadable.calls).not.toContain('act');
  }
});

it('fence-to-act races honor declared preconditions and reconcile next tick', async () => {
  for (const [name, appliedProbe, precondition] of effectRows.slice(1)) {
    const h = taskHarness([{ ...executionEffect(), name, appliedProbe, precondition }]); let head = 'abc', writes = 0;
    h.args.effects.probe = () => ({ applied: false, thread: { source: 'live-thread', complete: true } });
    h.args.effects.fence = () => { head = 'new'; return factsFor(); };
    h.args.effects.act = ({ precondition: guard }) => {
      if (guard !== 'none' && head !== 'abc') throw Error('server precondition rejected');
      writes++; return { head };
    };
    expect((await runItemTask(h.args)).outcome).toBe(precondition === 'none' ? 'acted' : 'failed');
    expect(writes).toBe(precondition === 'none' ? 1 : 0);
    h.mutate(r => ({ ...r, job: { ...r.job, attempts: 4 } })); h.args.attempt = 4;
    h.args.effects.probe = () => ({ applied: true, evidence: { reconciled: true }, thread: { source: 'live-thread', complete: true } });
    expect((await runItemTask(h.args)).outcome).toBe('acted'); expect(writes).toBe(precondition === 'none' ? 1 : 0);
  }
});

it('unknown applied probe fails without later effects', async () => {
  for (const probe of [() => undefined, () => ({ applied: 'unknown' }), () => { throw Error('unreadable'); }]) {
    const h = taskHarness([executionEffect(), { ...executionEffect(), name: 'later' }]); h.args.effects.probe = probe;
    expect((await runItemTask(h.args)).outcome).toBe('failed'); expect(h.calls).toEqual(['release']);
  }
});

it.each([
  ['read', 'read', []], ['probe', 'read', ['read']],
  ['fence', 'read', ['read', 'probe']], ['act', 'write', ['read', 'probe', 'fence']],
])('superseded %s adapter cannot invoke metered gh.%s after awaiting', async (phase, _kind, priorCalls) => {
  const h = taskHarness(); let signalAdapter, resumeAdapter;
  const adapterPending = new Promise(resolve => { signalAdapter = resolve; });
  const adapterResumed = new Promise(resolve => { resumeAdapter = resolve; });
  h.args.read = ({ gh }) => gh.read(() => { h.calls.push('read'); return factsFor(); });
  const target = phase === 'read' ? h.args : h.args.effects;
  const adapter = target[phase];
  target[phase] = async context => {
    signalAdapter();
    await adapterResumed;
    return adapter(context);
  };
  const running = runItemTask(h.args);
  await adapterPending;
  expect(h.calls).toEqual(priorCalls);
  h.mutate(r => ({ ...r, job: { ...r.job, attempts: 4 } }));
  resumeAdapter();
  const result = await running;
  expect(result.outcome).toBe('superseded');
  expect(h.calls).toEqual(phase === 'read' ? priorCalls : [...priorCalls, 'release']);
  expect(result.gh).toEqual({ read: priorCalls.length, write: 0 });
  expect(h.record.job.task.failureCount).toBe(0);
  expect(h.record.job.task.execution?.results?.[3]).toBeUndefined();
});

it.each([
  ['missing budgets', undefined], ['null budgets', null], ['missing limits', {}],
  ...['read', 'write'].flatMap(kind => [
    ['missing', undefined], ['negative', -1], ['fractional', 0.5], ['NaN', NaN],
    ['infinite', Infinity], ['negative infinite', -Infinity], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ].map(([label, limit]) => [`${kind} ${label}`, { read: 100, write: 100, [kind]: limit }])),
])('invalid task budgets reject %s before read probe fence or act', async (_label, budgets) => {
  const h = taskHarness(); h.args.budgets = budgets;
  const read = h.args.read;
  h.args.read = context => { h.calls.push('read'); return read(context); };
  const result = await runItemTask(h.args);
  expect(result.outcome).toBe('deferred-read');
  expect(result.reason).toBe('task requires finite read/write budgets; correct policy before rescheduling');
  expect(h.calls).toEqual([]);
  expect(result.gh).toEqual({ read: 0, write: 0 });
  expect(result.recordedReads).toEqual([]);
});

it('task telemetry meters probes fences and acts before budget spend', async () => {
  for (const [budgets, outcome, expected] of [
    [{ read: 0, write: 1 }, 'failed', []], [{ read: 1, write: 1 }, 'deferred-read', ['probe']],
    [{ read: 2, write: 0 }, 'failed', ['probe', 'fence']], [{ read: 2, write: 1 }, 'acted', ['probe', 'fence', 'act']],
  ]) {
    const h = taskHarness(); h.args.budgets = budgets;
    const result = await runItemTask(h.args);
    expect(result.outcome).toBe(outcome);
    expect(h.calls.filter(c => c !== 'release')).toEqual(expected);
    expect(result.gh).toEqual({ read: expected.filter(c => c !== 'act').length, write: expected.includes('act') ? 1 : 0 });
    if (outcome !== 'acted') expect(result.reason).toContain('budget-exhausted');
    expect(result.recordedReads).toHaveLength(1);
    for (const phase of ['read', 'plan', 'claim', 'probe', 'fence', 'act', 'mark']) expect(result.timings[phase]).toBeGreaterThanOrEqual(0);
    await runItemTask(h.args); expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ type: 'task-timing', key: `${h.args.task.id}:3`, attempt: 3 });
  }
  const h = taskHarness(); h.args.budgets.read = 0;
  h.args.read = ({ gh }) => gh.read(() => { throw Error('denied call executed'); });
  const result = await runItemTask(h.args);
  expect(result.outcome).toBe('deferred-read'); expect(result.reason).toContain('budget-exhausted');
  expect(result.gh.read).toBe(0);
});
