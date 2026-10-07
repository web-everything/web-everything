/**
 * @file scripts/lib/daemon-version-switch.mjs
 * @description Card 89 S4 — dormant CAS switching, rollback, pins and retention.
 * All mutations share a short synchronous mkdir mutex; health runs outside it and
 * must revalidate probation before acting. Readers never traverse metadata symlinks.
 * Remote pins cannot be probed: retain them until retainMinAgeMs has elapsed.
 * deps: fs, now, pidAlive, hostname, alert, health; failAfterRename is a crash seam.
 */
import * as filesystem from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { logicalCloneRoot } from './daemon-clone-layout.mjs';
import { isVersionedClone, validateDaemonVersionsSettings } from './daemon-versions-settings.mjs';

const disabled = { status: 'disabled' };
let sequence = 0;
function validId(id) {
  if (typeof id !== 'string' || id === '.' || id.includes('..') || !/^[0-9A-Za-z._-]+$/.test(id)) {
    throw new Error(`Invalid version id: ${id}`);
  }
  return id;
}
function context({ clone, home, settings, deps = {} }) {
  const name = basename(logicalCloneRoot(clone));
  if (!isVersionedClone(name, settings)) return null;
  validId(name);
  const fs = deps.fs ?? filesystem;
  const root = join(resolve(home), name);
  const now = () => new Date((deps.now ?? Date.now)()).getTime();
  const stat = path => {
    try { return fs.lstatSync(path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  // Check every ancestor inside root, including root itself. current/previous are
  // parsed as relative references, never opened as paths through a symlink.
  const safe = (relative = '', directory = false) => {
    let path = root;
    const parts = relative ? relative.split('/') : [];
    for (let i = 0; i <= parts.length; i++) {
      if (i) path = join(path, parts[i - 1]);
      const entry = stat(path);
      if (entry && (entry.isSymbolicLink() || ((i < parts.length || directory) && !entry.isDirectory()))) {
        throw new Error(`Unsafe version path: ${path}`);
      }
    }
    return path;
  };
  const read = relative => {
    const path = safe(relative);
    const entry = stat(path);
    if (!entry) return null;
    if (!entry.isFile()) throw new Error(`Unsafe metadata file: ${path}`);
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  };
  const atomic = (relative, value) => {
    const path = safe(relative);
    const temp = `${path}.tmp.${process.pid}.${sequence++}`;
    let created = false;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); created = true;
      fs.renameSync(temp, path);
    } finally { if (created) fs.rmSync(temp, { force: true }); }
  };
  const linkId = name => {
    safe();
    const path = join(root, name);
    if (!stat(path)) return null;
    if (!stat(path).isSymbolicLink()) throw new Error(`Unsafe version link: ${name}`);
    const target = fs.readlinkSync(path);
    if (!target.startsWith('versions/')) throw new Error(`Unsafe version link: ${target}`);
    const id = validId(target.slice('versions/'.length));
    safe(`versions/${id}`, true);
    return id;
  };
  const state = () => ({ adopted: null, retired: {}, hold: null, probation: null, ...read('state.json') });
  const record = id => read(`versions/${validId(id)}/.version.json`);
  safe();
  return { fs, root, now, stat, safe, read, atomic, linkId, state, record, deps,
    config: validateDaemonVersionsSettings(settings),
    host: () => typeof deps.hostname === 'string' ? deps.hostname : (deps.hostname ?? hostname)(),
  };
}
function locked(c, action) {
  const { fs, root } = c;
  fs.mkdirSync(c.safe('', true), { recursive: true });
  const path = c.safe('switch.lock', true);
  const existing = c.stat(path);
  if (existing) {
    if (c.now() - existing.mtimeMs <= 30000) return { status: 'busy' };
    try { fs.rmdirSync(path); }
    catch (error) { if (error.code !== 'ENOENT') return { status: 'busy' }; }
  }
  try { fs.mkdirSync(path); }
  catch (error) { if (error.code === 'EEXIST') return { status: 'busy' }; throw error; }
  const owner = c.stat(path);
  try {
    const time = new Date(c.now()); fs.utimesSync(path, time, time);
    return action();
  } finally {
    const present = c.stat(join(root, 'switch.lock'));
    if (present?.ino === owner.ino && present?.dev === owner.dev) fs.rmdirSync(path);
  }
}
function replaceLink(c, name, id) {
  c.linkId(name); // Refuse unsafe existing pointers, even though rename would replace them.
  const temp = join(c.root, `${name}.tmp.${process.pid}`);
  let created = false;
  try {
    c.fs.symlinkSync(`versions/${validId(id)}`, temp); created = true;
    c.fs.renameSync(temp, join(c.root, name));
  } finally { if (created) c.fs.rmSync(temp, { force: true }); }
}
function switchInside(c, { id, expectCurrent, rollback = false, reason, by, dryRun = false }) {
  validId(id);
  if (expectCurrent !== null) validId(expectCurrent);
  const actual = c.linkId('current');
  if (actual !== expectCurrent) return { status: 'aborted', reason: 'current-moved', actual };
  const dir = c.safe(`versions/${id}`, true);
  if (!c.stat(dir)) return rollback ? { status: 'no-previous' } : { status: 'refused', reason: 'not-built' };
  if (!rollback) {
    const record = c.record(id);
    if (record?.id !== id || record.status !== 'built') return { status: 'refused', reason: 'not-built' };
  }
  if (actual === id) return { status: 'noop' };
  if (dryRun) return { status: 'dry-run', current: actual, target: id };
  const state = c.state();
  const since = new Date(c.now()).toISOString();
  if (actual) replaceLink(c, 'previous', actual);
  else {
    c.linkId('previous'); c.fs.rmSync(join(c.root, 'previous'), { force: true });
  }
  replaceLink(c, 'current', id);
  c.deps.failAfterRename?.();
  if (actual) state.retired = { ...state.retired, [actual]: since };
  state.probation = !rollback && c.config.autoRollback ? { id, since, prev: actual } : null;
  if (rollback) state.hold = { version: actual, reason: reason ?? 'rollback', by: by ?? 'operator', until: 'main-moves' };
  state.adopted = id;
  c.atomic('state.json', state);
  return { status: 'switched', id, previous: actual };
}

/** Explicit expectation is mandatory, including null for the first adoption. */
export async function switchCurrent(options) {
  const c = context(options); if (!c) return disabled;
  validId(options.id);
  if (options.expectCurrent !== null) validId(options.expectCurrent);
  if (options.dryRun) return switchInside(c, options);
  return locked(c, () => switchInside(c, options));
}
export async function reconcile(options) {
  const c = context(options); if (!c) return disabled;
  return locked(c, () => {
    const id = c.linkId('current');
    const truth = id ? c.record(id) : null;
    if (id && truth?.id !== id) throw new Error('Current version record is missing or mismatched');
    const state = c.state();
    if (state.adopted === (truth?.id ?? null)) return { status: 'ok' };
    state.adopted = truth?.id ?? null; c.atomic('state.json', state);
    return { status: 'reconciled' };
  });
}
function pinPath(c, { id, pid = process.pid, host = c.host() }) {
  validId(id); validId(host);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid pin pid');
  return { path: `pins/${host}-${pid}.json`, value: { id, pid, host, since: new Date(c.now()).toISOString() } };
}
export async function pin(options) {
  const c = context(options); if (!c) return disabled;
  const { path, value } = pinPath(c, options);
  return locked(c, () => {
    if (!c.stat(c.safe(`versions/${value.id}`, true))) throw new Error('Missing pin version');
    c.fs.mkdirSync(c.safe('pins', true), { recursive: true }); c.atomic(path, value);
    return { status: 'pinned' };
  });
}
export async function unpin(options) {
  const c = context(options); if (!c) return disabled;
  const { path, value } = pinPath(c, options);
  return locked(c, () => {
    // A delayed cleanup from an old adoption must not erase this PID's new pin.
    if (c.read(path)?.id === value.id) c.fs.rmSync(c.safe(path), { force: true });
    return { status: 'unpinned' };
  });
}
function versions(c) {
  const path = c.safe('versions', true);
  if (!c.stat(path)) return [];
  return c.fs.readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => {
    validId(e.name);
    let record;
    try { record = c.record(e.name); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    return { id: e.name, record };
  });
}
function livePins(c, prune = false) {
  const path = c.safe('pins', true);
  const ids = new Set();
  if (!c.stat(path)) return ids;
  const alive = c.deps.pidAlive ?? (pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
  });
  for (const entry of c.fs.readdirSync(path, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const relative = `pins/${entry.name}`;
    let value;
    try { value = c.read(relative); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    let live = false;
    if (value?.id) {
      validId(value.id);
      if (Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.host === 'string') {
        const age = c.now() - Date.parse(value.since);
        live = value.host === c.host() ? alive(value.pid) !== false
          : !Number.isFinite(age) || age < c.config.retainMinAgeMs;
      }
    }
    if (live) ids.add(value.id);
    else if (prune) c.fs.rmSync(c.safe(relative), { force: true });
  }
  return ids;
}
/** Unknown/missing metadata is in-progress; rejected builds are collected first. */
export async function gc(options) {
  const c = context(options); if (!c) return disabled;
  return locked(c, () => {
    const current = c.linkId('current'), previous = c.linkId('previous');
    const state = c.state(), pins = livePins(c, true), entries = versions(c);
    const built = e => e.record?.id === e.id && e.record.status === 'built';
    const failed = e => e.record?.id === e.id && ['rejected', 'smoke-failed'].includes(e.record.status);
    const newest = (a, b) => (Date.parse(b.record?.builtAt) || 0) - (Date.parse(a.record?.builtAt) || 0) || b.id.localeCompare(a.id);
    const recent = new Set(entries.filter(built).sort(newest).slice(0, c.config.keep).map(e => e.id));
    const inspection = entries.filter(failed).sort(newest)[0]?.id;
    const removed = [], kept = [];
    for (const entry of entries.sort((a, b) => Number(failed(b)) - Number(failed(a)))) {
      const { id } = entry;
      const retired = Object.hasOwn(state.retired, id) ? state.retired[id] : null;
      const young = retired != null && (!Number.isFinite(Date.parse(retired)) || c.now() - Date.parse(retired) < c.config.retainMinAgeMs);
      const why = id === current ? 'current' : id === previous ? 'previous' : pins.has(id) ? 'pinned'
        : young ? 'young' : !built(entry) && !failed(entry) ? 'unknown'
          : recent.has(id) ? 'newest' : id === inspection ? 'inspection' : null;
      if (why) kept.push({ id, why });
      else { c.fs.rmSync(c.safe(`versions/${id}`, true), { recursive: true }); removed.push(id); }
    }
    return { removed, kept };
  });
}
export async function rollback(options) {
  const c = context(options); if (!c) return disabled;
  if (options.to != null) validId(options.to);
  return locked(c, () => {
    const id = options.to ?? c.linkId('previous');
    if (!id) return { status: 'no-previous' };
    return switchInside(c, { ...options, id, expectCurrent: c.linkId('current'), rollback: true });
  });
}
export async function checkProbation(options) {
  const c = context(options); if (!c) return disabled;
  const initial = locked(c, () => {
    const state = c.state();
    if (!state.probation) return { status: 'none' };
    if (c.now() - Date.parse(state.probation.since) > c.config.probationMs) {
      state.probation = null; c.atomic('state.json', state); return { status: 'out-of-probation' };
    }
    return { probation: state.probation };
  });
  if (!initial.probation) return initial;
  const p = initial.probation; validId(p.id); if (p.prev != null) validId(p.prev);
  if (!c.deps.health) throw new Error('Probation requires a health dependency');
  const health = await c.deps.health({ id: p.id, clone: options.clone });
  return locked(c, () => {
    const state = c.state(), actual = c.linkId('current');
    if (actual !== p.id || JSON.stringify(state.probation) !== JSON.stringify(p)) {
      return { status: 'aborted', reason: 'current-moved', actual };
    }
    if (health.ok !== false) return { status: 'probation-ok' };
    if (!c.config.autoRollback) return { status: 'probation-failed', reason: health.reason };
    if (!p.prev) return { status: 'no-previous' };
    const record = c.record(p.id);
    const result = switchInside(c, { id: p.prev, expectCurrent: p.id, rollback: true, by: 'probation', reason: health.reason });
    if (result.status === 'switched') {
      c.atomic(`versions/${p.id}/.version.json`, { ...record, id: p.id, status: 'rejected' });
      (c.deps.alert ?? (() => {}))('probation-rollback', { id: p.id, to: p.prev, reason: health.reason });
    }
    return result;
  });
}
export async function status(options) {
  const c = context(options); if (!c) return disabled;
  const state = c.state(), pins = livePins(c);
  return { current: c.linkId('current'), previous: c.linkId('previous'), adopted: state.adopted,
    hold: state.hold, probation: state.probation,
    versions: versions(c).map(({ id, record }) => ({ id, status: record?.status ?? 'unknown', pinned: pins.has(id), retiredAt: Object.hasOwn(state.retired, id) ? state.retired[id] : null })),
  };
}
