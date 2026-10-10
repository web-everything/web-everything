// @vitest-environment node
/**
 * Card xx7ckd6 N1 — the red-main QUARANTINE safety net's auto add/prune (we:scripts/lib/red-main-quarantine-io.mjs
 * `runSafetyNet`, hooked on the `main-ci-red` health smell). Replays today's red main: last green c3c3ba71d, first
 * red 2cb94418d (run 38077022020, 2026-10-10 18:44Z), failing job `test-shard (3)` + its aggregator `test`, one failing
 * test `scripts/operations/__tests__/record-referral-ruling.test.mjs > #4979 the sanctioned writer > …`.
 * With `redMainMode: stop` (the shipped setting) it only logs what it WOULD do.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as quarantine from '../../lib/red-main-quarantine.mjs';
const { parseVitestFailures, planSafetyNet, addEntries, pruneOnGreen, setMode, validateQuarantineList } = quarantine;
import { runSafetyNet, resolveQuarantineSettings, readListOrAbsent, SAFETY_NET_SHADOW_LOG, SAFETY_NET_LEDGER } from '../../lib/red-main-quarantine-io.mjs';
import smell, { defaultQuarantineSafetyNet } from '../health-smells/main-ci-red.mjs';

const TEST_FILE = 'scripts/operations/__tests__/record-referral-ruling.test.mjs';
const TEST_NAME = '#4979 the sanctioned writer > the reader hands the ruled PR and its head to the card resolver';
const FIRST_RED = '2cb94418d3d95e9d64ca59ce6de789a319a6718c';
const T = (iso) => Date.parse(iso);
const MIN = 60_000;

// Main's CI runs around the break (real, from `gh run list --workflow ci.yml --branch main`).
const GREEN = { databaseId: 38076234498, status: 'completed', conclusion: 'success', headSha: 'c3c3ba71d389e04b3c883ddf584243c37a9c3e73', createdAt: '2026-10-10T18:33:07Z', updatedAt: '2026-10-10T18:44:56Z', event: 'push' };
const CANCELLED = { databaseId: 38076915712, status: 'completed', conclusion: 'cancelled', headSha: 'a4d09c6916ff259b15b744bf603499264cfd7685', createdAt: '2026-10-10T18:43:16Z', updatedAt: '2026-10-10T18:44:53Z', event: 'push' };
const RED = { databaseId: 38077022020, status: 'completed', conclusion: 'failure', headSha: FIRST_RED, createdAt: '2026-10-10T18:44:51Z', updatedAt: '2026-10-10T18:54:42Z', event: 'push' };
const LATER_GREEN = { databaseId: 99, status: 'completed', conclusion: 'success', headSha: 'd'.repeat(40), createdAt: '2026-10-10T20:00:00Z', updatedAt: '2026-10-10T20:12:00Z', event: 'push' };
const RED_RUNS = [RED, CANCELLED, GREEN];
const FAILING = { jobs: ['test-shard (3)', 'test'], tests: [], runId: 38077022020 };
const JOBS = { failed: [{ id: 114286123395, name: 'test-shard (3)' }, { id: 114287958124, name: 'test' }] };

// The real log lines of job 114286123395 (ANSI colour + GitHub timestamps kept).
const E = '\x1b';
const LOG = [
  `2026-10-10T18:51:42.2758298Z  ${E}[32m✓${E}[39m scripts/conveyor/__tests__/review-side-import-cycle.test.mjs ${E}[2m (${E}[22m${E}[2m7 tests${E}[22m${E}[2m)${E}[22m`,
  `2026-10-10T18:51:42.3015305Z ${E}[31m⎯⎯⎯⎯⎯⎯⎯${E}[1m${E}[7m Failed Tests 1 ${E}[27m${E}[22m⎯⎯⎯⎯⎯⎯⎯${E}[39m`,
  `2026-10-10T18:51:42.3059106Z ${E}[31m${E}[1m${E}[7m FAIL ${E}[27m${E}[22m${E}[39m ${TEST_FILE}${E}[2m > ${E}[22m#4979 the sanctioned writer${E}[2m > ${E}[22mthe reader hands the ruled PR and its head to the card resolver`,
  `2026-10-10T18:51:42.3088534Z ${E}[31m${E}[1mAssertionError${E}[22m: expected [] to deeply equal [ { repo: 'o/r', pr: 7, …(1) } ]${E}[39m`,
  `2026-10-10T18:51:42.3315589Z ${E}[2m Test Files ${E}[22m ${E}[1m${E}[31m1 failed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[1m${E}[32m242 passed${E}[39m${E}[22m${E}[90m (243)${E}[39m`,
  `2026-10-10T18:51:42.3345065Z ${E}[2m      Tests ${E}[22m ${E}[1m${E}[31m1 failed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[1m${E}[32m8244 passed${E}[39m`,
].join('\n');

const STOP = { value: 'stop', source: 'settings' };
const QUARANTINE = { value: 'quarantine', source: 'env' };
const SETTINGS = resolveQuarantineSettings({ env: {}, file: '/nonexistent', platform: null });

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rmq-auto-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function net(o) {
  const calls = { jobs: 0, logs: 0, writes: [], reads: 0, logLines: [] };
  const r = runSafetyNet({
    dir, settings: SETTINGS, mode: STOP, live: true,
    readJobs: () => { calls.jobs += 1; return JOBS; },
    readLog: () => { calls.logs += 1; return parseVitestFailures(LOG); },
    readList: () => { calls.reads += 1; return { ok: true, list: o.list ?? { version: 1, entries: [] } }; },
    write: (w) => { calls.writes.push(w); return { events: [] }; },
    log: (l) => calls.logLines.push(l),
    ...o,
  });
  return { r, calls };
}
const shadowLines = () => (existsSync(join(dir, SAFETY_NET_SHADOW_LOG)) ? readFileSync(join(dir, SAFETY_NET_SHADOW_LOG), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('parseVitestFailures — a CI job log', () => {
  it('names the failing file and test from the real 2026-10-10 log, complete against the summary', () => {
    const f = parseVitestFailures(LOG);
    expect(f.files).toEqual([TEST_FILE]);
    expect(f.tests).toEqual([{ file: TEST_FILE, name: TEST_NAME }]);
    expect(f.complete).toBe(true);
  });
  it('a log with no summary line (crash, cut-off) is not complete', () => {
    expect(parseVitestFailures(LOG.split('\n').slice(0, 3).join('\n')).complete).toBe(false);
  });
  it('a summary naming more failed files than were parsed is not complete', () => {
    expect(parseVitestFailures(LOG.replace('1 failed', '2 failed')).complete).toBe(false);
  });
  it('a suite that failed to load (`FAIL file [ file ]`) is still a failing file', () => {
    const f = parseVitestFailures(` FAIL  a/__tests__/x.test.mjs [ a/__tests__/x.test.mjs ]\n Test Files  1 failed | 3 passed (4)`);
    expect(f.files).toEqual(['a/__tests__/x.test.mjs']);
    expect(f.complete).toBe(true);
  });
  it('an unsafe path is never a test id', () => {
    expect(parseVitestFailures(' FAIL ../etc/x.test.mjs\n FAIL a/$(rm).test.mjs\n Test Files  2 failed').files).toEqual([]);
  });
});

describe('planSafetyNet — pure rules', () => {
  const jf = { 'test-shard (3)': parseVitestFailures(LOG) };
  const now = T('2026-10-10T19:00:00Z');
  it('main red on a known failing test ⇒ add exactly that file', () => {
    const p = planSafetyNet({ status: 'red', firstRedSha: FIRST_RED, failedJobs: FAILING.jobs, jobFailures: jf, list: { version: 1, entries: [] }, fixPrs: null, now });
    expect(p).toMatchObject({ action: 'add', tests: [TEST_FILE] });
    expect(p.names).toEqual([`${TEST_FILE} > ${TEST_NAME}`]);
  });
  it('a failed job outside the unit suite ⇒ none (quarantine cannot skip it; STOP holds)', () => {
    expect(planSafetyNet({ status: 'red', firstRedSha: FIRST_RED, failedJobs: [...FAILING.jobs, 'smoke'], jobFailures: jf, list: { version: 1, entries: [] }, now }).action).toBe('none');
  });
  it('a unit job whose failing tests are unknown ⇒ none', () => {
    expect(planSafetyNet({ status: 'red', firstRedSha: FIRST_RED, failedJobs: FAILING.jobs, jobFailures: { 'test-shard (3)': null }, list: { version: 1, entries: [] }, now }).action).toBe('none');
  });
  it('more failing files than maxTests ⇒ none', () => {
    const many = { files: ['a/1.test.mjs', 'a/2.test.mjs'], tests: [], complete: true };
    expect(planSafetyNet({ status: 'red', firstRedSha: FIRST_RED, failedJobs: ['test-shard (1)'], jobFailures: { 'test-shard (1)': many }, list: { version: 1, entries: [] }, now, settings: { maxTests: 1 } }).action).toBe('none');
  });
  it('main green with entries ⇒ prune (main-green)', () => {
    const list = addEntries(null, { tests: [TEST_FILE], brokenSha: FIRST_RED, owner: 'o', reason: 'r', actor: 'red-main-safety-net', now }).list;
    expect(planSafetyNet({ status: 'green', list, now })).toMatchObject({ action: 'prune', mainGreen: true });
  });
  it('an entry for this red that already expired is never re-added (stale-entry guard)', () => {
    const p = planSafetyNet({ status: 'red', firstRedSha: FIRST_RED, failedJobs: FAILING.jobs, jobFailures: jf, list: { version: 1, entries: [] }, addedForRed: [TEST_FILE], now });
    expect(p.action).toBe('none');
    expect(p.why).toMatch(/expired — STOP/);
  });
  it('unknown main state ⇒ none', () => {
    expect(planSafetyNet({ status: 'unknown', now }).action).toBe('none');
  });
});

describe('runSafetyNet — replay of 2026-10-10 (first red 2cb94418d)', () => {
  const at = T('2026-10-10T18:56:00Z');
  it('SHADOW (redMainMode stop): logs that it WOULD add exactly record-referral-ruling.test.mjs; writes nothing', () => {
    const { r, calls } = net({ mainCiRuns: { runs: RED_RUNS, failing: FAILING, priority: null }, now: at });
    expect(r).toMatchObject({ mode: 'stop', shadow: true, applied: false });
    expect(r.plan).toMatchObject({ action: 'add', tests: [TEST_FILE] });
    expect(calls.writes).toEqual([]);
    expect(calls.reads).toBe(0); // shadow never even reads the live list
    const lines = shadowLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ wouldDo: 'add', tests: [TEST_FILE], firstRedSha: FIRST_RED, mode: 'stop', modeSource: 'settings' });
    expect(lines[0].names).toEqual([`${TEST_FILE} > ${TEST_NAME}`]);
    expect(lines[0].settingsSources).toMatchObject({ ttlMin: 'standard', maxTests: 'standard' });
    expect(calls.logLines.join('\n')).toMatch(/WOULD add scripts\/operations\/__tests__\/record-referral-ruling\.test\.mjs/);
  });
  it('reads the job logs once per red window and adds once; later ticks are quiet', () => {
    const first = net({ mainCiRuns: { runs: RED_RUNS, failing: FAILING, priority: null }, now: at });
    const second = net({ mainCiRuns: { runs: RED_RUNS, failing: FAILING, priority: null }, now: at + MIN });
    expect(first.calls.logs).toBe(1);
    expect(second.calls.logs).toBe(0);
    expect(second.r.plan.action).toBe('none');
    expect(shadowLines()).toHaveLength(1);
  });
  it('the fix PR set rides on the list once one is published', () => {
    net({ mainCiRuns: { runs: RED_RUNS, failing: FAILING, priority: null }, now: at });
    const r = net({ mainCiRuns: { runs: RED_RUNS, failing: FAILING, priority: { pr: 4980, prs: [4980] } }, now: at + MIN }).r;
    expect(r.plan.fixPrs).toEqual([4980]);
    expect(shadowLines()[1]).toMatchObject({ wouldDo: 'none', fixPrs: [4980] });
    expect(JSON.parse(readFileSync(join(dir, SAFETY_NET_LEDGER), 'utf8')).shadowList.fixPrs).toEqual([4980]);
  });
  it('PRUNE on green: the shadow list empties and the log says it would prune', () => {
    net({ mainCiRuns: { runs: RED_RUNS, failing: FAILING, priority: null }, now: at });
    const g = net({ mainCiRuns: { runs: [LATER_GREEN, ...RED_RUNS], failing: { jobs: [], tests: [] }, priority: null }, now: T('2026-10-10T20:13:00Z') });
    expect(g.r.plan).toMatchObject({ action: 'prune', mainGreen: true });
    expect(shadowLines().at(-1)).toMatchObject({ wouldDo: 'prune' });
    expect(JSON.parse(readFileSync(join(dir, SAFETY_NET_LEDGER), 'utf8')).shadowList.entries).toEqual([]);
    // green again next tick: nothing more to do
    expect(net({ mainCiRuns: { runs: [LATER_GREEN, ...RED_RUNS], failing: { jobs: [], tests: [] } }, now: T('2026-10-10T20:14:00Z') }).r.plan.action).toBe('none');
  });
  it('LIVE (redMainMode quarantine): writes the add as red-main-safety-net with the file entry', () => {
    const { r, calls } = net({ mode: QUARANTINE, mainCiRuns: { runs: RED_RUNS, failing: FAILING, priority: { pr: 4980, prs: [4980] } }, now: at });
    expect(r).toMatchObject({ shadow: false, applied: true });
    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0].actor).toBe('red-main-safety-net');
    const res = calls.writes[0].change({ version: 1, entries: [] });
    expect(res.ok).toBe(true);
    expect(res.list.entries.map((e) => [e.test, e.brokenSha, e.owner])).toEqual([[TEST_FILE, FIRST_RED, 'red-main-safety-net']]);
    expect(res.list.entries[0].expiresAt - res.list.entries[0].addedAt).toBe(360 * MIN);
    expect(res.list.fixPrs).toEqual([4980]);
    expect(shadowLines()).toEqual([]);
  });
  it('LIVE but a replay/dry-run tick (`live:false`) stays shadow', () => {
    const { r, calls } = net({ mode: QUARANTINE, live: false, mainCiRuns: { runs: RED_RUNS, failing: FAILING }, now: at });
    expect(r.shadow).toBe(true);
    expect(calls.writes).toEqual([]);
  });
  it('LIVE with an unreadable list does nothing (fail closed)', () => {
    const { r, calls } = net({ mode: QUARANTINE, readList: () => ({ ok: false, error: 'fetch failed' }), mainCiRuns: { runs: RED_RUNS, failing: FAILING }, now: at });
    expect(r.plan.action).toBe('none');
    expect(calls.writes).toEqual([]);
  });
  it('no dir ⇒ does nothing', () => {
    expect(runSafetyNet({ mainCiRuns: { runs: RED_RUNS, failing: FAILING } })).toBeNull();
  });
});

describe('runSafetyNet — review round 1 (PR #4816)', () => {
  const at = T('2026-10-10T18:56:00Z');
  const RUNS = { runs: RED_RUNS, failing: FAILING, priority: null };
  const flaky = (n) => { let left = n; return () => { if (left-- > 0) throw new Error('rate limited'); return parseVitestFailures(LOG); }; };

  it('a failed log read is retried on a later tick (after its backoff), not cached for the red window', () => {
    const first = net({ mainCiRuns: RUNS, now: at, readLog: flaky(1) });
    expect(first.r.plan.action).toBe('none');
    expect(first.r.plan.why).toMatch(/unknown/);
    const early = net({ mainCiRuns: RUNS, now: at + 10_000 });
    expect(early.calls.logs).toBe(0); // inside the backoff: no hammering of a rate-limited API
    expect(early.r.plan.action).toBe('none');
    const later = net({ mainCiRuns: RUNS, now: at + 2 * MIN });
    expect(later.calls.logs).toBe(1);
    expect(later.r.plan).toMatchObject({ action: 'add', tests: [TEST_FILE] });
    // now it IS cached: a further tick reads nothing
    expect(net({ mainCiRuns: RUNS, now: at + 3 * MIN }).calls.logs).toBe(0);
  });
  it('a failed jobs-list read is retried too', () => {
    let throws = 1;
    const readJobs = () => { if (throws-- > 0) throw new Error('timeout'); return JOBS; };
    expect(net({ mainCiRuns: RUNS, now: at, readJobs }).r.plan.action).toBe('none');
    expect(net({ mainCiRuns: RUNS, now: at + 2 * MIN, readJobs }).r.plan).toMatchObject({ action: 'add', tests: [TEST_FILE] });
  });
  it('the retry backoff grows while reads keep failing', () => {
    const bad = () => { throw new Error('rate limited'); };
    net({ mainCiRuns: RUNS, now: at, readLog: bad });
    net({ mainCiRuns: RUNS, now: at + 2 * MIN, readLog: bad });
    expect(net({ mainCiRuns: RUNS, now: at + 3 * MIN }).calls.logs).toBe(0); // 2nd failure ⇒ 2 min backoff
    expect(net({ mainCiRuns: RUNS, now: at + 5 * MIN }).calls.logs).toBe(1);
  });

  it('an incomplete parse (cut-off / still-uploading log) is retried, not cached as the answer', () => {
    const partial = parseVitestFailures(LOG.split('\n').slice(0, 3).join('\n'));
    expect(partial.complete).toBe(false);
    expect(net({ mainCiRuns: RUNS, now: at, readLog: () => partial }).r.plan.action).toBe('none');
    expect(net({ mainCiRuns: RUNS, now: at + 2 * MIN }).r.plan).toMatchObject({ action: 'add', tests: [TEST_FILE] });
  });
  it('a re-run of the same run id (new updatedAt) is read again', () => {
    expect(net({ mainCiRuns: RUNS, now: at }).calls.logs).toBe(1);
    const rerun = { ...RUNS, runs: RED_RUNS.map((r) => (r === RED ? { ...RED, updatedAt: '2026-10-10T19:30:00Z' } : r)) };
    expect(net({ mainCiRuns: rerun, now: at + MIN }).calls.logs).toBe(1);
    expect(net({ mainCiRuns: rerun, now: at + 2 * MIN }).calls.logs).toBe(0);
  });
  it('a live push that throws after landing is still withdrawable on a flip back to stop', () => {
    const boom = net({ mode: QUARANTINE, mainCiRuns: RUNS, now: at, write: () => { throw new Error('push timed out'); } });
    expect(boom.r.error).toMatch(/push timed out/);
    const stamped = { version: 1, entries: [], mode: 'quarantine' };
    const stopped = net({ mode: STOP, mainCiRuns: RUNS, list: stamped, now: at + MIN });
    expect(stopped.calls.writes).toHaveLength(1);
    expect(stopped.calls.writes[0].change(stamped).list.mode).toBe('stop');
  });
  it('a prune-only live write does not mark the mode as published', () => {
    const list = addEntries(null, { tests: [TEST_FILE], brokenSha: FIRST_RED, owner: 'o', reason: 'r', actor: 'red-main-safety-net', now: at }).list; // unstamped
    const g = net({ mode: QUARANTINE, mainCiRuns: { runs: [LATER_GREEN, ...RED_RUNS], failing: { jobs: [], tests: [] } }, list, now: at + MIN });
    expect(g.r.plan.action).toBe('prune');
    expect(net({ mode: STOP, mainCiRuns: RUNS, list: { version: 1, entries: [], mode: 'quarantine' }, now: at + 2 * MIN }).calls.reads).toBe(0);
  });

  it('a shadow add does not stop the first LIVE add of the same red window (stop → quarantine)', () => {
    const shadow = net({ mainCiRuns: RUNS, now: at });
    expect(shadow.r.plan.action).toBe('add');
    const live = net({ mode: QUARANTINE, mainCiRuns: RUNS, now: at + MIN });
    expect(live.r.plan).toMatchObject({ action: 'add', tests: [TEST_FILE] });
    expect(live.calls.writes).toHaveLength(1);
  });

  it('an active red stays non-renewable beyond the ledger retention (no re-add of an expired entry)', () => {
    const t0 = at;
    const first = net({ mode: QUARANTINE, mainCiRuns: RUNS, now: t0 });
    const entry = first.calls.writes[0].change({ version: 1, entries: [] }).list;
    const afterTtl = net({ mode: QUARANTINE, mainCiRuns: RUNS, list: entry, now: t0 + 7 * 60 * MIN });
    expect(afterTtl.r.plan.why).toMatch(/expired — STOP/);
    net({ mode: QUARANTINE, mainCiRuns: RUNS, list: entry, now: t0 + 49 * 60 * MIN }); // the tick that used to evict the live window's record
    const wayLater = net({ mode: QUARANTINE, mainCiRuns: RUNS, list: entry, now: t0 + 50 * 60 * MIN });
    expect(wayLater.r.plan.why).toMatch(/expired — STOP/);
    expect(wayLater.calls.writes.every((w) => w.change(entry).events?.every((e) => e.type !== 'quarantine-added'))).toBe(true);
    expect(wayLater.calls.logs).toBe(0); // the record (and its log cache) survived
  });
  it('a red window that has not been seen for 48h is forgotten', () => {
    net({ mainCiRuns: RUNS, now: at });
    net({ mainCiRuns: { runs: [LATER_GREEN, ...RED_RUNS], failing: { jobs: [], tests: [] } }, now: at + 49 * 60 * MIN });
    expect(Object.keys(JSON.parse(readFileSync(join(dir, SAFETY_NET_LEDGER), 'utf8')).reds)).toEqual([]);
  });

  it('LIVE publishes the effective mode on the list, so CI reads the same switch as the daemon', () => {
    const { calls } = net({ mode: QUARANTINE, mainCiRuns: RUNS, now: at });
    expect(calls.writes[0].change({ version: 1, entries: [] }).list.mode).toBe('quarantine');
  });
  it('LIVE re-stamps the mode when live entries exist but the stamp is missing (stop → quarantine flip)', () => {
    const first = net({ mode: QUARANTINE, mainCiRuns: RUNS, now: at });
    const unstamped = { ...first.calls.writes[0].change({ version: 1, entries: [] }).list };
    delete unstamped.mode;
    const { calls } = net({ mode: QUARANTINE, mainCiRuns: RUNS, list: unstamped, now: at + MIN });
    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0].change(unstamped).list.mode).toBe('quarantine');
  });
  it('flipping back to stop withdraws a stamp the daemon published; a daemon that never published writes nothing', () => {
    const never = net({ mode: STOP, mainCiRuns: RUNS, now: at });
    expect(never.calls.writes).toEqual([]);
    expect(never.calls.reads).toBe(0);
    const live = net({ mode: QUARANTINE, mainCiRuns: RUNS, now: at + MIN });
    const stamped = live.calls.writes[0].change({ version: 1, entries: [] }).list;
    const stopped = net({ mode: STOP, mainCiRuns: RUNS, list: stamped, now: at + 2 * MIN });
    expect(stopped.calls.writes).toHaveLength(1);
    expect(stopped.calls.writes[0].change(stamped).list.mode).toBe('stop');
    expect(net({ mode: STOP, mainCiRuns: RUNS, list: { ...stamped, mode: 'stop' }, now: at + 3 * MIN }).calls.writes).toEqual([]);
  });
  it('an operator add or a prune keeps the published mode; a bad mode makes the list unreadable', () => {
    const stamped = { ...addEntries(null, { tests: [TEST_FILE], brokenSha: FIRST_RED, owner: 'o', reason: 'r', actor: 'operator', now: at }).list, mode: 'quarantine' };
    expect(addEntries(stamped, { tests: ['a/b.test.mjs'], brokenSha: FIRST_RED, owner: 'o', reason: 'r', actor: 'operator', now: at }).list.mode).toBe('quarantine');
    expect(pruneOnGreen(stamped, { mainGreen: null, now: at }).list.mode).toBe('quarantine');
    expect(setMode(stamped, { mode: 'stop', actor: 'red-main-safety-net', now: at }).list.mode).toBe('stop');
    expect(setMode(stamped, { mode: 'stop', actor: 'someone', now: at }).ok).toBe(false);
    expect(validateQuarantineList({ ...stamped, mode: 'yolo' }).ok).toBe(false);
  });
});

describe('readListOrAbsent — the first add must be possible', () => {
  const fail = (status) => (args) => { if (args[0] === 'ls-remote') { const e = new Error('ls-remote'); e.status = status; throw e; } throw new Error('fetch failed'); };
  it('a branch that provably does not exist yet (ls-remote exit 2) is an empty list', () => {
    expect(readListOrAbsent({ board: '/x', run: fail(2) })).toMatchObject({ ok: true, absent: true, list: { version: 1, entries: [] } });
  });
  it('any other failure stays unreadable', () => {
    expect(readListOrAbsent({ board: '/x', run: fail(128) }).ok).toBe(false);
  });
});

describe('settings cascade — standard → platform → tool → env, with sources', () => {
  it('standard defaults', () => {
    expect(SETTINGS.value).toMatchObject({ ttlMin: 360, maxTests: 5, derivedJobs: ['test'] });
    expect(SETTINGS.sources.ttlMin).toBe('standard');
  });
  it('platform, then env override; an invalid env value never wins', () => {
    const s = resolveQuarantineSettings({ env: { WE_RED_MAIN_QUARANTINE_TTL_MIN: '90', WE_RED_MAIN_QUARANTINE_MAX_TESTS: 'lots' }, file: '/nonexistent', platform: { maxTests: 3 } });
    expect(s.value).toMatchObject({ ttlMin: 90, maxTests: 3 });
    expect(s.sources).toMatchObject({ ttlMin: 'env', maxTests: 'platform' });
    expect(s.invalid.join(' ')).toMatch(/maxTests/);
  });
});

describe('main-ci-red smell hook', () => {
  it('runs the safety net every tick and reports its plan in the measure, red or green', () => {
    const seen = [];
    const ctx = { now: T('2026-10-10T19:20:00Z'), config: {}, quarantineSafetyNet: (m) => { seen.push(m); return { mode: 'stop', shadow: true, plan: { action: 'add', tests: [TEST_FILE], why: 'w' } }; } };
    const res = smell.evaluate({ mainCiRuns: { runs: RED_RUNS, failing: FAILING } }, ctx);
    expect(res[0].measure.quarantine).toEqual({ mode: 'stop', shadow: true, action: 'add', tests: [TEST_FILE], why: 'w' });
    expect(smell.evaluate({ mainCiRuns: { runs: [LATER_GREEN, ...RED_RUNS], failing: {} } }, ctx)).toEqual([]);
    expect(seen).toHaveLength(2); // green ticks still reach the net (that is where prune happens)
  });
  it('a throwing safety net never breaks the smell', () => {
    const res = smell.evaluate({ mainCiRuns: { runs: RED_RUNS, failing: FAILING } }, { now: T('2026-10-10T19:20:00Z'), config: {}, quarantineSafetyNet: () => { throw new Error('boom'); } });
    expect(res[0].measure.quarantine).toBeNull();
  });
  it('the default net never runs under test (no live IO from a smell test)', () => {
    expect(defaultQuarantineSafetyNet({ runs: RED_RUNS, failing: FAILING }, { now: Date.now() })).toBeNull();
  });
});
