// @vitest-environment node
// The job child runs under plain Node; happy-dom's AbortController is not one child_process accepts.
import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';
import { EventEmitter } from 'node:events';
import { coronerNightDue, runNightlyCoronerJob, extractNightlyCoroner, runNightlyCoronerEntry, CHILD_STOP_GRACE_MS, RELEASE_TIMEOUT_MS, CORONER_LANE_SESSION, coronerLaneSession, resolveNightlyCoronerSettings, nightlyCoronerTickAllowed, NIGHTLY_DEFAULTS, coronerDeadline, publishCoronerFailure, coronerExtractorArgs } from '../nightly-coroner-job.mjs';
import { createJobStore, enqueueJob, reattachTick, runJob, JOB_ID_ENV, JOB_ATTEMPT_ENV } from '../../lib/daemon-jobs-runtime.mjs';
import { HEALTH_WATCH_JOB_KINDS, HEALTH_NIGHTLY_CORONER_KIND } from '../../../skills-src/conveyor/daemon-manifest.mjs';
import { parseFeedLine } from '../../operations/needs-you-feed.mjs';
import { markLaunching } from '../../lib/daemon-jobs.mjs';
import coronerSmell from '../health-smells/nightly-coroner-failed.mjs';
import { emptyHealthState, runHealthTick } from '../health-watch-core.mjs';
const roots = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'nightly-coroner-')); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each([
  ['2026-10-17T02:16:59Z', '2026-10-15', null],
  ['2026-10-17T02:17:00Z', '2026-10-15', '2026-10-16'],
  ['2026-10-17T03:30:00Z', '2026-10-15', '2026-10-16'],
  ['2026-10-17T03:30:00Z', '2026-10-16', null],
  ['2026-10-17T12:00:00Z', '2026-10-15', '2026-10-16'],
  ['2026-01-17T03:17:00Z', '2026-01-15', '2026-01-16'],
  ['2026-11-02T03:17:00Z', '2026-10-31', '2026-11-01'],
  ['2026-03-09T02:17:00Z', '2026-03-07', '2026-03-08'],
])('schedule at %s since %s gives %s', (now, last, expected) => {
  expect(coronerNightDue(Date.parse(now), {}, last)).toBe(expected);
});
it('honors disabled and customized time; catches up the latest night on first start', () => {
  expect(coronerNightDue(Date.parse('2026-10-17T02:17:00Z'), { enabled: false })).toBeNull();
  expect(coronerNightDue(Date.parse('2026-10-17T02:17:00Z'), { at: '23:00' }, '2026-10-15')).toBeNull();
  expect(coronerNightDue(Date.parse('2026-10-17T12:00:00Z'))).toBe('2026-10-16');
  expect(coronerNightDue(Date.parse('2026-01-01T12:00:00Z'))).toBe('2025-12-31');
});
it('resolves all cascade layers independently and logs enabled source', () => {
  const read = (path) => path.endsWith('coroner.json') ? JSON.stringify({ coroner: { nightly: { at: '21:00' } } })
    : JSON.stringify({ coroner: { nightly: { enabled: false, at: '20:00' } } });
  const log = vi.fn();
  const out = resolveNightlyCoronerSettings({ read, log, env: {} });
  expect(out.value).toEqual({ ...NIGHTLY_DEFAULTS, at: '21:00', enabled: false });
  expect(out.sources).toMatchObject({ at: 'tool', enabled: 'platform', laneWaitMs: 'standard' });
  expect(log.mock.calls[0][0]).toContain('enabled=false (platform)');
  const overridden = resolveNightlyCoronerSettings({ read, log, config: { coroner: { nightly: { at: '22:00' } } }, env: { WE_CORONER_NIGHTLY_ENABLED: 'true', WE_CORONER_NIGHTLY_AT: '23:11' } });
  expect(overridden.sources).toMatchObject({ at: 'env', enabled: 'env' });
  expect(overridden.value).toEqual({ ...NIGHTLY_DEFAULTS, at: '23:11', enabled: true });
  const bad = resolveNightlyCoronerSettings({ read, log, env: { WE_CORONER_NIGHTLY_AT: '25:11' } });
  expect(bad.value.at).toBe('21:00'); expect(bad.errors.length).toBeGreaterThan(0);
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  expect(resolveNightlyCoronerSettings({ read: missing, log, env: {} }).value).toEqual(NIGHTLY_DEFAULTS);
});
function jobOptions(root) {
  return { dir: root, store: createJobStore(join(root, 'jobs')), config: { enabled: true, at: '22:17' }, codeSha: 'abc',
    reattach: vi.fn(async () => ({})), evict: vi.fn(), snapshot: {}, sourceRoot: root, statusFeed: join(root, 'feed.jsonl'),
    sweepLanes: vi.fn(async () => {}) };
}
it('persists one job per night even when health state is lost, and catches up on restart', async () => {
  const root = temp(); const opts = jobOptions(root);
  const before = await runNightlyCoronerJob({ ...opts, now: Date.parse('2026-10-17T02:16:00Z') });
  expect(before.enqueued).toBe('nightly-coroner-2026-10-15');
  // The previous night's catch-up completes; today's deadline has not arrived.
  opts.store.update(before.enqueued, (r) => ({ ...r, job: { ...r.job, status: 'succeeded' } }));
  expect((await runNightlyCoronerJob({ ...jobOptions(root), now: Date.parse('2026-10-17T02:16:30Z') })).enqueued).toBeNull();
  // No tick at 22:17: the next morning catches up, using only the persisted job ledger.
  const caught = await runNightlyCoronerJob({ ...jobOptions(root), now: Date.parse('2026-10-17T12:00:00Z') });
  expect(caught.enqueued).toBe('nightly-coroner-2026-10-16');
  expect((await runNightlyCoronerJob({ ...jobOptions(root), now: Date.parse('2026-10-17T12:01:00Z') })).enqueued).toBeNull();
  opts.store.update(caught.enqueued, (r) => ({ ...r, job: { ...r.job, status: 'succeeded' } }));
  expect((await runNightlyCoronerJob({ ...jobOptions(root), now: Date.parse('2026-10-17T13:00:00Z') })).enqueued).toBeNull();
  expect(HEALTH_WATCH_JOB_KINDS.get('nightly-coroner')).toBe(HEALTH_NIGHTLY_CORONER_KIND);
});
it('refuses corrupt records and suppresses fixture/dry-run execution', async () => {
  const opts = jobOptions(temp());
  opts.store.list = () => ({ records: [], corrupt: ['broken'] });
  await expect(runNightlyCoronerJob({ ...opts, now: Date.now() })).rejects.toThrow('corrupt');
  for (const flags of [{ 'dry-run': true }, { 'state-root': 'fixture' }, { 'ps-fixture': 'fixture' }, { 'no-gh': true }]) {
    expect(nightlyCoronerTickAllowed(flags, { enabled: true })).toBe(false);
  }
  expect(nightlyCoronerTickAllowed({}, { enabled: true })).toBe(true);
});
it('clears retained failed nights after a later successful night without republishing the failure', async () => {
  const opts = jobOptions(temp());
  const failed = await runNightlyCoronerJob({ ...opts, now: Date.parse('2026-10-17T02:17:00Z') });
  opts.store.update(failed.enqueued, (r) => ({ ...r, job: { ...r.job, status: 'failed', error: 'lane unavailable' } }));
  const failure = await runNightlyCoronerJob({ ...opts, now: Date.parse('2026-10-17T03:00:00Z') });
  expect(failure.alerts).toHaveLength(1);
  expect(failure.failures).toHaveLength(1);
  const feed = readFileSync(opts.statusFeed, 'utf8');
  const next = await runNightlyCoronerJob({ ...opts, now: Date.parse('2026-10-18T02:17:00Z') });
  opts.store.update(next.enqueued, (r) => ({ ...r, job: { ...r.job, status: 'succeeded' } }));
  for (const now of ['2026-10-18T03:00:00Z', '2026-10-18T04:00:00Z']) {
    const result = await runNightlyCoronerJob({ ...opts, now: Date.parse(now) });
    expect(result.alerts).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(readFileSync(opts.statusFeed, 'utf8')).toBe(feed);
  }
  expect(opts.store.read(failed.enqueued).job.status).toBe('failed');
});
it('publishes a previous night failed by a restart after the next boundary, once, without a current alert', async () => {
  const opts = jobOptions(temp());
  const first = await runNightlyCoronerJob({ ...opts, now: Date.parse('2026-10-17T02:17:00Z') });
  opts.store.update(first.enqueued, (r) => markLaunching(r, { at: '2026-10-17T02:17:01.000Z' })); // its child then dies
  const now = Date.parse('2026-10-18T02:17:00Z');
  const restarted = { ...opts, reattach: (args) => reattachTick({ ...args, observation: { now, slept: false, gapMs: 0 }, launch: vi.fn() }) };
  const result = await runNightlyCoronerJob({ ...restarted, now });
  expect(opts.store.read(first.enqueued).job).toMatchObject({ status: 'failed', error: expect.stringContaining('deadline exceeded') });
  expect(result.alerts).toEqual([]);
  const lines = readFileSync(opts.statusFeed, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(parseFeedLine(lines[0])).toMatchObject({ kind: 'coroner-failed', job: first.enqueued, error: expect.stringContaining('deadline exceeded') });
  expect(opts.store.read(first.enqueued).failurePublishedAt).toBeTruthy();
  for (const at of ['2026-10-18T02:18:00Z', '2026-10-18T03:00:00Z']) await runNightlyCoronerJob({ ...opts, now: Date.parse(at) });
  expect(readFileSync(opts.statusFeed, 'utf8').trim().split('\n')).toHaveLength(1);
});
it('keeps alerting on a previous night wedged past its deadline that cannot be stopped, publishing it once', async () => {
  const opts = jobOptions(temp());
  const first = await runNightlyCoronerJob({ ...opts, now: Date.parse('2026-10-17T02:17:00Z') });
  opts.store.update(first.enqueued, (r) => ({ ...r, job: { ...r.job, status: 'running', handle: 'testhost:4242:1', attempts: 1 } }));
  for (const at of ['2026-10-18T02:17:00Z', '2026-10-18T03:00:00Z', '2026-10-19T02:17:00Z']) {
    const now = Date.parse(at);
    const wedged = { ...opts, reattach: (args) => reattachTick({ ...args, observation: { now, slept: false, gapMs: 0 },
      probe: () => 'alive', stop: async () => ({ gone: false }), launch: vi.fn() }) };
    const result = await runNightlyCoronerJob({ ...wedged, now });
    expect(result.enqueued).toBeNull();
    expect(result.alerts.map((a) => a.id)).toEqual([first.enqueued]);
  }
  expect(opts.store.read(first.enqueued).job.status).toBe('running');
  expect(readFileSync(opts.statusFeed, 'utf8').trim().split('\n')).toHaveLength(1);
});
it('publishes a retained historical failure that was never published, once', async () => {
  const opts = jobOptions(temp());
  const old = await runNightlyCoronerJob({ ...opts, now: Date.parse('2026-10-15T02:17:00Z') });
  opts.store.update(old.enqueued, (r) => ({ ...r, job: { ...r.job, status: 'failed', error: 'lane unavailable' } }));
  for (const at of ['2026-10-18T03:00:00Z', '2026-10-18T03:01:00Z']) {
    expect((await runNightlyCoronerJob({ ...opts, now: Date.parse(at) })).alerts).toEqual([]);
  }
  const lines = readFileSync(opts.statusFeed, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(parseFeedLine(lines[0])).toMatchObject({ job: old.enqueued, error: 'lane unavailable' });
});
it('scrubs and bounds failure text before appending the raw feed line', () => {
  const feed = join(temp(), 'feed.jsonl');
  const secret = `ghp_${'a'.repeat(36)}`;
  publishCoronerFailure({ id: 'nightly-coroner-2026-10-16', error: `${secret}\n\r\u2028\u2029\u202e${'x'.repeat(20000)}`, reason: 'attempts exhausted', attempts: 3, maxAttempts: 3 }, feed);
  const line = readFileSync(feed, 'utf8').trim();
  expect(line).not.toContain(secret);
  expect(line).not.toMatch(/[\u2028\u2029\u202e]/);
  expect(line.length).toBeLessThan(6000);
  expect(parseFeedLine(line)).toMatchObject({ kind: 'coroner-failed', attempts: 3 });
});
function extraction(root) {
  const home = join(root, 'handoff'), dir = join(root, 'state'), lane = { lane: 7, holder: 'coroner-test', path: join(root, 'lane') };
  const ops = join(lane.path, 'scripts/operations');
  mkdirSync(ops, { recursive: true });
  writeFileSync(join(ops, 'coroner-extract.mjs'), '');
  return { input: { night: '2026-10-16', until: '2026-10-17T02:17:00.000Z', dir, sourceRoot: root },
    io: { root, home, statusFeed: join(home, 'needs-you-events.jsonl'), acquire: vi.fn(async () => lane), release: vi.fn(async () => {}), sweep: vi.fn(async () => {}), run: vi.fn(async () => JSON.stringify({ changeRequests: { rounds: 2 } })) } };
}
it.each(['lane-directory', 'script-file'])('executes both extractor CLIs through a symlinked %s path', async (kind) => {
  const root = temp(); const { input, io } = extraction(root);
  const lane = await io.acquire(); io.acquire.mockClear();
  const script = `import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ sessions: { count: 3 }, cli: true }));
}
`;
  const ops = join(lane.path, 'scripts/operations');
  for (const name of ['coroner-extract.mjs', 'coroner-false-findings.mjs']) {
    const path = join(ops, name);
    if (kind === 'script-file') {
      const physical = join(root, `physical ${name}`);
      writeFileSync(physical, script);
      rmSync(path, { force: true });
      symlinkSync(physical, path);
    } else writeFileSync(path, script);
  }
  if (kind === 'lane-directory') {
    const alias = join(root, 'lane alias');
    symlinkSync(lane.path, alias, 'dir');
    lane.path = alias;
  }
  io.run = vi.fn(async (args, cwd) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 5000 }));
  const result = await extractNightlyCoroner(input, io);
  const report = readFileSync(join(io.home, result.report), 'utf8');
  expect(report).toContain('Sessions observed: 3');
  expect(report.match(/"cli": true/g)).toHaveLength(2);
  expect(io.run).toHaveBeenCalledTimes(2);
  expect(io.release).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(join(input.dir, 'nightly-coroner-cursor.json'), 'utf8')).lastEnd).toBe(input.until);
});
it('leases/releases, publishes a report and feed line, and persists cursor across independent runs', async () => {
  const root = temp(); const { input, io } = extraction(root);
  const first = await extractNightlyCoroner(input, io);
  expect(first.window.since).toBe('2026-10-16T02:17:00.000Z');
  expect(io.acquire).toHaveBeenCalledOnce(); expect(io.release).toHaveBeenCalledOnce();
  expect(io.run.mock.calls[0][0]).toContain('--no-save');
  expect(readFileSync(join(io.home, first.report), 'utf8')).toContain('"rounds": 2');
  // Simulate interruption between report publication and cursor persistence.
  rmSync(join(input.dir, 'nightly-coroner-cursor.json'));
  await extractNightlyCoroner(input, io);
  expect(JSON.parse(readFileSync(join(input.dir, 'nightly-coroner-cursor.json'), 'utf8')).lastEnd).toBe(input.until);
  expect(io.run).toHaveBeenCalledOnce();
  expect(readFileSync(io.statusFeed, 'utf8').trim().split('\n')).toHaveLength(1);
  const next = await extractNightlyCoroner({ ...input, night: '2026-10-17', until: '2026-10-18T02:17:00.000Z' }, io);
  expect(next.window.since).toBe(input.until);
  expect(JSON.parse(readFileSync(join(input.dir, 'nightly-coroner-cursor.json'), 'utf8')).lastEnd).toBe(next.window.until);
});
it('releases a lane on extraction failure and never advances cursor or publishes success', async () => {
  const { input, io } = extraction(temp()); io.run.mockRejectedValue(new Error('extract failed'));
  await expect(extractNightlyCoroner(input, io)).rejects.toThrow('extract failed');
  expect(io.release).toHaveBeenCalledOnce();
  expect(existsSync(join(input.dir, 'nightly-coroner-cursor.json'))).toBe(false);
  expect(existsSync(io.statusFeed)).toBe(false);
});
it('runs the optional false-findings extractor when present', async () => {
  const { input, io } = extraction(temp());
  const ops = join((await io.acquire()).path, 'scripts/operations'); mkdirSync(ops, { recursive: true });
  writeFileSync(join(ops, 'coroner-false-findings.mjs'), '');
  await extractNightlyCoroner(input, io);
  expect(io.run).toHaveBeenCalledTimes(2);
  expect(io.run.mock.calls[1][0][0]).toContain('coroner-false-findings.mjs');
});
it('publishes real deterministic extraction output from isolated inputs', async () => {
  const { runCoroner } = await import('../../operations/coroner-extract.mjs');
  const root = temp(); const { input, io } = extraction(root);
  const env = Object.fromEntries(['JOBS', 'JOBS_ARCHIVE', 'PROJECTS', 'DAEMON_DIR', 'VERIFY_LOG', 'ADMISSION', 'LANES', 'STATE', 'COORD', 'BACKLOG', 'LAUNCH_AGENTS'].map((key) => [`WE_CORONER_${key}`, join(root, key.toLowerCase())]));
  env.WE_CORONER_NO_EXECUTORS = '1';
  io.run = async ([, ...args]) => runCoroner(args, { env, home: root, gh: (args) => args[1].includes('/actions/') ? { workflow_runs: [] } : [] }).output;
  const report = await extractNightlyCoroner(input, io);
  const text = readFileSync(join(io.home, report.report), 'utf8');
  expect(text).toContain('"errorRates"');
  expect(text).toContain('"changeRequests"');
  expect(report.window.until).toBe(input.until);
});
it('passes its exact extractor argv through both real CLI parsers (job and scripts cannot drift)', async () => {
  const { runCoroner } = await import('../../operations/coroner-extract.mjs');
  const { runFalseFindings } = await import('../../operations/coroner-false-findings.mjs');
  const root = temp(); const { input, io } = extraction(root);
  writeFileSync(join((await io.acquire()).path, 'scripts/operations/coroner-false-findings.mjs'), '');
  const env = Object.fromEntries(['JOBS', 'JOBS_ARCHIVE', 'PROJECTS', 'DAEMON_DIR', 'VERIFY_LOG', 'ADMISSION', 'LANES', 'STATE', 'COORD', 'BACKLOG', 'LAUNCH_AGENTS'].map((key) => [`WE_CORONER_${key}`, join(root, key.toLowerCase())]));
  env.WE_CORONER_NO_EXECUTORS = '1';
  let seenWindow;
  io.run = vi.fn(async ([script, ...args]) => script.endsWith('coroner-false-findings.mjs')
    ? runFalseFindings(args, { env, home: root, collect: (w) => { seenWindow = w; return { count: 0 }; } }).output
    : runCoroner(args, { env, home: root, gh: (a) => a[1].includes('/actions/') ? { workflow_runs: [] } : [] }).output);
  const report = await extractNightlyCoroner(input, io);
  expect(io.run).toHaveBeenCalledTimes(2);
  expect(io.run.mock.calls[1][0].slice(1)).toEqual(coronerExtractorArgs(report.window.since, input.until));
  expect(seenWindow).toEqual(report.window);
});
it('caps each extractor run at coroner.nightly.runTimeoutMin, falling back to the default when invalid', async () => {
  for (const [runTimeoutMin, expected] of [[7, 7 * 60000], [0, NIGHTLY_DEFAULTS.runTimeoutMin * 60000]]) {
    const { input, io } = extraction(temp());
    writeFileSync(join((await io.acquire()).path, 'scripts/operations/coroner-false-findings.mjs'), '');
    await extractNightlyCoroner({ ...input, nightly: { ...NIGHTLY_DEFAULTS, runTimeoutMin } }, io);
    expect(io.run.mock.calls.map((c) => c[2].timeout)).toEqual([expected, expected]);
  }
  const log = vi.fn();
  const read = () => JSON.stringify({ coroner: { nightly: { runTimeoutMin: 12 } } });
  const out = resolveNightlyCoronerSettings({ read, log, env: {} });
  expect(out.value.runTimeoutMin).toBe(12);
  expect(log.mock.calls.flat().join('\n')).toContain('runTimeoutMin');
  expect(resolveNightlyCoronerSettings({ read: () => JSON.stringify({ coroner: { nightly: { runTimeoutMin: -1 } } }), log, env: {} }).value.runTimeoutMin).toBe(NIGHTLY_DEFAULTS.runTimeoutMin);
});
it.each([
  ['2026-10-16', '2026-10-17T07:30:00.000Z'],
  ['2026-01-16', '2026-01-17T08:30:00.000Z'],
  ['2026-03-07', '2026-03-08T07:30:00.000Z'],
  ['2026-10-31', '2026-11-01T08:30:00.000Z'],
])('resolves the next ET morning deadline for %s', (night, expected) => {
  expect(new Date(coronerDeadline(night)).toISOString()).toBe(expected);
});
it.each(['02:00', '02:15', '02:30', '02:59'])('expires nonexistent ET deadline %s at the first valid instant after the gap', (deadline) => {
  expect(new Date(coronerDeadline('2026-03-07', deadline)).toISOString()).toBe('2026-03-08T07:00:00.000Z');
});
it('chooses the first occurrence of an ambiguous ET deadline', () => {
  expect(new Date(coronerDeadline('2026-10-31', '01:30')).toISOString()).toBe('2026-11-01T05:30:00.000Z');
});
it.each([
  [undefined, 600000], [0, 600000], [-1, 600000], [123456, 123456],
])('forwards laneWaitMs=%s as --wait-ms=%s', async (laneWaitMs, expected) => {
  const { input, io } = extraction(temp());
  delete io.acquire;
  io.run.mockResolvedValueOnce(JSON.stringify({ lane: 7, holder: 'test', path: join(io.root, 'lane') }));
  await extractNightlyCoroner({ ...input, nightly: { laneWaitMs } }, io);
  expect(io.run.mock.calls[0][0]).toContain(`--wait-ms=${expected}`);
});
async function driveNight({ failAlways = false, deadline = false, retryBackoffMin = 10 } = {}) {
  const root = temp(), { input, io } = extraction(root), opts = jobOptions(root);
  opts.dir = input.dir;
  opts.config.retryBackoffMin = retryBackoffMin;
  let now = Date.parse(input.until);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const promises = [];
  io.acquire.mockRejectedValueOnce(new Error('no lane within 600000ms (lock contention)'));
  if (failAlways) io.acquire.mockRejectedValue(new Error('gh throttle: retry later'));
  opts.reattach = (args) => reattachTick({ ...args, observation: { now, slept: false, gapMs: 0 }, probe: () => 'dead',
    launch: ({ store, id }) => {
      const record = store.update(id, (r) => markLaunching(r, { at: new Date(now).toISOString() }));
      promises.push(runJob({ env: { [JOB_ID_ENV]: id, [JOB_ATTEMPT_ENV]: String(record.job.attempts), OPERATION_RUNS_DIR: store.dir },
        readStart: () => 'test-start', steps: [{ name: 'extract', run: ({ input: jobInput }) => extractNightlyCoroner(jobInput, io) }] }));
      return record;
    },
  });
  const tick = async () => {
    const out = await runNightlyCoronerJob({ ...opts, now });
    await Promise.all(promises.splice(0));
    return out;
  };
  await tick(); // first extraction fails
  await tick(); // dead child requeued with ten minute backoff
  const id = 'nightly-coroner-2026-10-16';
  expect(opts.store.read(id).job.nextAttemptAt).toBe(new Date(Date.parse(input.until) + retryBackoffMin * 60000).toISOString());
  if (deadline) now = coronerDeadline(input.night);
  else now += retryBackoffMin * 60000;
  await tick();
  if (failAlways && !deadline) {
    await tick(); // backoff doubles after attempt two
    expect(opts.store.read(id).job.nextAttemptAt).toBe(new Date(now + 2 * retryBackoffMin * 60000).toISOString());
    now += 2 * retryBackoffMin * 60000;
    await tick();
  }
  const result = await tick();
  return { result, opts, io, input, record: opts.store.read(id), tick };
}
it('retries the whole daemon job after lane contention and writes the report and cursor', async () => {
  const { record, io, input } = await driveNight();
  expect(record.job.status).toBe('succeeded');
  expect(record.job.attempts).toBe(2);
  expect(readFileSync(join(io.home, 'coroner-2026-10-16.md'), 'utf8')).toContain('Nightly coroner');
  expect(JSON.parse(readFileSync(join(input.dir, 'nightly-coroner-cursor.json'), 'utf8')).lastEnd).toBe(input.until);
});
it('exhausts attempts, retains the last error and publishes one needs-you failure event', async () => {
  const { record, opts, tick, result } = await driveNight({ failAlways: true });
  expect(record.job.status).toBe('failed');
  expect(record.job.attempts).toBe(3);
  expect(record.job.error).toContain('gh throttle');
  expect(result.alerts[0]).toMatchObject({ attempts: 3, maxAttempts: 3 });
  await tick();
  const lines = readFileSync(opts.statusFeed, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(parseFeedLine(lines[0])).toMatchObject({ kind: 'coroner-failed', attempts: 3, error: expect.stringContaining('gh throttle') });
  const health = runHealthTick(emptyHealthState(), { nightlyCoronerStatus: { alerts: result.alerts, threshold: 3 } }, [coronerSmell], Date.now(), { config: { mode: 'shadow' } });
  expect(health.plan.some((p) => p.kind === 'notify' && !p.suppressed)).toBe(true);
});
it('expires queued retries at the ET deadline without another extraction', async () => {
  const { record, io, opts } = await driveNight({ deadline: true });
  expect(record.job.status).toBe('failed');
  expect(record.job.error).toContain('deadline exceeded');
  expect(io.acquire).toHaveBeenCalledOnce();
  expect(readFileSync(opts.statusFeed, 'utf8')).toContain('deadline exceeded');
});
it('uses a configured retry backoff and doubles it for the second retry', async () => {
  const { record, io } = await driveNight({ failAlways: true, retryBackoffMin: 3 });
  expect(record.job.status).toBe('failed');
  expect(io.acquire).toHaveBeenCalledTimes(3);
});
it('expires a fresh late catch-up without acquiring a lane or launching extraction', async () => {
  const root = temp(), opts = jobOptions(root), { io } = extraction(root);
  const launch = vi.fn(() => { io.acquire(); });
  const now = Date.parse('2026-10-17T08:00:00Z'); // 04:00 ET, after the 03:30 deadline
  opts.reattach = (args) => reattachTick({ ...args, observation: { now, slept: false, gapMs: 0 }, launch });
  const result = await runNightlyCoronerJob({ ...opts, now });
  expect(launch).not.toHaveBeenCalled();
  expect(io.acquire).not.toHaveBeenCalled();
  expect(opts.store.read(result.enqueued).job).toMatchObject({ status: 'failed', attempts: 0, error: expect.stringContaining('deadline exceeded') });
  expect(result.alerts).toHaveLength(1);
  expect(readFileSync(opts.statusFeed, 'utf8')).toContain('deadline exceeded');
});
it('on SIGTERM stops the running extractor subprocess and releases the lane before the job child exits', async () => {
  const root = temp(), { input, io } = extraction(root);
  const lane = await io.acquire();
  const pidFile = join(root, 'extractor.pid');
  // The extractor takes a moment to exit on SIGTERM: the lane must not be released while it still runs.
  writeFileSync(join(lane.path, 'scripts/operations/coroner-extract.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
    `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400));\n${keepAliveScript()}\n`);
  delete io.run; // the real subprocess runner, so the extractor is a live child process
  let aliveAtRelease = null;
  io.release.mockImplementation(async () => { aliveAtRelease = alive(); });
  const store = createJobStore(join(root, 'jobs'));
  mkdirSync(store.dir, { recursive: true });
  enqueueJob({ store, id: 'nightly-coroner-2026-10-16', kindDef: HEALTH_NIGHTLY_CORONER_KIND, codeSha: 'test-sha', input, now: Date.now() });
  const record = store.update('nightly-coroner-2026-10-16', (r) => markLaunching(r, { at: new Date().toISOString() }));
  const signals = new EventEmitter();
  const done = runNightlyCoronerEntry({ io, signals, env: { [JOB_ID_ENV]: record.id, [JOB_ATTEMPT_ENV]: String(record.job.attempts), OPERATION_RUNS_DIR: store.dir } });
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let pid = 0;
  for (let i = 0; i < 200 && !pid; i++) { await new Promise((r) => setTimeout(r, 25)); pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0; }
  expect(pid).toBeGreaterThan(0);
  try {
    signals.emit('SIGTERM', 'SIGTERM');
    expect(await done).toMatchObject({ outcome: 'error' });
    expect(io.release).toHaveBeenCalledWith(lane);
    expect(aliveAtRelease).toBe(false);
    expect(alive()).toBe(false);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(existsSync(join(input.dir, 'nightly-coroner-cursor.json'))).toBe(false);
  } finally { if (alive()) process.kill(pid, 'SIGKILL'); }
});
it('declares a stop grace that covers the child stop plus the bounded release, inside one health tick', () => {
  expect(HEALTH_NIGHTLY_CORONER_KIND.stopGraceMs).toBeGreaterThan(CHILD_STOP_GRACE_MS + RELEASE_TIMEOUT_MS);
  expect(HEALTH_NIGHTLY_CORONER_KIND.stopGraceMs).toBeLessThan(60_000);
});
it('a stop during lane acquire releases the half-claimed lease by session and never runs the extractor', async () => {
  const { input, io } = extraction(temp());
  const controller = new AbortController();
  io.acquire.mockImplementation(() => new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason))));
  const out = extractNightlyCoroner(input, { ...io, signal: controller.signal });
  await new Promise((r) => setTimeout(r, 10));
  controller.abort(new Error('nightly-coroner stopped by SIGTERM'));
  await expect(out).rejects.toThrow('stopped by SIGTERM');
  expect(io.sweep).toHaveBeenCalledTimes(2); // once before acquiring, once for the lease the killed acquire may hold
  expect(io.release).not.toHaveBeenCalled();
  expect(io.run).not.toHaveBeenCalled();
});
it('acquires under the fixed coroner session and bounds the release after a stop', async () => {
  const { input, io } = extraction(temp());
  const lane = await io.acquire();
  delete io.acquire; delete io.release;
  const controller = new AbortController();
  io.run.mockImplementation(async (args, _cwd, opts = {}) => {
    if (args.includes('acquire')) return JSON.stringify(lane);
    if (args.includes('release')) return '';
    controller.abort(new Error('nightly-coroner stopped by SIGTERM'));
    throw opts.signal.reason;
  });
  await expect(extractNightlyCoroner(input, { ...io, signal: controller.signal })).rejects.toThrow('stopped by SIGTERM');
  expect(io.run.mock.calls[0][0]).toContain(`--session=${CORONER_LANE_SESSION}`);
  const release = io.run.mock.calls.find(([args]) => args.includes('release'));
  expect(release[0]).toContain(`--session=${lane.holder}`);
  expect(release[2]).toEqual({ timeout: RELEASE_TIMEOUT_MS });
});
it('sweeps orphaned coroner leases after a failure until a sweep succeeds, never while an attempt is live', async () => {
  const root = temp(), opts = jobOptions(root);
  const now = Date.parse('2026-10-17T08:00:00Z'); // after the deadline: the fresh catch-up fails at once
  opts.reattach = (args) => reattachTick({ ...args, observation: { now, slept: false, gapMs: 0 }, launch: vi.fn() });
  opts.sweepLanes.mockRejectedValueOnce(new Error('lane-pool timed out'));
  const first = await runNightlyCoronerJob({ ...opts, now });
  expect(opts.store.read(first.enqueued).input.laneSession).toBe(coronerLaneSession(opts.store.dir));
  expect(opts.store.read(first.enqueued).laneSweptAt).toBeUndefined(); // the failed sweep stays owed
  await runNightlyCoronerJob({ ...opts, now: now + 60000 });
  expect(opts.sweepLanes).toHaveBeenCalledTimes(2);
  expect(opts.store.read(first.enqueued).laneSweptAt).toBeTruthy();
  await runNightlyCoronerJob({ ...opts, now: now + 120000 });
  expect(opts.sweepLanes).toHaveBeenCalledTimes(2); // paid: never swept again
  expect(opts.sweepLanes).toHaveBeenLastCalledWith(coronerLaneSession(opts.store.dir));
  // A failed record from before lane sessions existed cannot be swept, so it is never stamped as swept.
  const legacy = jobOptions(temp());
  const old = await runNightlyCoronerJob({ ...legacy, now: Date.parse('2026-10-17T03:00:00Z') });
  legacy.store.update(old.enqueued, (r) => ({ ...r, input: { ...r.input, laneSession: undefined }, job: { ...r.job, status: 'failed' } }));
  await runNightlyCoronerJob({ ...legacy, now: Date.parse('2026-10-17T03:01:00Z') });
  expect(legacy.sweepLanes).not.toHaveBeenCalled();
  expect(legacy.store.read(old.enqueued).laneSweptAt).toBeUndefined();
  expect(coronerLaneSession(join(root, 'other-store'))).not.toBe(coronerLaneSession(opts.store.dir));
  const live = jobOptions(temp());
  live.reattach = vi.fn(async ({ store }) => {
    const id = store.list().records[0].id;
    return { actions: [{ id, action: 'requeue' }] };
  });
  await runNightlyCoronerJob({ ...live, now: Date.parse('2026-10-17T03:00:00Z') });
  expect(live.sweepLanes).not.toHaveBeenCalled();
});
it('alerts on the configured consecutive probe failure threshold and resets on success', () => {
  let state = emptyHealthState();
  const now = Date.parse('2026-10-17T03:00:00Z');
  const probes = { nightlyCoronerStatus: { alerts: [], threshold: 4 } };
  for (let i = 1; i <= 4; i++) {
    const result = runHealthTick(state, probes, [coronerSmell], now + i, { config: { mode: 'shadow' }, probeErrors: { nightlyCoronerJob: 'enqueue lock contention' } });
    state = result.state;
    expect(result.plan.some((p) => p.kind === 'notify' && !p.suppressed)).toBe(i === 4);
  }
  const success = runHealthTick(state, probes, [coronerSmell], now + 5);
  expect(success.state.probeErrors.nightlyCoronerJob).toBeUndefined();
});
