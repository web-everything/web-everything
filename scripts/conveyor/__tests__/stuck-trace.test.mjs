import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { enqueueStuckTrace, drainStuckTraces, TRACE_TRIGGERS } from '../stuck-trace.mjs';
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

const queue = f => JSON.parse(readFileSync(join(f.root, 'stuck-trace-queue.json')));
const key = `${repo}#17@${head}`;
async function traceStuckPr(options) {
  const enqueued = enqueueStuckTrace(options);
  if (enqueued.skipped === 'trigger') return enqueued;
  const result = await drainStuckTraces(options);
  return { posted: result.processed > 0 };
}

test('enqueue never throws, including an unwritable queue, and does no subprocess IO', t => {
  const f = fixture(t);
  assert.deepEqual(enqueueStuckTrace(f.options), { queued: true });
  assert.equal(f.calls.length, 0);
  assert.equal(queue(f)[key].attempts, 0);
  assert.equal(enqueueStuckTrace({ ...f.options, kind: 'stalled' }).skipped, 'duplicate');
  const bad = join(f.root, 'not-a-directory'); writeFileSync(bad, 'file');
  assert.doesNotThrow(() => enqueueStuckTrace({ ...f.options, stateDir: bad }));
});

test('drain processes only two oldest entries, persists claims before IO, and done never repeats', async t => {
  const f = fixture(t);
  for (const pr of [19, 18, 17]) enqueueStuckTrace({ ...f.options, pr, now: Date.parse(now) + pr });
  const run = async args => {
    const subject = `${repo}#${args[1].slice('--pr='.length)}@${head}`;
    assert.equal(queue(f)[subject].attempts, 1);
    assert.equal(queue(f)[subject].state, 'queued');
    return f.options.run(args);
  };
  assert.equal((await drainStuckTraces({ ...f.options, now: Date.parse(now) + 100, run })).processed, 2);
  assert.deepEqual(f.events.map(e => e.pr), [17, 18]);
  assert.equal(f.calls.length, 4);
  assert.equal(queue(f)[key].state, 'done');
  await drainStuckTraces(f.options); await drainStuckTraces(f.options);
  assert.deepEqual(f.events.map(e => e.pr), [17, 18, 19]);
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.calls[0], ['why', '--pr=17', `--repo=${repo}`, '--json']);
  assert.equal((await drainStuckTraces({ ...f.options, max: 3 })).processed, 0);
});

test('transient read or sink failure retries an unchanged head after ten minutes, up to three attempts', async t => {
  for (const failure of ['read', 'sink', 'throw']) {
    const f = fixture(t); enqueueStuckTrace(f.options);
    const failed = { ...f.options, ...(failure === 'read'
      ? { run: async () => { throw Error('offline'); } }
      : { emit: () => { if (failure === 'throw') throw Error('sink'); return false; } }) };
    await drainStuckTraces(failed);
    assert.equal(queue(f)[key].state, 'queued');
    assert.equal(f.events.length, 0);
    assert.equal(enqueueStuckTrace(f.options).skipped, 'duplicate');
    assert.equal((await drainStuckTraces({ ...f.options, now: Date.parse(now) + 599_999 })).processed, 0);
    await drainStuckTraces({ ...f.options, now: Date.parse(now) + 600_000 });
    assert.equal(queue(f)[key].state, 'done');
    assert.equal(queue(f)[key].attempts, 2);
    assert.equal(f.events.length, 1);
    await drainStuckTraces({ ...f.options, now: Date.parse(now) + 1800_000 });
    assert.equal(f.events.length, 1);
  }
  const f = fixture(t); enqueueStuckTrace(f.options);
  for (const minutes of [0, 10, 20, 30]) await drainStuckTraces({ ...f.options,
    now: Date.parse(now) + minutes * 60_000, emit: () => false });
  assert.equal(queue(f)[key].attempts, 3); assert.equal(f.calls.length, 6);
});

test('crashed claims retry; legacy done receipts and completion markers remain delivered', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'stuck-trace.json'), JSON.stringify({
    [key]: { state: 'claimed', at: now, attempts: 1 },
    [`${repo}#18@${head}`]: { state: 'done', at: now, attempts: 1 },
    [`${repo}#19@${head}`]: { at: now, trigger: 'stalled' },
    [`${repo}#20@${head}`]: { state: 'claimed', at: now, attempts: 1 },
  }));
  const hash = createHash('sha256').update(`${repo}#20@${head}`).digest('hex');
  writeFileSync(join(f.root, `stuck-trace-done-${hash}.json`), JSON.stringify({ state: 'done' }));
  assert.equal((await drainStuckTraces(f.options)).processed, 0);
  await drainStuckTraces({ ...f.options, now: Date.parse(now) + 600_000 });
  assert.deepEqual(f.events.map(e => e.pr), [17]);
  assert.equal(queue(f)[key].state, 'done');
});

test('successful emit survives a busy receipt-finalization lock and never repeats', async t => {
  const f = fixture(t), lock = join(f.root, 'stuck-trace-queue.json.lock');
  enqueueStuckTrace(f.options);
  await drainStuckTraces({ ...f.options, emit: event => {
    f.events.push(event);
    writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return true;
  } });
  assert.equal(queue(f)[key].state, 'queued');
  const hash = createHash('sha256').update(key).digest('hex');
  assert.equal(JSON.parse(readFileSync(join(f.root, `stuck-trace-done-${hash}.json`))).state, 'done');
  rmSync(lock);
  for (const minutes of [10, 30]) {
    assert.equal((await drainStuckTraces({ ...f.options, now: Date.parse(now) + minutes * 60_000 })).processed, 0);
  }
  assert.equal(queue(f)[key].state, 'done');
  assert.equal(f.events.length, 1); assert.equal(f.calls.length, 2);
  enqueueStuckTrace({ ...f.options, pr: 18 });
  await drainStuckTraces(f.options);
  assert.deepEqual(f.events.map(e => e.pr), [17, 18]);
  assert.equal(f.calls.length, 4);
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
    assert.match(f.events[0].detail.note, /INCOMPLETE/); // unavailable review ledger
  }
});

test('unknown direct shapes remain queued without delivering a note', async t => {
  const f = fixture(t);
  await traceStuckPr({ ...f.options, run: async () => ({ owner: 17, likelyBlocker: null }) });
  assert.equal(f.events.length, 0);
  assert.equal(queue(f)[key].state, 'queued');
});

test('persistent failure of either evidence read never delivers duplicate incomplete notes', async t => {
  for (const failedOp of ['why', 'pr-trace']) {
    const f = fixture(t); enqueueStuckTrace(f.options);
    let calls = 0;
    const run = async args => {
      calls++;
      if (args[0] === failedOp) throw Error('offline');
      return f.options.run(args);
    };
    for (const minutes of [0, 10, 20, 30]) await drainStuckTraces({ ...f.options, run,
      now: Date.parse(now) + minutes * 60_000 });
    assert.equal(calls, 6);
    assert.equal(queue(f)[key].attempts, 3);
    assert.equal(queue(f)[key].state, 'queued');
    assert.equal(f.events.length, 0);
  }
});

test('why screen gaps and each pr-trace gap list independently mark notes INCOMPLETE', async t => {
  for (const source of ['screen', 'unavailable', 'incomplete', 'none']) {
    const f = fixture(t); f.trace.unavailable = [];
    if (source === 'screen') f.why.screen = 'why pr 17\nowner\n  operator\ngaps\n  checks: offline\n  queue: denied';
    else if (source !== 'none') f.trace[source] = ['checks: offline'];
    await traceStuckPr(f.options);
    const note = f.events[0].detail.note;
    if (source === 'none') assert.doesNotMatch(note, /INCOMPLETE/);
    else { assert.match(note, /INCOMPLETE/); assert.match(note, /checks: offline/); }
    if (source === 'screen') assert.match(note, /queue: denied/);
    await drainStuckTraces({ ...f.options, now: Date.parse(now) + 1800_000 });
    assert.equal(f.events.length, 1);
  }
});

test('oversized why gaps are bounded with a full-evidence fallback', async t => {
  const f = fixture(t), gap = 'checks: ' + 'x'.repeat(5000) + 'END_OF_GAP';
  f.why.screen = 'gaps\n  ' + gap;
  await traceStuckPr(f.options);
  const note = f.events[0].detail.note;
  assert.match(note, /INCOMPLETE/); assert.match(note, /checks:/);
  // The gap field hits clean()'s bound before the whole-note byte cap.
  const gapLine = note.split('\n').find(line => line.startsWith('why gaps:'));
  assert.match(gapLine, /checks:.*… \[bounded; inspect full operation JSON\]$/);
  assert.ok(gapLine.length < gap.length);
  assert.doesNotMatch(note, /END_OF_GAP/);
  assert.ok(Buffer.byteLength(note) <= 3000);
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

test('unreadable queue fails closed without subprocess IO', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'stuck-trace-queue.json'), '{bad');
  assert.equal(enqueueStuckTrace(f.options).queued, false);
  assert.equal((await drainStuckTraces(f.options)).processed, 0);
  assert.equal(f.calls.length, 0);
});

test('unknown head re-arms once per PR per day', async t => {
  const f = fixture(t), options = { ...f.options, head: 'unknown-head' };
  await traceStuckPr(options); await traceStuckPr(options);
  await traceStuckPr({ ...options, now: '2026-11-11T12:00:00Z' });
  assert.equal(f.events.length, 2);
});

test('hung reads and hung delivery are bounded and remain queued for retry', async t => {
  for (const stage of ['read', 'emit']) {
    const f = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
    enqueueStuckTrace(f.options);
    const pending = drainStuckTraces({ ...f.options, ...(stage === 'read'
      ? { run: () => new Promise(() => {}) } : { emit: () => new Promise(() => {}) }) });
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(stage === 'read' ? 59_000 : 1000);
    await pending;
    assert.equal(queue(f)[key].state, 'queued');
    assert.equal(queue(f)[key].attempts, 1);
    t.mock.timers.reset();
  }
});

test('digest enqueues every unchanged operator head and drains detached after alerts, never under test', async t => {
  const f = fixture(t), seen = [], order = [];
  const item = { repo, pr: 17, head, lane: 'operator', state: 'queue-wait', evidence: [] };
  const options = { stateDir: join(f.root, 'digest'), traceStateDir: f.root, feedPath: join(f.root, 'feed.jsonl'),
    now: Date.parse(now), env: {}, notify: () => { order.push('alert'); return { ok: true }; },
    enqueue: args => { seen.push(args); enqueueStuckTrace(args); },
    drain: () => { order.push('drain'); throw Error('best effort'); } };
  const pass = { items: [item, { ...item, pr: 18, lane: 'daemon' }], incomplete: false };
  publishStalledDigest(pass, options);
  assert.deepEqual(order, ['alert']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['alert', 'drain']);
  publishStalledDigest(pass, options);
  assert.equal(seen.length, 2); assert.equal(seen[1].kind, 'stalled');
  assert.equal(Object.keys(queue(f)).length, 1);
  await new Promise(resolve => setImmediate(resolve));
  publishStalledDigest(pass, { ...options, env: { WE_UNDER_TEST: '1' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(order.filter(x => x === 'drain').length, 2);
});

test('digest still alerts when queue writing and post-pass drain throw', async t => {
  const f = fixture(t); let alerts = 0;
  publishStalledDigest({ items: [{ repo, pr: 17, head, lane: 'operator', state: 'queue-wait' }] }, {
    stateDir: join(f.root, 'digest'), feedPath: join(f.root, 'feed.jsonl'), env: {},
    enqueue: () => { throw Error('queue write'); }, drain: () => { throw Error('drain'); },
    notify: () => { alerts++; return { ok: true }; },
  });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(alerts, 1);
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
      drain: () => {}, enqueue: args => { seen.push(args); assert.ok(order.includes(args.kind)); } });
    assert.equal(seen.length, delivery === 'ok' ? 1 : 0, `${kind} ${delivery}`);
    if (seen.length) { assert.equal(seen[0].kind, kind); assert.equal(seen[0].head, head); }
  }
});
