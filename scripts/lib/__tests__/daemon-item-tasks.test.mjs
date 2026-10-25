import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createJobStore } from '../daemon-jobs-runtime.mjs';
import { defineJobKind } from '../daemon-jobs.mjs';
import { isValidRunId } from '../../operations/run-record.mjs';
import { withFileLock } from '../atomic-json-file.mjs';
import { enqueueItemTask, taskIdentity, taskTupleLockId, createRecordingFacts, validateTaskPlan } from '../daemon-item-tasks.mjs';

let dir, store;
const kindDef = defineJobKind({ kind: 'fix', entry: 'job.mjs' });
const identity = (seq = 1, repo = 'owner/repo') => ({ kind: 'fix', repo, item: 12, seq });
const options = (seq = 1, repo) => ({ store, kindDef, ...identity(seq, repo), codeSha: 'abc', acting: true, resourceKind: 'build', policyOptions: { platform: null, env: {} } });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'item-tasks-')); store = createJobStore(dir); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

it('unreadable facts defer and incomplete comments cannot authorize effects', () => {
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
