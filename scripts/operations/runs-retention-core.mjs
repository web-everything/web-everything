/**
 * @file scripts/operations/runs-retention-core.mjs
 * @description R549 — archive-then-delete retention for terminal run records. IO is injected so tests drive it on a
 *   fixture dir. NEVER deletes without a verified archive; NEVER touches a non-terminal record, a parked review run
 *   a `--resume` could need, or anything newer than keepDays. Dry-run (the default) reports counts and bytes only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, lstatSync, linkSync, rmdirSync, unlinkSync, rmSync, statSync, statfsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isRunRecordTerminal, listRunIds, resolveRunsDir, runPath } from './run-store.mjs';
import { parseRunRecord } from './run-record.mjs';

const DAY = 86400000;
const GIB = 1024 ** 3;
const DEFAULTS = Object.freeze({
  keepDays: 14,
  archiveDir: '~/Library/CloudStorage/GoogleDrive-nic.g.gilbert@gmail.com/My Drive/WE-archive/runs',
  minFreeGiB: 30,
  batchMaxGiB: 4,
  batchMaxCompressedGiB: 2,
  archivePrEvidence: false,
});

/** standard defaults < scripts/settings/runs-retention.json < env. Invalid values throw (never guess). */
export function resolveRetentionSettings({ env = process.env, tool } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../settings/runs-retention.json'), 'utf8'))?.runs?.retention; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const e = { keepDays: env.WE_RUNS_RETENTION_KEEP_DAYS, archiveDir: env.WE_RUNS_RETENTION_ARCHIVE_DIR,
    minFreeGiB: env.WE_RUNS_RETENTION_MIN_FREE_GIB, batchMaxGiB: env.WE_RUNS_RETENTION_BATCH_MAX_GIB };
  const v = { ...DEFAULTS, ...(tool ?? {}) };
  for (const [k, x] of Object.entries(e)) if (x !== undefined && x !== '') v[k] = k === 'archiveDir' ? x : Number(x);
  for (const k of ['keepDays', 'minFreeGiB', 'batchMaxGiB', 'batchMaxCompressedGiB']) {
    if (!Number.isFinite(v[k]) || v[k] < 0) throw new Error(`runs-retention: invalid setting ${k}=${v[k]}`);
  }
  if (typeof v.archiveDir !== 'string' || !v.archiveDir.trim()) throw new Error('runs-retention: invalid setting archiveDir');
  v.archiveDir = v.archiveDir.replace(/^~(?=\/|$)/, homedir());
  return v;
}

/**
 * NOTE ON WRITERS: run records are only ever written by writeRun -> writeJsonAtomic (temp + same-fs rename), never
 * modified in place, so the inode quarantined below can not change underneath the hash; a concurrent writer creates
 * a NEW file at the canonical name, which this pass never touches.
 */
/** Conservative superset of review runs a `--resume` could need (parked / unfinished advise). */
export function reviewRunMayResume(record) {
  if (record.op !== 'review-pr') return false;
  if (record.resumeOf && !record.stepTimings?.some(t => t?.step === 'advise' && t.finishedAt)) return true;
  return [record.verdict, record.findings?.referralVerdict, record.resumeOf?.verdict].some(verdict =>
    verdict && (verdict.verdict === 'needs-human' || (Array.isArray(verdict.pendingReferrals) && verdict.pendingReferrals.length > 0)));
}

const hashOf = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const monthOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).format(ms).slice(0, 7);

export function defaultCodec() {
  const zstd = spawnSync('zstd', ['--version']).status === 0;
  return { ext: zstd ? 'tar.zst' : 'tar.gz', flag: zstd ? '--zstd' : '-z' };
}
export function defaultTarCreate(dest, srcDir, names, codec) {
  const dir = mkdtempSync(join(tmpdir(), 'runs-retention-'));
  try {
    const list = join(dir, 'files');
    writeFileSync(list, names.join('\0') + '\0');
    const r = spawnSync('tar', ['-c', codec.flag, '-f', dest, '-C', srcDir, '--null', '-T', list], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`tar create failed: ${String(r.stderr).split('\n')[0]}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function defaultTarList(file, codec) {
  const r = spawnSync('tar', ['-t', codec.flag, '-f', file], { maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`tar list failed: ${String(r.stderr).split('\n')[0]}`);
  return String(r.stdout).split('\n').filter(Boolean);
}
function defaultVerify(file, batch, codec) {
  const tmp = mkdtempSync(join(tmpdir(), 'runs-retention-verify-'));
  try {
    const r = spawnSync('tar', ['-x', codec.flag, '-f', file, '-C', tmp], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`tar extract failed: ${String(r.stderr).split('\n')[0]}`);
    for (const f of batch) {
      const p = join(tmp, f.name);
      const l = lstatSync(p);
      if (!l.isFile() || hashOf(p) !== f.hash) throw new Error(`archive content mismatch for ${f.name}; originals retained`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
const defaultFreeGiB = dir => { const s = statfsSync(dir); return (s.bavail * s.bsize) / GIB; };

/**
 * @returns {{status:string, dryRun:boolean, scanned:number, eligible:number, eligibleBytes:number, kept:{young:number,nonTerminal:number,resumable:number,unreadable:number},
 *   archived:number, deleted:number, bytesFreed:number, archives:string[], errors:string[]}}
 */
export function runsRetention(o = {}) {
  const settings = o.settings ?? resolveRetentionSettings({ env: o.env });
  const dir = o.runsDir ?? resolveRunsDir();
  const now = o.now ?? Date.now();
  const dryRun = o.dryRun !== false;
  const codec = o.codec ?? defaultCodec();
  const tarCreate = o.tarCreate ?? defaultTarCreate, tarList = o.tarList ?? defaultTarList;
  const freeGiB = o.freeGiB ?? defaultFreeGiB;
  const isComplete = o.isComplete ?? (() => false);
  const verifyContents = o.verifyContents ?? defaultVerify;
  const out = { status: dryRun ? 'dry-run' : 'archived', dryRun, scanned: 0, eligible: 0, eligibleBytes: 0,
    kept: { young: 0, nonTerminal: 0, resumable: 0, unreadable: 0 }, archived: 0, deleted: 0, bytesFreed: 0, archives: [], errors: [], months: {} };
  const cutoff = now - settings.keepDays * DAY;
  // Crash recovery: a record parked under .retiring-* by an interrupted pass goes back to its canonical name.
  if (!dryRun) for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const m = /^\.retiring-(.+)\.[0-9a-f-]{36}$/.exec(name);
    if (m) { try { linkSync(join(dir, name), runPath(m[1], dir)); unlinkSync(join(dir, name)); } catch { /* canonical exists: leave the parked copy for an operator */ } }
  }
  const ids = listRunIds(dir);
  out.scanned = ids.length;
  const byMonth = new Map();
  for (const id of ids) {
    let st;
    try { st = lstatSync(runPath(id, dir)); } catch { out.kept.unreadable++; continue; }
    if (!st.isFile() || st.mtimeMs >= cutoff) { out.kept.young++; continue; }
    const month = monthOf(st.mtimeMs);
    if (o.month && month !== o.month) continue;
    // ONE read: eligibility and the content hash come from the same bytes.
    let record, bytes;
    try {
      bytes = readFileSync(runPath(id, dir));
      const parsed = parseRunRecord(bytes.toString('utf8'));
      if (!parsed.ok) throw new Error(parsed.reason);
      record = parsed.record;
    } catch { out.kept.unreadable++; continue; }
    // Finished = no pending effect AND the cursor reached the declaration's last step (`isComplete`, injected;
    // unknown op or no injection = retained). An interrupted run between steps is what --resume continues.
    if (!record || !isRunRecordTerminal(record) || !isComplete(record)) { out.kept.nonTerminal++; continue; }
    if (reviewRunMayResume(record)) { out.kept.resumable++; continue; }
    // PR evidence outlives the cursor (same rule as pruneTerminalRuns): retained unless the setting opts in.
    if (!settings.archivePrEvidence && record.effects.some(e => e?.result?.pr)) { out.kept.resumable++; continue; }
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push({ id, name: `${id}.json`, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, hash: createHash('sha256').update(bytes).digest('hex') });
    out.eligible++; out.eligibleBytes += st.size;
    out.months[month] = (out.months[month] ?? 0) + 1;
  }
  if (dryRun || !out.eligible) { if (!dryRun) out.status = 'nothing-to-do'; return out; }

  // The archive target must already be mounted: never create the cloud-storage root locally.
  const mountRoot = dirname(dirname(settings.archiveDir));
  const realDir = p => { try { const l = lstatSync(p); return l.isDirectory() && !l.isSymbolicLink() ? l : null; } catch { return null; } };
  const mount0 = realDir(mountRoot);
  if (!mount0) { out.status = 'skipped'; out.errors.push(`archive target not mounted (${mountRoot} missing or not a real directory); originals retained`); return out; }
  const mountSame = () => { const m = realDir(mountRoot); return m && m.dev === mount0.dev && m.ino === mount0.ino; };
  // One invocation at a time: an atomic mkdir lock beside the archives (never overwrite a verified archive).
  const lockDir = join(dirname(settings.archiveDir), '.runs-retention.lock');
  try { mkdirSync(dirname(settings.archiveDir), { recursive: true }); mkdirSync(lockDir); }
  catch (e) { out.status = 'skipped'; out.errors.push(`archive busy or unwritable (${e.code}); originals retained`); return out; }
  try { return archiveAll(); } finally { rmdirSync(lockDir); }
  function archiveAll() {
  const maxBytes = settings.batchMaxGiB * GIB, maxCompressed = settings.batchMaxCompressedGiB * GIB;
  for (const [month, files] of [...byMonth].sort()) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
    const batches = []; let cur = [], size = 0;
    for (const f of files) {
      if (cur.length && size + f.size > maxBytes) { batches.push(cur); cur = []; size = 0; }
      cur.push(f); size += f.size;
    }
    if (cur.length) batches.push(cur);
    const monthDir = join(settings.archiveDir, month);
    for (const batch of batches) {
      if (freeGiB(dir) < settings.minFreeGiB) { out.status = 'paused-low-disk'; out.errors.push(`free disk below ${settings.minFreeGiB} GiB; paused`); return out; }
      let partial;
      try {
        mkdirSync(monthDir, { recursive: true });
        partial = join(monthDir, `.${randomUUID()}.${codec.ext}.partial`);
        const names = batch.map(f => f.name);
        tarCreate(partial, dir, names, codec);
        const written = statSync(partial).size;
        if (written <= 0 || written > maxCompressed) throw new Error(`archive size ${written} out of bounds`);
        // READ-BACK before any delete: the listing must equal the source set exactly.
        const listed = tarList(partial, codec).map(x => x.replace(/^\.\//, '')).sort();
        const want = [...names].sort();
        if (listed.length !== want.length || listed.some((x, i) => x !== want[i])) throw new Error('archive read-back mismatch; originals retained');
        // Content read-back: extract and compare every entry's hash with the source hash taken at selection.
        verifyContents(partial, batch, codec);
        // Reserve an unused final name atomically: link() fails on EEXIST, so no verified archive is ever replaced.
        let final;
        for (let n = 1; n < 10000 && !final; n++) {
          const candidate = join(monthDir, `runs-${month}-${String(n).padStart(3, '0')}.${codec.ext}`);
          try { linkSync(partial, candidate); final = candidate; } catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
        if (!final) throw new Error('archive part bound exceeded');
        unlinkSync(partial); partial = undefined;
        if (!mountSame()) throw new Error('archive mount changed; originals retained');
        out.archives.push(final); out.archived += names.length;
        for (const f of batch) {
          const path = runPath(f.id, dir), held = join(dir, `.retiring-${f.id}.${randomUUID()}`);
          try {
            // Move the record AWAY first (atomic): a writer replacing it now creates an independent new file, and
            // the exact inode we hash is the one we delete. A changed record is put back, never destroyed.
            renameSync(path, held);
            if (hashOf(held) === f.hash && lstatSync(held).isFile()) { unlinkSync(held); out.deleted++; out.bytesFreed += f.size; }
            else {
              out.kept.young++;
              try { linkSync(held, path); unlinkSync(held); } catch { out.errors.push(`${f.id}: changed after archive; kept at ${held}`); }
            }
          } catch (e) {
            if (e.code !== 'ENOENT') out.errors.push(`${f.id}: delete failed (${e.code ?? e.message}); original retained`);
          }
        }
      } catch (e) { if (partial) rmSync(partial, { force: true }); out.errors.push(`${month}: ${e.message}`); out.status = 'partial'; return out; }
    }
  }
  return out;
  }
}
