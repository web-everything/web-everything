/** R217: archives are retained forever; source removal requires verified Drive evidence. */
import { lstat, opendir, mkdir, writeFile, rename, unlink, rmdir, mkdtemp, rm, link } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { sharedRunsDir } from '../operations/run-store.mjs';
import { resolveCascade, readPlatformPreferences, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { boundedText } from './host-overload-settings.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
const exec = promisify(execFile);
const DAY = 86400000;
const standard = { runs: { keepDays: 14 }, sessions: { keepDays: 30 }, driveRoot: join(homedir(), 'Library', 'CloudStorage', 'GoogleDrive-nic.g.gilbert@gmail.com', 'My Drive', 'web-everything-archive') };
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
  if (env.WE_ARCHIVE_DRIVE_ROOT !== undefined) envValues.driveRoot = env.WE_ARCHIVE_DRIVE_ROOT;
  const valid = { runs: v => Number.isSafeInteger(v?.keepDays ?? v) && (v?.keepDays ?? v) >= 0,
    sessions: v => Number.isSafeInteger(v?.keepDays ?? v) && (v?.keepDays ?? v) >= 0,
    driveRoot: v => typeof v === 'string' && v.trim().length > 0 };
  // Validate complete blocks too: empty objects must not silently disappear in the cascade.
  for (const layer of [p.prefs.archive, tool, envValues]) if (layer !== undefined) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) throw Error('invalid archive policy');
    for (const k of Object.keys(valid)) if (Object.hasOwn(layer, k) && (!valid[k](layer[k]) || (k !== 'driveRoot' && (typeof layer[k] !== 'object' || Array.isArray(layer[k]))))) throw Error(`invalid archive policy: ${k}`);
  }
  const r = resolveCascade({ standard, platform: p.prefs.archive, tool, envValues, valid });
  if (r.invalid.length) throw Error(`invalid archive policy: ${r.invalid.join('; ')}`);
  log(formatCascadeSourcesLine('archive', r));
  return r;
}
const dayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const same = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
// Include identity/ctime so a replacement or a same-size write with restored mtime is new.
const version = s => [s.size, s.mtimeMs, s.ctimeMs, s.dev, s.ino];
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
    const cutoff = Math.min(now - (o.keepDays ?? settings.value[kind].keepDays) * DAY, now - 600000);
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
    if (kind === 'runs') {
      for (const f of (await scan(source, true)).files) if (f.path.endsWith('.json') && f.stat.mtimeMs < cutoff) add(`runs-${dayOf(f.stat.mtimeMs)}`, [f]);
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
        const verified = await lstat(final);
        if (!verified.isFile() || verified.size <= 0 || verified.size !== written.size || listing.length !== names.length || listing.some((n, i) => n !== names[i])) throw Error('archive verification failed; originals retained');
        const driveNow = await directory(drive);
        if (driveNow.dev !== driveIdentity.dev || driveNow.ino !== driveIdentity.ino) throw Error('Drive changed; originals retained, operator must inspect mount');
        // Commit verified versions before removal or the daily stamp. A crash/retry must
        // not archive retained originals again. Use the pre-bundle stat: concurrent edits
        // differ on the next scan and must get their own verified archive.
        const next = new Map(archived);
        for (const f of group.files) next.set(relative(source, f.path), version(f.stat));
        await writeArchiveManifest(archiveManifest, source, drive, next, maxFiles);
        archived = next;
        out.bundles.push(final); out.filesArchived += names.length;
        let uncoordinated = 0;
        for (const f of group.files) {
          let removed = false, entered = false;
          const remove = async (writerExcluded) => {
            if (entered) throw Error('source writer exclusion invoked removal more than once');
            entered = true;
            if (!same(f.stat, await lstat(f.path))) return;
            // Test seam exercises precisely the former final-stat → unlink interval.
            await o.afterSourceStat?.(f.path);
            if (!writerExcluded) return;
            await unlink(f.path);
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
          if (!removed) out.filesRetained++;
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
  if (!o.dryRun) await (o.emit ?? (e => appendDaemonEvent(e, { env })))(event);
  return out;
}
