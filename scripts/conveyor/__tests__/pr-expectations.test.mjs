// @vitest-environment node
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, mkdirSync, truncateSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveActions, evaluateExpectations, resolveExpectationSettings, REACTIONS, ACTIONS } from '../pass-daemons/pr-expectations.mjs';
import { runUpdateBranch } from '../../operations/update-branch.mjs';
import { runExpectationPass, runExpectationCli, collectExpectationEvidence, readExpectationSettings } from '../pass-daemons/pr-expectation-pass.mjs';

const table = JSON.parse(readFileSync(fileURLToPath(new URL('../../settings/expectations.json', import.meta.url)), 'utf8'));
const settings = resolveExpectationSettings({ tool: table });
const sha = 'a'.repeat(40), next = 'b'.repeat(40);
const at = minutes => new Date(Date.UTC(2026, 10, 19) + minutes * 60000).toISOString();
const observation = (action, minutes = 0, head = sha) => ({ pr: 7, sha: head, action, at: at(minutes), source: `fixture:${action}:${minutes}` });
const evidence = (reactions = [], extra = {}) => ({ eventsReadable: true,
  prs: { 7: { sha, complete: true, reactions, ...extra } } });
const evaluate = (row, reactions, now, extra = {}) => evaluateExpectations({
  settings: resolveExpectationSettings({ tool: { mode: 'observe', expectations: [row] } }),
  actions: [observation(row.after[0])], evidence: evidence(reactions, extra), now })[0];

for (const row of table.expectations) {
  test(`${row.id}: met in time, met late, pending, missed, unreadable evidence`, () => {
    const reactions = minutes => REACTIONS[row.expect].map(group => observation(group[0], minutes));
    assert.equal(evaluate(row, reactions(1), at(2)).status, 'met');
    assert.equal(evaluate(row, reactions(1), at(2)).late, false);
    const late = evaluate(row, reactions(row.deadlineMinutes + 1), at(row.deadlineMinutes + 2));
    assert.equal(late.status, 'met'); assert.equal(late.late, true);
    assert.equal(evaluate(row, [], at(1)).status, 'pending');
    const missed = evaluate(row, [], at(row.deadlineMinutes + 1));
    assert.equal(missed.status, 'missed'); assert.equal(missed.minutesLate, 1);
    assert.equal(missed.wouldBeResponse, row.wouldBeResponse);
    assert.deepEqual(missed.evidenceRefs, [observation(row.after[0]).source]);
    assert.equal(evaluate(row, reactions(1), at(100), { complete: false }).status, 'unknown');
    assert.equal(evaluate(row, null, at(100)).status, 'unknown');
    assert.equal(evaluate(row, [null], at(100)).status, 'unknown');
  });
}
const row = table.expectations[0];
test('deadline boundary is pending exactly, missed 1 ms later; old/future reactions cannot satisfy', () => {
  assert.equal(evaluate(row, [], at(5)).status, 'pending');
  assert.equal(evaluate(row, [], new Date(Date.parse(at(5)) + 1).toISOString()).status, 'missed');
  assert.equal(evaluate(row, [observation('merge-gate-started', 5)], at(5)).status, 'met');
  assert.equal(evaluate(row, [observation('merge-gate-started', -1)], at(6)).status, 'missed');
  assert.equal(evaluate(row, [observation('merge-gate-started', 7)], at(6)).status, 'missed');
});
test('update-branch requires CI and either review or red team on the same head', () => {
  const update = table.expectations.find(r => r.id === 'update-no-restart');
  assert.equal(evaluate(update, [observation('ci-started', 1)], at(20)).status, 'missed');
  assert.equal(evaluate(update, [observation('ci-started', 1), observation('red-team-started', 2)], at(20)).status, 'met');
});
test('heartbeat must be a subsequent heartbeat; a new head supersedes old-sha expectations', () => {
  const beat = table.expectations.find(r => r.expect === 'next-heartbeat');
  assert.equal(evaluate(beat, [observation('change-lead-heartbeat')], at(16)).status, 'missed');
  const results = evaluateExpectations({ settings, actions: [observation('worker-push', 0, next), observation('ready-to-merge')],
    evidence: evidence([], { sha: next }), now: at(20) });
  assert.equal(results.length, 1); assert.equal(results[0].sha, next);
  assert.equal(results[0].expectationId, 'push-no-review');
});
test('mode off, observe, garbage; settings defaults and malformed/absent settings fail closed', () => {
  assert.equal(resolveExpectationSettings().mode, 'observe');
  for (const mode of ['off', 'observe', 'garbage']) {
    const config = resolveExpectationSettings({ tool: { ...table, mode } });
    assert.equal(config.mode, mode === 'observe' ? 'observe' : 'off');
  }
  for (const config of [undefined, {}, { ...settings, expectations: [{ id: 'broken' }] },
    resolveExpectationSettings({ tool: { ...table, expectations: [] } }),
    resolveExpectationSettings({ tool: table, readable: false })]) {
    const results = evaluateExpectations({ settings: config, actions: [observation('ready-to-merge')], evidence: evidence(), now: at(100) });
    assert.ok(results.length); assert.ok(results.every(r => r.status === 'unknown'));
  }
  assert.deepEqual(evaluateExpectations({ settings: { mode: 'off' } }), []);
  const oversized = Array.from({ length: 101 }, (_, i) => ({ ...row, id: `row-${i}` }));
  assert.equal(resolveExpectationSettings({ tool: { expectations: oversized } }).valid, false);
});
test('derive explicit head-bound events and timeline; unknown actions ignored, malformed known actions taint', () => {
  assert.deepEqual(deriveActions([{ kind: 'unrelated' }]), []);
  assert.equal(deriveActions(null), null);
  assert.deepEqual(deriveActions([{ kind: 'worker-push', pr: 7 }]), []);
  assert.deepEqual(deriveActions([{ pr: 7, kind: 'action', at: at(0), detail: { action: 'worker-push', head: sha } }]),
    [{ ...observation('worker-push'), source: 'daemon-events:1' }]);
  assert.deepEqual(deriveActions([], [observation('review-started')]), [observation('review-started')]);
});
test('real update-branch events bind the resulting head; unbindable triggers do not blind other PRs', () => {
  const updated = { kind: 'update-branch', repo: 'example/widgets', pr: 7, at: at(0),
    detail: { ok: true, status: 'updated', beforeHead: next, afterHead: sha } };
  assert.deepEqual(deriveActions([updated]), [{ ...observation('update-branch'), source: 'daemon-events:1' }]);
  assert.deepEqual(deriveActions([{ kind: 'update-branch', pr: 8, at: at(0), detail: {} },
    observation('worker-push')]), [observation('worker-push')]);
});
test('every supported action ignores missing bindings but rejects malformed explicit bindings', () => {
  for (const kind of ACTIONS) {
    assert.deepEqual(deriveActions([{ kind, pr: 7, at: at(0) }]), [], kind);
    assert.deepEqual(deriveActions([{ kind, sha, at: at(0) }]), [], kind);
    assert.equal(deriveActions([{ kind, pr: 7, sha: 'bad', at: at(0) }]), null, kind);
    assert.equal(deriveActions([{ kind, pr: 7, sha: null, at: at(0) }]), null, kind);
    assert.equal(deriveActions([{ kind, pr: '7', sha, at: at(0) }]), null, kind);
    assert.deepEqual(deriveActions([{ kind, pr: 7, sha, at: at(0) }]),
      [{ ...observation(kind), source: 'daemon-events:1' }]);
  }
});
test('update-branch producer contract: only confirmed head changes start a deadline', async () => {
  for (const scenario of ['updated', 'already-up-to-date', 'unconfirmed', 'failed']) {
    const events = []; let reads = 0;
    await runUpdateBranch({ repo: 'example/widgets', pr: 7, reason: 'contract test' }, {
      actor: () => 'fixture', sleep: async () => {}, update: async () => 202,
      readPr: async () => {
        if (scenario === 'failed') throw Error('unavailable');
        return { state: 'open', head: { sha: ++reads > 1 && scenario === 'updated' ? sha : next }, base: { ref: 'main' },
          mergeable: true, mergeable_state: 'behind' };
      },
      compare: async () => ({ behind_by: scenario === 'already-up-to-date' || (scenario === 'updated' && reads > 1) ? 0 : 1 }),
      append: async e => { events.push({ ...e, at: at(0) }); return true; },
    });
    assert.equal(deriveActions(events)?.length, scenario === 'updated' ? 1 : 0, scenario);
  }
});
function scratch(fn) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'expectations-'));
  const paths = { eventsFile: join(root, 'events.jsonl'), stateFile: join(root, 'state.json'), evidenceFile: join(root, 'evidence.json') };
  writeFileSync(paths.eventsFile, JSON.stringify({ ...observation('ready-to-merge'), repo: 'example/widgets' }) + '\n');
  writeFileSync(paths.evidenceFile, JSON.stringify(evidence()));
  return Promise.resolve().then(() => fn(paths, root)).finally(() => rmSync(root, { recursive: true, force: true }));
}
const options = paths => ({ ...paths, repo: 'example/widgets', settings, now: at(6), log() {}, gh() { throw Error('no gh permitted in replay'); } });
test('observe emits only expectation-missed; durable dedup across repeated passes and state reload', () => scratch(async paths => {
  const first = await runExpectationPass(options(paths));
  assert.equal(first.delivered, 1);
  const events = readFileSync(paths.eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.slice(1).map(e => e.kind), ['expectation-missed']);
  assert.equal(events[1].daemon, 'expectation-babysitter');
  assert.equal(events[1].detail.mode, 'observe');
  assert.deepEqual(events[1].detail, { pr: 7, sha, expectationId: row.id, action: 'ready-to-merge',
    actionAt: at(0), deadline: at(5), observedAt: at(6), minutesLate: 1,
    evidenceRefs: ['fixture:ready-to-merge:0'], wouldBeResponse: row.wouldBeResponse, mode: 'observe' });
  assert.equal((await runExpectationPass(options(paths))).delivered, 0);
  const saved = JSON.parse(readFileSync(paths.stateFile));
  writeFileSync(paths.stateFile, JSON.stringify(saved)); // simulate process restart: no memory receipts
  assert.equal((await runExpectationPass(options(paths))).delivered, 0);
}));
test('unreadable or malformed events/evidence/state never emit and never report met', () => scratch(async paths => {
  for (const file of [paths.eventsFile, paths.evidenceFile, paths.stateFile]) {
    writeFileSync(file, '{broken');
    const result = await runExpectationPass(options(paths));
    assert.equal(result.delivered, 0); assert.equal(result.incomplete, true);
    assert.ok(result.results.every(r => r.status === 'unknown'));
  }
  rmSync(paths.stateFile, { force: true }); rmSync(paths.eventsFile);
  writeFileSync(paths.evidenceFile, JSON.stringify(evidence([observation('merge-gate-started', 1)])));
  const result = await runExpectationPass(options(paths));
  assert.ok(result.results.length); assert.ok(result.results.every(r => r.status === 'unknown'));
}));
test('off performs no IO; replay paths are mandatory, distinct and cannot alias the live log', () => scratch(async (paths, root) => {
  assert.equal((await runExpectationPass({ settings: { mode: 'off' }, eventsFile: 'absent' })).delivered, 0);
  await assert.rejects(runExpectationPass({ settings, eventsFile: paths.eventsFile }), /replay requires/);
  const link = join(root, 'alias'); symlinkSync(paths.eventsFile, link);
  await assert.rejects(runExpectationPass({ ...options(paths), env: { WE_DAEMON_EVENTS: link } }), /scratch paths/);
  await assert.rejects(runExpectationCli({ 'as-of': at(1) }), /scratch replay/);
}));
test('failed delivery keeps its reservation and requires operator inspection without retry', () => scratch(async paths => {
  let attempts = 0; let ok = false;
  const opts = { ...options(paths), emitEvent() { attempts++; return ok; } };
  assert.equal((await runExpectationPass(opts)).incomplete, true);
  ok = true;
  assert.equal((await runExpectationPass(opts)).delivered, 0);
  assert.equal((await runExpectationPass(opts)).delivered, 0);
  assert.equal(attempts, 1);
}));
test('receipt is durable before delivery; failure saving after successful delivery cannot duplicate on restart', () => scratch(async paths => {
  let saves = 0, sends = 0;
  const opts = { ...options(paths), saveState(file, state) {
    if (++saves > 1) throw Error('disk full after delivery');
    writeFileSync(file, JSON.stringify(state));
  }, emitEvent() {
    sends++;
    assert.equal(Object.keys(JSON.parse(readFileSync(paths.stateFile)).prs[7].emitted).length, 1);
    return true;
  } };
  const first = await runExpectationPass(opts);
  assert.equal(first.incomplete, true); assert.equal(first.delivered, 1);
  assert.equal((await runExpectationPass({ ...opts, saveState: undefined })).delivered, 0);
  assert.equal(sends, 1);
}));
test('failed reservation save never delivers an event', () => scratch(async paths => {
  let sends = 0;
  const result = await runExpectationPass({ ...options(paths), saveState() { throw Error('disk full'); },
    emitEvent() { sends++; return true; } });
  assert.equal(result.incomplete, true); assert.equal(sends, 0);
}));
test('state growth beyond the byte cap refuses reservation before any event is sent', () => scratch(async paths => {
  const state = { version: 1, prs: {}, cursor: 0, padding: '' };
  state.padding = 'x'.repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(state)) - 10);
  writeFileSync(paths.stateFile, JSON.stringify(state));
  let sends = 0;
  const result = await runExpectationPass({ ...options(paths), emitEvent() { sends++; return true; } });
  assert.equal(result.incomplete, true); assert.equal(sends, 0);
  assert.ok(readFileSync(paths.stateFile).length < 16 * 1024 * 1024);
}));
test('an event with no sha (pr-merged) is ignored; a malformed sha still reads unknown', () => {
  assert.deepEqual(deriveActions([{ kind: 'pr-merged', pr: 5, at: at(0) }]), []);
  assert.equal(deriveActions([{ kind: 'pr-merged', pr: 5, sha: 'zz', at: at(0) }]), null);
});
test('own expectation-missed events are never triggers; unrelated checks are not review', () => {
  assert.deepEqual(deriveActions([{ kind: 'expectation-missed', pr: 1, detail: { action: 'worker-push', sha, at: at(0) }, at: at(0) }]), []);
});

function githubRead() {
  const calls = [];
  const gh = args => {
    calls.push(args);
    assert.equal(args[0], 'api');
    assert.ok(!args.includes('-X') && !args.includes('--method'));
    if (args[1] === 'graphql') {
      assert.match(args[3], /^query=query /); assert.ok(!/mutation/.test(args[3]));
      return { data: { repository: { pullRequest: { number: 7, headRefOid: sha,
        state: 'OPEN', mergedAt: null, mergeStateStatus: 'CLEAN', headRef: { target: { committedDate: at(-1) } },
        labels: { nodes: [{ name: 'ready-to-merge' }], pageInfo: { hasNextPage: false } }, mergeQueueEntry: null } } } };
    }
    if (args[1].includes('/timeline?')) return [];
    if (args[1].includes('/check-runs?')) return { total_count: 0, check_runs: [] };
    if (args[1].endsWith('/pulls/7')) return { state: 'open', head: { sha } };
    throw Error('unexpected gh read');
  };
  return { gh, calls };
}
test('live pass uses only gh GET/query reads and emits only expectation-missed', () => scratch(async paths => {
  const io = githubRead(), emitted = [];
  const opts = { repo: 'example/widgets', pr: 7, settings, now: at(0),
    stateFile: paths.stateFile, env: { WE_DAEMON_EVENTS: paths.eventsFile }, gh: io.gh,
    emitEvent(e) { emitted.push(e); return true; }, log() {} };
  assert.equal((await runExpectationPass(opts)).delivered, 0);
  assert.equal((await runExpectationPass({ ...opts, now: at(16) })).delivered, 2);
  assert.deepEqual(emitted.map(e => e.kind), ['expectation-missed', 'expectation-missed']);
  assert.ok(emitted.some(e => e.detail.expectationId === 'clean-not-enqueued'));
  assert.equal(io.calls.length, 8);
}));
const liveOptions = paths => ({ repo: 'example/widgets', settings, now: at(0),
  stateFile: paths.stateFile, env: { WE_DAEMON_EVENTS: paths.eventsFile }, log() {}, emitEvent: () => true });
test.each(['success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required', 'stale'])(
  'completed red-team %s settles the pending expectation after its label clears', conclusion => scratch(async paths => {
    const io = githubRead(); let completed = false;
    const opts = { ...liveOptions(paths), pr: 7, gh(args) {
      if (args[1].includes('/timeline?')) return [
        { event: 'labeled', label: { name: 'red-team:pending' }, created_at: at(0), id: 1 },
        ...(completed ? [{ event: 'unlabeled', label: { name: 'red-team:pending' }, created_at: at(5), id: 2 }] : []),
      ];
      if (args[1].includes('/check-runs?')) return { total_count: 1, check_runs: [{
        name: 'red-team', head_sha: sha, status: completed ? 'completed' : 'in_progress',
        started_at: at(0), completed_at: completed ? at(5) : null,
        conclusion: completed ? conclusion : null, id: 3,
      }] };
      const response = io.gh(args);
      if (args[1] === 'graphql') response.data.repository.pullRequest.labels.nodes = completed ? [] : [{ name: 'red-team:pending' }];
      return response;
    } };
    const first = await runExpectationPass(opts);
    assert.equal(first.results.find(r => r.expectationId === 'red-team-no-verdict')?.status, 'pending');
    completed = true;
    const result = await runExpectationPass({ ...opts, now: at(61) });
    assert.equal(result.incomplete, false);
    const verdict = result.results.find(r => r.expectationId === 'red-team-no-verdict');
    assert.equal(verdict?.status, 'met');
    assert.equal(verdict.reactionAt, at(5)); assert.equal(verdict.late, false);
    assert.equal(result.delivered, 0);
  }));
test.each(['review-gate', 'Review Gate', 'CI / review-gate (labels)'])(
  '%s and unit checks cannot satisfy review-started or update restart', name => scratch(async paths => {
    writeFileSync(paths.eventsFile, ['worker-push', 'update-branch'].map(action => JSON.stringify(observation(action))).join('\n') + '\n');
    const io = githubRead();
    const result = await runExpectationPass({ ...liveOptions(paths), pr: 7, now: at(16), gh(args) {
      if (args[1].includes('/check-runs?')) return { total_count: 2, check_runs: ['unit', name].map((checkName, id) => ({
        name: checkName, head_sha: sha, status: 'completed', conclusion: id ? 'failure' : 'success',
        started_at: at(1), completed_at: at(2), id,
      })) };
      return io.gh(args);
    } });
    assert.equal(result.incomplete, false);
    for (const id of ['push-no-review', 'update-no-restart'])
      assert.equal(result.results.find(r => r.expectationId === id)?.status, 'missed');
  }));
test('real review dispatch still satisfies review-started', () => {
  const io = githubRead();
  const collected = collectExpectationEvidence({ repo: 'example/widgets', pr: 7, now: at(16), read(args) {
    if (args[1].includes('/check-runs?')) return { total_count: 1, check_runs: [{
      name: 'AI review', head_sha: sha, status: 'in_progress', started_at: at(1), id: 1,
    }] };
    return io.gh(args);
  } });
  const result = evaluateExpectations({ settings, actions: [observation('worker-push')],
    evidence: { eventsReadable: true, prs: { 7: collected } }, now: at(16) });
  assert.equal(result.find(r => r.expectationId === 'push-no-review')?.status, 'met');
});
test('historical actions outside the collected set do not make the live pass incomplete', () => scratch(async paths => {
  writeFileSync(paths.eventsFile, JSON.stringify({ ...observation('worker-push'), pr: 99 }) + '\n');
  const io = githubRead();
  const result = await runExpectationPass({ ...liveOptions(paths), gh: args => args[1].includes('/pulls?') ? [{ number: 7, state: 'open' }] : io.gh(args) });
  assert.equal(result.incomplete, false);
  assert.ok(result.results.every(r => r.pr === 7));
  assert.equal(JSON.parse(readFileSync(paths.stateFile)).prs[99], undefined);
}));
test('merged and closed PRs are pruned after evaluation and absent from the next collection', () => scratch(async paths => {
  for (const state of ['MERGED', 'CLOSED']) {
    rmSync(paths.stateFile, { force: true });
    writeFileSync(paths.eventsFile, '');
    const io = githubRead(); let terminal = false; let reads = 0;
    const opts = { ...liveOptions(paths), gh(args) {
      if (args[1].includes('/pulls?')) return terminal ? [] : [{ number: 7, state: 'open' }];
      reads++;
      if (args[1].includes('/timeline?')) return [{ event: 'labeled', label: { name: 'ready-to-merge' },
        created_at: at(0), url: 'fixture:timeline' }];
      const response = io.gh(args);
      if (terminal && args[1] === 'graphql') Object.assign(response.data.repository.pullRequest,
        { state, headRef: null, mergedAt: state === 'MERGED' ? at(10) : null });
      if (terminal && args[1].endsWith('/pulls/7')) response.state = 'closed';
      return response;
    } };
    await runExpectationPass(opts); terminal = true;
    const final = await runExpectationPass({ ...opts, now: at(16) });
    assert.equal(final.incomplete, false);
    assert.ok(final.results.some(r => r.expectationId === 'ready-no-gate' && r.status === 'missed'));
    assert.equal(final.delivered, 1);
    assert.equal(JSON.parse(readFileSync(paths.stateFile)).prs[7], undefined);
    const before = reads;
    assert.equal((await runExpectationPass({ ...opts, now: at(17) })).incomplete, false);
    assert.equal(reads, before);
  }
}));
test('terminal state shrinks even when other tracked PRs exhaust the tick budget', () => scratch(async paths => {
  writeFileSync(paths.stateFile, JSON.stringify({ version: 1, cursor: 0, prs: Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [i + 1, { emitted: {}, observations: [{ ...observation('worker-push'), pr: i + 1 }] }])) }));
  const io = githubRead(); let calls = 0;
  const opts = { ...liveOptions(paths), now: at(16), gh(args) {
    calls++;
    if (args[1].includes('/pulls?')) return [];
    if (args[1] === 'graphql') {
      const response = io.gh(args);
      Object.assign(response.data.repository.pullRequest, { number: Number(args[3].match(/number: (\d+)/)[1]),
        state: 'MERGED', mergedAt: at(10), headRef: null });
      return response;
    }
    if (/\/pulls\/\d+$/.test(args[1])) return { state: 'closed', head: { sha } };
    return io.gh(args);
  } };
  assert.equal((await runExpectationPass(opts)).incomplete, true);
  assert.equal(calls, 128);
  assert.equal(Object.keys(JSON.parse(readFileSync(paths.stateFile)).prs).length, 9);
  assert.equal((await runExpectationPass(opts)).incomplete, false);
  assert.deepEqual(JSON.parse(readFileSync(paths.stateFile)).prs, {});
}));
test('a reopened PR during collection is unknown and cannot be retired', () => {
  const io = githubRead();
  assert.throws(() => collectExpectationEvidence({ repo: 'example/widgets', pr: 7, now: at(16), read(args) {
    const response = io.gh(args);
    if (args[1] === 'graphql') response.data.repository.pullRequest.state = 'CLOSED';
    return response;
  } }), /state changed/);
});
test('already-enqueued PR does not start an enqueue deadline, including after dequeue and requeue', () => scratch(async paths => {
  const io = githubRead(); let queued = true;
  const opts = { ...liveOptions(paths), pr: 7, gh(args) {
    const response = io.gh(args);
    if (args[1] === 'graphql') response.data.repository.pullRequest.mergeQueueEntry = queued ? { enqueuedAt: at(-0.5) } : null;
    return response;
  } };
  await runExpectationPass(opts);
  assert.ok(!(await runExpectationPass({ ...opts, now: at(16) })).results.some(r => r.expectationId === 'clean-not-enqueued'));
  queued = false;
  await runExpectationPass({ ...opts, now: at(17) });
  assert.ok((await runExpectationPass({ ...opts, now: at(33) })).results.some(r => r.expectationId === 'clean-not-enqueued' && r.status === 'missed'));
  queued = true;
  assert.ok(!(await runExpectationPass({ ...opts, now: at(34) })).results.some(r => r.expectationId === 'clean-not-enqueued'));
}));
test('bounded live log tail tolerates a torn append and preserves known triggers after rotation', () => scratch(async paths => {
  const io = githubRead(); const opts = { ...liveOptions(paths), pr: 7, gh: io.gh };
  const trigger = JSON.stringify(observation('worker-push'));
  writeFileSync(paths.eventsFile, JSON.stringify({ kind: 'unrelated', padding: 'x'.repeat(16 * 1024 * 1024) }) + '\n' + trigger + '\n{"kind":');
  assert.equal((await runExpectationPass(opts)).incomplete, false);
  writeFileSync(paths.eventsFile, JSON.stringify({ kind: 'unrelated' }) + '\n');
  const result = await runExpectationPass({ ...opts, now: at(16) });
  assert.equal(result.incomplete, false);
  assert.ok(result.results.some(r => r.expectationId === 'push-no-review' && r.status === 'missed'));
  writeFileSync(paths.eventsFile, '{broken}\n' + trigger + '\n');
  const corrupt = await runExpectationPass({ ...opts, now: at(17) });
  assert.equal(corrupt.incomplete, true); assert.equal(corrupt.delivered, 0);
}));
test('oversized timeline/checks and head races refuse evidence with operator fallback', () => {
  for (const scenario of ['timeline', 'checks', 'head']) {
    const io = githubRead();
    assert.throws(() => collectExpectationEvidence({ repo: 'example/widgets', pr: 7, now: at(10), read(args) {
      if (scenario === 'timeline' && args[1].includes('/timeline?')) return Array.from({ length: 100 }, () => ({ event: 'commented' }));
      if (scenario === 'checks' && args[1].includes('/check-runs?')) return { total_count: 101, check_runs: [] };
      if (scenario === 'head' && args[1].endsWith('/pulls/7')) return { head: { sha: next } };
      return io.gh(args);
    } }), /cap|head changed/);
  }
});
test('settings read through feature discovery and cascade with provenance; taint stays unknown', () => scratch((paths, root) => {
  const dir = join(root, 'settings'); mkdirSync(dir);
  const feature = join(dir, 'expectations.json'); writeFileSync(feature, JSON.stringify(table));
  const config = resolveExpectationSettings({ standard: { mode: 'observe' }, platform: { mode: 'off' }, tool: table,
    envValues: { mode: 'off' } });
  assert.equal(config.mode, 'off'); assert.equal(config.sources.mode, 'env');
  const lines = [];
  const resolved = readExpectationSettings({ settingsFiles: { dir, legacyPath: null },
    env: { WE_EXPECTATIONS_MODE: 'garbage', WE_PLATFORM_PREFERENCES_FILE: join(root, 'absent') }, log: line => lines.push(line) });
  assert.equal(resolved.mode, 'off'); assert.ok(lines[0].includes('policy-cascade'));
}));
test('unrelated settings taint preserves non-default expectation settings and evaluation', () => scratch(async (paths, root) => {
  const dir = join(root, 'settings'); mkdirSync(dir);
  const custom = { mode: 'observe', expectations: [{ ...row, deadlineMinutes: 2, wouldBeResponse: 'fixture response' }] };
  writeFileSync(join(dir, 'expectations.json'), JSON.stringify(custom));
  writeFileSync(join(dir, 'unrelated.json'), '{broken');
  const config = readExpectationSettings({ settingsFiles: { dir, legacyPath: null }, env: {
    WE_PLATFORM_PREFERENCES_FILE: join(root, 'absent') }, log() {} });
  assert.equal(config.valid, true); assert.deepEqual(config.expectations, custom.expectations);
  const result = await runExpectationPass({ ...options(paths), settings: config });
  assert.equal(result.delivered, 1); assert.equal(result.results[0].deadline, at(2));
  assert.equal(result.results[0].wouldBeResponse, 'fixture response');
}));

test('absent PR evidence and malformed settings retain known actions as unknown', () => {
  for (const missing of [undefined, {}, { prs: {} }]) {
    const result = evaluateExpectations({ settings, actions: [observation('ready-to-merge')], evidence: missing, now: at(100) });
    assert.ok(result.length); assert.ok(result.every(r => r.status === 'unknown'));
  }
  assert.match(resolveExpectationSettings({ tool: table, envValues: { mode: 'active' } }).sources.mode, /env.*invalid/);
});
test('new action timestamp can emit a new miss, superseded head cannot emit the old miss', () => scratch(async paths => {
  assert.equal((await runExpectationPass(options(paths))).delivered, 1);
  writeFileSync(paths.eventsFile, JSON.stringify(observation('ready-to-merge', 10)) + '\n');
  assert.equal((await runExpectationPass({ ...options(paths), now: at(16) })).delivered, 1);
  writeFileSync(paths.evidenceFile, JSON.stringify(evidence([], { sha: next })));
  const result = await runExpectationPass({ ...options(paths), now: at(100) });
  assert.equal(result.delivered, 0);
  assert.ok(!result.results.some(r => r.sha === sha && r.status === 'missed'));
}));
test('corrupt durable state, held lock, and oversized event input fail closed with operator fallback', () => scratch(async paths => {
  const messages = [];
  const opts = { ...options(paths), log: line => messages.push(line) };
  writeFileSync(paths.stateFile, '{bad');
  assert.equal((await runExpectationPass(opts)).delivered, 0);
  rmSync(paths.stateFile);
  mkdirSync(`${paths.stateFile}.lock`);
  assert.equal((await runExpectationPass(opts)).incomplete, true);
  rmSync(`${paths.stateFile}.lock`, { recursive: true });
  truncateSync(paths.eventsFile, 16 * 1024 * 1024 + 1);
  const capped = await runExpectationPass(opts);
  assert.equal(capped.delivered, 0); assert.equal(capped.incomplete, true);
  assert.ok(capped.results.every(r => r.status === 'unknown'));
  assert.ok(messages.every(m => /operator must inspect/.test(m)));
}));
test('GitHub readers share the 128-call tick budget and expose operator fallback on exhaustion', () => scratch(async paths => {
  const io = githubRead(); let count = 0; const messages = [];
  const result = await runExpectationPass({ repo: 'example/widgets', settings, now: at(0),
    stateFile: paths.stateFile, env: { WE_DAEMON_EVENTS: paths.eventsFile }, log: m => messages.push(m), gh(args) {
      count++;
      if (args[1].includes('/pulls?')) return args[1].endsWith('page=1')
        ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: 'open' })) : [];
      // Force ten timeline pages per PR to exercise budget shared with discovery.
      if (args[1] === 'graphql') {
        const response = io.gh(args);
        const n = Number(args[3].match(/number: (\d+)/)[1]);
        response.data.repository.pullRequest.number = n;
        return response;
      }
      if (args[1].includes('/timeline?')) return Array.from({ length: 100 }, () => ({ event: 'commented' }));
      throw Error('unexpected read');
    } });
  assert.equal(count, 128); assert.equal(result.incomplete, true); assert.equal(result.delivered, 0);
  assert.ok(messages.some(m => /operator must inspect/.test(m)));
}));

test('replay path matrix rejects every scratch role against both live destinations and canonical aliases before mutation', () => scratch(async (paths, root) => {
  const home = join(root, 'home');
  const liveEvents = join(root, 'protected', 'events.jsonl');
  const liveState = join(home, 'workspace', '.operations', 'handoff', 'state', 'expectation-babysitter', 'example--widgets.json');
  const protectedPaths = [liveEvents, liveState];
  for (const [index, target] of protectedPaths.entries()) {
    mkdirSync(dirname(target), { recursive: true });
    const aliasDir = join(root, `protected-alias-${index}`);
    symlinkSync(dirname(target), aliasDir);
    const alias = join(aliasDir, basename(target));
    for (const present of [false, true]) {
      if (present) writeFileSync(target, 'protected sentinel\n');
      for (const role of ['eventsFile', 'evidenceFile', 'stateFile']) {
        for (const candidate of [target, alias]) {
          let emissions = 0;
          await assert.rejects(runExpectationPass({ ...options(paths), home,
            env: { WE_DAEMON_EVENTS: liveEvents }, [role]: candidate,
            emitEvent() { emissions++; return true; },
          }), /scratch paths/, `${role} must reject ${candidate} (present=${present})`);
          assert.equal(emissions, 0);
          assert.equal(existsSync(target), present);
          if (present) assert.equal(readFileSync(target, 'utf8'), 'protected sentinel\n');
          assert.equal(existsSync(paths.stateFile), false);
          assert.equal(existsSync(`${paths.stateFile}.lock`), false);
          assert.equal(existsSync(`${target}.lock`), false);
        }
      }
      if (present) rmSync(target);
    }
  }
}));
