#!/usr/bin/env node
// S1 manual deploy: copy the five already-bundled setup payloads. No fetch or timer.
// Usage: forge-deploy.mjs install --sha HEX [--source BUNDLE_DIR] [--root DIR] [--dry-run]
//        forge-deploy.mjs switch --sha HEX | rollback | status | preflight [--root DIR] [--state-dir DIR] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const payloads = Object.freeze(['forge-exec-run.mjs', 'forge-warm-base.mjs',
  'forge-exec-limits.mjs', 'forge-cache-prune.mjs', 'forge-exec-sweep.mjs']);
const DEFAULT_ROOT = '/usr/local/libexec/forge';
const SHA = /^[a-fA-F0-9]{7,64}$/;
function sha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error('sha must be 7-64 hex characters');
  return value;
}
function exists(name) {
  try { return fs.lstatSync(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Do not canonicalize user paths: that would conceal a symlinked ancestor.
function directory(name, create = false, owner = 0) {
  if (name.split(path.sep).includes('..')) throw new Error('parent traversal refused');
  const absolute = path.resolve(name);
  let cursor = path.parse(absolute).root;
  for (const part of ['', ...absolute.slice(cursor.length).split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    let st = exists(cursor);
    if (!st && create) { fs.mkdirSync(cursor, {mode: 0o755}); st = fs.lstatSync(cursor); }
    if (!st && !create) continue;
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe directory: ${cursor}`);
    if (st.uid !== owner || (st.mode & 0o022)) throw new Error(`untrusted directory: ${cursor}; inspect ownership and permissions before retrying`);
  }
  return absolute;
}
function read(name, limit, owner) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > limit) throw new Error(`invalid or oversized file: ${name}; inspect it before retrying`);
    if (owner !== undefined && (st.uid !== owner || (st.mode & 0o022))) throw new Error(`untrusted payload: ${name}; inspect ownership and permissions before retrying`);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function syncDir(name) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function write(name, bytes, mode) {
  const fd = fs.openSync(name, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function record(root, value) {
  const temporary = path.join(root, `.record-${randomUUID()}`);
  try {
    write(temporary, JSON.stringify(value) + '\n', 0o644);
    fs.renameSync(temporary, path.join(root, 'deploy.json'));
    syncDir(root);
  } finally { fs.rmSync(temporary, {force: true}); }
}
function version(root, value, owner) {
  sha(value);
  const target = path.join(root, 'versions', value);
  directory(target, false, owner);
  if (!exists(target)) throw new Error(`version not installed: ${value}`);
  for (const name of payloads) read(path.join(target, name), 8 * 1024 * 1024, owner);
}
function state(root, owner, stateDir, recover = false) {
  let current = null;
  const link = path.join(root, 'current');
  if (exists(link)) {
    if (!fs.lstatSync(link).isSymbolicLink()) throw new Error('current must be a symlink');
    const target = fs.readlinkSync(link);
    const match = /^versions\/([a-fA-F0-9]{7,64})$/.exec(target);
    if (!match) throw new Error('current escapes version layout');
    current = match[1];
    version(root, current, owner);
  }
  const file = path.join(root, 'deploy.json');
  if (!exists(file)) {
    if (current) throw new Error('missing deploy record; inspect before retrying');
    return {current: null, previous: null};
  }
  const saved = JSON.parse(read(file, 4096, owner));
  if (!saved || Array.isArray(saved) || saved.schema !== 1 || !Object.hasOwn(saved, 'current') || !Object.hasOwn(saved, 'previous') || Object.keys(saved).some(key => !['schema', 'current', 'previous', 'pending'].includes(key))) throw new Error('invalid deploy record');
  for (const key of ['current', 'previous']) if (saved[key] !== null) version(root, saved[key], owner);
  if (saved.pending !== undefined) {
    version(root, saved.pending, owner);
    // The surviving link decides which publication survived. Repair telemetry
    // before clearing intent, under the deploy lock, so recovery is retryable.
    const switched = current === saved.pending;
    if (!switched && current !== saved.current) throw new Error('deploy intent disagrees with current; inspect before retrying');
    if (!recover) throw new Error('incomplete deployment; inspect the deploy lock and retry without --dry-run');
    const recovered = {current, previous: switched ? saved.current : saved.previous};
    if (current) writeState(root, current, stateDir, owner);
    record(root, {schema: 1, ...recovered});
    return recovered;
  } else if (current !== saved.current) throw new Error('deploy record disagrees with current; inspect before retrying');
  return {current, previous: saved.previous};
}
function writeState(root, target, stateDir, owner) {
  stateDir = directory(stateDir, true, owner);
  const digest = createHash('sha256');
  for (const name of [...payloads].sort()) {
    const hash = createHash('sha256').update(read(path.join(root, 'versions', target, name), 8 * 1024 * 1024, owner)).digest('hex');
    digest.update(name + '\0' + hash + '\n');
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(new Date()).map(({type, value}) => [type, value]));
  const installedAtET = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.000${parts.timeZoneName.replace('GMT', '')}`;
  // Content-addressed setup versions have no Git provenance; keep S0's null fallback.
  const value = {schema: 1, forgeSetSha: /^[a-f0-9]{40}$/.test(target) ? target : null,
    setDigest: digest.digest('hex'), hostTier: 1, installedAtET};
  const temporary = path.join(stateDir, `.state-${randomUUID()}`);
  try {
    write(temporary, JSON.stringify(value) + '\n', 0o644);
    fs.renameSync(temporary, path.join(stateDir, 'state.json'));
    syncDir(stateDir);
  } finally { fs.rmSync(temporary, {force: true}); }
}
export function deploy({command, root, source = path.dirname(root ?? DEFAULT_ROOT), sha: target, dryRun = false,
  stateDir = '/var/lib/forge-deploy', beforeSwitchRename = () => {}, afterSwitchRename = () => {}, afterStateWrite = () => {}}) {
  if (!['install', 'switch', 'rollback', 'status', 'preflight'].includes(command)) throw new Error('expected install, switch, rollback, status or preflight');
  if (command === 'preflight' && dryRun) throw new Error('preflight must acquire the lock; omit --dry-run');
  const owner = root === undefined ? 0 : process.getuid();
  root ??= DEFAULT_ROOT;
  if (command === 'install' || command === 'switch') sha(target);
  const create = !dryRun && (command === 'install' || command === 'preflight');
  root = directory(root, create, owner);
  directory(path.join(root, 'versions'), create, owner);
  if (command === 'status' && !exists(root)) return state(root, owner);
  const lock = path.join(root, '.deploy-lock');
  if (!dryRun) {
    try { fs.mkdirSync(lock, {mode: 0o700}); }
    catch (error) { throw new Error(`deploy locked or unavailable; inspect ${lock} before retrying: ${error.message}`); }
  }
  try {
    const old = state(root, owner, stateDir, !dryRun);
    if (command === 'status') return old;
    if (command === 'preflight') return {preflight: true};
    if (command === 'install') {
      source = directory(source, false, owner);
      const bytes = payloads.map(name => read(path.join(source, name), 8 * 1024 * 1024, owner));
      const destination = path.join(root, 'versions', target);
      if (exists(destination)) {
        version(root, target, owner);
        if (!payloads.every((name, i) => read(path.join(destination, name), 8 * 1024 * 1024).equals(bytes[i]))) {
          throw new Error('version already exists with different bytes; use a new sha');
        }
        return {installed: target, dryRun};
      }
      if (!dryRun) {
        const stage = path.join(root, `.building-${randomUUID()}`);
        fs.mkdirSync(stage, {mode: 0o755});
        try {
          payloads.forEach((name, i) => write(path.join(stage, name), bytes[i], 0o755));
          syncDir(stage);
          fs.renameSync(stage, destination);
          syncDir(path.join(root, 'versions'));
        } finally { fs.rmSync(stage, {recursive: true, force: true}); }
      }
      return {installed: target, dryRun};
    }
    if (command === 'rollback') {
      if (!old.previous) throw new Error('no previous version; install and switch a version explicitly');
      target = old.previous;
    }
    version(root, target, owner);
    if (dryRun || target === old.current) return {...old, target, dryRun};
    const temporary = path.join(root, `.current-${randomUUID()}`);
    try {
      fs.symlinkSync(`versions/${target}`, temporary);
      record(root, {schema: 1, ...old, pending: target});
      beforeSwitchRename();
      // The only mutation of current: rename(2) replaces the symlink atomically.
      fs.renameSync(temporary, path.join(root, 'current'));
      afterSwitchRename();
      syncDir(root);
      try { writeState(root, target, stateDir, owner); }
      catch (error) {
        if (old.current) {
          fs.symlinkSync(`versions/${old.current}`, temporary);
          fs.renameSync(temporary, path.join(root, 'current'));
        } else fs.unlinkSync(path.join(root, 'current'));
        syncDir(root);
        record(root, {schema: 1, ...old});
        throw error;
      }
      afterStateWrite();
      record(root, {schema: 1, current: target, previous: old.current});
    } finally { fs.rmSync(temporary, {force: true}); }
    return {current: target, previous: old.current};
  } finally { if (!dryRun) fs.rmdirSync(lock); }
}
export function main(args) {
  const command = args.shift();
  const options = {command};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') options.dryRun = true;
    else if (['--root', '--source', '--sha', '--state-dir'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i] === '--state-dir' ? (i++, 'stateDir') : args[i++].slice(2)] = args[i];
    else throw new Error(`unknown or incomplete option: ${args[i]}`);
  }
  return deploy(options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(`forge-deploy: ${error.message}`); process.exitCode = 1; }
}
