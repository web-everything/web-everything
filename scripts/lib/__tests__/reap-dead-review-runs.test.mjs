import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, utimesSync, rmSync, statSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { newRunRecord } from '../../operations/run-record.mjs';
import { newJobBlock } from '../../operations/job-record.mjs';
import { writeRun, tryReadRun, runPath, isRunRecordTerminal, resolveRunsDir, migrateLegacyRuns } from '../../operations/run-store.mjs';
import { writeJobRecord } from '../../operations/review-job-store.mjs';
import { abandonedPath, isRunAbandoned, isRunTerminalOrAbandoned, markRunAbandoned } from '../run-abandoned.mjs';
import { reapDeadReviewRuns } from '../reap-dead-review-runs.mjs';

// Pass-through spies: they observe whether the migrating resolver is reached, without changing behaviour.
vi.mock('../../operations/run-store.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, resolveRunsDir: vi.fn(actual.resolveRunsDir), migrateLegacyRuns: vi.fn(actual.migrateLegacyRuns) };
});
const HOUR = 3600000, now = Date.parse('2026-11-08T12:00:00Z');
let dir, env, probes;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dead-review-runs-'));
  env = { WE_PLATFORM_PREFERENCES_FILE: join(dir, 'preferences.json'), OPERATION_REVIEW_JOBS_DIR: join(dir, 'jobs') };
  mkdirSync(env.OPERATION_REVIEW_JOBS_DIR);
  probes = { reviewJobs: vi.fn(() => []), pidIdentity: vi.fn(() => ({ alive: false })),
    leases: vi.fn(() => '[]'), sessions: vi.fn(() => '[]') };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const effect = (status, more = {}) => ({ key: `effect-${status}`, type: 'review', stepIndex: 0, index: 0, status, ...more });
function record(id = 'review-dead', more = {}, age = 8 * HOUR) {
  const r = { ...newRunRecord({ id, op: 'review-pr', input: { pr: 123, repo: 'owner/repo' } }),
    pending: { kind: 'effect', step: 'review', stepIndex: 0 }, ...more };
  writeRun(r, dir);
  utimesSync(runPath(id, dir), new Date(now - age), new Date(now - age));
  return r;
}
function sweep(more = {}) { return reapDeadReviewRuns({ dir, now, env, probes, log: () => {}, apply: true, ...more }); }
function kept(reason, more = {}) { expect(sweep(more).kept[reason]).toEqual(['review-dead']); }

it('apply creates exactly one sidecar and preserves run bytes, mtime, verdict and effects', () => {
  const original = record(undefined, { verdict: { outcome: 'needs-work' }, effects: [effect('in-flight')] });
  const path = runPath(original.id, dir), before = readFileSync(path), mtime = statSync(path).mtimeMs;
  expect(sweep().reaped).toEqual([original.id]);
  expect(readFileSync(path)).toEqual(before); expect(statSync(path).mtimeMs).toBe(mtime);
  const tombstone = JSON.parse(readFileSync(abandonedPath(original.id, dir), 'utf8'));
  expect(tombstone).toMatchObject({ by: 'reap-dead-review-runs', at: new Date(now).toISOString(),
    reason: 'dead: no live pid/handle/lease/session; unchanged for >= 6h' });
  expect(isRunTerminalOrAbandoned(original, original.id, dir, isRunRecordTerminal)).toBe(true);
  const bytes = readFileSync(abandonedPath(original.id, dir));
  expect(sweep().kept.abandoned).toEqual([original.id]);
  expect(readFileSync(abandonedPath(original.id, dir))).toEqual(bytes);
  expect(readdirSync(dir).filter(f => f.endsWith('.abandoned.json'))).toHaveLength(1);
});
it('never manufactures a verdict when the verdict is null', () => {
  record(); sweep(); expect(tryReadRun('review-dead', dir).verdict).toBeNull();
});
it('dry-run leaves file bytes identical and reports wouldReap', () => {
  record(); const before = readFileSync(runPath('review-dead', dir));
  const r = reapDeadReviewRuns({ dir, now, env, probes, log: () => {} });
  expect(r.wouldReap).toEqual(['review-dead']); expect(r.reaped).toEqual([]);
  expect(readdirSync(dir).some(f => f.endsWith('.abandoned.json'))).toBe(false);
  expect(readFileSync(runPath('review-dead', dir))).toEqual(before);
});
it('ignores other operations and keeps terminal records without running probes', () => {
  record('other', { op: 'fix' }); record('terminal', { pending: null });
  const r = sweep(); expect(r.scanned).toBe(1); expect(r.kept.terminal).toEqual(['terminal']);
  expect(r.reaped).toEqual([]); expect(probes.reviewJobs).not.toHaveBeenCalled();
});
it.each([{ options: [] }, { asks: 'answer' }, { of: 'question' }])('keeps awaiting-answer suspension %j before age and probes', pending => {
  record(undefined, { pending: { kind: 'confirm', step: 'confirm', stepIndex: 0, ...pending } });
  kept('suspended-awaiting-answer'); expect(probes.reviewJobs).not.toHaveBeenCalled();
});
it.each(['pending', 'in-flight'])('keeps mandatoryReferrals %s effects', status => {
  record(undefined, { effects: [effect(status, { step: 'mandatoryReferrals' })] }); kept('suspended-mandatory-referrals');
});
it('keeps mandatoryReferrals pending cursor', () => {
  record(undefined, { pending: { kind: 'effect', step: 'mandatoryReferrals', stepIndex: 0 } }); kept('suspended-mandatory-referrals');
});
it('keeps young work without running probes', () => {
  record(undefined, {}, HOUR); kept('young'); expect(probes.leases).not.toHaveBeenCalled();
});
it('keeps corrupt JSON and leaves its bytes untouched', () => {
  writeFileSync(runPath('review-dead', dir), '{corrupt'); kept('unreadable');
  expect(readFileSync(runPath('review-dead', dir), 'utf8')).toBe('{corrupt');
});
it('keeps null reads and stat failures as unreadable', () => {
  record(); kept('unreadable', { store: { tryReadRun: () => null } });
  kept('unreadable', { store: { stat: () => { throw Error('stat denied'); } } });
});
it.each([true, undefined])('keeps matching review jobs with alive-or-unknown pid (%s)', alive => {
  record(); probes.reviewJobs = () => [{ pr: 123, repo: 'owner/repo', pid: 1234 }];
  probes.pidIdentity = () => ({ alive }); kept('live-review-job');
});
it('uses review-job readers by default and does not remove dead job records', () => {
  record(); writeJobRecord({ slug: 'job', pr: 123, repo: 'owner/repo', pid: 1234 }, env.OPERATION_REVIEW_JOBS_DIR);
  delete probes.reviewJobs; probes.pidIdentity = () => ({ alive: true }); kept('live-review-job');
  probes.pidIdentity = () => ({ alive: false }); expect(sweep().reaped).toEqual(['review-dead']);
  expect(readFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'job.json'), 'utf8')).toContain('1234');
});
it('keeps every candidate when the review-job directory is missing or contains an unreadable record', () => {
  record(); delete probes.reviewJobs;
  writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'bad.json'), '{'); kept('probe-unreadable');
  rmSync(env.OPERATION_REVIEW_JOBS_DIR, { recursive: true }); kept('probe-unreadable');
});
it('does not mistake a job for another PR or repo for this run', () => {
  record(); probes.reviewJobs = () => [{ pr: 124, repo: 'owner/repo', pid: 1234 }, { pr: 123, repo: 'other/repo', pid: 1234 }];
  probes.pidIdentity = () => ({ alive: true }); expect(sweep().reaped).toEqual(['review-dead']);
});
it.each(['alive', 'unknown', 'remote', 'unparseable'])('keeps %s in-flight handles', mode => {
  const handle = mode === 'unparseable' ? 'unknown-handle' : `${mode === 'remote' ? 'another-host' : hostname()}:1234:start`;
  record(undefined, { effects: [effect('in-flight', { handle })] });
  probes.pidIdentity = () => ({ alive: mode === 'alive' ? true : mode === 'unknown' ? undefined : false }); kept('live-handle');
});
it('checks record.job.handle as well as effect handles', () => {
  record(undefined, { job: { ...newJobBlock({ kind: 'review' }), handle: `${hostname()}:1234:start` } });
  probes.pidIdentity = () => ({ alive: true }); kept('live-handle');
});
it('allows a proven dead local handle and passes its process start to pidIdentity', () => {
  record(undefined, { effects: [effect('in-flight', { handle: `${hostname()}:1234:start` })] });
  expect(sweep().reaped).toEqual(['review-dead']); expect(probes.pidIdentity).toHaveBeenCalledWith(1234, { expectStart: 'start' });
});
it('keeps a run mentioned in a lease', () => { record(); probes.leases = () => 'lease review-dead'; kept('live-lease'); });
it.each(['review-dead', `${hostname()}:1234:start`])('keeps a session mentioning %s', mention => {
  record(undefined, { effects: [effect('in-flight', { handle: `${hostname()}:1234:start` })] });
  probes.sessions = () => mention; kept('live-session');
});
it('runs lease and session probes lazily once per sweep', () => {
  record('first'); record('second'); expect(sweep().reaped).toEqual(['first', 'second']);
  expect(probes.leases).toHaveBeenCalledTimes(1); expect(probes.sessions).toHaveBeenCalledTimes(1);
});
it.each(['reviewJobs', 'pidIdentity', 'leases', 'sessions'])('fails closed for every candidate when %s throws or times out', probe => {
  record('first', { effects: [effect('in-flight', { handle: `${hostname()}:1234:start` })] }); record('second');
  probes[probe] = () => { throw Error('timeout / oversized output'); };
  const r = sweep(); expect(r.reaped).toEqual([]); expect(r.kept['probe-unreadable']).toEqual(['first', 'second']);
  expect(tryReadRun('first', dir).pending).not.toBeNull();
});
it.each(['record', 'mtime', 'removed'])('keeps work changed during sweep (%s)', change => {
  record(); probes.sessions = () => {
    if (change === 'record') { const r = tryReadRun('review-dead', dir); r.findings.new = true; writeRun(r, dir); }
    if (change === 'mtime') utimesSync(runPath('review-dead', dir), new Date(now), new Date(now));
    if (change === 'removed') rmSync(runPath('review-dead', dir));
    return '[]';
  }; kept('changed-during-sweep');
});
it('re-reads immediately before each write, including same-mtime content changes', () => {
  record(); let reads = 0;
  kept('changed-during-sweep', { store: { tryReadRun: (id, d) => {
    const r = tryReadRun(id, d); if (++reads === 2) r.findings.concurrent = true; return r;
  }, stat: (...args) => statSync(...args) } });
});
it('preserves a competing update inserted after the final stat and before replacement', () => {
  record(); let stats = 0;
  const result = sweep({ store: { stat: path => {
    const observed = statSync(path);
    if (++stats === 2) {
      const resumed = tryReadRun('review-dead', dir);
      resumed.findings.concurrentProgress = 'must survive';
      writeRun(resumed, dir);
    }
    return observed;
  } } });
  expect(tryReadRun('review-dead', dir).findings.concurrentProgress).toBe('must survive');
  expect(result.reaped).toEqual([]);
});
it.each([['2', 2, 'env'], ['0', 6, 'standard'], ['NaN', 6, 'standard'], ['Infinity', 6, 'standard'], ['-1', 6, 'standard']])('resolves env %s to %s hours (%s)', (value, hours, source) => {
  env.WE_REAP_DEAD_REVIEW_RUNS_AFTER_HOURS = value;
  const log = vi.fn(); const r = sweep({ log });
  expect(r.thresholdMs).toBe(hours * HOUR); expect(r.thresholdSource).toBe(source);
  expect(log.mock.calls.flat().join('\n')).toContain(`abandonAfterHours=${hours} (${source})`);
});
it('resolves platform and tool layers and records explicit threshold provenance', () => {
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ reviewRunReaper: { abandonAfterHours: 9 } }));
  expect(sweep().thresholdSource).toBe('platform'); expect(sweep().thresholdMs).toBe(9 * HOUR);
  expect(sweep({ tool: { abandonAfterHours: 7 } }).thresholdSource).toBe('tool');
  expect(sweep({ thresholdMs: HOUR }).thresholdSource).toBe('argument');
});
it('refuses unreadable platform preferences instead of silently shortening retention', () => {
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{'); expect(() => sweep()).toThrow();
});
it('bounds default subprocess probes and supplies argv without shell interpolation', () => {
  record(); delete probes.leases; delete probes.sessions;
  probes.execFileSync = vi.fn(() => '[]');
  expect(sweep().reaped).toEqual(['review-dead']);
  expect(probes.execFileSync.mock.calls.map(c => c.slice(0, 2))).toEqual([
    [process.execPath, ['scripts/lane-pool.mjs', 'status', '--json', '--leased-only', '--max-age-ms=0']], ['claude', ['agents', '--json']],
  ]);
  // lane-pool status measured 26s on a loaded host: its bound is 120s, the session listing's 10s.
  expect(probes.execFileSync.mock.calls.map(c => c[2].timeout)).toEqual([120000, 10000]);
  for (const [, , opts] of probes.execFileSync.mock.calls) expect(opts.maxBuffer).toBe(4 * 1024 * 1024);
});
it.each(['oversized', 'malformed'])('retains candidates on %s default probe output and logs the retry fallback', mode => {
  record(); delete probes.leases;
  probes.execFileSync = () => { if (mode === 'oversized') throw Object.assign(Error('maxBuffer exceeded'), { code: 'ENOBUFS' }); return '{'; };
  const log = vi.fn(); kept('probe-unreadable', { log });
  expect(log.mock.calls.flat().join('\n')).toContain('restore probe access and retry');
});
it.each(['leases', 'sessions'])('holds every candidate when the %s listing is {}', probe => {
  record('first'); record('second'); delete probes[probe];
  probes.execFileSync = () => '{}';
  const log = vi.fn(); const result = sweep({ log });
  expect(result.reaped).toEqual([]);
  expect(result.kept['probe-unreadable']).toEqual(['first', 'second']);
  expect(readdirSync(dir).some(f => f.endsWith('.abandoned.json'))).toBe(false);
  expect(log.mock.calls.flat().join('\n')).toContain('restore probe access and retry');
});
it.each([
  ['leases', { lanes: null }], ['leases', { sessions: [] }],
  ['sessions', { sessions: null }], ['sessions', { count: 0 }],
  ['leases', null], ['sessions', false],
])('holds on an unknown %s listing shape: %j', (probe, listing) => {
  record(); delete probes[probe]; probes.execFileSync = () => JSON.stringify(listing);
  kept('probe-unreadable');
});
it.each([
  ['sessions', { sessions: [{}] }], ['leases', { lanes: [{}] }],
  ['sessions', { sessions: [], errors: ['permission denied'] }],
  ['leases', { lanes: [], error: 'permission denied' }],
  ['sessions', { agents: [], error: ['permission denied'] }],
  ['sessions', { sessions: [], errors: 'permission denied' }],
  ['leases', { lanes: [], readError: 'permission denied' }],
  ['sessions', { sessions: [{ id: '', name: ' ' }] }],
  ['leases', { lanes: [{ lane: '3', lease: null }] }],
  ['sessions', { errors: [] }],
  ['sessions', { sessions: null, errors: [] }],
  ['sessions', [null]], ['leases', [null]], ['leases', { lanes: [null] }],
  ['sessions', { sessions: [null] }], ['sessions', { agents: [null] }],
  ['sessions', [[]]], ['leases', [[]]],
  ['sessions', ['unknown']], ['leases', ['unknown']],
  ['sessions', [false]], ['leases', [42]],
])('holds every candidate on malformed %s listing rows or wrappers: %j', (probe, listing) => {
  record('first'); record('second'); delete probes[probe];
  probes.execFileSync = () => JSON.stringify(listing);
  const log = vi.fn(); const result = sweep({ log });
  expect(result.reaped).toEqual([]);
  expect(result.kept['probe-unreadable']).toEqual(['first', 'second']);
  expect(readdirSync(dir).some(f => f.endsWith('.abandoned.json'))).toBe(false);
  expect(log.mock.calls.flat().join('\n')).toContain('restore probe access and retry');
});
it.each([
  ['sessions', { sessions: [{ id: 'other', error: 'permission denied' }] }],
  ['leases', { lanes: [{ lane: 3, lease: null, errors: ['permission denied'] }] }],
  ['sessions', { sessions: [], detail: { error: 'permission denied' } }],
  ['sessions', [{ id: 'other', detail: { nested: [{ errors: ['permission denied'] }] } }]],
])('holds every candidate on nested %s error fields: %j', (probe, listing) => {
  record('first'); record('second'); delete probes[probe];
  probes.execFileSync = () => JSON.stringify(listing);
  const log = vi.fn(); const result = sweep({ log });
  expect(result.reaped).toEqual([]);
  expect(result.kept['probe-unreadable']).toEqual(['first', 'second']);
  expect(readdirSync(dir).some(f => f.endsWith('.abandoned.json'))).toBe(false);
  expect(log.mock.calls.flat().join('\n')).toContain('restore probe access and retry');
});
it.each([
  ['leases', []], ['leases', { lanes: [] }],
  ['sessions', []], ['sessions', { sessions: [] }], ['sessions', { agents: [] }],
  ['sessions', { sessions: [], errors: [] }],
  ['leases', { lanes: [], errors: [] }],
])('accepts an empty %s listing with a recognized array shape: %j', (probe, listing) => {
  record(); delete probes[probe]; probes.execFileSync = () => JSON.stringify(listing);
  expect(sweep().reaped).toEqual(['review-dead']);
});
it.each([
  ['leases', { lanes: [{ lane: 3, lease: null }] }],
  ['leases', { lanes: [{ lane: 3, lease: null, errors: [], error: null }] }],
  ['sessions', { sessions: [{ id: 'other', errors: [], error: null }] }],
  ['sessions', { sessions: [], detail: { nested: [{ errors: [], error: null }] } }],
  ['leases', { lanes: [{ lane: 4, exists: false }] }],
  ['sessions', [{ id: 'abc12345', sessionId: 'abc12345-session', name: 'conveyor-1', kind: 'background' }]],
  ['sessions', { sessions: [{ pid: 111, sessionId: 'interactive-session', name: 'my terminal', kind: 'interactive' }] }],
  ['sessions', { agents: [{ name: 'another-review' }] }],
  ['sessions', [{ handle: 'another-session' }]],
])('accepts identifying %s producer rows: %j', (probe, listing) => {
  record(); delete probes[probe]; probes.execFileSync = () => JSON.stringify(listing);
  expect(sweep().reaped).toEqual(['review-dead']);
});
it('session-reaper flag opts in to a dry-run and adds deadReviewRuns to JSON', async () => {
  const { runSessionReaperCli } = await import('../../conveyor/session-reaper.mjs');
  for (const [key, value] of Object.entries({ ...env, OPERATION_RUNS_DIR: dir, WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' })) vi.stubEnv(key, value);
  // Young work exercises the real sweep without invoking host lease/session probes.
  record(); utimesSync(runPath('review-dead', dir), new Date(), new Date());
  const args = ['--json', '--dry-run', '--no-run-rating', '--no-ground-truth', '--no-completion-record',
    '--no-hung-detection', '--no-auth-expired-detection', '--no-idle-finished-detection', '--no-pid-dead-detection'];
  let stdout = '', stderr = '';
  const io = { exec: () => '[]', stdout: s => { stdout += s; }, stderr: s => { stderr += s; } };
  expect(runSessionReaperCli(args, io)).toBe(0);
  expect(JSON.parse(stdout).deadReviewRuns).toBeNull();
  stdout = '';
  expect(runSessionReaperCli([...args, '--reap-dead-review-runs'], io)).toBe(0);
  expect(JSON.parse(stdout).deadReviewRuns.kept.young).toEqual(['review-dead']);
  expect(stderr).toContain('session-reaper dead-review-runs:');
  expect(tryReadRun('review-dead', dir).pending).not.toBeNull();
});

// Fail-closed liveness (sibling stuck-referral-expiry audits failed on exactly these).
it.each(['not-a-pid', '', '0'])('holds a record whose lock sidecar is malformed (%j)', body => {
  record(); writeFileSync(join(dir, 'review-dead.json.lock'), body); kept('live-writer');
});
it('holds a record whose lock sidecar is unreadable (a directory)', () => {
  record(); mkdirSync(join(dir, 'review-dead.json.lock')); kept('probe-unreadable');
});
it('holds on a live or unknown lock pid, releases a proven dead one', () => {
  record(); writeFileSync(join(dir, 'review-dead.json.lock'), '4242');
  probes.pidIdentity = () => ({ alive: null }); kept('live-writer');
  probes.pidIdentity = () => ({ alive: false }); expect(sweep().reaped).toEqual(['review-dead']);
});
it('holds on a live temp sibling writer', () => {
  record(); writeFileSync(join(dir, 'review-dead.json.4242.abc.tmp'), '{}');
  probes.pidIdentity = () => ({ alive: true }); kept('live-writer');
});
it.each([
  'lease {"run":"review-dead"}',
  'lease {"run":"review-dead","heartbeatAt":"garbage"}',
  'lease {"session":"review-dead","expiresAt":null}',
])('holds a lease naming the run even with a missing or bad timestamp: %s', text => {
  record(); probes.leases = () => text; kept('live-lease');
});
it.each([[{ pr: undefined, repo: 'owner/repo' }], [{ pr: 123 }], [{ pr: 'x', repo: 'owner/repo' }], [{ pr: 123, repo: '' }]])(
  'holds a record whose PR or repo identity is unreadable %j', input => {
    const r = record(); writeRun({ ...r, input }, dir);
    utimesSync(runPath('review-dead', dir), new Date(now - 8 * HOUR), new Date(now - 8 * HOUR));
    kept('identity-unreadable');
  });
it('holds when a review-job record has an unreadable PR or repo identity', () => {
  record(); probes.reviewJobs = () => [{ pr: null, repo: 'owner/repo', pid: 1 }]; probes.pidIdentity = () => ({ alive: false });
  kept('probe-unreadable');
});
it.each(['resumeOf', 'resumedAt'])('holds a record carrying %s', field => {
  record(undefined, { [field]: field === 'resumedAt' ? '2026-11-08T01:00:00Z' : { id: 'review-prev' } }); kept('resumed-run');
});
it('holds when the process scan errors or reports unknown', () => {
  record(undefined, { effects: [effect('in-flight', { handle: `${hostname()}:1234:start` })] });
  probes.pidIdentity = () => { throw Error('ps failed'); }; kept('probe-unreadable');
  probes.pidIdentity = () => ({ alive: null, reason: 'unreadable' }); kept('live-handle');
  probes.reviewJobs = () => [{ pr: 123, repo: 'owner/repo', pid: 77 }];
  record('review-dead', { effects: [] }); kept('live-review-job');
});
it('ignores review-job sidecar files without a pid, but a pid-bearing record with no identity still holds', () => {
  record(); delete probes.reviewJobs;
  writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-1.spec-red-team.pass.json'), '{}');
  expect(sweep().reaped).toEqual(['review-dead']);
  rmSync(abandonedPath('review-dead', dir)); record(); writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-2.json'), JSON.stringify({ pid: 5 }));
  kept('probe-unreadable');
});

it.each(['1e3', '0x3e8', '+1000', '01000'])('holds on a lock whose text %s only coerces to a dead pid', body => {
  record(); writeFileSync(join(dir, 'review-dead.json.lock'), body); probes.pidIdentity = () => ({ alive: false }); kept('live-writer');
});
it('holds on a pid-less review-job file that is not a recognized sidecar', () => {
  record(); delete probes.reviewJobs; writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-9.json'), '{}');
  kept('probe-unreadable');
});
it('dry-run creates no sidecars or locks and apply leaves no locks', () => {
  record(); const before = readFileSync(runPath('review-dead', dir), 'utf8');
  const r = sweep({ apply: false });
  expect(r.wouldReap).toEqual(['review-dead']); expect(readFileSync(runPath('review-dead', dir), 'utf8')).toBe(before);
  expect(readdirSync(dir).filter(f => f.endsWith('.lock'))).toEqual([]);
  expect(sweep().reaped).toEqual(['review-dead']); expect(readdirSync(dir).filter(f => f.endsWith('.lock'))).toEqual([]);
});
it('keeps a record when a writer lock appears after the sweep decided (live pid during the final re-check)', () => {
  record(); let calls = 0;
  let locked = false; probes.pidIdentity = () => ({ alive: locked });
  probes.sessions = () => { writeFileSync(join(dir, 'review-dead.json.lock'), '4242'); locked = true; return '[]'; };
  const r = sweep(); expect(r.kept).toEqual({ 'live-writer': ['review-dead'] }); expect(calls).toBe(0);
});
it.each([['dry-run', false], ['apply', true]])('resolves the default dir without the legacy runs migration (%s)', (_mode, apply) => {
  // No `dir`, no OPERATION_RUNS_DIR: the shared folder is derived from the coordination root (a temp "home").
  const shared = join(dir, 'ws', 'runs');
  const home = { ...env, WE_COORDINATION_ROOT: join(dir, 'ws', 'coordination') };
  expect(home.OPERATION_RUNS_DIR).toBeUndefined();
  mkdirSync(shared, { recursive: true });
  const r = { ...newRunRecord({ id: 'review-dead', op: 'review-pr', input: { pr: 123, repo: 'owner/repo' } }),
    pending: { kind: 'effect', step: 'review', stepIndex: 0 } };
  writeRun(r, shared); utimesSync(runPath('review-dead', shared), new Date(now - 8 * HOUR), new Date(now - 8 * HOUR));
  vi.mocked(resolveRunsDir).mockClear(); vi.mocked(migrateLegacyRuns).mockClear();
  const result = reapDeadReviewRuns({ now, env: home, probes, log: () => {}, apply });
  expect(result[apply ? 'reaped' : 'wouldReap']).toEqual(['review-dead']); // the default dir was really used
  expect(resolveRunsDir).not.toHaveBeenCalled(); // the only resolver that migrates legacy per-clone runs
  expect(migrateLegacyRuns).not.toHaveBeenCalled();
  expect(readdirSync(shared).filter(f => f.endsWith('.abandoned.json'))).toEqual(apply ? ['review-dead.abandoned.json'] : []);
});
it('re-abandons a resumed run that dies again: stale tombstone is replaced, not reported already-abandoned', () => {
  record();
  expect(sweep().reaped).toEqual(['review-dead']);
  // The run resumes: a writer lands (new inode/ctime/mtime), so the old tombstone no longer abandons it.
  const w = tryReadRun('review-dead', dir); w.findings.resumed = 'again'; writeRun(w, dir);
  expect(isRunAbandoned('review-dead', dir)).toBe(false);
  // It then dies for real: no progress for > threshold.
  const old = new Date(now - 8 * HOUR); utimesSync(runPath('review-dead', dir), old, old);
  const second = sweep({ now: now + HOUR });
  expect(second.kept['already-abandoned']).toBeUndefined();
  expect(second.reaped).toEqual(['review-dead']);
  const fresh = new Date(now + 2 * HOUR); utimesSync(abandonedPath('review-dead', dir), fresh, fresh);
  expect(isRunAbandoned('review-dead', dir)).toBe(true);
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});
it('an unreplaceable stale tombstone (a directory) is kept and does not abort the sweep of other runs', () => {
  record('review-poisoned'); record('review-dead');
  mkdirSync(abandonedPath('review-poisoned', dir));
  const r = sweep();
  expect(r.kept['stale-tombstone-unreplaceable']).toEqual(['review-poisoned']);
  expect(r.reaped).toEqual(['review-dead']);
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});
it.each([['zero-byte', ''], ['partial', '{"at":']])('a crash-left %s tombstone does not make the run permanently un-reapable', (_n, body) => {
  record(); writeFileSync(abandonedPath('review-dead', dir), body);
  const r = sweep();
  expect(r.reaped).toEqual(['review-dead']); expect(r.kept['already-abandoned']).toBeUndefined();
  expect(JSON.parse(readFileSync(abandonedPath('review-dead', dir), 'utf8')).by).toBe('reap-dead-review-runs');
});
it.each([
  ['unreadable lease marker', { lanes: [{ lane: 3, lease: null, readError: 'EACCES' }] }],
  ['malformed lease marker nested', { lanes: [{ lane: 3, lease: null, detail: { readError: 'bad json' } }] }],
])('holds every candidate when lane-pool status reports an %s', (_name, listing) => {
  record(); delete probes.leases; probes.execFileSync = () => JSON.stringify(listing);
  kept('probe-unreadable');
});
it('still checks the alternate <id>.lock sidecar during the final re-check', () => {
  record(); probes.pidIdentity = () => ({ alive: false });
  probes.sessions = () => { writeFileSync(join(dir, 'review-dead.lock'), 'garbage'); return '[]'; };
  expect(sweep().kept).toEqual({ 'live-writer': ['review-dead'] });
  expect(tryReadRun('review-dead', dir).pending).not.toBeNull();
});
it('detects a writer landing during the final read with the second stat', () => {
  record(); let reads = 0;
  const result = sweep({ store: { tryReadRun: (id, d) => {
    const r = tryReadRun(id, d);
    if (++reads === 2) { const w = tryReadRun(id, d); w.findings.late = 'newer progress'; w.verdict = { verdict: 'accept' }; writeRun(w, d); }
    return r; // stale snapshot: the second stat must catch the writer's atomic replacement
  } } });
  expect(result.reaped).toEqual([]); expect(result.kept['changed-during-sweep']).toEqual(['review-dead']);
  const now2 = tryReadRun('review-dead', dir); expect(now2.findings.late).toBe('newer progress'); expect(now2.verdict).toEqual({ verdict: 'accept' });
  expect(readdirSync(dir).filter(f => f.startsWith('.reaping-') || f.endsWith('.lock'))).toEqual([]);
});
it('preserves the original record when the sidecar write fails', () => {
  record(); const before = readFileSync(runPath('review-dead', dir), 'utf8');
  expect(() => sweep({ store: { markRunAbandoned: () => { throw Error('boom'); } } })).toThrow('boom');
  expect(readFileSync(runPath('review-dead', dir), 'utf8')).toBe(before);
  expect(readdirSync(dir).filter(f => f.startsWith('.reaping-') || f.endsWith('.lock'))).toEqual([]);
});

it.each([
  [[], false], [['--apply'], true], [['--dry-run'], false], [['--apply', '--dry-run'], false],
])('session-reaper abandonment requires explicit apply: %j', async (flags, apply) => {
  const { runSessionReaperCli } = await import('../../conveyor/session-reaper.mjs');
  const reap = vi.fn(() => ({ scanned: 0, reaped: [], wouldReap: [] }));
  runSessionReaperCli(['--reap-dead-review-runs', '--no-run-rating', '--no-ground-truth',
    '--no-completion-record', '--no-hung-detection', '--no-auth-expired-detection',
    '--no-idle-finished-detection', '--no-pid-dead-detection', ...flags],
    { exec: () => '[]', stdout: () => {}, stderr: () => {}, reapDeadReviewRuns: reap });
  expect(reap).toHaveBeenCalledWith(expect.objectContaining({ apply }));
});
it.each(['{', '{}', 'null'])('holds a malformed review-job claim %s', body => {
  record(); delete probes.reviewJobs;
  writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-123.json'), body);
  kept('probe-unreadable');
});
it('holds an unreadable review-job claim', () => {
  record(); delete probes.reviewJobs;
  mkdirSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-123.json'));
  kept('probe-unreadable');
});
it('a newer live record wins over an existing tombstone', () => {
  record(); markRunAbandoned({ id: 'review-dead', dir, now, reason: 'old', probes: {}, by: 'test' });
  const later = statSync(abandonedPath('review-dead', dir)).mtimeMs + HOUR;
  utimesSync(runPath('review-dead', dir), new Date(later), new Date(later));
  expect(isRunAbandoned('review-dead', dir)).toBe(false);
  kept('young');
});

it.each([1, 'true', {}, undefined])('only literal apply:true writes; %j remains dry-run', apply => {
  record(); expect(sweep({ apply }).wouldReap).toEqual(['review-dead']);
  expect(readdirSync(dir).filter(f => f.endsWith('.abandoned.json'))).toEqual([]);
});

it('a writer landing immediately before sidecar creation remains alive', () => {
  record();
  let updated, before, mtime;
  sweep({ store: { markRunAbandoned: args => {
    // All reaper checks have finished; the writer lands immediately before exclusive creation.
    updated = tryReadRun(args.id, dir);
    updated.findings.late = 'active writer';
    writeRun(updated, dir);
    // Preserve the old mtime: record identity must protect progress even when the tombstone is newer.
    const old = new Date(now - 8 * HOUR);
    utimesSync(runPath(args.id, dir), old, old);
    before = readFileSync(runPath(args.id, dir));
    mtime = statSync(runPath(args.id, dir)).mtimeMs;
    return markRunAbandoned(args);
  } } });
  expect(statSync(abandonedPath('review-dead', dir)).mtimeMs).toBeGreaterThanOrEqual(mtime);
  expect(readFileSync(runPath('review-dead', dir))).toEqual(before);
  expect(statSync(runPath('review-dead', dir)).mtimeMs).toBe(mtime);
  expect(isRunAbandoned('review-dead', dir)).toBe(false);
  expect(isRunTerminalOrAbandoned(updated, 'review-dead', dir, isRunRecordTerminal)).toBe(false);
});
