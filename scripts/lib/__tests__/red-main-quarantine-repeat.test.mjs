// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSafetyNet, addEntries, decideCiSkip, validateQuarantineList } from '../red-main-quarantine.mjs';
import { runSafetyNet, resolveQuarantineSettings, readTouchedFiles } from '../red-main-quarantine-io.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../conveyor/health-smells-notify-list.mjs';
import smell from '../../conveyor/health-smells/red-main-quarantined-test.mjs';
const now = Date.parse('2026-10-27T12:00:00Z');
const file = 'scripts/lib/__tests__/example.test.mjs';
const failure = { complete: true, files: [file], tests: [{ file, name: 'fails' }] };
const rows = [1, 2].map((n) => ({ databaseId: n, headSha: String(n).repeat(40), status: 'completed', conclusion: 'failure', createdAt: `2026-10-27T10:0${n}:00Z`, updatedAt: `2026-10-27T10:1${n}:00Z`, jobFailures: { integration: failure } }));
const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'repeat-quarantine-')); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const plan = (o = {}) => planSafetyNet({ status: 'red', firstRedSha: rows[0].headSha, failedJobs: ['integration'], jobFailures: { integration: failure }, repeatRuns: rows, latestRunId: 2, touchedFiles: () => [], now, ...o });
const proof = { kind: 'repeat-failed', runIds: [1, 2], shas: rows.map((r) => r.headSha), count: 2 };
describe('quarantine CLI entry guard', () => {
  it.each(['directory', 'file'])('runs through a symlinked %s and prints usage without remote IO', (kind) => {
    const cli = fileURLToPath(new URL('../red-main-quarantine-io.mjs', import.meta.url));
    const link = join(temp(), 'entry');
    symlinkSync(kind === 'directory' ? dirname(cli) : cli, link);
    const out = spawnSync(process.execPath, [kind === 'directory' ? join(link, 'red-main-quarantine-io.mjs') : link], {
      encoding: 'utf8', timeout: 20_000,
    });
    expect(out.status, out.error?.message ?? out.stderr).toBe(2);
    expect(out.stderr).toContain('usage: red-main-quarantine-io.mjs');
  }, 30_000);
});
describe('R157 repeat failure quarantine', () => {
  const jobOrders = [['integration', 'test-shard (10)'], ['test-shard (10)', 'integration']];
  const skip = (list, job) => decideCiSkip({ mode: 'quarantine', read: { ok: true, list },
    ctx: { known: true, onMain: false, prNumber: 99 }, changedFiles: [], now, job }).skip;
  const publish = (list, entries, at = now) => entries.reduce((cur, e) => {
    const out = addEntries(cur, { tests: [e.test], job: e.job, proof: e.proof, brokenSha: rows[0].headSha,
      actor: 'red-main-safety-net', owner: 'operator', reason: 'repeat', now: at });
    expect(out.ok).toBe(true);
    return out.list;
  }, list);
  const twoJobs = (jobs, overrides = {}) => plan({ failedJobs: jobs,
    jobFailures: Object.fromEntries(jobs.map((job) => [job, failure])), settings: { maxTests: 1 }, ...overrides });
  it.each(jobOrders.map((jobs) => [jobs.join(' then '), jobs]))('covers both jobs, counts one file and owes one card: %s', (_label, jobs) => {
    const p = twoJobs(jobs);
    expect(p.action).toBe('add');
    expect(p.entries.map((e) => e.job).sort()).toEqual([...jobs].sort());
    expect(p.tests).toEqual([file]);
    expect(p.cards).toHaveLength(1);
    for (const job of jobs) expect(p.cards[0].title).toContain(job);
    const list = publish(null, p.entries);
    for (const job of jobs) expect(skip(list, job)).toEqual([file]);
    expect(skip(list, 'soak-shard (1)')).toEqual([]);
    expect(twoJobs(jobs, { list, addedForRed: [file] }).why).toContain('already quarantined');
  });
  it.each(jobOrders.map((jobs) => [jobs.join(' then '), jobs]))('repairs partial coverage without extending the file TTL: %s', (_label, jobs) => {
    const list = publish(null, [{ test: file, job: jobs[0], proof }]);
    const p = twoJobs(jobs, { list, addedForRed: [file], now: now + 60_000 });
    expect(p.action).toBe('add');
    expect(p.entries).toEqual([{ test: file, job: jobs[1], proof }]);
    expect(p.cards).toHaveLength(1);
    for (const job of jobs) expect(p.cards[0].title).toContain(job);
    const repaired = publish(list, p.entries, now + 60_000);
    for (const job of jobs) expect(skip(repaired, job)).toEqual([file]);
    expect(repaired.entries.map((e) => e.expiresAt)).toEqual([list.entries[0].expiresAt, list.entries[0].expiresAt]);
    expect(p.cards[0].expiresAt).toBe(list.entries[0].expiresAt);
    const expired = twoJobs(jobs, { list: repaired, addedForRed: [file], now: list.entries[0].expiresAt });
    expect(expired.action).toBe('prune');
    expect(expired.why).toContain('expired');
    expect(twoJobs(jobs, { list: { version: 1, entries: [] }, addedForRed: [file] }).action).toBe('none');
  });
  it('legacy untagged entries cover unit shards but still need integration coverage', () => {
    const list = publish(null, [{ test: file, proof }]);
    const p = twoJobs(jobOrders[0], { list, addedForRed: [file] });
    expect(p.entries).toEqual([{ test: file, job: 'integration', proof }]);
    const repaired = publish(list, p.entries);
    for (const job of jobOrders[0]) expect(skip(repaired, job)).toEqual([file]);
  });
  it('the live writer persists both jobs and repairs a partially published list on a later tick', () => {
    const dir = temp();
    let list = { version: 1, entries: [] };
    const jobs = jobOrders[0];
    const tick = () => runSafetyNet({ now, dir,
      mainCiRuns: { runs: rows, failing: { runId: 2, jobs } },
      mode: { value: 'quarantine', source: 'test' }, touchedFiles: () => [],
      readJobs: () => ({ failed: jobs.map((name, id) => ({ name, id: id + 10 })), jobs: [] }), readLog: () => failure,
      readList: () => ({ ok: true, list }), write: ({ change }) => { const out = change(list); list = out.list; return out; }, log: () => {} });
    const first = tick();
    expect(first.applied).toBe(true);
    for (const job of jobs) expect(skip(list, job)).toEqual([file]);
    expect(first.events.filter((e) => e.type === 'card-owed')).toHaveLength(1);
    list.entries = list.entries.filter((e) => e.job === jobs[0]);
    expect(tick().plan).toMatchObject({ action: 'add', entries: [{ test: file, job: jobs[1] }] });
    for (const job of jobs) expect(skip(list, job)).toEqual([file]);
    expect(tick().plan.action).toBe('none');
  });
  it('twice-fails-untouched adds with 24h expiry, owner card, audit event and live notice', () => {
    let list = { version: 1, entries: [] }; let events;
    const out = runSafetyNet({ now, dir: temp(), mainCiRuns: { runs: rows, failing: { runId: 2, jobs: ['integration'] } },
      touchedFiles: () => [], readJobs: () => ({ failed: [{ id: 10, name: 'integration' }], jobs: [] }), readLog: () => failure,
      readList: () => ({ ok: true, list }), write: ({ change }) => { const r = change(list); list = r.list; events = r.events; return r; }, log: () => {} });
    expect(out).toMatchObject({ applied: true, mode: 'quarantine', plan: { action: 'add' } });
    expect(list.entries[0]).toMatchObject({ test: file, proof, expiresAt: now + 86400000 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'card-owed', test: file, expiresAt: now + 86400000 }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'quarantine-added', proof }));
    expect(smell.evaluate({ mainCiRuns: {} }, { now, quarantineSafetyNet: () => out })).toEqual([expect.objectContaining({
      breach: true, subject: `quarantine:${file}`,
      summary: expect.stringContaining('deterministic-failure quarantine, not flake evidence'),
    })]);
  });
  it('planner records distinct run proof', () => expect(plan()).toMatchObject({ action: 'add', entries: [{ test: file, proof }] }));
  it.each([
    ['fail/pass/fail on one SHA holds', [1, 3], [2], 'none', [3]],
    ['fail/fail on one SHA adds', [1, 3], [], 'add', [1, 3]],
    ['two failures after green add', [1, 3, 4], [2], 'add', [3, 4]],
    ['latest of multiple greens resets proof', [1, 3, 5], [2, 4], 'none', [5]],
    ['failure tied with green is excluded', [2, 3], [2], 'none', [3]],
  ])('IO red window: %s', (_label, failedMinutes, greenMinutes, action, eligibleMinutes) => {
    const run = (minute, conclusion, databaseId) => ({
      ...rows[0], databaseId, headSha: rows[1].headSha, conclusion, attempt: 1,
      createdAt: `2026-10-27T10:0${minute}:00Z`, updatedAt: `2026-10-27T10:1${minute}:00Z`,
    });
    const failures = failedMinutes.map((minute) => run(minute, 'failure', minute));
    const greens = greenMinutes.map((minute) => run(minute, 'success', 100 + minute));
    const latestRunId = failedMinutes.at(-1);
    const readJobs = vi.fn(() => ({ failed: [{ id: 10, name: 'integration' }], jobs: [] }));
    const write = vi.fn(({ change }) => change({ version: 1, entries: [] }));
    const out = runSafetyNet({ now, dir: temp(),
      mainCiRuns: { runs: [...failures, ...greens].reverse(), failing: { runId: latestRunId, jobs: ['integration'] } },
      mode: { value: 'quarantine', source: 'test' }, touchedFiles: () => [], readJobs, readLog: () => failure,
      readList: () => ({ ok: true, list: { version: 1, entries: [] } }), write, log: () => {} });
    expect(out.plan.action).toBe(action);
    expect(readJobs.mock.calls.map(([id]) => id)).toEqual([latestRunId, ...eligibleMinutes.filter((id) => id !== latestRunId)]);
    if (action === 'none') expect(write).not.toHaveBeenCalled();
    else {
      expect(write).toHaveBeenCalledOnce();
      expect(out.plan.entries[0].proof.runIds).toEqual(eligibleMinutes);
    }
  });
  it('once => none', () => expect(plan({ repeatRuns: [rows[1]] })).toMatchObject({ action: 'none', why: expect.any(String) }));
  it('planner refuses repeatFailureCount below two even with one failing run', () => {
    expect(plan({ settings: { repeatFailureCount: 1 }, repeatRuns: [rows[1]] })).toMatchObject({ action: 'none', why: expect.stringMatching(/count|bound/) });
  });
  it('persisted repeat proof with count 1 is refused', () => {
    const added = addEntries(null, { tests: [file], brokenSha: rows[0].headSha, actor: 'operator', owner: 'operator', reason: 'repeat', proof, now });
    expect(added.ok).toBe(true);
    expect(validateQuarantineList({ ...added.list, entries: [{ ...added.list.entries[0], proof: { ...proof, count: 1, runIds: [2] } }] })).toMatchObject({ ok: false });
  });
  it('two rows with no timestamps => none with an operator-visible why', () => {
    expect(plan({ repeatRuns: rows.map((r) => ({ ...r, createdAt: undefined })) })).toMatchObject({ action: 'none', why: expect.stringMatching(/createdAt|chronolog|timestamp/) });
  });
  it('unparseable timestamp => none with an operator-visible why', () => {
    expect(plan({ repeatRuns: [{ ...rows[0], createdAt: 'invalid' }, rows[1]] })).toMatchObject({ action: 'none', why: expect.stringMatching(/createdAt|chronolog|timestamp/) });
  });
  it('tied timestamps => none with an operator-visible why', () => {
    expect(plan({ repeatRuns: [{ ...rows[0], createdAt: rows[1].createdAt }, rows[1]] })).toMatchObject({ action: 'none', why: expect.stringMatching(/createdAt|chronolog|timestamp/) });
  });
  it('out-of-order evidence => none with an operator-visible why', () => {
    expect(plan({ repeatRuns: [...rows].reverse(), latestRunId: 1 })).toMatchObject({ action: 'none', why: expect.stringMatching(/createdAt|chronolog|timestamp/) });
  });
  it('distinct heads are not required for chronologically distinct failing runs', () => {
    expect(plan({ repeatRuns: [{ ...rows[0], headSha: rows[1].headSha }, rows[1]] })).toMatchObject({ action: 'add', entries: [{ proof: { ...proof, shas: [rows[1].headSha, rows[1].headSha] } }] });
  });
  it('same-SHA proof still checks the touched-files window and refuses unknown or tied chronology', () => {
    const repeatRuns = [{ ...rows[0], headSha: rows[1].headSha }, rows[1]];
    const touchedFiles = vi.fn(() => ['scripts/unrelated.mjs']);
    expect(plan({ repeatRuns, touchedFiles }).action).toBe('add');
    expect(touchedFiles).toHaveBeenCalledWith(rows[1].headSha, rows[1].headSha);
    expect(plan({ repeatRuns, touchedFiles: () => null }).action).toBe('none');
    expect(plan({ repeatRuns, touchedFiles: () => [file] }).action).toBe('none');
    expect(plan({ repeatRuns: repeatRuns.map((r) => ({ ...r, createdAt: rows[1].createdAt })) }).action).toBe('none');
  });
  it.each([undefined, 'invalid'])('IO excludes a malformed row sharing a red run sha (%s) => none', (createdAt) => {
    const readJobs = vi.fn(() => ({ failed: [{ id: 10, name: 'integration' }], jobs: [] }));
    const write = vi.fn();
    const out = runSafetyNet({ now, dir: temp(), mainCiRuns: { runs: [{ ...rows[0], headSha: rows[1].headSha, createdAt }, rows[1]], failing: { runId: 2, jobs: ['integration'] } },
      touchedFiles: () => [], readJobs, readLog: () => failure,
      readList: () => ({ ok: true, list: { version: 1, entries: [] } }), write, log: () => {} });
    expect(out.plan).toMatchObject({ action: 'none', why: expect.stringMatching(/not a proven flake|insufficient|createdAt|chronolog|timestamp/) });
    expect(readJobs.mock.calls.some(([id]) => id === 1)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it('duplicate run ids do not count twice', () => expect(plan({ repeatRuns: [rows[1], rows[1]] }).action).toBe('none'));
  it.each([undefined, 'invalid'])('IO holds when a completed green has unknown chronology (%s)', (createdAt) => {
    const write = vi.fn();
    const out = runSafetyNet({ now, dir: temp(),
      mainCiRuns: { runs: [...rows, { ...rows[0], databaseId: 3, conclusion: 'success', createdAt, attempt: 1 }], failing: { runId: 2, jobs: ['integration'] } },
      mode: { value: 'quarantine', source: 'test' }, touchedFiles: () => [],
      readJobs: () => ({ failed: [{ id: 10, name: 'integration' }], jobs: [] }), readLog: () => failure,
      readList: () => ({ ok: true, list: { version: 1, entries: [] } }), write, log: () => {} });
    expect(out.plan).toMatchObject({ action: 'none', why: expect.stringContaining('insufficient distinct failing main runs') });
    expect(write).not.toHaveBeenCalled();
  });
  it('repeat evidence IO caps run and log reads at ten runs and maxTests logs per run', () => {
    const history = Array.from({ length: 15 }, (_, i) => ({
      ...rows[0], databaseId: i + 1, headSha: (i + 1).toString(16).padStart(40, '0'), attempt: 1,
      createdAt: new Date(now - (30 - i) * 60_000).toISOString(),
      updatedAt: new Date(now - (29 - i) * 60_000).toISOString(),
    }));
    const readJobs = vi.fn((id) => ({ failed: [
      { id: id * 10 + 1, name: 'integration' }, { id: id * 10 + 2, name: 'test-shard (1)' },
    ], jobs: [] }));
    const readLog = vi.fn(() => failure);
    const write = vi.fn(({ change }) => change({ version: 1, entries: [] }));
    const out = runSafetyNet({ now, dir: temp(), mainCiRuns: { runs: history, failing: { runId: 15, jobs: ['integration'] } },
      settings: { value: { ...resolveQuarantineSettings({ env: {} }).value, maxTests: 2 }, sources: {} },
      mode: { value: 'quarantine', source: 'test' }, touchedFiles: () => [], readJobs, readLog,
      readList: () => ({ ok: true, list: { version: 1, entries: [] } }), write, log: () => {} });
    expect(out.error).toBeUndefined();
    expect(out.plan.action).toBe('add');
    // The latest run is read once for the current failure and reused by repeat evidence.
    expect(readJobs.mock.calls.map(([id]) => id)).toEqual([15, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(readLog.mock.calls.map(([id]) => id)).toEqual([151,
      ...Array.from({ length: 9 }, (_, i) => [(i + 6) * 10 + 1, (i + 6) * 10 + 2]).flat()]);
    expect(write).toHaveBeenCalledOnce();
  });
  it('repeat evidence IO skips all logs for a historical run exceeding maxTests jobs', () => {
    const readJobs = vi.fn((id) => ({ failed: id === 1
      ? [{ id: 11, name: 'integration' }, { id: 12, name: 'test-shard (1)' }, { id: 13, name: 'soak-shard (1)' }]
      : [{ id: 21, name: 'integration' }], jobs: [] }));
    const readLog = vi.fn(() => failure);
    const write = vi.fn();
    const out = runSafetyNet({ now, dir: temp(), mainCiRuns: { runs: rows.map((r) => ({ ...r, attempt: 1 })), failing: { runId: 2, jobs: ['integration'] } },
      settings: { value: { ...resolveQuarantineSettings({ env: {} }).value, maxTests: 2 }, sources: {} },
      mode: { value: 'quarantine', source: 'test' }, touchedFiles: () => [], readJobs, readLog,
      readList: () => ({ ok: true, list: { version: 1, entries: [] } }), write, log: () => {} });
    expect(out.error).toBeUndefined();
    expect(out.plan.action).toBe('none');
    expect(readJobs.mock.calls.map(([id]) => id)).toEqual([2, 1]);
    expect(readLog.mock.calls.map(([id]) => id)).toEqual([21]);
    expect(write).not.toHaveBeenCalled();
  });
  it.each(['1; x', '1/../x', 0, -1, '', null])('repeat evidence IO rejects malformed run id %s before reading jobs', (databaseId) => {
    const readJobs = vi.fn(() => ({ failed: [{ id: 21, name: 'integration' }], jobs: [] }));
    const readLog = vi.fn(() => failure);
    const write = vi.fn();
    const out = runSafetyNet({ now, dir: temp(), mainCiRuns: { runs: [{ ...rows[0], databaseId, attempt: 1 }, { ...rows[1], attempt: 1 }], failing: { runId: 2, jobs: ['integration'] } },
      mode: { value: 'quarantine', source: 'test' }, touchedFiles: () => [], readJobs, readLog,
      readList: () => ({ ok: true, list: { version: 1, entries: [] } }), write, log: () => {} });
    expect(out.error).toBeUndefined();
    expect(out.plan.action).toBe('none');
    expect(readJobs.mock.calls.map(([id]) => id)).toEqual([2]);
    expect(readLog.mock.calls.map(([id]) => id)).toEqual([21]);
    expect(write).not.toHaveBeenCalled();
  });
  it('touched file between runs => none', () => expect(plan({ touchedFiles: () => [file] }).action).toBe('none'));
  it('touchedFiles unknown => none', () => expect(plan({ touchedFiles: () => null }).action).toBe('none'));
  it('touchedFiles throws => none', () => expect(plan({ touchedFiles: () => { throw Error('unknown'); } }).action).toBe('none'));
  it('missing sha => none', () => expect(plan({ repeatRuns: [{ ...rows[0], headSha: null }, rows[1]] }).action).toBe('none'));
  it('different failed file => none', () => expect(plan({ repeatRuns: [{ ...rows[0], jobFailures: {} }, rows[1]] }).action).toBe('none'));
  it('latest failing run must be in evidence', () => expect(plan({ latestRunId: 9 }).action).toBe('none'));
  it('setting off falls back to requireProvenFlake behaviour', () => {
    expect(plan({ settings: { repeatFailureProof: false } }).action).toBe('none');
    expect(plan({ settings: { repeatFailureProof: false }, flakeProof: { integration: { kind: 'rerun-passed', runId: 3, attempt: 2 } } }).action).toBe('add');
  });
  it('configured count must be met', () => expect(plan({ settings: { repeatFailureCount: 3 } }).action).toBe('none'));
  it('validates repeat proof and refuses malformed persisted evidence', () => {
    const added = addEntries(null, { tests: [file], brokenSha: rows[0].headSha, actor: 'operator', owner: 'operator', reason: 'repeat', proof, now });
    expect(added.ok).toBe(true);
    for (const bad of [{ ...proof, count: 3 }, { ...proof, runIds: [1, 1] }, { ...proof, shas: [null, rows[1].headSha] }, { ...proof, kind: 'guess' }, { ...proof, runIds: [0, 2] }]) {
      expect(validateQuarantineList({ ...added.list, entries: [{ ...added.list.entries[0], proof: bad }] }).ok).toBe(false);
    }
  });
  it('notify-list contains the quarantine smell', () => expect(NOTIFY_EVEN_IN_SHADOW.has('red-main-quarantined-test')).toBe(true));
  it('bounded history refuses oversize evidence with an operator-visible why', () => {
    expect(plan({ repeatRuns: Array(101).fill(rows[0]) })).toMatchObject({ action: 'none', why: expect.stringMatching(/bound|limit|cap/) });
  });
});
describe('repeat settings cascade', () => {
  it('env COUNT=1 falls back to default 2 with provenance and still needs two runs (once => none)', () => {
    const settings = resolveQuarantineSettings({ file: join(temp(), 'absent.json'), platform: null, env: { WE_RED_MAIN_QUARANTINE_REPEAT_FAILURE_COUNT: '1' } });
    expect(settings).toMatchObject({ value: { repeatFailureCount: 2 }, sources: { repeatFailureCount: 'standard' } });
    expect(settings.invalid.join(' ')).toContain('repeatFailureCount');
    expect(plan({ settings: settings.value, repeatRuns: [rows[1]] }).action).toBe('none');
    expect(plan({ settings: settings.value }).action).toBe('add');
  });
  it('settings COUNT=1 is rejected at platform and tool layers with provenance', () => {
    const path = join(temp(), 'settings.json');
    writeFileSync(path, JSON.stringify({ redMainQuarantine: { repeatFailureCount: 1 } }));
    const settings = resolveQuarantineSettings({ file: path, platform: { repeatFailureCount: 1 }, env: {} });
    expect(settings).toMatchObject({ value: { repeatFailureCount: 2 }, sources: { repeatFailureCount: 'standard' } });
    expect(settings.invalid.join(' ')).toContain('repeatFailureCount');
  });
  it.each([['repeatFailureProof', true, false, 'on', true, 'REPEAT_FAILURE_PROOF'], ['repeatFailureCount', 2, 3, '4', 4, 'REPEAT_FAILURE_COUNT']])('%s resolves standard, platform, tool and env with provenance', (key, standard, override, raw, value, suffix) => {
    const path = join(temp(), 'settings.json'); const base = { file: path, env: {}, platform: null };
    expect(resolveQuarantineSettings(base)).toMatchObject({ value: { [key]: standard }, sources: { [key]: 'standard' } });
    expect(resolveQuarantineSettings({ ...base, platform: { [key]: override } })).toMatchObject({ value: { [key]: override }, sources: { [key]: 'platform' } });
    writeFileSync(path, JSON.stringify({ redMainQuarantine: { [key]: override } }));
    expect(resolveQuarantineSettings(base)).toMatchObject({ value: { [key]: override }, sources: { [key]: 'tool' } });
    expect(resolveQuarantineSettings({ ...base, env: { [`WE_RED_MAIN_QUARANTINE_${suffix}`]: raw } })).toMatchObject({ value: { [key]: value }, sources: { [key]: 'env' } });
    const invalid = resolveQuarantineSettings({ ...base, env: { [`WE_RED_MAIN_QUARANTINE_${suffix}`]: 'garbage' } });
    expect(invalid.sources[key]).toBe('tool'); expect(invalid.invalid.join(' ')).toContain(key);
  });
});
describe('git touched-files seam', () => {
  it('uses bounded argv diff and refuses invalid sha or unreadable output', () => {
    const run = vi.fn((args) => args[0] === 'diff' ? `${file}\0` : '');
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run })).toEqual([file]);
    expect(run).toHaveBeenCalledWith(['diff', '--name-only', '-z', rows[0].headSha, rows[1].headSha, '--'], expect.any(Object));
    expect(readTouchedFiles('--bad', rows[1].headSha, { run })).toBeNull(); expect(run).toHaveBeenCalledTimes(3);
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run: () => { throw Error('timeout'); } })).toBeNull();
  });
  it('detects a file changed and reverted between endpoint trees', () => {
    const middle = 'a'.repeat(40);
    const run = vi.fn((args) => {
      if (args[0] === 'rev-list') return `${rows[1].headSha} ${middle}\n${middle} ${rows[0].headSha}\n`;
      if (args[0] === 'diff' && args[3] === rows[0].headSha && args[4] === rows[1].headSha) return '';
      return args[0] === 'diff' ? `${file}\0` : '';
    });
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run })).toEqual([file]);
  });
  it('oversized commit history fails closed for operator repair', () => {
    const run = (args) => args[0] === 'rev-list' ? Array(101).fill(`${rows[1].headSha} ${rows[0].headSha}`).join('\n') : '';
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run })).toBeNull();
  });
  it('non-ancestor commits and incomplete diff output fail closed', () => {
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run: (args) => { if (args[0] === 'merge-base') throw Error('not ancestor'); return ''; } })).toBeNull();
    expect(readTouchedFiles(rows[0].headSha, rows[1].headSha, { run: () => 'unterminated' })).toBeNull();
  });

});
