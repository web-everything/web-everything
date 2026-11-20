// @vitest-environment node
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateStuck } from '../pass-daemons/stuck-rules.mjs';
import { readLogTail, runStuckCli, emitNewCauses } from '../stuck-prs.mjs';

// Daemon lines captured in sweep2/{7204,7042,7171,7112}.txt (operator why truncates them).
const drain = '[drain-daemon] 2026-11-20T16:11:37.513Z enqueue-on-event: catch-up #7204 catch-up, check_suite.completed=success — not woken: 1 check(s) still running (red-team';
const nothing = '2026-11-20T15:34:40.890Z reconcile-fix-dispatch-daemon: reconcile-refused nothing-owed web-everything/web-everything PR #7042 — phase `queued` — reviewed and qu';
const held = '2026-11-20T14:57:08.809Z reconcile-fix-dispatch-daemon: refused held web-everything/web-everything PR #7171 — a fix dispatch for PR #7171 is already claimed (he';
const capacity = '2026-11-20T16:14:51.166Z review-daemon: red-team queue hold web-everything/web-everything#7112: capacity; waiting for a later tick';
// Actual #7112 review line in review-daemon.log.1; it contains NO head binding.
const human = '2026-11-20T12:31:12.232Z review-daemon: web-everything/web-everything#7112 review:human, no review dispatched — review-hold-red: review daemon owns held gates: merge-gate';
const sha = '043ef6387185527abd691b0433aa51beb25bca7e';
const at = '2026-11-20T16:11:37.513Z', now = '2026-11-20T16:41:37.513Z';
const row = (line, time = at) => ({ at: time, line });
const pr = (number, labels = [], extra = {}) => ({ number, headSha: sha, labels, mergeStateStatus: 'CLEAN', ...extra });
const evaluate = (prs, logs = {}, claims = [], time = now) => evaluateStuck({ now: time, prs, logs, claims });
const rule = (records, name) => records.filter(r => r.rule === name);
const ready = pr(7204, ['review:accepted', 'red-team:clear']);

test('R-a: captured not-woken run reaches 30 minutes; first same-reason timestamp and ET', () => {
  const records = rule(evaluate([ready], { drain: [row(drain), row(drain, now)] }), 'R-a');
  assert.equal(records.length, 1); assert.equal(records[0].sinceET, '11:11');
  assert.equal(records[0].cause, 'B'); assert.match(records[0].link, /pull\/7204$/);
  assert.ok(records[0].evidence.length);
});
test('R-a negative: young, changed reason, intervening success, missing labels and non-CLEAN', () => {
  for (const logs of [[row(drain, now)], [row(drain), row(drain.replace('1 check(s)', '2 check(s)'), now)],
    [row(drain), row('catch-up #7204 — enqueued', now), row(drain, now)],
    [row(drain), row('pr-events(drain): marked #7204 — waking a pass', now)]]) {
    assert.deepEqual(rule(evaluate([ready], { drain: logs }), 'R-a'), []);
  }
  for (const p of [pr(7204), { ...ready, mergeStateStatus: 'BLOCKED' }])
    assert.deepEqual(rule(evaluate([p], { drain: [row(drain)] }), 'R-a'), []);
});
test('R-b: captured nothing-owed contradicts blocked or ci-red', () => {
  for (const label of ['red-team:blocked', 'status:ci-red'])
    assert.equal(rule(evaluate([pr(7042, [label])], { fix: [row(nothing)] }), 'R-b')[0].cause, 'C');
});
test('R-b negative: no owed label, newer progress, or another PR is the subject', () => {
  assert.deepEqual(evaluate([pr(7042)], { fix: [row(nothing)] }), []);
  assert.deepEqual(evaluate([pr(7042, ['red-team:blocked'])], { fix: [row(nothing), row('PR #7042 dispatched', now)] }), []);
  assert.deepEqual(evaluate([pr(7123, ['red-team:blocked'])], { fix: [row(nothing)] }), []);
  assert.deepEqual(evaluate([pr(7042, ['red-team:blocked'])], { fix: [row(nothing.replace('web-everything/web-everything', 'frontierui/frontierui'))] }), []);
});
test('R-c: explicitly dead fix or ci-heal claim; captured held line is evidence context', () => {
  for (const kind of ['fix', 'ci-heal']) assert.equal(rule(evaluate([pr(7171)], { fix: [row(held)] },
    [{ pr: 7171, kind, holder: 'fix-7171', live: false }]), 'R-c')[0].cause, 'D');
});
test('R-c negative: unknown/live holder and unrelated kinds never imply dead', () => {
  for (const live of [true, null, undefined]) assert.deepEqual(evaluate([pr(7171)], {}, [{ pr: 7171, kind: 'fix', holder: 'fix-7171', live }]), []);
  assert.deepEqual(evaluate([pr(7171)], {}, [{ pr: 7171, kind: 'review', live: false }]), []);
});
test('R-d: real human-pending grammar with explicit live-head binding and accepted label', () => {
  // Augment the captured line with an explicit binding; the unbound original is tested below.
  const records = rule(evaluate([pr(7112, ['review:accepted'])], { review: [row(`${human} head=${sha}`)] }), 'R-d');
  assert.equal(records.length, 1); assert.equal(records[0].cause, 'B');
  assert.equal(rule(evaluate([pr(7112)], { review: [row(`${human} head=${sha}`),
    row(`review-daemon: web-everything/web-everything#7112 clear-human head=${sha}`, now)] }), 'R-d').length, 1);
});
test('R-d negative: captured #7112 capacity/unbound human, stale head, no acceptance, later settled run', () => {
  for (const lines of [[human], [capacity], [`${human} head=${'b'.repeat(40)}`],
    [`${human} head=${sha}`, `review-daemon: web-everything/web-everything#7112 review:accepted head=${sha}`]])
    assert.deepEqual(rule(evaluate([pr(7112, ['review:accepted'])], { review: lines.map(l => row(l)) }), 'R-d'), []);
  assert.deepEqual(evaluate([pr(7112)], { review: [row(`${human} head=${sha}`)] }), []);
});
test('R-e: three captured same-daemon refusals ignore timestamps and seq numbers', () => {
  const lines = [1, 2, 3].map(n => row(`${nothing} seq ${n}`, new Date(Date.parse(at) + n).toISOString()));
  assert.equal(rule(evaluate([pr(7042)], { fix: lines }), 'R-e')[0].cause, 'E');
  assert.equal(rule(evaluate([pr(7112)], { review: [row(human), row(human), row(human)] }), 'R-e')[0].cause, 'E');
});
test('R-e negative: two mentions, intervening progress/reason, or mixed daemons', () => {
  for (const logs of [{ fix: [row(nothing), row(nothing)] },
    { fix: [row(nothing), row('PR #7042 dispatched'), row(nothing)] },
    { fix: [row(nothing), row(nothing.replace('nothing-owed', 'other-refusal')), row(nothing)] },
    { fix: [row(nothing), row(nothing)], drain: [row(nothing)] }])
    assert.deepEqual(rule(evaluate([pr(7042)], logs), 'R-e'), []);
});
test('unknown/missing/malformed/future evidence fails closed', () => {
  assert.deepEqual(evaluate(null), []);
  for (const logs of [{}, { fix: null }, { fix: [{ line: nothing }] }, { fix: [row(nothing, 'bad')] },
    { fix: [row(nothing, '2099-01-01T00:00:00Z')] }, { fix: [row(nothing), null] }])
    assert.deepEqual(evaluate([pr(7042, ['red-team:blocked'])], logs), []);
});
test('R-a known head-moved cause A and unknown reason NEW; independent evidence and inputs stay intact', () => {
  const moved = drain.replace(/not woken:.*/, 'not enqueued: head moved since the pass-start decision');
  const unknown = drain.replace(/not woken:.*/, 'not enqueued: unrecognised refusal');
  assert.equal(evaluate([ready], { drain: [row(moved)] })[0].cause, 'A');
  const input = { now, prs: [ready], logs: { drain: [row(unknown)], fix: null }, claims: null };
  const original = JSON.stringify(input);
  assert.equal(evaluateStuck(input)[0].cause, 'NEW'); assert.equal(JSON.stringify(input), original);
});
const scratch = fn => { const dir = mkdtempSync(join(tmpdir(), 'stuck-prs-')); return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true })); };
test('bounded tail drops cut first and incomplete last lines; missing is unknown; warns on oversized input', () => scratch(dir => {
  const path = join(dir, 'log'), warnings = [];
  writeFileSync(path, `${'x'.repeat(150)}\n${nothing}\nunfinished`);
  const rows = readLogTail(path, { maxBytes: 260, warn: s => warnings.push(s) });
  assert.equal(rows.length, 1); assert.equal(rows[0].line, nothing); assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tail|inspect/i); assert.equal(readLogTail(join(dir, 'absent'), { warn: () => {} }), null);
}));
test('CLI: one batched PR read, no mutation, empty/json/md output and listing cap escalation', async () => {
  const calls = [], warnings = [], base = { readPrs: args => { calls.push(args); return [ready]; },
    readLogs: () => ({ drain: [row(drain)] }), readClaims: () => [], now: () => now, emit: async () => {} };
  assert.match(await runStuckCli(['--md'], base), /^#7204 R-a \(cause B\) since 11:11 ET https:/);
  assert.equal(calls.length, 1); assert.ok(calls[0].includes('200')); assert.ok(calls[0].includes('number,headRefOid,labels,mergeStateStatus'));
  assert.equal(await runStuckCli(['--json'], { ...base, readPrs: () => [] }), 'none');
  assert.equal(JSON.parse(await runStuckCli(['--json'], base))[0].pr, 7204);
  assert.equal(await runStuckCli([], { ...base, readPrs: () => { throw Error('unreadable'); }, warn: s => warnings.push(s) }), 'none');
  await runStuckCli([], { ...base, readPrs: () => Array(200).fill(ready), warn: s => warnings.push(s) });
  assert.ok(warnings.some(s => /200.*inspect/.test(s)));
});
test('NEW cause event is at most once per PR/rule/head, known causes never emit; failed reservation never sends', () => scratch(async dir => {
  const path = join(dir, 'state.json'), events = [], record = { pr: 7, rule: 'R-a', cause: 'NEW', evidence: ['unknown refusal'], sinceET: '11:11', link: 'link' };
  const opts = { statePath: path, send: async e => { events.push(e); return true; }, warn: () => {} };
  const prs = [pr(7)];
  await emitNewCauses([record, { ...record, cause: 'A' }], prs, opts);
  await emitNewCauses([record], prs, opts);
  assert.equal(events.length, 1); assert.equal(events[0].detail.needsYou, true);
  await emitNewCauses([record], [pr(7, [], { headSha: 'b'.repeat(40) })], opts);
  assert.equal(events.length, 2); assert.ok(readFileSync(path, 'utf8').includes(sha));
  await emitNewCauses([record], prs, { ...opts, statePath: join(dir, 'missing', 'state.json') });
  assert.equal(events.length, 2);
}));
test('event receipt closed paths: corrupt/oversized state and concurrent lock never emit; failed append stays reserved', () => scratch(async dir => {
  const record = { pr: 7, rule: 'R-a', cause: 'NEW' }, events = [], warnings = [];
  const statePath = join(dir, 'state.json'), opts = { statePath, warn: s => warnings.push(s),
    send: async e => { events.push(e); return false; } };
  for (const content of ['corrupt', 'x'.repeat(256 * 1024 + 1)]) {
    writeFileSync(statePath, content); await emitNewCauses([record], [pr(7)], opts);
  }
  assert.equal(events.length, 0); assert.equal(warnings.length, 2);
  writeFileSync(statePath, '[]');
  await Promise.all([emitNewCauses([record], [pr(7)], opts), emitNewCauses([record], [pr(7)], opts)]);
  await emitNewCauses([record], [pr(7)], opts);
  assert.equal(events.length, 1); assert.ok(warnings.some(s => /append failed/.test(s)));
}));
