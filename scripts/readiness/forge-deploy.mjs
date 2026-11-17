#!/usr/bin/env node
// current is the commit record. Only recover repairs interrupted publications.
import nativeFs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const payloads = Object.freeze(['forge-exec-run.mjs', 'forge-warm-base.mjs',
  'forge-exec-limits.mjs', 'forge-cache-prune.mjs', 'forge-exec-sweep.mjs']);
export const ID = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
function easternTimestamp(ms = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset'}).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(new Date(ms).getUTCMilliseconds()).padStart(3, '0')}${parts.timeZoneName.replace('GMT', '')}`;
}
const validET = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}-0[45]:00$/.test(value)
  && Number.isFinite(Date.parse(value)) && easternTimestamp(Date.parse(value)) === value;
const fail = reason => { throw new Error(`${reason}; inspect the remote runner and run recover`); };
const validId = value => { if (typeof value !== 'string' || !ID.test(value)) fail('id must match ^[a-f0-9]{64}$'); return value; };
const stat = (fs, name) => {
  try { return fs.lstatSync(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// The same predicate applies to production (uid 0) and injected test identities.
export function trusted(st, uid, directory = false) {
  if (!st || st.uid !== uid || (st.mode & 0o022) || st.isSymbolicLink()) return false;
  return directory ? st.isDirectory() : st.isFile();
}
export function trustDirectory(name, {fs = nativeFs, uid = 0, missing = false} = {}) {
  if (typeof name !== 'string' || name.split(path.sep).includes('..')) fail('invalid directory or parent traversal');
  const absolute = path.resolve(name);
  let cursor = path.parse(absolute).root;
  for (const part of ['', ...absolute.slice(cursor.length).split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    const st = stat(fs, cursor);
    if (!st && missing) continue;
    if (!trusted(st, uid, true)) fail('untrusted directory');
  }
  return absolute;
}
function safeRead(fs, name, uid, limit = 8 * 1024 * 1024) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!trusted(st, uid) || st.size > limit) fail('untrusted or oversized file');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) fail('oversized file');
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
function json(fs, name, uid) { return JSON.parse(safeRead(fs, name, uid, 16384)); }
export function contentDigest(files) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) hash.update(name + '\0' +
    createHash('sha256').update(files[name]).digest('hex') + '\n');
  return hash.digest('hex');
}
export function readVersion(root, id, {fs = nativeFs, uid = 0} = {}) {
  validId(id);
  const dir = trustDirectory(path.join(root, 'versions', id), {fs, uid});
  const manifest = json(fs, path.join(dir, 'manifest.json'), uid);
  if (!manifest || Object.keys(manifest).sort().join() !== 'digest,files,sha' ||
      manifest.digest !== id || !(manifest.sha === null || (typeof manifest.sha === 'string' && SHA.test(manifest.sha))) ||
      !Array.isArray(manifest.files) || manifest.files.length !== payloads.length ||
      [...manifest.files].sort().some((name, i) => name !== [...payloads].sort()[i])) fail('invalid manifest');
  if (fs.readdirSync(dir).sort().join() !== [...payloads, 'manifest.json'].sort().join()) fail('extra or missing version files');
  const files = Object.fromEntries(payloads.map(name => [name, safeRead(fs, path.join(dir, name), uid)]));
  const digest = contentDigest(files);
  if (digest !== id || digest !== manifest.digest) fail('version digest mismatch');
  return {...manifest, recomputedDigest: digest};
}

// flock holds an inherited, owner-checked file description until the child exits.
// No mkdir-lock fallback: platforms without flock must provision it first.
export async function flockLock(name, action, {fs = nativeFs, uid = 0, spawnImpl = spawn} = {}) {
  const fd = fs.openSync(name, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  let child;
  try {
    if (!trusted(fs.fstatSync(fd), uid)) fail('untrusted lock file');
    child = spawnImpl('sh', ['-c', 'flock -n -x 3 || exit 1; exec "$@"', 'forge-deploy-lock', process.execPath, '-e',
      "process.stdout.write('locked\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"],
    {stdio: ['pipe', 'pipe', 'ignore', fd]});
    const exited = new Promise(resolve => child.once('close', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('flock unavailable or busy; provision flock or retry on the remote runner')), 5000);
      const finish = fn => value => { clearTimeout(timer); fn(value); };
      child.once('error', finish(() => reject(new Error('flock unavailable; provision flock on the remote runner'))));
      child.once('exit', finish(() => reject(new Error('flock unavailable or busy; provision flock or retry on the remote runner'))));
      child.stdout.once('data', finish(data => data.toString() === 'locked\n' ? resolve() : reject(new Error('invalid flock handshake'))));
    });
    try { return await action(); }
    finally { child.stdin.end(); await exited; }
  } finally {
    if (child && child.exitCode === null) child.kill();
    fs.closeSync(fd);
  }
}

export async function deploy({command, root, source, id, sha: legacyId, shaMeta = null,
  unknown = false, fs = nativeFs, uid = 0, lock = flockLock} = {}) {
  if (!['install', 'switch', 'rollback', 'status', 'preflight', 'recover'].includes(command)) fail('invalid command');
  if (['install', 'switch'].includes(command)) id = validId(id ?? legacyId);
  if (!(shaMeta === null || (typeof shaMeta === 'string' && SHA.test(shaMeta)))) fail('sha metadata must be 40 lowercase hex');
  root = trustDirectory(root, {fs, uid, missing: true});
  const at = name => path.join(root, name);
  const present = name => stat(fs, at(name));
  const syncDir = name => {
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { if (!trusted(fs.fstatSync(fd), uid, true)) fail('untrusted directory'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const write = (name, value, mode = 0o644) => {
    const fd = fs.openSync(name, 'wx', mode);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const atomic = (name, value) => {
    const temp = at(`.record-${randomUUID()}`);
    write(temp, JSON.stringify(value) + '\n');
    fs.renameSync(temp, at(name)); syncDir(root);
  };
  const readOptional = name => present(name) ? json(fs, at(name), uid) : null;
  const current = () => {
    const st = present('current');
    if (!st) return null;
    if (!st.isSymbolicLink() || st.uid !== uid) fail('untrusted current');
    const match = /^versions\/([a-f0-9]{64})$/.exec(fs.readlinkSync(at('current')));
    if (!match) fail('current escapes version layout');
    return match[1];
  };
  const record = () => {
    const value = readOptional('deploy.json');
    if (present('deploy.json') && (!value || !['previous', 'previous,provenance'].includes(Object.keys(value).sort().join()) ||
      ('provenance' in value && value.provenance !== 'unknown') ||
      !(value.previous === null || (typeof value.previous === 'string' && ID.test(value.previous))))) fail('invalid deploy record');
    return value;
  };
  const cache = (recover = false) => {
    const value = readOptional('state.json');
    if (present('state.json') && (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join() !== 'forgeSetSha,hostTier,installedAtET,schema,setDigest' ||
      !(value.setDigest === null || (typeof value.setDigest === 'string' && /^[a-f0-9]{64}$/i.test(value.setDigest))) ||
      !(value.forgeSetSha === null || (typeof value.forgeSetSha === 'string' && /^[a-f0-9]{40}$/i.test(value.forgeSetSha))) ||
      value.schema !== 1 || !(Number.isSafeInteger(value.hostTier) && value.hostTier > 0) ||
      !validET(value.installedAtET))) {
      // Invalid cache fields cannot supply provenance, tier or timestamps to recovery.
      if (recover) return null;
      fail('stale deploy: invalid state cache');
    }
    return value;
  };
  const artifacts = () => fs.readdirSync(root).filter(name => /^\.(stage|publish|current|record)-/.test(name));
  const inspect = () => {
    if (present('quarantine')) fail('deploy quarantined');
    const active = current(), saved = cache(), savedDeploy = record();
    const version = active ? readVersion(root, active, {fs, uid}) : null;
    if (artifacts().length || (active ? (!saved || saved.setDigest !== active || !savedDeploy) : saved?.setDigest != null)) fail('stale deploy');
    if (version?.sha && saved.forgeSetSha !== version.sha) fail('stale provenance cache');
    if (savedDeploy?.previous) readVersion(root, savedDeploy.previous, {fs, uid});
    return {current: active, previous: savedDeploy?.previous ?? null};
  };
  if (command === 'status' || command === 'preflight') {
    if (command === 'preflight' && source !== undefined) {
      const dir = trustDirectory(source, {fs, uid});
      const files = Object.fromEntries(payloads.map(name => [name, safeRead(fs, path.join(dir, name), uid)]));
      if (id !== undefined && contentDigest(files) !== validId(id)) fail('source digest mismatch');
    }
    if (!stat(fs, root)) return {current: null, previous: null};
    trustDirectory(at('versions'), {fs, uid});
    return inspect();
  }
  // Check stale/quarantine before even opening the writer lock file.
  if (command !== 'recover' && stat(fs, root)) inspect();
  const ensure = name => {
    trustDirectory(name, {fs, uid, missing: true});
    if (!stat(fs, name)) { ensure(path.dirname(name)); fs.mkdirSync(name, {mode: 0o755}); syncDir(path.dirname(name)); }
  };
  ensure(root);
  return lock(at('.deploy-lock'), async () => {
    ensure(at('versions'));
    const remove = name => {
      const st = stat(fs, name);
      if (!st) return;
      if (st.isDirectory() && !st.isSymbolicLink()) {
        trustDirectory(name, {fs, uid});
        for (const entry of fs.readdirSync(name)) remove(path.join(name, entry));
        fs.rmdirSync(name);
      } else { if (st.uid !== uid) fail('untrusted staged artifact'); fs.unlinkSync(name); }
    };
    const finish = (active, previous, saved, manifest) => {
      // A null-sha manifest cannot borrow provenance from another content set.
      // Recovery has no authority to declare an interrupted switch unknown.
      if (active && !manifest.sha && command === 'recover' && saved?.setDigest !== active) fail('missing matching provenance cache');
      const provenance = manifest?.sha ?? (command === 'recover' ? saved?.forgeSetSha : null);
      syncDir(root);
      if (active) atomic('state.json', {schema: 1, forgeSetSha: provenance, setDigest: active,
        hostTier: saved?.hostTier ?? 1,
        installedAtET: command === 'recover' && saved?.setDigest === active && saved.forgeSetSha === provenance && saved.installedAtET
          ? saved.installedAtET : easternTimestamp()});
      atomic('deploy.json', {previous, ...(active && provenance === null ? {provenance: 'unknown'} : {})});
    };
    if (command === 'recover') {
      try {
        const active = current(), saved = cache(true), old = record();
        const manifest = active ? readVersion(root, active, {fs, uid}) : null;
        if (!active && saved?.setDigest != null) fail('current missing');
        let previous = old?.previous ?? null;
        const transactions = artifacts().filter(name => name.startsWith('.publish-'));
        if (transactions.length > 1) fail('ambiguous publication records');
        for (const name of transactions) {
          const txn = json(fs, at(name), uid);
          validId(txn.to);
          if (txn.from !== null) validId(txn.from);
          if (active === txn.to) previous = txn.from;
          else if (active !== txn.from) fail('publication record disagrees with current');
        }
        if (previous) readVersion(root, previous, {fs, uid});
        syncDir(at('versions'));
        finish(active, previous, saved, manifest);
        for (const name of artifacts()) remove(at(name));
        if (present('quarantine')) fs.unlinkSync(at('quarantine'));
        syncDir(root);
        return inspect();
      } catch (error) {
        // Failure to persist the marker also remains a non-zero recovery failure.
        atomic('quarantine', {reason: error.message});
        throw error;
      }
    }
    const old = inspect();
    if (command === 'install') {
      if (shaMeta === null && !unknown) fail('missing provenance: provide --sha-meta or explicit --unknown');
      source = trustDirectory(source, {fs, uid});
      const files = Object.fromEntries(payloads.map(name => [name, safeRead(fs, path.join(source, name), uid)]));
      if (contentDigest(files) !== id) fail('source digest mismatch');
      if (present(`versions/${id}`)) {
        const existing = readVersion(root, id, {fs, uid});
        if (existing.sha !== shaMeta) fail('immutable version provenance differs');
        return {installed: id};
      }
      const stage = at(`.stage-${randomUUID()}`);
      try {
        fs.mkdirSync(stage, {mode: 0o755});
        for (const name of payloads) write(path.join(stage, name), files[name], 0o755);
        write(path.join(stage, 'manifest.json'), JSON.stringify({digest: id, sha: shaMeta, files: payloads}) + '\n');
        syncDir(stage);
        fs.renameSync(stage, at(`versions/${id}`));
        syncDir(at('versions'));
      } catch (error) {
        if (!error.crash) remove(stage);
        throw error;
      }
      return {installed: id};
    }
    if (command === 'rollback') { if (!old.previous) fail('no previous version'); id = old.previous; }
    const manifest = readVersion(root, id, {fs, uid});
    const saved = cache();
    if (!manifest.sha && !unknown) fail('missing provenance: provide --sha-meta or explicit --unknown');
    if (id === old.current) return old;
    const txn = at(`.publish-${randomUUID()}`), link = at(`.current-${randomUUID()}`);
    let committed = false;
    try {
      write(txn, JSON.stringify({from: old.current, to: id})); syncDir(root);
      fs.symlinkSync(`versions/${id}`, link);
      fs.renameSync(link, at('current')); // Commit: never undo this rename.
      committed = true;
      finish(id, old.current, saved, manifest);
      fs.unlinkSync(txn); syncDir(root);
      return {current: id, previous: old.current};
    } catch (error) {
      if (!committed && !error.crash) { remove(link); remove(txn); }
      throw error;
    }
  }, {fs, uid});
}

export function main(args) {
  const options = {command: args[0]};
  const flags = {'--root': 'root', '--source': 'source', '--id': 'id', '--sha': 'id', '--sha-meta': 'shaMeta'};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--unknown') options.unknown = true;
    else if (flags[args[i]] && args[i + 1] && !args[i + 1].startsWith('--')) options[flags[args[i++]]] = args[i];
    else fail('unknown or incomplete option');
  }
  return deploy(options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(error => {
    console.error(`forge-deploy: ${error.message.replace(/[\x00-\x1f\x7f]/g, ' ')}`); process.exitCode = 1;
  });
}
