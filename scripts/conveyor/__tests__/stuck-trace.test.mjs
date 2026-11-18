import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { traceStuckPr, TRACE_TRIGGERS } from '../stuck-trace.mjs';
import { publishStalledDigest } from '../pr-stall-digest.mjs';
import { runMergeWatch } from '../pass-daemons/pr-merge-watch-pass.mjs';

const repo = 'example/widgets', head = 'a'.repeat(40), now = '2026-11-10T12:00:00Z';
function fixture(t) {
  assert.ok(process.env.TMPDIR, 'task TMPDIR required');
  const root = mkdtempSync(join(process.env.TMPDIR, 'stuck-trace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [], calls = [];
  const why = { owner: 'operator', waitingFor: 'human ruling', suggestedOp: 'unpark --preview',
    sections: ['state', 'checks', 'holds', 'daemons'].map((name, i) => ({ name,
      lines: [['OPEN labels: review:human'], ['unit: FAILURE', 'lint: PENDING'], ['build hold: exhausted'], ['fix: refused']][i] })) };
  const trace = { likelyBlocker: 'waiting behind landing-holder #9', labels: ['review:human'],
    ci: [{ name: 'lint', ageMinutes: 20 }], queue: { landingHolder: 9 }, conflicts: ['accepted + pending'],
    looping: [{ source: 'fix', count: 12 }], latest: { fix: 'refused #17', drain: 'behind #9' },
    latestAtET: { fix: '07:00 ET', drain: '06:59 ET' }, unavailable: ['review ledger'], incomplete: [] };
  const options = { repo, pr: 17, head, kind: 'ready-stuck', stateDir: root, now, env: {},
    run: async args => { calls.push(args); return args[0] === 'why' ? { runId: 'why-17', verdict: why } : trace; },
    emit: event => { events.push(event); return true; } };
  return { root, options, events, calls, why, trace };
}

test('dedupe persists before IO across callers and triggers; a new head re-arms', async t => {
  const f = fixture(t);
  const run = f.options.run;
  f.options.run = async args => {
    assert.ok(JSON.parse(readFileSync(join(f.root, 'stuck-trace.json')))[`${repo}#17@${head}`]);
    return run(args);
  };
  const results = await Promise.all([traceStuckPr(f.options), traceStuckPr({ ...f.options, kind: 'stalled' })]);
  assert.equal(results.filter(r => r.posted).length, 1);
  assert.equal((await traceStuckPr(f.options)).skipped, 'duplicate');
  await traceStuckPr({ ...f.options, run, head: 'b'.repeat(40) });
  assert.equal(f.events.length, 2); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[0], ['why', '--pr=17', `--repo=${repo}`, '--json']);
});

test('one event contains owner, suggested operation, gates, holds, stage, labels and daemon times', async t => {
  const f = fixture(t); assert.deepEqual(await traceStuckPr(f.options), { posted: true });
  assert.equal(f.events.length, 1);
  const { kind, detail } = f.events[0]; assert.equal(kind, 'stuck-trace');
  for (const text of ['root cause: waiting behind', 'operator', 'human ruling', 'unpark', 'OPEN', 'review:human',
    'FAILURE', 'PENDING', 'build hold', 'landingHolder', 'label conflicts', 'looping', 'fix (07:00 ET)', 'drain (06:59 ET)', 'review ledger'])
    assert.ok(detail.note.includes(text), text);
});

test('reads both direct and wrapped verdict shapes for each operation', async t => {
  for (const wrapped of [false, true]) {
    const f = fixture(t);
    await traceStuckPr({ ...f.options, run: async ([op]) => {
      const verdict = op === 'why' ? f.why : f.trace;
      return wrapped ? { runId: 'test-17', verdict } : verdict;
    } });
    assert.equal(f.events[0].detail.owner, f.why.owner);
    assert.equal(f.events[0].detail.headline, f.trace.likelyBlocker);
    assert.doesNotMatch(f.events[0].detail.note, /INCOMPLETE/);
  }
});

test('unknown direct shapes emit incomplete evidence with a manual inspection fallback', async t => {
  const f = fixture(t);
  await traceStuckPr({ ...f.options, run: async () => ({ owner: 17, likelyBlocker: null }) });
  assert.match(f.events[0].detail.note, /INCOMPLETE/);
  assert.match(f.events[0].detail.note, /inspect manually/);
});

test('operation failure emits one incomplete note with unavailable fields and never retries', async t => {
  const f = fixture(t); let calls = 0;
  const options = { ...f.options, run: async () => { calls++; throw Error('offline'); } };
  await traceStuckPr(options); await traceStuckPr(options);
  assert.equal(calls, 2); assert.equal(f.events.length, 1);
  assert.match(f.events[0].detail.note, /INCOMPLETE/);
  assert.match(f.events[0].detail.note, /owner: unavailable/);
});

test('emit failure never throws and never re-arms', async t => {
  for (const emit of [() => false, () => { throw Error('sink'); }]) {
    const f = fixture(t);
    assert.equal((await traceStuckPr({ ...f.options, emit })).posted, false);
    assert.equal((await traceStuckPr(f.options)).skipped, 'duplicate');
  }
});

test('only the three trace triggers are admitted', async t => {
  assert.deepEqual(TRACE_TRIGGERS, ['ready-stuck', 'pr-no-progress', 'stalled']);
  const f = fixture(t);
  assert.equal((await traceStuckPr({ ...f.options, kind: 'pr-merged' })).skipped, 'trigger');
  assert.equal(f.calls.length, 0);
});

test('oversized hostile fields are bounded, sanitized and name the full-evidence fallback', async t => {
  const f = fixture(t); f.why.owner = '\x1b\u202e' + '界'.repeat(5000);
  f.trace.latest.fix = '\x00' + 'x'.repeat(5000);
  await traceStuckPr(f.options);
  const note = f.events[0].detail.note;
  assert.ok(Buffer.byteLength(note) <= 3000);
  assert.ok(!note.includes('\x1b') && !note.includes('\u202e') && !note.includes('\x00'));
  assert.match(note, /inspect full operation JSON/);
});

test('unreadable receipts fail closed without running operations', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'stuck-trace.json'), '{bad');
  assert.equal((await traceStuckPr(f.options)).posted, false); assert.equal(f.calls.length, 0);
});

test('unknown head re-arms once per PR per day', async t => {
  const f = fixture(t); const opts = { ...f.options, head: 'unknown-head' };
  await traceStuckPr(opts); assert.equal((await traceStuckPr(opts)).skipped, 'duplicate');
  await traceStuckPr({ ...opts, now: '2026-11-11T12:00:00Z' }); assert.equal(f.events.length, 2);
});

test('hung operations time out into one incomplete event without a retry', async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = { ...f.options, run: () => new Promise(() => {}) };
  const pending = traceStuckPr(options);
  t.mock.timers.tick(59_000);
  assert.deepEqual(await pending, { posted: true });
  assert.match(f.events[0].detail.note, /INCOMPLETE/);
  assert.equal((await traceStuckPr(options)).skipped, 'duplicate');
});

test('hung event delivery is bounded and leaves the receipt claimed', async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = traceStuckPr({ ...f.options, emit: () => new Promise(() => {}) });
  // Allow both injected operation results to settle before advancing the sink timer.
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  assert.equal((await pending).posted, false);
  assert.equal((await traceStuckPr(f.options)).skipped, 'duplicate');
});

test('digest traces only newly written operator stalls, detached and never under test', async t => {
  const f = fixture(t), seen = [];
  const item = { repo, pr: 17, head, lane: 'operator', state: 'queue-wait', evidence: [] };
  const options = { stateDir: join(f.root, 'digest'), traceStateDir: f.root, feedPath: join(f.root, 'feed.jsonl'),
    now: Date.parse(now), env: {}, notify: () => ({ ok: false }), trace: args => { seen.push(args); return Promise.reject(Error('best effort')); } };
  const pass = { items: [item, { ...item, pr: 18, lane: 'daemon' }], incomplete: false };
  publishStalledDigest(pass, options); assert.equal(seen.length, 0);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'stalled'); assert.equal(seen[0].stateDir, f.root);
  publishStalledDigest(pass, options); // failed desktop delivery is retried, trace is not
  publishStalledDigest({ ...pass, items: [{ ...item, pr: 19 }] }, { ...options, env: { WE_UNDER_TEST: '1' } });
  publishStalledDigest({ ...pass, items: [{ ...item, pr: 20 }] }, { ...options, feedPath: join(options.stateDir, 'digest-state.json') });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(seen.length, 1);
});

test('watch hook runs only after successful delivery for ready-stuck and pr-no-progress', async t => {
  for (const kind of ['ready-stuck', 'pr-no-progress']) for (const delivery of ['ok', 'false', 'throw']) {
    const f = fixture(t), seen = [], order = [];
    const pr = { number: 17, state: 'OPEN', isDraft: false, headRefOid: head, labels: kind === 'ready-stuck' ? [{ name: 'ready-to-merge' }] : [], mergeStateStatus: 'BLOCKED', statusCheckRollup: [] };
    const gh = args => {
      if (args[0] === 'pr') return pr;
      const path = args[1];
      if (path.includes('/pulls?')) return [{ number: 17, state: 'open', head: { sha: head } }];
      if (path.includes('/comments?') || path.includes('/timeline?')) return [];
      if (path.includes('/check-runs?')) return { check_runs: [] };
      if (path.includes('/commits/')) return { sha: head, commit: { committer: { date: '2026-11-09T00:00:00Z' } } };
      throw Error('unexpected fixture read');
    };
    await runMergeWatch({ repos: [repo], stateDir: f.root, now, gh,
      settings: { noProgressMinutes: kind === 'ready-stuck' ? 100000 : 180 }, signalLogs: () => [], log: () => {},
      readyStuck: { readLabelTime: () => '2026-11-09T00:00:00Z', readSkipReason: () => 'held' },
      emitEvent: event => { order.push(event.kind); if (delivery === 'throw') throw Error('delivery'); return delivery === 'ok'; },
      trace: args => { seen.push(args); assert.ok(order.includes(args.kind)); } });
    assert.equal(seen.length, delivery === 'ok' ? 1 : 0, `${kind} ${delivery}`);
    if (seen.length) { assert.equal(seen[0].kind, kind); assert.equal(seen[0].head, head); }
  }
});
