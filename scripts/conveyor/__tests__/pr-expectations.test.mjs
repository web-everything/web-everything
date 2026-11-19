// @vitest-environment node
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, mkdirSync, truncateSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveActions, evaluateExpectations, resolveExpectationSettings, REACTIONS } from '../pass-daemons/pr-expectations.mjs';
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
  assert.equal(deriveActions([{ kind: 'worker-push', pr: 7 }]), null);
  assert.deepEqual(deriveActions([{ pr: 7, kind: 'action', at: at(0), detail: { action: 'worker-push', head: sha } }]),
    [{ ...observation('worker-push'), source: 'daemon-events:1' }]);
  assert.deepEqual(deriveActions([], [observation('review-started')]), [observation('review-started')]);
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
test('failed delivery is not marked emitted: the next pass retries, then dedupes', () => scratch(async paths => {
  let attempts = 0; let ok = false;
  const opts = { ...options(paths), emitEvent() { attempts++; return ok; } };
  assert.equal((await runExpectationPass(opts)).incomplete, true);
  ok = true;
  assert.equal((await runExpectationPass(opts)).delivered, 1);
  assert.equal((await runExpectationPass(opts)).delivered, 0);
  assert.equal(attempts, 2);
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
        mergedAt: null, mergeStateStatus: 'CLEAN', headRef: { target: { committedDate: at(-1) } },
        labels: { nodes: [{ name: 'ready-to-merge' }], pageInfo: { hasNextPage: false } }, mergeQueueEntry: null } } } };
    }
    if (args[1].includes('/timeline?')) return [];
    if (args[1].includes('/check-runs?')) return { total_count: 0, check_runs: [] };
    if (args[1].endsWith('/pulls/7')) return { head: { sha } };
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
