/**
 * @file scripts/operations/runs-retention-core.mjs
 * @description R549 — archive-then-delete retention for terminal run records. IO is injected so tests drive it on a
 *   fixture dir. NEVER deletes without a verified archive; NEVER touches a non-terminal record, a parked review run
 *   a `--resume` could need, or anything newer than keepDays. Dry-run (the default) reports counts and bytes only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isRunRecordTerminal, listRunIds, resolveRunsDir, runPath, tryReadRun } from './run-store.mjs';

const DAY = 86400000;
const GIB = 1024 ** 3;
const DEFAULTS = Object.freeze({
  keepDays: 14,
  archiveDir: '~/Library/CloudStorage/GoogleDrive-nic.g.gilbert@gmail.com/My Drive/WE-archive/runs',
  minFreeGiB: 30,
  batchMaxGiB: 4,
  batchMaxCompressedGiB: 2,
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

/** Conservative superset of review runs a `--resume` could need (parked / unfinished advise). */
export function reviewRunMayResume(record) {
  if (record.op !== 'review-pr') return false;
  if (record.resumeOf && !record.stepTimings?.some(t => t?.step === 'advise' && t.finishedAt)) return true;
  return [record.verdict, record.findings?.referralVerdict, record.resumeOf?.verdict].some(verdict =>
    verdict && (verdict.verdict === 'needs-human' || (Array.isArray(verdict.pendingReferrals) && verdict.pendingReferrals.length > 0)));
}

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
  const out = { status: dryRun ? 'dry-run' : 'archived', dryRun, scanned: 0, eligible: 0, eligibleBytes: 0,
    kept: { young: 0, nonTerminal: 0, resumable: 0, unreadable: 0 }, archived: 0, deleted: 0, bytesFreed: 0, archives: [], errors: [], months: {} };
  const cutoff = now - settings.keepDays * DAY;
  const ids = listRunIds(dir);
  out.scanned = ids.length;
  const byMonth = new Map();
  for (const id of ids) {
    let st;
    try { st = statSync(runPath(id, dir)); } catch { out.kept.unreadable++; continue; }
    if (!st.isFile() || st.mtimeMs >= cutoff) { out.kept.young++; continue; }
    const month = monthOf(st.mtimeMs);
    if (o.month && month !== o.month) continue;
    let record;
    try { record = tryReadRun(id, dir); } catch { out.kept.unreadable++; continue; }
    if (!record || !isRunRecordTerminal(record)) { out.kept.nonTerminal++; continue; }
    if (reviewRunMayResume(record)) { out.kept.resumable++; continue; }
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push({ id, name: `${id}.json`, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    out.eligible++; out.eligibleBytes += st.size;
    out.months[month] = (out.months[month] ?? 0) + 1;
  }
  if (dryRun || !out.eligible) { if (!dryRun) out.status = 'nothing-to-do'; return out; }

  // The archive target must already be mounted: never create the cloud-storage root locally.
  const mountRoot = dirname(dirname(settings.archiveDir));
  if (!existsSync(mountRoot)) { out.status = 'skipped'; out.errors.push(`archive target not mounted (${mountRoot} missing); originals retained`); return out; }

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
        let n = 0, final;
        do { final = join(monthDir, `runs-${month}-${String(++n).padStart(3, '0')}.${codec.ext}`); } while (existsSync(final));
        partial = `${final}.partial`;
        const names = batch.map(f => f.name);
        tarCreate(partial, dir, names, codec);
        const written = statSync(partial).size;
        if (written <= 0 || written > maxCompressed) throw new Error(`archive size ${written} out of bounds`);
        // READ-BACK before any delete: the listing must equal the source set exactly.
        const listed = tarList(partial, codec).map(x => x.replace(/^\.\//, '')).sort();
        const want = [...names].sort();
        if (listed.length !== want.length || listed.some((x, i) => x !== want[i])) throw new Error('archive read-back mismatch; originals retained');
        renameSync(partial, final);
        out.archives.push(final); out.archived += names.length;
        for (const f of batch) {
          try {
            const now2 = statSync(runPath(f.id, dir));
            if (now2.mtimeMs !== f.mtimeMs || now2.size !== f.size || now2.ino !== f.ino) { out.kept.young++; continue; } // a writer advanced it
            rmSync(runPath(f.id, dir), { force: true });
            out.deleted++; out.bytesFreed += f.size;
          } catch { /* vanished: nothing to free */ }
        }
      } catch (e) { if (partial) rmSync(partial, { force: true }); out.errors.push(`${month}: ${e.message}`); out.status = 'partial'; return out; }
    }
  }
  return out;
}
