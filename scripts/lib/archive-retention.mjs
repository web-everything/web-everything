/** R217: archives are retained forever; source removal requires verified Drive evidence. */
import { lstat, opendir, mkdir, writeFile, rename, unlink, rmdir, mkdtemp, rm, link, access } from 'node:fs/promises';
import { join, dirname, basename, relative, resolve, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { sharedRunsDir } from '../operations/run-store.mjs';
import { resolveCascade, readPlatformPreferences, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { boundedText } from './host-overload-settings.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { createRunsWriterExclusion, runRecordEligible, loadRunCompletion } from './runs-writer-exclusion.mjs';
import { readFile } from 'node:fs/promises';
const exec = promisify(execFile);
const DAY = 86400000;
const standard = { runs: { keepDays: 14 }, sessions: { keepDays: 30 }, runsBatchCap: 5000, runsSchedule: 'daily', runsMinAgeDays: 7, driveRoot: join(homedir(), 'Library', 'CloudStorage', 'GoogleDrive-nic.g.gilbert@gmail.com', 'My Drive', 'web-everything-archive') };
export function archiveSettings({ env = process.env, tool, log = console.error } = {}) {
  const p = readPlatformPreferences({ env, readFile: path => boundedText(path) });
  if (p.errors.length) throw Error(p.errors.join('; '));
  if (!tool) {
    try { tool = JSON.parse(boundedText(join(dirname(fileURLToPath(import.meta.url)), '../settings/archive-retention.json'))).archive; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const envValues = {};
  for (const kind of ['runs', 'sessions']) {
    const v = env[`WE_ARCHIVE_${kind.toUpperCase()}_KEEP_DAYS`];
    if (v !== undefined) envValues[kind] = { keepDays: Number(v) };
  }
  if (env.WE_ARCHIVE_RUNS_MIN_AGE_DAYS !== undefined) envValues.runsMinAgeDays = Number(env.WE_ARCHIVE_RUNS_MIN_AGE_DAYS);
  if (env.WE_ARCHIVE_RUNS_BATCH_CAP !== undefined) envValues.runsBatchCap = Number(env.WE_ARCHIVE_RUNS_BATCH_CAP);
  if (env.WE_ARCHIVE_DRIVE_ROOT !== undefined) envValues.driveRoot = env.WE_ARCHIVE_DRIVE_ROOT;
  const valid = { runs: v => Number.isSafeInteger(v?.keepDays ?? v) && (v?.keepDays ?? v) >= 0,
    sessions: v => Number.isSafeInteger(v?.keepDays ?? v) && (v?.keepDays ?? v) >= 0,
    runsBatchCap: v => Number.isSafeInteger(v) && v > 0,
    runsSchedule: v => v === 'daily',
    runsMinAgeDays: v => Number.isSafeInteger(v) && v >= 0,
    driveRoot: v => typeof v === 'string' && v.trim().length > 0 };
  // Validate complete blocks too: empty objects must not silently disappear in the cascade.
  for (const layer of [p.prefs.archive, tool, envValues]) if (layer !== undefined) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) throw Error('invalid archive policy');
    for (const k of Object.keys(valid)) if (Object.hasOwn(layer, k) && (!valid[k](layer[k]) || (!['driveRoot', 'runsBatchCap', 'runsSchedule', 'runsMinAgeDays'].includes(k) && (typeof layer[k] !== 'object' || Array.isArray(layer[k]))))) throw Error(`invalid archive policy: ${k}`);
  }
  const r = resolveCascade({ standard, platform: p.prefs.archive, tool, envValues, valid });
  if (r.invalid.length) throw Error(`invalid archive policy: ${r.invalid.join('; ')}`);
  log(formatCascadeSourcesLine('archive', r));
  return r;
}
/** Default provider per kind: runs get the live-writer exclusion; sessions keep the retain-only behaviour. */
export const defaultWriterExclusion = kind => (kind === 'runs' ? createRunsWriterExclusion() : undefined);
const dayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const same = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
// Include identity/ctime so a replacement or a same-size write with restored mtime is new.
const version = s => [s.size, s.mtimeMs, s.ctimeMs, s.dev, s.ino];
const MAX_REMOVAL_RETRIES = 3;
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
async function readArchiveManifest(path, source, drive, maxFiles) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw Error('invalid or oversized manifest');
    const data = JSON.parse(boundedText(path, stat.size));
    if (data.v !== 1 || typeof data.source !== 'string' || typeof data.drive !== 'string' || !Array.isArray(data.files) || data.files.length > maxFiles) throw Error('invalid or oversized manifest');
    const files = new Map();
    for (const entry of data.files) {
      if (!Array.isArray(entry) || entry.length !== 6 || typeof entry[0] !== 'string' || !entry[0] || relative(source, resolve(source, entry[0])) !== entry[0] || entry[0].startsWith('../') || !entry.slice(1).every(Number.isFinite) || files.has(entry[0])) throw Error('invalid manifest entry');
      files.set(entry[0], entry.slice(1));
    }
    return data.source === source && data.drive === drive ? files : new Map();
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    throw Error(`archive manifest unreadable; operator must inspect or restore manifest: ${e.message}`);
  }
}
async function writeArchiveManifest(path, source, drive, files, maxFiles) {
  if (files.size > maxFiles) throw Error('archive manifest entry bound exceeded; operator must split the source/state or inspect and raise maxFiles');
  const data = JSON.stringify({ v: 1, source, drive, files: [...files].map(([name, v]) => [name, ...v]) });
  if (Buffer.byteLength(data) > MAX_MANIFEST_BYTES) throw Error('archive manifest byte bound exceeded; operator must split the source/state');
  const temp = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function directory(path) { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) throw Error('not a real directory'); return s; }
async function tar(args) { return exec('tar', args, { timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }); }
/**
 * WRITER-EXCLUSION CONTRACT (R559, runs): no writer lock exists or is built. A run record may leave only when it is
 * FINISHED (parses against the canonical schema, terminal effects, verdict present, cursor > 0) AND its mtime is older
 * than max(keepDays, runsMinAgeDays=7) days; the live-pid check in runs-writer-exclusion.mjs is defence in depth.
 * Removal is quarantine-rename, identity+content re-verify, then unlink; a failed restore alerts loudly and every
 * later runs scan retries `.retiring-<name>.<uuid>` files.
 * Source removal requires `withSourceWriterExclusion(path, criticalSection)`.
 * The provider must exclude ALL writers (including existing open descriptors and atomic
 * replacements) until the awaited critical section returns. An archiver-only lock, quiet
 * mtime or advisory lock ignored by Claude is insufficient. If exclusion cannot be acquired,
 * the provider must not invoke the callback. No provider means archive and retain originals;
 * there is deliberately no policy/env switch that asserts this safety property.
 */
export async function archiveRetention(o = {}) {
  const env = o.env ?? process.env, now = o.now ?? Date.now(), kind = o.kind ?? 'runs';
  const out = { kind, status: 'skipped', filesArchived: 0, filesRetained: 0, bytesFreed: 0, errors: [], bundles: [] };
  let lock, scratch;
  try {
    if (o.withSourceWriterExclusion !== undefined && typeof o.withSourceWriterExclusion !== 'function') throw Error('invalid source writer exclusion provider');
    if (!['runs', 'sessions'].includes(kind)) throw Error('kind must be runs or sessions');
    const settings = archiveSettings({ env, tool: o.tool, log: o.log ?? (() => {}) });
    out.policy = { value: settings.value, sources: settings.sources };
    const drive = resolve(o.driveRoot ?? settings.value.driveRoot);
    // NEVER create the Drive root: a disconnected mount must leave all originals alone.
    const driveIdentity = await directory(drive);
    const source = resolve(kind === 'runs' ? (o.runsDir ?? env.OPERATION_RUNS_DIR ?? sharedRunsDir(env)) : (o.sessionsDir ?? join(homedir(), '.claude', 'projects')));
    if (source === drive || source.startsWith(drive + '/') || drive.startsWith(source + '/')) throw Error('source and archive overlap');
    await directory(source);
    const state = o.stateDir ?? join(homedir(), '.cache', 'we-archive-retention');
    const stamp = join(state, `${kind}.stamp`);
    const archiveManifest = join(state, `${kind}.manifest.json`);
    if (!o.dryRun) {
      await mkdir(state, { recursive: true });
      lock = join(state, `${kind}.lock`);
      try { await mkdir(lock); } catch (e) { lock = undefined; throw Error(`archive busy; operator must inspect stale lock: ${e.code}`); }
      try {
        const at = Number(boundedText(stamp, 128));
        if (!Number.isFinite(at)) throw Error('invalid archive stamp; operator must inspect');
        if (now - at < DAY) { out.status = 'rate-limited'; return out; }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (o.keepDays !== undefined && (!Number.isSafeInteger(o.keepDays) || o.keepDays < 0)) throw Error('invalid keepDays');
    const keepDays = Math.max(o.keepDays ?? settings.value[kind].keepDays, kind === 'runs' ? (o.minAgeDays ?? settings.value.runsMinAgeDays) : 0);
    const cutoff = Math.min(now - keepDays * DAY, now - 600000);
    const groups = new Map(); let scanned = 0;
    const maxFiles = o.maxFiles ?? 500000;
    let archived = await readArchiveManifest(archiveManifest, source, drive, maxFiles);
    async function scan(dir, recursive) {
      const files = [], dirs = []; let fresh = false;
      for await (const entry of await opendir(dir)) {
        if (++scanned > maxFiles) throw Error('scan bound exceeded; operator must split the source or raise maxFiles after inspection');
        if (/[\r\n]/.test(entry.name)) throw Error('unsupported filename; operator must inspect');
        const path = join(dir, entry.name), s = await lstat(path);
        if (s.isSymbolicLink()) { fresh = true; continue; }
        if (s.isFile()) { files.push({ path, stat: s }); if (s.mtimeMs >= cutoff) fresh = true; }
        else if (s.isDirectory() && recursive) {
          if (entry.name === 'memory') { fresh = true; continue; }
          const sub = await scan(path, true); files.push(...sub.files); dirs.push(path, ...sub.dirs);
          if (s.mtimeMs >= cutoff || sub.fresh) fresh = true;
        }
      }
      return { files, dirs, fresh };
    }
    function add(key, files, dirs = []) {
      files = files.filter(f => {
        const prior = archived.get(relative(source, f.path));
        return !prior || !version(f.stat).every((v, i) => v === prior[i]);
      });
      if (!files.length) return;
      if (!groups.has(key)) groups.set(key, { files: [], dirs: [] });
      groups.get(key).files.push(...files); groups.get(key).dirs.push(...dirs);
    }
    // A failed restore is loud (error + event), never silent; the parked file stays discoverable for the next scan.
    async function restore(parked, canonical) {
      try { await link(parked, canonical); await unlink(parked); return true; }
      catch (e) {
        out.errors.push(`ALERT: restore of ${basename(parked)} failed (${e.code ?? e.message}); operator must inspect`);
        // The emitter may be sync or async and may throw: an alert failure must never abort the scan.
        try { await (o.emit ?? (ev => appendDaemonEvent(ev, { env })))({ kind: 'archive-retention-alert', daemon: 'archive-retention', detail: { parked, canonical, error: e.message } }); } catch { /* alert is best-effort */ }
        return false;
      }
    }
    // A runs record archived but not removed is forgotten by the manifest so the next run re-verifies and retries removal,
    // at most MAX_REMOVAL_RETRIES times per path (each retry writes one more verified bundle); then it stays excluded
    // and an operator-visible error says so. The counter lives in its own state file (keyed by relative path; run ids are unique, so it is never reused).
    const retriesFile = join(state, 'runs.removal-retries.json');
    async function retryRemoval(pending, manifest) {
      let counts = {};
      try { counts = JSON.parse(boundedText(retriesFile, 1024 * 1024)); if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw Error('invalid retry state'); }
      catch (e) { if (e.code !== 'ENOENT') { out.errors.push(`removal-retry state unreadable (${e.message}); records stay excluded, operator must inspect`); return manifest; } }
      const forget = new Map(manifest); let changed = false;
      for (const key of pending) {
        const n = Number.isSafeInteger(counts[key]) ? counts[key] : 0;
        if (n >= MAX_REMOVAL_RETRIES) { out.errors.push(`ALERT: ${key} archived but not removed after ${n} retries; operator must inspect`); continue; }
        counts[key] = n + 1; forget.delete(key); changed = true;
      }
      if (!changed) return manifest;
      const temp = `${retriesFile}.${randomUUID()}.partial`;
      try { await writeFile(temp, JSON.stringify(counts), { flag: 'wx', mode: 0o600 }); await rename(temp, retriesFile); } finally { await unlink(temp).catch(() => {}); }
      await writeArchiveManifest(archiveManifest, source, drive, forget, maxFiles);
      return forget;
    }
    const intentFile = join(state, 'runs.removal-intent.json');
    if (kind === 'runs') {
      // Oldest first, bounded by the batch cap; unreadable or unfinished records are skipped (never eligible).
      const cap = o.batchCap ?? settings.value.runsBatchCap;
      const scanned1 = (await scan(source, true)).files;
      for (const f of scanned1) {
        const m = /^\.retiring-(.+)\.[0-9a-f-]{36}$/.exec(basename(f.path));
        if (!m) continue;
        if (o.dryRun) { out.errors.push(`ALERT: parked ${basename(f.path)} awaits restore`); continue; }
        await restore(f.path, join(dirname(f.path), m[1]));
      }
      // Crash recovery: a run killed between the manifest commit and the removal loop's bookkeeping leaves an intent file
      // naming the records it archived but had not yet removed. Treat them like skipped records (bounded retry) so the
      // manifest does not exclude them forever.
      if (!o.dryRun) {
        let keys = null;
        try { keys = JSON.parse(boundedText(intentFile, 1024 * 1024)); if (!Array.isArray(keys)) throw Error('invalid intent state'); }
        catch (e) { if (e.code !== 'ENOENT') out.errors.push(`removal-intent state unreadable (${e.message}); records may stay excluded, operator must inspect`); }
        if (keys) {
          const stillThere = new Set();
          for (const k of keys) if (typeof k === 'string' && !isAbsolute(k) && !k.split('/').includes('..') && await access(join(source, k)).then(() => true, () => false)) stillThere.add(k);
          if (stillThere.size) archived = await retryRemoval(stillThere, archived);
          await unlink(intentFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
        }
      }
      const old = scanned1.filter(f => f.path.endsWith('.json') && f.stat.mtimeMs < cutoff && !(archived.get(relative(source, f.path)) && version(f.stat).every((v, i) => v === archived.get(relative(source, f.path))[i])))
        .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
      let taken = 0;
      const isComplete = o.runEligible ? undefined : (o.isComplete ?? await loadRunCompletion());
      for (const f of old) {
        if (taken >= cap) break;
        let ok = false;
        try { const bytes = await readFile(f.path); ok = (o.runEligible ?? (t => runRecordEligible(t, isComplete)))(bytes.toString('utf8')); if (ok) f.hash = createHash('sha256').update(bytes).digest('hex'); } catch { ok = false; }
        if (!ok) { out.filesRetained++; continue; }
        add(`runs-${dayOf(f.stat.mtimeMs)}`, [f]); taken++;
      }
    } else {
      for await (const project of await opendir(source)) {
        if (++scanned > maxFiles) throw Error('scan bound exceeded; operator must split the source or raise maxFiles after inspection');
        if (!project.isDirectory() || project.name === 'memory') continue;
        const base = join(source, project.name); await directory(base);
        for await (const entry of await opendir(base)) {
          if (++scanned > maxFiles) throw Error('scan bound exceeded; operator must split the source or raise maxFiles after inspection');
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const id = entry.name.slice(0, -6);
          if (id === env.CLAUDE_CODE_SESSION_ID) continue;
          const path = join(base, entry.name), s = await lstat(path);
          if (!s.isFile() || s.mtimeMs >= cutoff) continue;
          let family = { files: [], dirs: [], fresh: false };
          try { const d = join(base, id), ds = await directory(d); family = await scan(d, true); family.dirs.push(d); family.fresh ||= ds.mtimeMs >= cutoff; }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (!family.fresh) add(`${project.name}-${dayOf(s.mtimeMs)}`, [{ path, stat: s }, ...family.files], family.dirs);
        }
      }
    }
    out.status = o.dryRun ? 'dry-run' : 'archived';
    if (o.dryRun) { out.filesEligible = [...groups.values()].reduce((n, g) => n + g.files.length, 0); return out; }
    const dest = join(drive, kind === 'runs' ? 'runs' : 'claude-sessions');
    try { await mkdir(dest); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await directory(dest);
    scratch = await mkdtemp(join(tmpdir(), 'archive-retention-'));
    for (const [key, group] of groups) {
      try {
        const manifest = join(scratch, 'files');
        const names = group.files.map(f => `./${relative(source, f.path)}`);
        if (names.some(n => /[\r\n]/.test(n))) throw Error('unsupported archive filename; operator must inspect');
        await writeFile(manifest, names.join('\0') + '\0');
        const temp = join(dest, `.${randomUUID()}.tar.gz.partial`);
        await tar(['-czf', temp, '-C', source, '--null', '-T', manifest]);
        const written = await lstat(temp);
        // Reserve an unused final name atomically; never overwrite any previous bundle.
        let final;
        for (let part = 0; part < 10000; part++) {
          const candidate = join(dest, `${key}${part ? `-part${part}` : ''}.tar.gz`);
          try { await link(temp, candidate); final = candidate; break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
        if (!final) throw Error('part bound exceeded; operator must inspect archives');
        await rename(temp, final);
        // POSIX rename of two hard links to the same inode may leave the temp name.
        await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await o.afterBundle?.(final);
        const listing = o.listBundle ? await o.listBundle(final) : (await tar(['-tzf', final])).stdout.trimEnd().split('\n');
        // Content check (runs): extract the Drive copy and compare each member's sha256 with the bytes judged eligible.
        if (group.files.every(f => f.hash)) {
          const check = await mkdtemp(join(tmpdir(), 'archive-retention-verify-'));
          try {
            await tar(['-xzf', final, '-C', check]);
            for (const f of group.files) {
              const got = createHash('sha256').update(await readFile(join(check, relative(source, f.path)))).digest('hex');
              if (got !== f.hash) throw Error('archive content mismatch; originals retained');
            }
          } finally { await rm(check, { recursive: true, force: true }); }
        }
        const verified = await lstat(final);
        if (!verified.isFile() || verified.size <= 0 || verified.size !== written.size || listing.length !== names.length || listing.some((n, i) => n !== names[i])) throw Error('archive verification failed; originals retained');
        const driveNow = await directory(drive);
        if (driveNow.dev !== driveIdentity.dev || driveNow.ino !== driveIdentity.ino) throw Error('Drive changed; originals retained, operator must inspect mount');
        // Commit verified versions before removal or the daily stamp. A crash/retry must
        // not archive retained originals again. Use the pre-bundle stat: concurrent edits
        // differ on the next scan and must get their own verified archive.
        const next = new Map(archived);
        for (const f of group.files) next.set(relative(source, f.path), version(f.stat));
        // Runs with a removal path (a provider): every group file starts "pending" and leaves the set only when removed.
        const pending = new Set(kind === 'runs' && o.withSourceWriterExclusion ? group.files.map(f => relative(source, f.path)) : []);
        if (pending.size) { // intent BEFORE the manifest commit, so a crash right after it is recovered on the next run
          const t = `${intentFile}.${randomUUID()}.partial`;
          try { await writeFile(t, JSON.stringify([...pending]), { flag: 'wx', mode: 0o600 }); await rename(t, intentFile); } finally { await unlink(t).catch(() => {}); }
        }
        await writeArchiveManifest(archiveManifest, source, drive, next, maxFiles);
        archived = next;
        out.bundles.push(final); out.filesArchived += names.length;
        await o.afterManifestCommit?.(); // test seam: a hard crash between the manifest commit and the removal loop
        let uncoordinated = 0;
        try {
          for (const f of group.files) {
            let removed = false, entered = false;
            const remove = async (writerExcluded) => {
              if (entered) throw Error('source writer exclusion invoked removal more than once');
              entered = true;
              if (!same(f.stat, await lstat(f.path))) return;
              // Test seam exercises precisely the former final-stat → unlink interval.
              await o.afterSourceStat?.(f.path);
              if (!writerExcluded) return;
              // Quarantine by atomic rename, re-verify the bytes' identity, only then unlink: a writer that replaced
              // the record between the stat and here is detected and its new file is restored, never deleted.
              const parked = join(dirname(f.path), `.retiring-${basename(f.path)}.${randomUUID()}`);
              await rename(f.path, parked);
              const q = await lstat(parked);
              if (!(q.isFile() && (!f.hash || createHash('sha256').update(await readFile(parked)).digest('hex') === f.hash) && q.dev === f.stat.dev && q.ino === f.stat.ino && q.size === f.stat.size && q.mtimeMs === f.stat.mtimeMs)) { await restore(parked, f.path); return; }
              // A writer holding a descriptor opened earlier can still append to the parked inode after the hash above:
              // re-stat right before unlink and restore the record if it changed. (Only the instants between this stat
              // and unlink remain open; a kernel-level lock would be needed to close them, see the operator error.)
              await o.afterQuarantineVerify?.(parked);
              if (!same(q, await lstat(parked))) { await restore(parked, f.path); return; }
              await unlink(parked);
              removed = true;
              out.bytesFreed += f.stat.size;
            };
            try {
              if (o.withSourceWriterExclusion) {
                await o.withSourceWriterExclusion(f.path, () => remove(true));
                if (!entered) uncoordinated++;
              } else {
                uncoordinated++;
                await remove(false);
              }
            } catch (e) { if (e.code !== 'ENOENT') throw e; }
            if (removed) pending.delete(relative(source, f.path)); else out.filesRetained++;
          }
        } finally {
          // Applied on EVERY exit (skip, restored quarantine, or a thrown error mid-loop), so no unremoved record is left
          // excluded forever by the manifest committed above. Bounded: see retryRemoval.
          // The intent file is dropped only once the bookkeeping succeeded; on failure it stays and the next run recovers.
          try {
            if (pending.size) archived = await retryRemoval(pending, archived);
            await unlink(intentFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
          } catch (e) { out.errors.push(`retry bookkeeping failed; operator must inspect: ${e.message}`); }
        }
        if (uncoordinated) out.errors.push(`Source removal skipped for ${uncoordinated} files: writer exclusion unavailable; originals retained. Operator must arrange exclusion of all source writers, including open descriptors, before reclamation.`);
        for (const dir of [...new Set(group.dirs)].sort((a, b) => b.length - a.length)) {
          try { await rmdir(dir); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
        }
      } catch (e) { out.errors.push(e.message); }
    }
    await writeFile(stamp, String(now));
  } catch (e) { out.errors.push(e.message); }
  finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    if (lock) await rmdir(lock);
  }
  if (out.errors.length && out.status === 'archived') out.status = out.filesArchived ? 'partial' : 'skipped';
  const event = { kind: 'archive-retention', daemon: 'archive-retention', detail: out, filesArchived: out.filesArchived, bytesFreed: out.bytesFreed };
  // Best-effort like the restore alert: all work is done, a sync/throwing/rejecting emitter must not turn it into a crash.
  if (!o.dryRun) { try { await (o.emit ?? (e => appendDaemonEvent(e, { env })))(event); } catch (e) { out.errors.push(`event emit failed: ${e.message}`); } }
  return out;
}
