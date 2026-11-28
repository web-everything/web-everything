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
let dir, env, probes, probeContext;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dead-review-runs-'));
  env = { WE_PLATFORM_PREFERENCES_FILE: join(dir, 'preferences.json'), OPERATION_REVIEW_JOBS_DIR: join(dir, 'jobs') };
  mkdirSync(env.OPERATION_REVIEW_JOBS_DIR);
  probeContext = { checkout: dir, pool: 'fixture-pool', poolRoot: join(dir, 'pools') };
  probes = { reviewJobs: vi.fn(() => []), pidIdentity: vi.fn(() => ({ alive: false })),
    leases: vi.fn(() => '[]'), sessions: vi.fn(() => '[]') };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const leaseListing = listing => JSON.stringify({ repo: probeContext.pool, root: join(probeContext.poolRoot, probeContext.pool), ...listing });
const listingText = (probe, listing) => probe === 'leases' && listing && !Array.isArray(listing) && typeof listing === 'object'
  ? leaseListing(listing) : JSON.stringify(listing);
const effect = (status, more = {}) => ({ key: `effect-${status}`, type: 'review', stepIndex: 0, index: 0, status, ...more });
function record(id = 'review-pr-dead', more = {}, age = 8 * HOUR) {
  const r = { ...newRunRecord({ id, op: 'review-pr', input: { pr: 123, repo: 'owner/repo' } }),
    pending: { kind: 'effect', step: 'review', stepIndex: 0 }, ...more };
  writeRun(r, dir);
  utimesSync(runPath(id, dir), new Date(now - age), new Date(now - age));
  return r;
}
// Isolate the six-hour standard in guard/cascade fixtures; test the shipped tool policy separately.
function sweep(more = {}) { return reapDeadReviewRuns({ tool: {}, dir, repo: 'owner/repo', probeContext, now, env, probes, log: () => {}, apply: true, ...more }); }
async function kept(reason, more = {}) { expect((await sweep(more)).kept[reason]).toEqual(['review-pr-dead']); }

it('apply creates exactly one sidecar and preserves run bytes, mtime and effects', async () => {
  const original = record(undefined, { effects: [effect('in-flight')] });
  const path = runPath(original.id, dir), before = readFileSync(path), mtime = statSync(path).mtimeMs;
  expect((await sweep()).reaped).toEqual([original.id]);
  expect(readFileSync(path)).toEqual(before); expect(statSync(path).mtimeMs).toBe(mtime);
  const tombstone = JSON.parse(readFileSync(abandonedPath(original.id, dir), 'utf8'));
  expect(tombstone).toMatchObject({ by: 'reap-dead-review-runs', at: new Date(now).toISOString(),
    reason: 'dead: no live pid/handle/lease/session; unchanged for >= 6h' });
  expect(isRunTerminalOrAbandoned(original, original.id, dir, isRunRecordTerminal)).toBe(true);
  const bytes = readFileSync(abandonedPath(original.id, dir));
  expect((await sweep()).kept.abandoned).toEqual([original.id]);
  expect(readFileSync(abandonedPath(original.id, dir))).toEqual(bytes);
  expect(readdirSync(dir).filter(f => f.endsWith('.abandoned.json'))).toHaveLength(1);
});
it('preserves an existing verdict without abandoning the run or probing liveness', async () => {
  const original = record(undefined, { verdict: { outcome: 'needs-work' }, effects: [effect('in-flight')] });
  const path = runPath(original.id, dir), before = readFileSync(path), mtime = statSync(path).mtimeMs;
  await kept('verdict-present');
  expect(readFileSync(path)).toEqual(before); expect(statSync(path).mtimeMs).toBe(mtime);
  expect(tryReadRun(original.id, dir).verdict).toEqual(original.verdict);
  expect(readdirSync(dir).some(f => f.endsWith('.abandoned.json'))).toBe(false);
  expect(probes.reviewJobs).not.toHaveBeenCalled();
});
it('ignores historical IDs outside the review-pr namespace', async () => {
  record('review-dead');
  const result = await sweep();
  expect(result.scanned).toBe(0); expect(result.reaped).toEqual([]);
  expect(tryReadRun('review-dead', dir).pending).not.toBeNull();
  expect(probes.reviewJobs).not.toHaveBeenCalled();
});
it('never manufactures a verdict when the verdict is null', async () => {
  record(); (await sweep()); expect(tryReadRun('review-pr-dead', dir).verdict).toBeNull();
});
it('dry-run leaves file bytes identical and reports wouldReap', async () => {
  record(); const before = readFileSync(runPath('review-pr-dead', dir));
  const r = (await reapDeadReviewRuns({ dir, repo: 'owner/repo', probeContext, now, env, probes, log: () => {} }));
  expect(r.wouldReap).toEqual(['review-pr-dead']); expect(r.reaped).toEqual([]);
  expect(readdirSync(dir).some(f => f.endsWith('.abandoned.json'))).toBe(false);
  expect(readFileSync(runPath('review-pr-dead', dir))).toEqual(before);
});
it('ignores other operations and keeps terminal records without running probes', async () => {
  record('review-pr-other', { op: 'fix' }); record('review-pr-terminal', { pending: null });
  const r = (await sweep()); expect(r.scanned).toBe(1); expect(r.kept.terminal).toEqual(['review-pr-terminal']);
  expect(r.reaped).toEqual([]); expect(probes.reviewJobs).not.toHaveBeenCalled();
});
it.each([{ options: [] }, { asks: 'answer' }, { of: 'question' }])('keeps awaiting-answer suspension %j before age and probes', async pending => {
  record(undefined, { pending: { kind: 'confirm', step: 'confirm', stepIndex: 0, ...pending } });
  (await kept('suspended-awaiting-answer')); expect(probes.reviewJobs).not.toHaveBeenCalled();
});
it.each(['pending', 'in-flight'])('keeps mandatoryReferrals %s effects', async status => {
  record(undefined, { effects: [effect(status, { step: 'mandatoryReferrals' })] }); (await kept('suspended-mandatory-referrals'));
});
it('keeps mandatoryReferrals pending cursor', async () => {
  record(undefined, { pending: { kind: 'effect', step: 'mandatoryReferrals', stepIndex: 0 } }); (await kept('suspended-mandatory-referrals'));
});
it('keeps young work without running probes', async () => {
  record(undefined, {}, HOUR); (await kept('young')); expect(probes.leases).not.toHaveBeenCalled();
});
it('keeps corrupt JSON and leaves its bytes untouched', async () => {
  writeFileSync(runPath('review-pr-dead', dir), '{corrupt'); (await kept('unreadable'));
  expect(readFileSync(runPath('review-pr-dead', dir), 'utf8')).toBe('{corrupt');
});
it('keeps null reads and stat failures as unreadable', async () => {
  record(); (await kept('unreadable', { store: { tryReadRun: () => null } }));
  (await kept('unreadable', { store: { stat: () => { throw Error('stat denied'); } } }));
});
it.each([true, undefined])('keeps matching review jobs with alive-or-unknown pid (%s)', async alive => {
  record(); probes.reviewJobs = () => [{ pr: 123, repo: 'owner/repo', pid: 1234 }];
  probes.pidIdentity = () => ({ alive }); (await kept('live-review-job'));
});
it('uses review-job readers by default and does not remove dead job records', async () => {
  record(); writeJobRecord({ slug: 'job', pr: 123, repo: 'owner/repo', pid: 1234 }, env.OPERATION_REVIEW_JOBS_DIR);
  delete probes.reviewJobs; probes.pidIdentity = () => ({ alive: true }); (await kept('live-review-job'));
  probes.pidIdentity = () => ({ alive: false }); expect((await sweep()).reaped).toEqual(['review-pr-dead']);
  expect(readFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'job.json'), 'utf8')).toContain('1234');
});
it('keeps every candidate when the review-job directory is missing or contains an unreadable record', async () => {
  record(); delete probes.reviewJobs;
  writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'bad.json'), '{'); (await kept('probe-unreadable'));
  rmSync(env.OPERATION_REVIEW_JOBS_DIR, { recursive: true }); (await kept('probe-unreadable'));
});
it('does not mistake a job for another PR or repo for this run', async () => {
  record(); probes.reviewJobs = () => [{ pr: 124, repo: 'owner/repo', pid: 1234 }, { pr: 123, repo: 'other/repo', pid: 1234 }];
  probes.pidIdentity = () => ({ alive: true }); expect((await sweep()).reaped).toEqual(['review-pr-dead']);
});
it.each(['alive', 'unknown', 'remote', 'unparseable'])('keeps %s in-flight handles', async mode => {
  const handle = mode === 'unparseable' ? 'unknown-handle' : `${mode === 'remote' ? 'another-host' : hostname()}:1234:start`;
  record(undefined, { effects: [effect('in-flight', { handle })] });
  probes.pidIdentity = () => ({ alive: mode === 'alive' ? true : mode === 'unknown' ? undefined : false }); (await kept('live-handle'));
});
it('checks record.job.handle as well as effect handles', async () => {
  record(undefined, { job: { ...newJobBlock({ kind: 'review' }), handle: `${hostname()}:1234:start` } });
  probes.pidIdentity = () => ({ alive: true }); (await kept('live-handle'));
});
it('allows a proven dead local handle and passes its process start to pidIdentity', async () => {
  record(undefined, { effects: [effect('in-flight', { handle: `${hostname()}:1234:start` })] });
  expect((await sweep()).reaped).toEqual(['review-pr-dead']); expect(probes.pidIdentity).toHaveBeenCalledWith(1234, { expectStart: 'start' });
});
it('keeps a run mentioned in a lease', async () => { record(); probes.leases = () => 'lease review-pr-dead'; (await kept('live-lease')); });
it.each(['review-pr-dead', `${hostname()}:1234:start`])('keeps a session mentioning %s', async mention => {
  record(undefined, { effects: [effect('in-flight', { handle: `${hostname()}:1234:start` })] });
  probes.sessions = () => mention; (await kept('live-session'));
});
it('runs lease and session probes lazily once per sweep', async () => {
  record('review-pr-first'); record('review-pr-second'); expect((await sweep()).reaped).toEqual(['review-pr-first', 'review-pr-second']);
  expect(probes.leases).toHaveBeenCalledTimes(1); expect(probes.sessions).toHaveBeenCalledTimes(1);
});
it.each(['reviewJobs', 'pidIdentity', 'leases', 'sessions'])('fails closed for every candidate when %s throws or times out', async probe => {
  record('review-pr-first', { effects: [effect('in-flight', { handle: `${hostname()}:1234:start` })] }); record('review-pr-second');
  probes[probe] = () => { throw Error('timeout / oversized output'); };
  const r = (await sweep()); expect(r.reaped).toEqual([]); expect(r.kept['probe-unreadable']).toEqual(['review-pr-first', 'review-pr-second']);
  expect(tryReadRun('review-pr-first', dir).pending).not.toBeNull();
});
it.each(['record', 'mtime', 'removed'])('keeps work changed during sweep (%s)', async change => {
  record(); probes.sessions = () => {
    if (change === 'record') { const r = tryReadRun('review-pr-dead', dir); r.findings.new = true; writeRun(r, dir); }
    if (change === 'mtime') utimesSync(runPath('review-pr-dead', dir), new Date(now), new Date(now));
    if (change === 'removed') rmSync(runPath('review-pr-dead', dir));
    return '[]';
  }; (await kept('changed-during-sweep'));
});
it('re-reads immediately before each write, including same-mtime content changes', async () => {
  record(); let reads = 0;
  (await kept('changed-during-sweep', { store: { tryReadRun: (id, d) => {
    const r = tryReadRun(id, d); if (++reads === 2) r.findings.concurrent = true; return r;
  }, stat: (...args) => statSync(...args) } }));
});
it('preserves a competing update inserted after the final stat and before replacement', async () => {
  record(); let stats = 0;
  const result = (await sweep({ store: { stat: path => {
    const observed = statSync(path);
    if (++stats === 2) {
      const resumed = tryReadRun('review-pr-dead', dir);
      resumed.findings.concurrentProgress = 'must survive';
      writeRun(resumed, dir);
    }
    return observed;
  } } }));
  expect(tryReadRun('review-pr-dead', dir).findings.concurrentProgress).toBe('must survive');
  expect(result.reaped).toEqual([]);
});
it.each([['2', 2, 'env'], ['0', 6, 'standard'], ['NaN', 6, 'standard'], ['Infinity', 6, 'standard'], ['-1', 6, 'standard']])('resolves env %s to %s hours (%s)', async (value, hours, source) => {
  env.WE_REAP_DEAD_REVIEW_RUNS_AFTER_HOURS = value;
  const log = vi.fn(); const r = (await sweep({ log }));
  expect(r.thresholdMs).toBe(hours * HOUR); expect(r.thresholdSource).toBe(source);
  expect(log.mock.calls.flat().join('\n')).toContain(`abandonAfterHours=${hours} (${source})`);
});
it('uses the current tool policy when no tool override is supplied', async () => {
  const result = await sweep({ tool: undefined });
  expect(result.thresholdMs).toBe(HOUR); expect(result.thresholdSource).toBe('tool');
});
it('resolves platform and tool layers and records explicit threshold provenance', async () => {
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ reviewRunReaper: { abandonAfterHours: 9 } }));
  expect((await sweep()).thresholdSource).toBe('platform'); expect((await sweep()).thresholdMs).toBe(9 * HOUR);
  expect((await sweep({ tool: { abandonAfterHours: 7 } })).thresholdSource).toBe('tool');
  expect((await sweep({ thresholdMs: HOUR })).thresholdSource).toBe('argument');
});
it('refuses unreadable platform preferences instead of silently shortening retention', async () => {
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{'); await expect(sweep()).rejects.toThrow();
});
it('bounds default subprocess probes and supplies argv without shell interpolation', async () => {
  record(); delete probes.leases; delete probes.sessions;
  probes.execFileSync = vi.fn(cmd => cmd === process.execPath ? leaseListing({ lanes: [] }) : '[]');
  expect((await sweep()).reaped).toEqual(['review-pr-dead']);
  expect(probes.execFileSync.mock.calls.map(c => c.slice(0, 2))).toEqual([
    [process.execPath, ['scripts/lane-pool.mjs', 'status', '--json', '--leased-only', '--max-age-ms=0', `--repo=${probeContext.checkout}`, `--name=${probeContext.pool}`]], ['claude', ['agents', '--json']],
  ]);
  // Authority-scoped lane-pool status is bounded at 45s; the session listing at 10s.
  expect(probes.execFileSync.mock.calls.map(c => c[2].timeout)).toEqual([45000, 10000]);
  for (const [, , opts] of probes.execFileSync.mock.calls) expect(opts.maxBuffer).toBe(4 * 1024 * 1024);
});
it.each(['oversized', 'malformed'])('retains candidates on %s default probe output and logs the retry fallback', async mode => {
  record(); delete probes.leases;
  probes.execFileSync = () => { if (mode === 'oversized') throw Object.assign(Error('maxBuffer exceeded'), { code: 'ENOBUFS' }); return '{'; };
  const log = vi.fn(); (await kept('probe-unreadable', { log }));
  expect(log.mock.calls.flat().join('\n')).toContain('restore probe access and retry');
});
it.each(['leases', 'sessions'])('holds every candidate when the %s listing is {}', async probe => {
  record('review-pr-first'); record('review-pr-second'); delete probes[probe];
  probes.execFileSync = () => '{}';
  const log = vi.fn(); const result = (await sweep({ log }));
  expect(result.reaped).toEqual([]);
  expect(result.kept['probe-unreadable']).toEqual(['review-pr-first', 'review-pr-second']);
  expect(readdirSync(dir).some(f => f.endsWith('.abandoned.json'))).toBe(false);
  expect(log.mock.calls.flat().join('\n')).toContain('restore probe access and retry');
});
it.each([
  ['leases', { lanes: null }], ['leases', { sessions: [] }],
  ['sessions', { sessions: null }], ['sessions', { count: 0 }],
  ['leases', null], ['leases', []], ['sessions', false],
])('holds on an unknown %s listing shape: %j', async (probe, listing) => {
  record(); delete probes[probe]; probes.execFileSync = () => listingText(probe, listing);
  (await kept('probe-unreadable'));
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
])('holds every candidate on malformed %s listing rows or wrappers: %j', async (probe, listing) => {
  record('review-pr-first'); record('review-pr-second'); delete probes[probe];
  probes.execFileSync = () => listingText(probe, listing);
  const log = vi.fn(); const result = (await sweep({ log }));
  expect(result.reaped).toEqual([]);
  expect(result.kept['probe-unreadable']).toEqual(['review-pr-first', 'review-pr-second']);
  expect(readdirSync(dir).some(f => f.endsWith('.abandoned.json'))).toBe(false);
  expect(log.mock.calls.flat().join('\n')).toContain('restore probe access and retry');
});
it.each([
  ['sessions', { sessions: [{ id: 'other', error: 'permission denied' }] }],
  ['leases', { lanes: [{ lane: 3, lease: null, errors: ['permission denied'] }] }],
  ['sessions', { sessions: [], detail: { error: 'permission denied' } }],
  ['sessions', [{ id: 'other', detail: { nested: [{ errors: ['permission denied'] }] } }]],
])('holds every candidate on nested %s error fields: %j', async (probe, listing) => {
  record('review-pr-first'); record('review-pr-second'); delete probes[probe];
  probes.execFileSync = () => listingText(probe, listing);
  const log = vi.fn(); const result = (await sweep({ log }));
  expect(result.reaped).toEqual([]);
  expect(result.kept['probe-unreadable']).toEqual(['review-pr-first', 'review-pr-second']);
  expect(readdirSync(dir).some(f => f.endsWith('.abandoned.json'))).toBe(false);
  expect(log.mock.calls.flat().join('\n')).toContain('restore probe access and retry');
});
it.each([
  ['leases', { lanes: [] }],
  ['sessions', []], ['sessions', { sessions: [] }], ['sessions', { agents: [] }],
  ['sessions', { sessions: [], errors: [] }],
  ['leases', { lanes: [], errors: [] }],
])('accepts an empty %s listing with a recognized array shape: %j', async (probe, listing) => {
  record(); delete probes[probe]; probes.execFileSync = () => listingText(probe, listing);
  expect((await sweep()).reaped).toEqual(['review-pr-dead']);
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
])('accepts identifying %s producer rows: %j', async (probe, listing) => {
  record(); delete probes[probe]; probes.execFileSync = () => listingText(probe, listing);
  expect((await sweep()).reaped).toEqual(['review-pr-dead']);
});
it('session-reaper flag opts in to a dry-run and adds deadReviewRuns to JSON', async () => {
  const { runSessionReaperCli } = await import('../../conveyor/session-reaper.mjs');
  for (const [key, value] of Object.entries({ ...env, OPERATION_RUNS_DIR: dir, WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' })) vi.stubEnv(key, value);
  // Young work exercises the real sweep without invoking host lease/session probes.
  record(); utimesSync(runPath('review-pr-dead', dir), new Date(), new Date());
  const args = ['--json', '--dry-run', '--no-run-rating', '--no-ground-truth', '--no-completion-record',
    '--no-hung-detection', '--no-auth-expired-detection', '--no-idle-finished-detection', '--no-pid-dead-detection'];
  let stdout = '', stderr = '';
  const io = { exec: () => '[]', stdout: s => { stdout += s; }, stderr: s => { stderr += s; } };
  expect((await runSessionReaperCli(args, io))).toBe(0);
  expect(JSON.parse(stdout).deadReviewRuns).toBeNull();
  stdout = '';
  expect((await runSessionReaperCli([...args, '--reap-dead-review-runs'], io))).toBe(0);
  expect(JSON.parse(stdout).deadReviewRuns.kept.young).toEqual(['review-pr-dead']);
  expect(stderr).toContain('session-reaper dead-review-runs:');
  expect(tryReadRun('review-pr-dead', dir).pending).not.toBeNull();
});

// Fail-closed liveness (sibling stuck-referral-expiry audits failed on exactly these).
it.each(['not-a-pid', '', '0'])('holds a record whose lock sidecar is malformed (%j)', async body => {
  record(); writeFileSync(join(dir, 'review-pr-dead.json.lock'), body); (await kept('live-writer'));
});
it('holds a record whose lock sidecar is unreadable (a directory)', async () => {
  record(); mkdirSync(join(dir, 'review-pr-dead.json.lock')); (await kept('probe-unreadable'));
});
it('holds on a live or unknown lock pid, releases a proven dead one', async () => {
  record(); writeFileSync(join(dir, 'review-pr-dead.json.lock'), '4242');
  probes.pidIdentity = () => ({ alive: null }); (await kept('live-writer'));
  probes.pidIdentity = () => ({ alive: false }); expect((await sweep()).reaped).toEqual(['review-pr-dead']);
});
it('holds on a live temp sibling writer', async () => {
  record(); writeFileSync(join(dir, 'review-pr-dead.json.4242.abc.tmp'), '{}');
  probes.pidIdentity = () => ({ alive: true }); (await kept('live-writer'));
});
it.each([
  'lease {"run":"review-pr-dead"}',
  'lease {"run":"review-pr-dead","heartbeatAt":"garbage"}',
  'lease {"session":"review-pr-dead","expiresAt":null}',
])('holds a lease naming the run even with a missing or bad timestamp: %s', async text => {
  record(); probes.leases = () => text; (await kept('live-lease'));
});
it.each([[{ pr: undefined, repo: 'owner/repo' }], [{ pr: 123 }], [{ pr: 'x', repo: 'owner/repo' }], [{ pr: 123, repo: '' }]])(
  'holds a record whose PR or repo identity is unreadable %j', async input => {
    const r = record(); writeRun({ ...r, input }, dir);
    utimesSync(runPath('review-pr-dead', dir), new Date(now - 8 * HOUR), new Date(now - 8 * HOUR));
    (await kept('identity-unreadable'));
  });
it('holds when a review-job record has an unreadable PR or repo identity', async () => {
  record(); probes.reviewJobs = () => [{ pr: null, repo: 'owner/repo', pid: 1 }]; probes.pidIdentity = () => ({ alive: false });
  (await kept('probe-unreadable'));
});
it.each(['resumeOf', 'resumedAt'])('holds a record carrying %s', async field => {
  record(undefined, { [field]: field === 'resumedAt' ? '2026-11-08T01:00:00Z' : { id: 'review-prev' } }); (await kept('resumed-run'));
});
it('holds when the process scan errors or reports unknown', async () => {
  record(undefined, { effects: [effect('in-flight', { handle: `${hostname()}:1234:start` })] });
  probes.pidIdentity = () => { throw Error('ps failed'); }; (await kept('probe-unreadable'));
  probes.pidIdentity = () => ({ alive: null, reason: 'unreadable' }); (await kept('live-handle'));
  probes.reviewJobs = () => [{ pr: 123, repo: 'owner/repo', pid: 77 }];
  record('review-pr-dead', { effects: [] }); (await kept('live-review-job'));
});
it('ignores review-job sidecar files without a pid, but a pid-bearing record with no identity still holds', async () => {
  record(); delete probes.reviewJobs;
  writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-1.spec-red-team.pass.json'), '{}');
  expect((await sweep()).reaped).toEqual(['review-pr-dead']);
  rmSync(abandonedPath('review-pr-dead', dir)); record(); writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-2.json'), JSON.stringify({ pid: 5 }));
  (await kept('probe-unreadable'));
});

it.each(['1e3', '0x3e8', '+1000', '01000'])('holds on a lock whose text %s only coerces to a dead pid', async body => {
  record(); writeFileSync(join(dir, 'review-pr-dead.json.lock'), body); probes.pidIdentity = () => ({ alive: false }); (await kept('live-writer'));
});
it('holds on a pid-less review-job file that is not a recognized sidecar', async () => {
  record(); delete probes.reviewJobs; writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-9.json'), '{}');
  (await kept('probe-unreadable'));
});
it('dry-run creates no sidecars or locks and apply leaves no locks', async () => {
  record(); const before = readFileSync(runPath('review-pr-dead', dir), 'utf8');
  const r = (await sweep({ apply: false }));
  expect(r.wouldReap).toEqual(['review-pr-dead']); expect(readFileSync(runPath('review-pr-dead', dir), 'utf8')).toBe(before);
  expect(readdirSync(dir).filter(f => f.endsWith('.lock'))).toEqual([]);
  expect((await sweep()).reaped).toEqual(['review-pr-dead']); expect(readdirSync(dir).filter(f => f.endsWith('.lock'))).toEqual([]);
});
it('keeps a record when a writer lock appears after the sweep decided (live pid during the final re-check)', async () => {
  record(); let calls = 0;
  let locked = false; probes.pidIdentity = () => ({ alive: locked });
  probes.sessions = () => { writeFileSync(join(dir, 'review-pr-dead.json.lock'), '4242'); locked = true; return '[]'; };
  const r = (await sweep()); expect(r.kept).toEqual({ 'live-writer': ['review-pr-dead'] }); expect(calls).toBe(0);
});
it.each([['dry-run', false], ['apply', true]])('resolves the default dir without migration and requires explicit apply authority (%s)', async (_mode, apply) => {
  // No `dir`, no OPERATION_RUNS_DIR: the shared folder is derived from the coordination root (a temp "home").
  const shared = join(dir, 'ws', 'runs');
  const home = { ...env, WE_COORDINATION_ROOT: join(dir, 'ws', 'coordination') };
  expect(home.OPERATION_RUNS_DIR).toBeUndefined();
  mkdirSync(shared, { recursive: true });
  const r = { ...newRunRecord({ id: 'review-pr-dead', op: 'review-pr', input: { pr: 123, repo: 'owner/repo' } }),
    pending: { kind: 'effect', step: 'review', stepIndex: 0 } };
  writeRun(r, shared); utimesSync(runPath('review-pr-dead', shared), new Date(now - 8 * HOUR), new Date(now - 8 * HOUR));
  vi.mocked(resolveRunsDir).mockClear(); vi.mocked(migrateLegacyRuns).mockClear();
  const result = (await reapDeadReviewRuns({ repo: 'owner/repo', probeContext, now, env: home, probes, log: () => {}, apply }));
  expect(result.scanned).toBe(1); // the default dir was really used
  expect(result.reaped).toEqual([]);
  if (apply) expect(result.kept['missing-context']).toEqual(['review-pr-dead']);
  else expect(result.wouldReap).toEqual(['review-pr-dead']);
  expect(resolveRunsDir).not.toHaveBeenCalled(); // the only resolver that migrates legacy per-clone runs
  expect(migrateLegacyRuns).not.toHaveBeenCalled();
  expect(readdirSync(shared).filter(f => f.endsWith('.abandoned.json'))).toEqual([]);
});
it('re-abandons a resumed run that dies again: stale tombstone is replaced, not reported already-abandoned', async () => {
  record();
  expect((await sweep()).reaped).toEqual(['review-pr-dead']);
  // The run resumes: a writer lands (new inode/ctime/mtime), so the old tombstone no longer abandons it.
  const w = tryReadRun('review-pr-dead', dir); w.findings.resumed = 'again'; writeRun(w, dir);
  expect(isRunAbandoned('review-pr-dead', dir)).toBe(false);
  // It then dies for real: no progress for > threshold.
  const old = new Date(now - 8 * HOUR); utimesSync(runPath('review-pr-dead', dir), old, old);
  const second = (await sweep({ now: now + HOUR }));
  expect(second.kept['already-abandoned']).toBeUndefined();
  expect(second.reaped).toEqual(['review-pr-dead']);
  const fresh = new Date(now + 2 * HOUR); utimesSync(abandonedPath('review-pr-dead', dir), fresh, fresh);
  expect(isRunAbandoned('review-pr-dead', dir)).toBe(true);
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});
it('an unreplaceable stale tombstone (a directory) is kept and does not abort the sweep of other runs', async () => {
  record('review-pr-poisoned'); record('review-pr-dead');
  mkdirSync(abandonedPath('review-pr-poisoned', dir));
  const r = (await sweep());
  expect(r.kept['stale-tombstone-unreplaceable']).toEqual(['review-pr-poisoned']);
  expect(r.reaped).toEqual(['review-pr-dead']);
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});
it.each([['zero-byte', ''], ['partial', '{"at":']])('a crash-left %s tombstone does not make the run permanently un-reapable', async (_n, body) => {
  record(); writeFileSync(abandonedPath('review-pr-dead', dir), body);
  const r = (await sweep());
  expect(r.reaped).toEqual(['review-pr-dead']); expect(r.kept['already-abandoned']).toBeUndefined();
  expect(JSON.parse(readFileSync(abandonedPath('review-pr-dead', dir), 'utf8')).by).toBe('reap-dead-review-runs');
});
it.each([
  ['unreadable lease marker', { lanes: [{ lane: 3, lease: null, readError: 'EACCES' }] }],
  ['malformed lease marker nested', { lanes: [{ lane: 3, lease: null, detail: { readError: 'bad json' } }] }],
])('holds every candidate when lane-pool status reports an %s', async (_name, listing) => {
  record(); delete probes.leases; probes.execFileSync = () => leaseListing(listing);
  (await kept('probe-unreadable'));
});
it('still checks the alternate <id>.lock sidecar during the final re-check', async () => {
  record(); probes.pidIdentity = () => ({ alive: false });
  probes.sessions = () => { writeFileSync(join(dir, 'review-pr-dead.lock'), 'garbage'); return '[]'; };
  expect((await sweep()).kept).toEqual({ 'live-writer': ['review-pr-dead'] });
  expect(tryReadRun('review-pr-dead', dir).pending).not.toBeNull();
});
it('detects a writer landing during the final read with the second stat', async () => {
  record(); let reads = 0;
  const result = (await sweep({ store: { tryReadRun: (id, d) => {
    const r = tryReadRun(id, d);
    if (++reads === 2) { const w = tryReadRun(id, d); w.findings.late = 'newer progress'; w.verdict = { verdict: 'accept' }; writeRun(w, d); }
    return r; // stale snapshot: the second stat must catch the writer's atomic replacement
  } } }));
  expect(result.reaped).toEqual([]); expect(result.kept['changed-during-sweep']).toEqual(['review-pr-dead']);
  const now2 = tryReadRun('review-pr-dead', dir); expect(now2.findings.late).toBe('newer progress'); expect(now2.verdict).toEqual({ verdict: 'accept' });
  expect(readdirSync(dir).filter(f => f.startsWith('.reaping-') || f.endsWith('.lock'))).toEqual([]);
});
it('preserves the original record when the sidecar write fails', async () => {
  record(); const before = readFileSync(runPath('review-pr-dead', dir), 'utf8');
  await expect(sweep({ store: { markRunAbandoned: () => { throw Error('boom'); } } })).rejects.toThrow('boom');
  expect(readFileSync(runPath('review-pr-dead', dir), 'utf8')).toBe(before);
  expect(readdirSync(dir).filter(f => f.startsWith('.reaping-') || f.endsWith('.lock'))).toEqual([]);
});

it.each([
  [[], false], [['--apply'], true], [['--dry-run'], false], [['--apply', '--dry-run'], false],
])('session-reaper abandonment requires explicit apply: %j', async (flags, apply) => {
  const { runSessionReaperCli } = await import('../../conveyor/session-reaper.mjs');
  const reap = vi.fn(() => ({ scanned: 0, reaped: [], wouldReap: [] }));
  (await runSessionReaperCli(['--reap-dead-review-runs', '--no-run-rating', '--no-ground-truth',
    '--no-completion-record', '--no-hung-detection', '--no-auth-expired-detection',
    '--no-idle-finished-detection', '--no-pid-dead-detection', ...flags],
    { exec: () => '[]', stdout: () => {}, stderr: () => {}, reapDeadReviewRuns: reap }));
  expect(reap).toHaveBeenCalledWith(expect.objectContaining({ apply }));
});
it.each(['{', '{}', 'null'])('holds a malformed review-job claim %s', async body => {
  record(); delete probes.reviewJobs;
  writeFileSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-123.json'), body);
  (await kept('probe-unreadable'));
});
it('holds an unreadable review-job claim', async () => {
  record(); delete probes.reviewJobs;
  mkdirSync(join(env.OPERATION_REVIEW_JOBS_DIR, 'review-123.json'));
  (await kept('probe-unreadable'));
});
it('a newer live record wins over an existing tombstone', async () => {
  record(); markRunAbandoned({ id: 'review-pr-dead', dir, now, reason: 'old', probes: {}, by: 'test' });
  const later = statSync(abandonedPath('review-pr-dead', dir)).mtimeMs + HOUR;
  utimesSync(runPath('review-pr-dead', dir), new Date(later), new Date(later));
  expect(isRunAbandoned('review-pr-dead', dir)).toBe(false);
  (await kept('young'));
});

it.each([1, 'true', {}, undefined])('only literal apply:true writes; %j remains dry-run', async apply => {
  record(); expect((await sweep({ apply })).wouldReap).toEqual(['review-pr-dead']);
  expect(readdirSync(dir).filter(f => f.endsWith('.abandoned.json'))).toEqual([]);
});

it('a writer landing immediately before sidecar creation remains alive', async () => {
  record();
  let updated, before, mtime;
  (await sweep({ store: { markRunAbandoned: args => {
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
  } } }));
  expect(statSync(abandonedPath('review-pr-dead', dir)).mtimeMs).toBeGreaterThanOrEqual(mtime);
  expect(readFileSync(runPath('review-pr-dead', dir))).toEqual(before);
  expect(statSync(runPath('review-pr-dead', dir)).mtimeMs).toBe(mtime);
  expect(isRunAbandoned('review-pr-dead', dir)).toBe(false);
  expect(isRunTerminalOrAbandoned(updated, 'review-pr-dead', dir, isRunRecordTerminal)).toBe(false);
});
