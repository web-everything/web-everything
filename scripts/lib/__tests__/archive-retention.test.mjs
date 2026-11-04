import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, access, readdir, rm, rename, symlink, appendFile, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveRetention, archiveSettings } from '../archive-retention.mjs';
import { runArchiveRetentionTick } from '../../conveyor/archive-retention-tick.mjs';
let root, drive, runs, sessions, stateDir;
const now = Date.now(), old = new Date(now - 45 * 86400000);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archive-retention-'));
  [drive, runs, sessions, stateDir] = ['drive', 'runs', 'sessions', 'state'].map(n => join(root, n));
  await Promise.all([drive, runs, sessions].map(p => mkdir(p)));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function file(path, date = old) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'record'); await utimes(path, date, date); return path; }
async function exists(p) { return access(p).then(() => true, () => false); }
// Existing fixtures have one writer, so this provider owns their entire write lifecycle.
// Tests with live/uncoordinated writers explicitly remove it.
const fixtureWriterExclusion = async (_path, criticalSection) => criticalSection();
const run = (extra = {}) => archiveRetention({ withSourceWriterExclusion: fixtureWriterExclusion, runEligible: () => true, kind: 'runs', driveRoot: drive, runsDir: runs, sessionsDir: sessions, stateDir, now, emit: () => {}, env: { WE_PLATFORM_PREFERENCES_FILE: join(root, 'policy.json') }, ...extra });
it('missing Drive keeps every original and reports skipped', async () => {
  const p = await file(join(runs, 'a.json'));
  expect((await run({ driveRoot: join(root, 'missing') })).status).toBe('skipped');
  expect(await exists(p)).toBe(true);
});
it('truncated bundle fails closed without removing originals', async () => {
  const p = await file(join(runs, 'a.json'));
  const out = await run({ afterBundle: async p => writeFile(p, 'truncated') });
  expect(out.errors.length).toBeGreaterThan(0); expect(await exists(p)).toBe(true);
});
it('listing count mismatch keeps all originals', async () => {
  const p = await file(join(runs, 'a.json'));
  expect((await run({ listBundle: async () => [] })).errors.length).toBeGreaterThan(0);
  expect(await exists(p)).toBe(true);
});
it('verified bundle removes originals, emits bytes, and daily stamp rate limits', async () => {
  const p = await file(join(runs, 'a.json')); const events = [];
  const out = await run({ emit: e => events.push(e) });
  expect(out.filesArchived).toBe(1); expect(out.bytesFreed).toBe(6);
  expect(await exists(p)).toBe(false); expect(events[0].bytesFreed).toBe(6);
  expect((await run()).status).toBe('rate-limited');
});
it('recent files and dry-run originals are untouched', async () => {
  const p = await file(join(runs, 'recent.json'), new Date(now - 60000));
  const q = await file(join(runs, 'old.json'));
  await run({ dryRun: true }); expect(await exists(q)).toBe(true);
  await run(); expect(await exists(p)).toBe(true);
});
it('file modified after bundling is kept', async () => {
  const p = await file(join(runs, 'a.json'));
  await run({ afterBundle: async () => writeFile(p, 'changed') });
  expect(await exists(p)).toBe(true);
});
it('rerun uses numbered parts and never overwrites a daily bundle', async () => {
  await file(join(runs, 'a.json')); await run();
  await file(join(runs, 'b.json')); await run({ now: now + 86400001 });
  expect((await readdir(join(drive, 'runs'))).filter(n => n.endsWith('.tar.gz')).length).toBe(2);
});
it.each(['runs', 'sessions'])('unchanged retained sources are archived only once (%s)', async kind => {
  const p = await file(kind === 'runs' ? join(runs, 'a.json') : join(sessions, 'project', 'old.jsonl'));
  const options = { kind, withSourceWriterExclusion: undefined };
  expect((await run(options)).filesArchived).toBe(1);
  const second = await run({ ...options, now: now + 86400001 });
  expect(second.filesArchived).toBe(0); expect(second.bundles).toEqual([]);
  expect(await readFile(p, 'utf8')).toBe('record');
  const dest = join(drive, kind === 'runs' ? 'runs' : 'claude-sessions');
  expect((await readdir(dest)).filter(n => n.endsWith('.tar.gz'))).toHaveLength(1);
});
it('daily health ticks retain sources and skip their verified versions on the next day', async () => {
  await file(join(runs, 'a.json')); await file(join(sessions, 'project', 'old.jsonl'));
  const archive = request => archiveRetention({ driveRoot: drive, runsDir: runs, sessionsDir: sessions, stateDir,
    emit: () => {}, env: { WE_PLATFORM_PREFERENCES_FILE: join(root, 'policy.json') }, runEligible: () => true, ...request });
  const first = await runArchiveRetentionTick({ now, archive, log: () => {} });
  expect(first.results.map(r => [r.filesArchived, r.filesRetained])).toEqual([[1, 0], [1, 1]]); // runs reclaim via the production writer-exclusion provider; sessions stay retain-only
  const second = await runArchiveRetentionTick({ now: now + 86400001, archive, log: () => {} });
  expect(second.results.map(r => r.bundles)).toEqual([[], []]);
  expect(second.error).toBeNull();
});
it.each(['size', 'mtime', 'same-size restored-mtime'])('changed retained sources are archived again (%s)', async change => {
  const p = await file(join(runs, 'a.json'));
  const options = { withSourceWriterExclusion: undefined };
  await run(options);
  if (change !== 'mtime') await writeFile(p, change === 'size' ? 'longer record' : 'update');
  const date = change === 'mtime' ? new Date(old.getTime() + 10000) : old;
  await utimes(p, date, date);
  const second = await run({ ...options, now: now + 86400001 });
  expect(second.filesArchived).toBe(1); expect(second.bundles).toHaveLength(1);
  const third = await run({ ...options, now: now + 2 * 86400001 });
  expect(third.filesArchived).toBe(0); expect(third.bundles).toEqual([]);
  expect((await readdir(join(drive, 'runs'))).filter(n => n.endsWith('.tar.gz'))).toHaveLength(2);
});
it('failed verification does not mark retained sources as archived', async () => {
  await file(join(runs, 'a.json'));
  const options = { withSourceWriterExclusion: undefined };
  const failed = await run({ ...options, listBundle: async () => [] });
  expect(failed.filesArchived).toBe(0); expect(failed.errors.join()).toMatch(/verification/);
  const retry = await run({ ...options, now: now + 86400001 });
  expect(retry.filesArchived).toBe(1);
  expect((await run({ ...options, now: now + 2 * 86400001 })).filesArchived).toBe(0);
});
it('a changed session companion is archived without duplicating its retained transcript', async () => {
  const project = join(sessions, 'project');
  await file(join(project, 'old.jsonl'));
  const companion = await file(join(project, 'old', 'agent.jsonl'));
  await utimes(join(project, 'old'), old, old);
  const options = { kind: 'sessions', withSourceWriterExclusion: undefined };
  expect((await run(options)).filesArchived).toBe(2);
  await writeFile(companion, 'updated companion'); await utimes(companion, old, old);
  expect((await run({ ...options, now: now + 86400001 })).filesArchived).toBe(1);
  expect((await run({ ...options, now: now + 2 * 86400001 })).filesArchived).toBe(0);
});
it('a source changed during bundling is eligible again after it ages', async () => {
  const p = await file(join(runs, 'a.json'));
  const options = { withSourceWriterExclusion: undefined };
  await run({ ...options, afterBundle: async () => { await writeFile(p, 'update'); await utimes(p, old, old); } });
  expect((await run({ ...options, now: now + 86400001 })).filesArchived).toBe(1);
});
it('dry-run reads archived versions without changing the manifest or stamp', async () => {
  await file(join(runs, 'a.json'));
  await run({ withSourceWriterExclusion: undefined });
  const manifest = join(stateDir, 'runs.manifest.json'), stamp = join(stateDir, 'runs.stamp');
  const before = await Promise.all([readFile(manifest, 'utf8'), readFile(stamp, 'utf8')]);
  expect((await run({ dryRun: true, now: now + 86400001 })).filesEligible).toBe(0);
  expect(await Promise.all([readFile(manifest, 'utf8'), readFile(stamp, 'utf8')])).toEqual(before);
});
it('a different Drive destination does not reuse archived-source evidence', async () => {
  await file(join(runs, 'a.json'));
  await run({ withSourceWriterExclusion: undefined });
  const otherDrive = join(root, 'other-drive'); await mkdir(otherDrive);
  expect((await run({ driveRoot: otherDrive, now: now + 86400001 })).filesArchived).toBe(1);
});
it('an unreadable or oversized manifest fails closed with an operator fallback', async () => {
  const p = await file(join(runs, 'a.json'));
  await run({ withSourceWriterExclusion: undefined });
  const manifest = join(stateDir, 'runs.manifest.json');
  await writeFile(manifest, '{bad json');
  const invalid = await run({ now: now + 86400001 });
  expect(invalid.errors.join()).toMatch(/manifest.*operator/); expect(invalid.bundles).toEqual([]);
  await writeFile(manifest, '{}');
  const fd = await open(manifest, 'r+');
  try { await fd.truncate(128 * 1024 * 1024 + 1); } finally { await fd.close(); }
  const oversized = await run({ now: now + 86400001 });
  expect(oversized.errors.join()).toMatch(/manifest.*operator/); expect(oversized.bundles).toEqual([]);
  expect(await exists(p)).toBe(true);
});
it('manifest publication failure retains sources and retries without trusting partial state', async () => {
  const p = await file(join(runs, 'a.json'));
  const manifest = join(stateDir, 'runs.manifest.json');
  const failed = await run({ afterBundle: async () => mkdir(manifest) });
  expect(failed.errors.length).toBeGreaterThan(0); expect(await exists(p)).toBe(true);
  expect((await readdir(stateDir)).filter(n => n.endsWith('.partial'))).toEqual([]);
  await rm(manifest, { recursive: true });
  const options = { withSourceWriterExclusion: undefined };
  expect((await run({ ...options, now: now + 86400001 })).filesArchived).toBe(1);
  expect((await run({ ...options, now: now + 2 * 86400001 })).filesArchived).toBe(0);
});
it.each(['read', 'write'])('manifest entry bound fails closed on %s', async mode => {
  await file(join(runs, 'a.json')); await run();
  let p = await file(join(runs, 'b.json'));
  if (mode === 'read') {
    expect((await run({ now: now + 86400001 })).filesArchived).toBe(1);
    p = await file(join(runs, 'c.json'));
  }
  const manifest = join(stateDir, 'runs.manifest.json'), before = await readFile(manifest, 'utf8');
  const out = await run({ maxFiles: 1, now: now + 2 * 86400001 });
  expect(out.errors.join()).toMatch(/manifest.*operator/); expect(out.filesArchived).toBe(0);
  expect(await readFile(manifest, 'utf8')).toBe(before); expect(await exists(p)).toBe(true);
});
it('verified manifest progress survives a failed stamp write', async () => {
  await file(join(runs, 'a.json'));
  const stamp = join(stateDir, 'runs.stamp');
  const options = { withSourceWriterExclusion: undefined };
  const first = await run({ ...options, afterBundle: async () => mkdir(stamp) });
  expect(first.filesArchived).toBe(1); expect(first.errors.length).toBeGreaterThan(0);
  await rm(stamp, { recursive: true });
  expect((await run(options)).filesArchived).toBe(0);
});
it('sessions archive old transcript and subagents but keep memory, current and active families', async () => {
  const project = join(sessions, 'project');
  const p = await file(join(project, 'old.jsonl'));
  const sub = await file(join(project, 'old', 'subagents', 'agent.jsonl'));
  // Directory metadata must also age out.
  await utimes(join(project, 'old', 'subagents'), old, old); await utimes(join(project, 'old'), old, old);
  const memory = await file(join(project, 'memory', 'MEMORY.md'));
  const current = await file(join(project, 'current.jsonl'));
  const active = await file(join(project, 'active.jsonl'));
  await file(join(project, 'active', 'subagents', 'agent.jsonl'), new Date(now));
  await run({ kind: 'sessions', env: { CLAUDE_CODE_SESSION_ID: 'current' } });
  expect(await exists(p)).toBe(false); expect(await exists(sub)).toBe(false);
  for (const kept of [memory, current, active]) expect(await exists(kept)).toBe(true);
});
it('oversized scan fails closed with an operator fallback', async () => {
  const p = await file(join(runs, 'a.json')); await file(join(runs, 'b.json'));
  const out = await run({ maxFiles: 1 }); expect(out.errors.join()).toMatch(/operator/); expect(await exists(p)).toBe(true);
});

it('nonempty size mismatch with a valid listing keeps originals', async () => {
  const p = await file(join(runs, 'a.json'));
  const out = await run({ listBundle: async () => ['./a.json'], afterBundle: async p => writeFile(p, 'wrong-size') });
  expect(out.errors.join()).toMatch(/verification/); expect(await exists(p)).toBe(true);
});
it('minimum ten minute write guard applies even with zero keepDays', async () => {
  const p = await file(join(runs, 'writing.json'), new Date(now - 9 * 60000));
  const q = await file(join(runs, 'idle.json'), new Date(now - 11 * 60000));
  const out = await run({ keepDays: 0, minAgeDays: 0 });
  expect(out.errors).toEqual([]); expect(await exists(p)).toBe(true); expect(await exists(q)).toBe(false);
});
it('runs use the Eastern day at the UTC boundary and preserve younger files', async () => {
  const t = Date.parse('2026-09-01T02:00:00Z');
  await file(join(runs, 'old.json'), new Date(t));
  const recent = await file(join(runs, 'young.json'), new Date(now - 13 * 86400000));
  const out = await run(); expect(out.errors).toEqual([]);
  expect(await readdir(join(drive, 'runs'))).toEqual(['runs-2026-08-31.tar.gz']);
  expect(await exists(recent)).toBe(true);
});
it('cascade resolves defaults, platform, tool and environment with provenance', async () => {
  const policy = join(root, 'policy.json');
  await writeFile(policy, JSON.stringify({ archive: { runs: { keepDays: 21 }, sessions: { keepDays: 40 } } }));
  const lines = [];
  const out = archiveSettings({ env: { WE_PLATFORM_PREFERENCES_FILE: policy, WE_ARCHIVE_RUNS_KEEP_DAYS: '7', WE_ARCHIVE_DRIVE_ROOT: drive }, tool: { sessions: { keepDays: 35 } }, log: l => lines.push(l) });
  expect(out.value.runs.keepDays).toBe(7); expect(out.value.sessions.keepDays).toBe(35);
  expect(out.sources).toMatchObject({ 'runs': 'env', 'sessions.keepDays': 'tool', driveRoot: 'env' });
  expect(lines.join()).toContain('(env)');
});
it('invalid policy fails closed before removing any source', async () => {
  const p = await file(join(runs, 'a.json'));
  const out = await run({ tool: { runs: {} } });
  expect(out.errors.join()).toMatch(/invalid archive policy/); expect(await exists(p)).toBe(true);
});

it('Drive disappearing after bundling retains all sources', async () => {
  const p = await file(join(runs, 'a.json'));
  const out = await run({ afterBundle: async () => rename(drive, join(root, 'unmounted')), listBundle: async () => ['./a.json'] });
  expect(out.errors.length).toBeGreaterThan(0); expect(await exists(p)).toBe(true);
});
it('an unavailable Drive path that is a file retains sources', async () => {
  const p = await file(join(runs, 'a.json')); const notDrive = await file(join(root, 'not-drive'));
  expect((await run({ driveRoot: notDrive })).status).toBe('skipped'); expect(await exists(p)).toBe(true);
});
it('symlink archive destination fails closed', async () => {
  const p = await file(join(runs, 'a.json')); const other = join(root, 'other'); await mkdir(other);
  await symlink(other, join(drive, 'runs'));
  expect((await run()).errors.length).toBeGreaterThan(0); expect(await exists(p)).toBe(true);
});
it('same-size replacement after bundling remains local', async () => {
  const p = await file(join(runs, 'a.json'));
  await run({ afterBundle: async () => { await rm(p); await file(p); } });
  expect(await exists(p)).toBe(true);
});
it('dry-run creates neither archives nor rate-limit state', async () => {
  await file(join(runs, 'a.json')); const out = await run({ dryRun: true });
  expect(out.filesEligible).toBe(1); expect(await readdir(drive)).toEqual([]); expect(await exists(stateDir)).toBe(false);
});

it('same-size write with restored mtime remains local through ctime protection', async () => {
  const p = await file(join(runs, 'a.json'));
  await run({ afterBundle: async () => { await writeFile(p, 'update'); await utimes(p, old, old); } });
  expect(await exists(p)).toBe(true);
});
it('concurrent invocation refuses a held lock without touching files', async () => {
  const p = await file(join(runs, 'a.json'));
  await mkdir(join(stateDir, 'runs.lock'), { recursive: true });
  const out = await run(); expect(out.errors.join()).toMatch(/operator.*lock/);
  expect(await exists(p)).toBe(true); expect(await readdir(drive)).toEqual([]);
});
it('session age window protects a transcript when a companion directory is recently modified', async () => {
  const base = join(sessions, 'project'); const p = await file(join(base, 'active.jsonl'));
  await file(join(base, 'active', 'subagents', 'old-agent.jsonl'));
  const out = await run({ kind: 'sessions' }); expect(out.errors).toEqual([]); expect(await exists(p)).toBe(true);
});

it('append between final stat and removal survives without writer exclusion', async () => {
  const p = await file(join(runs, 'a.json'));
  const out = await run({ withSourceWriterExclusion: undefined, afterSourceStat: async path => appendFile(path, '-late') });
  expect(await exists(p)).toBe(true);
  expect(await readFile(p, 'utf8')).toBe('record-late');
  expect(out.bytesFreed).toBe(0);
});
it('an already-open transcript writer keeps late bytes without writer exclusion', async () => {
  const p = await file(join(sessions, 'project', 'old.jsonl'));
  const writer = await open(p, 'a');
  try {
    const out = await run({ kind: 'sessions', withSourceWriterExclusion: undefined, afterSourceStat: async () => writer.write('-late') });
    expect(await exists(p)).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('record-late');
    expect(out.bytesFreed).toBe(0);
  } finally { await writer.close(); }
});

it('default retention reports that verified archives cannot reclaim uncoordinated sources', async () => {
  const p = await file(join(runs, 'a.json')); const events = [];
  const out = await run({ withSourceWriterExclusion: undefined, emit: event => events.push(event) });
  expect(out.filesArchived).toBe(1); expect(out.filesRetained).toBe(1); expect(out.bytesFreed).toBe(0);
  expect(out.status).toBe('partial'); expect(out.errors.join()).toMatch(/Operator must arrange exclusion/);
  expect(await readFile(p, 'utf8')).toBe('record'); expect(events[0].bytesFreed).toBe(0);
});
it('unavailable writer exclusion never invokes removal and retains the original', async () => {
  const p = await file(join(runs, 'a.json'));
  const out = await run({ withSourceWriterExclusion: async () => {} });
  expect(out.filesRetained).toBe(1); expect(out.bytesFreed).toBe(0);
  expect(out.errors.join()).toMatch(/writer exclusion unavailable/); expect(await exists(p)).toBe(true);
});
it('coordinated writer arriving after final stat waits until removal and its new bytes survive', async () => {
  const p = await file(join(runs, 'a.json'));
  let tail = Promise.resolve(), pendingWrite, queued = false;
  const exclusive = fn => { const work = tail.then(fn); tail = work.catch(() => {}); return work; };
  const out = await run({
    withSourceWriterExclusion: (_path, criticalSection) => exclusive(criticalSection),
    afterSourceStat: async path => {
      queued = true;
      pendingWrite = exclusive(() => appendFile(path, '-late'));
      // The writer has arrived but cannot run while verification/removal holds exclusion.
      expect(await readFile(path, 'utf8')).toBe('record');
    },
  });
  await pendingWrite;
  expect(queued).toBe(true); expect(out.errors).toEqual([]); expect(out.bytesFreed).toBe(6);
  expect(await readFile(p, 'utf8')).toBe('-late');
});

// R555: pluggable writer exclusion, batch cap, eligibility, fail-closed.
import { newRunRecord } from '../../operations/run-record.mjs';
const rec = JSON.stringify({ ...newRunRecord({ id: 'r1', op: 'review-pr' }), cursor: 2, verdict: { verdict: 'approve' } });
const realRun = (extra = {}) => run({ runEligible: undefined, ...extra });
it('batch cap archives only the oldest N files per run', async () => {
  const mk = i => file(join(runs, `r${i}.json`), new Date(now - (60 - i) * 86400000));
  const ps = await Promise.all([1, 2, 3, 4, 5].map(mk));
  const out = await run({ batchCap: 2 });
  expect(out.filesArchived).toBe(2);
  expect(await Promise.all(ps.map(exists))).toEqual([false, false, true, true, true]);
});
it('settings default the runs batch cap and schedule with provenance, env overrides the cap', () => {
  const a = archiveSettings({ env: { WE_PLATFORM_PREFERENCES_FILE: join(root, 'p.json') }, tool: {} });
  expect(a.value.runsBatchCap).toBe(5000); expect(a.value.runsSchedule).toBe('daily');
  const b = archiveSettings({ env: { WE_PLATFORM_PREFERENCES_FILE: join(root, 'p.json'), WE_ARCHIVE_RUNS_BATCH_CAP: '7' }, tool: {} });
  expect(b.value.runsBatchCap).toBe(7); expect(b.sources.runsBatchCap).toBe('env');
  expect(() => archiveSettings({ env: { WE_PLATFORM_PREFERENCES_FILE: join(root, 'p.json'), WE_ARCHIVE_RUNS_BATCH_CAP: '0' }, tool: {} })).toThrow(/invalid archive policy/);
});
it('age threshold: records younger than keepDays stay', async () => {
  const young = await file(join(runs, 'y.json'), new Date(now - 3 * 86400000));
  const oldp = await file(join(runs, 'o.json'));
  await realRun({ runEligible: () => true });
  expect(await exists(young)).toBe(true); expect(await exists(oldp)).toBe(false);
});
it('unreadable, non-terminal and PR-evidence records are never eligible', async () => {
  const bad = await file(join(runs, 'bad.json')); // 'record' is not JSON
  const pending = join(runs, 'p.json'); await writeFile(pending, JSON.stringify({ effects: [{ status: 'pending' }] })); await utimes(pending, old, old);
  const pr = join(runs, 'pr.json'); await writeFile(pr, JSON.stringify({ effects: [{ status: 'applied', result: { pr: 1 } }] })); await utimes(pr, old, old);
  const ok = join(runs, 'ok.json'); await writeFile(ok, rec); await utimes(ok, old, old);
  await realRun({ isComplete: () => true });
  expect(await Promise.all([bad, pending, pr, ok].map(exists))).toEqual([true, true, true, false]);
});
it('a live writer pid skips the record; a dead pid is eligible; unreadable state is skipped', async () => {
  const { createRunsWriterExclusion } = await import('../runs-writer-exclusion.mjs');
  const a = join(runs, 'a.json'), b = join(runs, 'b.json'), c = join(runs, 'c.json');
  for (const p of [a, b, c]) { await writeFile(p, rec); await utimes(p, old, old); }
  const u = '1700000000000.abc123';
  await writeFile(join(runs, `a.json.111.${u}.tmp`), '{}');
  await writeFile(join(runs, `b.json.222.${u}.tmp`), '{}');
  await writeFile(join(runs, 'c.json.lock'), 'garbage');
  const provider = createRunsWriterExclusion({ isPidAlive: pid => pid === 111 });
  const out = await realRun({ withSourceWriterExclusion: provider, isComplete: () => true });
  expect(await Promise.all([a, b, c].map(exists))).toEqual([true, false, true]);
  expect(out.errors.join()).toMatch(/writer exclusion unavailable/);
});
it('a writer that appears after a first check is seen (no cached listing)', async () => {
  const { createRunsWriterExclusion } = await import('../runs-writer-exclusion.mjs');
  const provider = createRunsWriterExclusion({ isPidAlive: () => true });
  let n = 0; await provider(join(runs, 'a.json'), async () => { n++; });
  await writeFile(join(runs, 'a.json.5.1700000000000.zz.tmp'), '{}');
  await provider(join(runs, 'a.json'), async () => { n++; });
  expect(n).toBe(1);
});
it('records with unknown effect statuses are not eligible', async () => {
  const { runRecordEligible } = await import('../runs-writer-exclusion.mjs');
  const base = newRunRecord({ id: 'r1', op: 'review-pr' });
  expect(runRecordEligible(JSON.stringify({ ...base, effects: [{ status: 'weird' }] }))).toBe(false);
  expect(runRecordEligible(JSON.stringify({ effects: [] }))).toBe(false); // schema-invalid
  expect(runRecordEligible(rec)).toBe(false); // no completion proof: fail closed
  expect(runRecordEligible(rec, () => true)).toBe(true);
  expect(runRecordEligible(rec, () => false)).toBe(false); // verdict + cursor 2 but not at the declared last step
  const fresh = newRunRecord({ id: 'r1', op: 'review-pr' });
  expect(runRecordEligible(JSON.stringify(fresh))).toBe(false); // cursor 0, no verdict
  expect(runRecordEligible(JSON.stringify({ ...fresh, cursor: 2 }))).toBe(false); // no verdict
  expect(runRecordEligible(JSON.stringify({ ...fresh, verdict: { verdict: 'approve' } }))).toBe(false); // cursor 0
});
it('a record replaced just before removal is restored, not deleted', async () => {
  const p = await file(join(runs, 'r.json'));
  const out = await run({ afterSourceStat: async path => { await writeFile(path + '.n', 'newer-bytes'); await rename(path + '.n', path); } });
  expect(await exists(p)).toBe(true); expect(await readFile(p, 'utf8')).toBe('newer-bytes'); expect(out.filesRetained).toBeGreaterThan(0);
});
it('an unreadable runs directory snapshot fails closed', async () => {
  const { createRunsWriterExclusion } = await import('../runs-writer-exclusion.mjs');
  let ran = false;
  await createRunsWriterExclusion({ list: async () => { throw Error('EIO'); } })(join(runs, 'x.json'), async () => { ran = true; });
  expect(ran).toBe(false);
});
it('Drive verification failure never deletes the local record (runs, real provider)', async () => {
  const { createRunsWriterExclusion } = await import('../runs-writer-exclusion.mjs');
  const p = join(runs, 'v.json'); await writeFile(p, rec); await utimes(p, old, old);
  const out = await realRun({ isComplete: () => true, withSourceWriterExclusion: createRunsWriterExclusion(), listBundle: async () => [] });
  expect(out.errors.length).toBeGreaterThan(0); expect(await exists(p)).toBe(true);
});
it('migration-format temp (<name>.<pid>.<uuid>.tmp) of a live pid also blocks removal', async () => {
  const { createRunsWriterExclusion } = await import('../runs-writer-exclusion.mjs');
  await writeFile(join(runs, 'm.json.77.00000000-0000-0000-0000-000000000000.tmp'), '{}');
  let ran = false;
  await createRunsWriterExclusion({ isPidAlive: () => true })(join(runs, 'm.json'), async () => { ran = true; });
  expect(ran).toBe(false);
});
it('same-inode rewrite with restored mtime is caught by the content hash at quarantine', async () => {
  const p = join(runs, 'h.json'); await writeFile(p, rec); await utimes(p, old, old);
  const out = await realRun({ isComplete: () => true, afterSourceStat: async path => { await writeFile(path, rec.replace('r1', 'r2')); await utimes(path, old, old); } });
  expect(await exists(p)).toBe(true); expect(out.filesRetained).toBeGreaterThan(0);
});

it('runsMinAgeDays (default 7, cascade) holds back records younger than it even with keepDays 0', async () => {
  const a = archiveSettings({ env: { WE_PLATFORM_PREFERENCES_FILE: join(root, 'p.json') }, tool: {} });
  expect(a.value.runsMinAgeDays).toBe(7);
  const b = archiveSettings({ env: { WE_PLATFORM_PREFERENCES_FILE: join(root, 'p.json'), WE_ARCHIVE_RUNS_MIN_AGE_DAYS: '9' }, tool: {} });
  expect(b.value.runsMinAgeDays).toBe(9); expect(b.sources.runsMinAgeDays).toBe('env');
  const young = await file(join(runs, 'y.json'), new Date(now - 3 * 86400000));
  const mid = await file(join(runs, 'm.json'), new Date(now - 8 * 86400000));
  await run({ keepDays: 0 });
  expect(await exists(young)).toBe(true); expect(await exists(mid)).toBe(false);
});
it('a parked .retiring file is restored by the next runs scan, and a failed restore alerts', async () => {
  const parked = join(runs, '.retiring-z.json.11111111-1111-1111-1111-111111111111');
  await writeFile(parked, rec);
  const out = await run({ keepDays: 100, batchCap: 1 });
  expect(await exists(join(runs, 'z.json'))).toBe(true); expect(await exists(parked)).toBe(false); expect(out.errors).toEqual([]);
  // canonical already exists -> restore fails loudly and the parked file stays discoverable
  await writeFile(parked, rec); const events = [];
  const out2 = await run({ keepDays: 100, now: now + 2 * 86400000, emit: e => events.push(e) });
  expect(out2.errors.join()).toMatch(/ALERT/); expect(await exists(parked)).toBe(true);
  expect(events.some(e => e.kind === 'archive-retention-alert')).toBe(true);
});

it('the live registry completion check treats cursor 1 of a multi-step op as unfinished', async () => {
  const { loadRunCompletion } = await import('../runs-writer-exclusion.mjs');
  const done = await loadRunCompletion();
  expect(done({ op: 'no-such-op', cursor: 1, pending: null })).toBe(false);
});
