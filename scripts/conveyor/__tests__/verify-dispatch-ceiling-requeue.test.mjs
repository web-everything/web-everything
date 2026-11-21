import { it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as dispatch from '../verify-dispatch.mjs';
import { verifyStartBody, verifyFinishBody } from '../../lib/lane-verify.mjs';

export function ceilingFixture(overrides = {}) {
  let marker = { sha: 'head', status: 'infrastructure-failure', runId: 'job-1', suites: 'npx vitest run own.test.mjs',
    selection: { status: 'complete' }, infrastructure: { kind: 'gate-ceiling' } };
  const enqueue = vi.fn(() => ({ id: 'job-2' }));
  const options = { dir: 'lane', headSha: 'head', afterJob: 'job-1', runId: 'job-1', timedOutPhase: 'gate', ceilingMs: 60000,
    readState: () => ({ headSha: 'head', marker }), writeMarker: value => { marker = value; }, enqueue,
    fallbackGate: () => ({ command: "npx vitest run 'own.test.mjs'", selection: { status: 'capped-fallback', tests: ['own.test.mjs'] } }), ...overrides };
  return { options, enqueue, marker: () => marker };
}
it('a gate-ceiling timeout requeues once with the capped gate and the marker records requeue.afterJob', () => {
  const f = ceilingFixture();
  expect(dispatch.requeueGateCeiling(f.options)).toBe(true);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.marker()).toMatchObject({ status: 'running', selection: { status: 'capped-fallback' }, requeue: {
    afterJob: 'job-1', afterSha: 'head', reason: 'gate-ceiling', ceilingMs: 60000, from: 'complete', to: 'capped-fallback', tests: 1 } });
});
it('second ceiling -> infrastructure failure only', () => {
  const f = ceilingFixture();
  dispatch.requeueGateCeiling(f.options);
  const marker = { ...f.marker(), status: 'infrastructure-failure' };
  expect(dispatch.requeueGateCeiling({ ...f.options, afterJob: 'job-2', readState: () => ({ headSha: 'head', marker }) })).toBe(false);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});
it.each([
  "'scripts/a && b.test.mjs'",
  '"scripts/a && b.test.mjs"',
  'scripts/a\\ \\&\\&\\ b.test.mjs',
])('a gate-ceiling retry preserves quoted shell operators in a filename (%s) and executes both gate halves', path => {
  const f = ceilingFixture();
  const tail = " && npm run check:standards -- --local --files='scripts/a && b.test.mjs'";
  f.marker().suites = `npx vitest run ${path}${tail}`;
  f.options.fallbackGate = () => ({ command: `npx vitest run ${path} --passWithNoTests`,
    selection: { status: 'capped-fallback', tests: ['scripts/a && b.test.mjs'] } });
  expect(dispatch.requeueGateCeiling(f.options)).toBe(true);
  const gate = f.enqueue.mock.calls[0][0].suites;
  expect(gate).toBe(`npx vitest run ${path} --passWithNoTests${tail}`);
  // Shell functions record argv without invoking real npm or Vitest processes.
  const output = execFileSync('/bin/sh', ['-c',
    `npx() { printf '<npx>\\n'; printf '%s\\n' "$@"; }; npm() { printf '<npm>\\n'; printf '%s\\n' "$@"; }; ${gate}`,
  ], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
  expect(output.split('\n')).toEqual(['<npx>', 'vitest', 'run', 'scripts/a && b.test.mjs', '--passWithNoTests',
    '<npm>', 'run', 'check:standards', '--', '--local', '--files=scripts/a && b.test.mjs', '']);
});
it('a gate-ceiling retry with a quoted operator and no standards tail runs only the capped tests', () => {
  const f = ceilingFixture();
  f.marker().suites = "npx vitest run 'scripts/a && b.test.mjs'";
  expect(dispatch.requeueGateCeiling(f.options)).toBe(true);
  expect(f.enqueue.mock.calls[0][0].suites).toBe("npx vitest run 'own.test.mjs'");
});
it('a gate-ceiling retry refuses an unmatched gate quote without enqueueing', () => {
  const f = ceilingFixture();
  f.marker().suites = "npx vitest run 'scripts/a && b.test.mjs";
  expect(dispatch.requeueGateCeiling(f.options)).toBe(false);
  expect(f.enqueue).not.toHaveBeenCalled();
});
it.each([
  '--config=vitest.custom.ts --project=browser',
  '--config vitest.custom.ts --project browser',
  "'--config' 'vitest custom.ts' '--project' 'browser suite'",
  '--project=browser',
  "--co'nfig'=vitest.custom.ts",
  '--confi\\g=vitest.custom.ts',
  '-c vitest.custom.ts',
  "-t 'configured suite'",
  '--exclude=slow.test.mjs',
  '--unknown-option',
])('ceiling recovery refuses custom configuration/project/filter options instead of executing a default-config suite: %s', options => {
  const f = ceilingFixture();
  f.marker().suites = `npx vitest run 'own.test.mjs' --passWithNoTests ${options} && npm run check:standards`;
  const original = structuredClone(f.marker());
  f.options.fallbackGate = vi.fn(f.options.fallbackGate);
  f.options.writeMarker = vi.fn();
  expect(dispatch.requeueGateCeiling(f.options)).toBe(false);
  expect(f.options.fallbackGate).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.options.writeMarker).not.toHaveBeenCalled();
  expect(f.marker()).toEqual(original);
});
it('ceiling recovery still accepts default sharding and timeout flags and preserves standards options', () => {
  const f = ceilingFixture();
  const tail = ' && npm run check:standards -- --local --files=own.test.mjs';
  f.marker().suites = "node 'scripts/lib/verify-shard-run.mjs' --shards=2 --parallel=3 --budget-ms=9000 -- npx vitest run 'own.test.mjs' --passWithNoTests --testTimeout=15000 --hookTimeout=30000" + tail;
  expect(dispatch.requeueGateCeiling(f.options)).toBe(true);
  expect(f.enqueue.mock.calls[0][0].suites).toBe("npx vitest run 'own.test.mjs'" + tail);
});
it.each(['queue', undefined])('no requeue for queue-phase timeouts or external kills (%s)', timedOutPhase => {
  const f = ceilingFixture({ timedOutPhase });
  expect(dispatch.requeueGateCeiling(f.options)).toBe(false);
  expect(f.enqueue).not.toHaveBeenCalled();
});
it('no requeue for moved head', () => {
  const f = ceilingFixture();
  expect(dispatch.requeueGateCeiling({ ...f.options, readState: () => ({ headSha: 'moved', marker: f.marker() }) })).toBe(false);
  expect(f.enqueue).not.toHaveBeenCalled();
});
it('dedupe survives restart using only persisted marker evidence', () => {
  const f = ceilingFixture();
  dispatch.requeueGateCeiling(f.options);
  const persisted = JSON.parse(JSON.stringify(f.marker()));
  expect(dispatch.requeueGateCeiling({ ...f.options, readState: () => ({ headSha: 'head', marker: persisted }) })).toBe(false);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});
it('unreadable marker or failed marker write refuses enqueue', () => {
  const f = ceilingFixture();
  expect(dispatch.requeueGateCeiling({ ...f.options, readState: () => ({ headSha: 'head', marker: null }) })).toBe(false);
  expect(dispatch.requeueGateCeiling({ ...f.options, writeMarker: () => { throw new Error('disk'); } })).toBe(false);
  expect(f.enqueue).not.toHaveBeenCalled();
});
it('marker writers preserve requeue, selection and explicit uncapped audit fields', () => {
  const audit = { selection: { status: 'capped-fallback', tests: 1 }, requeue: { afterJob: 'job-1' }, gateUncapped: true };
  const start = verifyStartBody({ sha: 'head', ...audit });
  expect(start).toMatchObject(audit);
  expect(verifyFinishBody(start, { exitCode: 0 })).toMatchObject(audit);
});

it('the in-process sweep retries once, then records only infrastructure failure', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'verify-cap-'));
  const lane = join(root, 'we', 'lane-1');
  mkdirSync(lane, { recursive: true });
  const git = args => execFileSync('git', args, { cwd: lane, encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']);
    writeFileSync(join(lane, 'own.test.mjs'), '');
    git(['add', '.']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
    git(['branch', 'origin/main']);
    const head = git(['rev-parse', 'HEAD']);
    writeFileSync(join(lane, 'own.test.mjs'), '// changed');
    const markerPath = join(lane, '.git', '.lane-verify');
    const read = () => JSON.parse(readFileSync(markerPath, 'utf8'));
    writeFileSync(markerPath, JSON.stringify({ sha: head, status: 'running', startedAt: 'request', suites: "npx vitest run 'own.test.mjs'", selection: { status: 'complete' } }));
    const spawnGate = vi.fn(async (args, io) => {
      writeFileSync(markerPath, JSON.stringify({ ...read(), runId: args.find(a => a.startsWith('--run-id=')).slice(9) }));
      io.onGateStarted();
      throw Object.assign(new Error('ceiling'), { timedOutPhase: 'gate', signal: 'SIGKILL', status: null });
    });
    const first = await dispatch.runVerifyDispatch({ poolRoot: root, spawnGate });
    expect(first.failures).toEqual([]);
    expect(read()).toMatchObject({ status: 'running', selection: { status: 'capped-fallback' }, requeue: { afterSha: head } });
    expect(read().requeue.afterJob).toBeTruthy();
    const second = await dispatch.runVerifyDispatch({ poolRoot: root, spawnGate });
    expect(second.failures).toHaveLength(1);
    expect(read().status).toBe('infrastructure-failure');
    await dispatch.runVerifyDispatch({ poolRoot: root, spawnGate });
    expect(spawnGate).toHaveBeenCalledTimes(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('detached job settlement requeues once and durable job dedupe survives a lost tick and restart', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { createJobStore } = await import('../../lib/daemon-jobs-runtime.mjs');
  const { markClaimed, markLaunching, markSucceeded } = await import('../../lib/daemon-jobs.mjs');
  const { createVerifyGateJobs, resultPath } = await import('../verify-gate-job.mjs');
  const root = mkdtempSync(join(tmpdir(), 'verify-cap-job-'));
  const lane = join(root, 'lane');
  mkdirSync(lane);
  const git = args => execFileSync('git', args, { cwd: lane, encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']);
    writeFileSync(join(lane, 'own.test.mjs'), '');
    git(['add', '.']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
    git(['branch', 'origin/main']);
    const headSha = git(['rev-parse', 'HEAD']);
    writeFileSync(join(lane, 'own.test.mjs'), '// changed');
    const markerPath = join(lane, '.git', '.lane-verify');
    const original = { sha: headSha, status: 'infrastructure-failure', runId: 'first-run', startedAt: '2026-11-21T00:00:00Z',
      suites: "npx vitest run 'own.test.mjs'", selection: { status: 'complete' } };
    writeFileSync(markerPath, JSON.stringify(original));
    const store = createJobStore(join(root, 'jobs'));
    const failures = [];
    const makeJobs = () => createVerifyGateJobs({ store, readHead: () => 'c0de', reattach: async () => ({ actions: [] }),
      log: () => {}, scanLane: () => [], groupExists: () => false, probe: () => 'dead', snapshot: {}, evict: () => {}, onSettled: f => failures.push(f) });
    const jobs = makeJobs();
    const first = jobs.launch({ dir: lane, pool: 'we', lane: 1, headSha, marker: original, runId: original.runId });
    const at = new Date().toISOString(); // fresh, so settlement housekeeping does not prune the job
    store.update(first.id, r => markSucceeded(markClaimed(markLaunching(r, { at }), { at, handle: 'h:1:s', host: 'h', pid: 1, procStart: 's' }), { at }));
    writeFileSync(resultPath(store.dir, first.id), JSON.stringify({ outcome: 'timed-out', timedOutPhase: 'gate', gateCeilingMs: 60000 }));
    await jobs.sync(new Map());
    expect(failures).toEqual([]);
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).requeue).toMatchObject({ afterJob: first.id, afterSha: headSha, ceilingMs: 60000 });
    expect(store.list().records).toHaveLength(2);
    // Reconstruct the crash window after enqueue but before marker/dedupe persistence.
    writeFileSync(markerPath, JSON.stringify(original));
    rmSync(join(store.dir, 'consumed.ids'));
    await makeJobs().sync(new Map());
    expect(store.list().records).toHaveLength(2);
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).requeue.afterJob).toBe(first.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
