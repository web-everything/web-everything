import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coronerNightDue, runNightlyCoronerJob, extractNightlyCoroner, resolveNightlyCoronerSettings, nightlyCoronerTickAllowed } from '../nightly-coroner-job.mjs';
import { createJobStore } from '../../lib/daemon-jobs-runtime.mjs';
import { HEALTH_WATCH_JOB_KINDS, HEALTH_NIGHTLY_CORONER_KIND } from '../../../skills-src/conveyor/daemon-manifest.mjs';
const roots = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'nightly-coroner-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
  expect(out.value).toEqual({ at: '21:00', enabled: false });
  expect(out.sources).toEqual({ at: 'tool', enabled: 'platform' });
  expect(log.mock.calls[0][0]).toContain('enabled=false (platform)');
  const overridden = resolveNightlyCoronerSettings({ read, log, config: { coroner: { nightly: { at: '22:00' } } }, env: { WE_CORONER_NIGHTLY_ENABLED: 'true', WE_CORONER_NIGHTLY_AT: '23:11' } });
  expect(overridden.sources).toEqual({ at: 'env', enabled: 'env' });
  expect(overridden.value).toEqual({ at: '23:11', enabled: true });
  const bad = resolveNightlyCoronerSettings({ read, log, env: { WE_CORONER_NIGHTLY_AT: '25:11' } });
  expect(bad.value.at).toBe('21:00'); expect(bad.errors.length).toBeGreaterThan(0);
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  expect(resolveNightlyCoronerSettings({ read: missing, log, env: {} }).value).toEqual({ enabled: true, at: '22:17' });
});
function jobOptions(root) {
  return { dir: root, store: createJobStore(join(root, 'jobs')), config: { enabled: true, at: '22:17' }, codeSha: 'abc',
    reattach: vi.fn(async () => ({})), evict: vi.fn(), snapshot: {}, sourceRoot: root };
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
function extraction(root) {
  const home = join(root, 'handoff'), dir = join(root, 'state'), lane = { lane: 7, holder: 'coroner-test', path: join(root, 'lane') };
  const ops = join(lane.path, 'scripts/operations');
  mkdirSync(ops, { recursive: true });
  writeFileSync(join(ops, 'coroner-extract.mjs'), '');
  return { input: { night: '2026-10-16', until: '2026-10-17T02:17:00.000Z', dir, sourceRoot: root },
    io: { root, home, statusFeed: join(home, 'needs-you-events.jsonl'), acquire: vi.fn(async () => lane), release: vi.fn(async () => {}), run: vi.fn(async () => JSON.stringify({ changeRequests: { rounds: 2 } })) } };
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
