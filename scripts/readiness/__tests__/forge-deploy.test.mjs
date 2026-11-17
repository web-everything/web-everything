// @vitest-environment node
import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {deploy, contentDigest, flockLock, ID, main, payloads, readVersion, trusted, trustDirectory} from '../forge-deploy.mjs';

const sandboxes = [];
afterEach(() => { for (const dir of sandboxes.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });
const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40);
const unlocked = async (_name, action) => action();
const mutations = new Set(['writeFileSync', 'fsyncSync', 'renameSync', 'symlinkSync', 'unlinkSync', 'rmdirSync', 'mkdirSync']);
function faults(base, k = Infinity, mode = 'eio') {
  let count = 0, fired = false;
  const io = new Proxy(base, {get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (...args) => {
      const mutates = mutations.has(key) || (key === 'openSync' &&
        (typeof args[1] === 'string' ? /[wa]/.test(args[1]) : Boolean(args[1] & fs.constants.O_CREAT)));
      const hit = mutates && ++count === k;
      if (hit) {
        fired = true;
        if (mode === 'eio') throw Object.assign(new Error('injected EIO'), {code: 'EIO'});
        value.apply(target, args);
        throw Object.assign(new Error('simulated process crash'), {crash: true});
      }
      return value.apply(target, args);
    };
  }});
  return {io, count: () => count, fired: () => fired};
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'forge-deploy-'));
  sandboxes.push(dir);
  const root = path.join(dir, 'deploy'), source = path.join(dir, 'bundle');
  fs.mkdirSync(source, {mode: 0o755});
  // Real temp ancestors are shared. Model trusted ancestor metadata through IO,
  // while retaining the production predicate, including all file-descriptor reads.
  const uid = process.getuid() + 42;
  const ancestors = new Set();
  for (let p = path.dirname(dir); ; p = path.dirname(p)) {
    ancestors.add(p);
    if (p === path.dirname(p)) break;
  }
  const io = new Proxy(fs, {get(target, key) {
    if (key === 'lstatSync' || key === 'fstatSync') return (...args) => {
      const st = target[key](...args);
      if (st.uid === process.getuid() || (key === 'lstatSync' && ancestors.has(args[0]))) st.uid = uid;
      if (key === 'lstatSync' && ancestors.has(args[0])) st.mode &= ~0o022;
      return st;
    };
    return target[key];
  }});
  const run = (command, options = {}) => deploy({command, root, source, fs: io, uid, lock: unlocked, ...options});
  const bundle = text => {
    const files = Object.fromEntries(payloads.map(name => [name, Buffer.from(`// remote runner ${text}: ${name}\n`)]));
    for (const name of payloads) fs.writeFileSync(path.join(source, name), files[name], {mode: 0o755});
    return contentDigest(files);
  };
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  return {dir, root, source, uid, io, run, bundle, read};
}
async function seeded() {
  const f = fixture();
  f.a = f.bundle('one'); await f.run('install', {id: f.a, shaMeta: sha}); await f.run('switch', {id: f.a});
  f.b = f.bundle('two'); await f.run('install', {id: f.b});
  return f;
}
function agreement(f) {
  const id = fs.readlinkSync(path.join(f.root, 'current')).slice('versions/'.length);
  const manifest = f.read(`versions/${id}/manifest.json`);
  // Independently recompute instead of relying on the implementation's digest helper.
  const hash = createHash('sha256');
  for (const name of [...payloads].sort()) hash.update(name + '\0' + createHash('sha256')
    .update(fs.readFileSync(path.join(f.root, 'versions', id, name))).digest('hex') + '\n');
  expect([id, f.read('state.json').setDigest, manifest.digest, hash.digest('hex')]).toEqual([id, id, id, id]);
}

describe('publication crash points', () => {
  for (const command of ['install', 'switch', 'rollback']) {
    for (const mode of ['eio', 'crash']) {
      it(`${command}: every mutating call ${mode} recovers forward or quarantines without weakening sha`, async () => {
        const prepare = async () => {
          const f = await seeded();
          if (command === 'rollback') await f.run('switch', {id: f.b});
          f.target = command === 'install' ? f.bundle('three') : f.b;
          return f;
        };
        const baseline = await prepare(), counter = faults(baseline.io);
        await baseline.run(command, {id: baseline.target, fs: counter.io});
        const bound = counter.count();
        expect(bound).toBeGreaterThan(0);
        for (let k = 1; k <= bound; k++) {
          const f = await prepare(), injected = faults(f.io, k, mode);
          const before = f.read('state.json').forgeSetSha;
          await expect(f.run(command, {id: f.target, fs: injected.io})).rejects.toThrow();
          expect(injected.fired(), `fault ${k}/${bound}`).toBe(true);
          // A crash at the current rename must keep the newly committed pointer.
          const committed = fs.readlinkSync(path.join(f.root, 'current'));
          try { await f.run('recover'); } catch {
            expect(fs.existsSync(path.join(f.root, 'quarantine'))).toBe(true);
          }
          if (!fs.existsSync(path.join(f.root, 'quarantine'))) {
            agreement(f);
            expect(fs.readlinkSync(path.join(f.root, 'current'))).toBe(committed);
            await f.run('recover'); agreement(f);
          }
          expect(f.read('state.json').forgeSetSha).toBe(before);
          fs.rmSync(f.dir, {recursive: true, force: true});
        }
      }, 30000);
    }
  }
});

it.each(['a'.repeat(40), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '../x', '', null, ['a'.repeat(64)]])
('rejects invalid digest ids before mutations: %s', async id => {
  const f = fixture(), probe = faults(f.io);
  for (const command of ['install', 'switch']) await expect(f.run(command, {id, fs: probe.io})).rejects.toThrow('^[a-f0-9]{64}$');
  expect(probe.count()).toBe(0);
  expect(ID.source).toBe('^[a-f0-9]{64}$');
});

it.each(['tampered', 'extra', 'missing', 'symlink', 'foreign', 'writable', 'manifest'])
('rejects %s version evidence on every read and quarantines failed recovery', async kind => {
  const f = await seeded(), dir = path.join(f.root, 'versions', f.a), file = path.join(dir, payloads[0]);
  let io = f.io;
  if (kind === 'tampered') fs.writeFileSync(file, 'tampered');
  if (kind === 'extra') fs.writeFileSync(path.join(dir, 'extra'), 'extra');
  if (kind === 'missing') fs.unlinkSync(file);
  if (kind === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(path.join(f.source, payloads[0]), file); }
  if (kind === 'writable') fs.chmodSync(file, 0o777);
  if (kind === 'manifest') fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({digest: f.b, sha, files: payloads}));
  if (kind === 'foreign') io = new Proxy(f.io, {get(target, key) {
    if (key === 'fstatSync') return fd => Object.assign(target.fstatSync(fd), {uid: f.uid + 1});
    return target[key];
  }});
  expect(() => readVersion(f.root, f.a, {fs: io, uid: f.uid})).toThrow();
  // Foreign metadata is injected only into the version-read probe above.
  if (kind === 'foreign') fs.chmodSync(file, 0o777);
  await expect(f.run('recover')).rejects.toThrow();
  expect(fs.existsSync(path.join(f.root, 'quarantine'))).toBe(true);
  expect(f.read('state.json').forgeSetSha).toBe(sha);
});

it('status and preflight take no lock and perform zero mutations, including absent roots and stale evidence', async () => {
  const f = fixture(), probe = faults(f.io);
  f.bundle('one');
  const lock = () => { throw new Error('read command acquired lock'); };
  for (const command of ['status', 'preflight']) await f.run(command, {fs: probe.io, lock});
  expect(fs.existsSync(f.root)).toBe(false);
  const id = f.bundle('one'); await f.run('install', {id, shaMeta: sha}); await f.run('switch', {id});
  for (const command of ['status', 'preflight']) await f.run(command, {fs: probe.io, lock});
  fs.writeFileSync(path.join(f.root, 'state.json'), JSON.stringify({setDigest: 'f'.repeat(64), forgeSetSha: sha}));
  for (const command of ['status', 'preflight']) await expect(f.run(command, {fs: probe.io, lock})).rejects.toThrow('stale');
  expect(probe.count()).toBe(0);
});

it.each(['stale', 'quarantined'])('all writers refuse %s evidence without mutating', async kind => {
  const f = await seeded();
  if (kind === 'stale') fs.writeFileSync(path.join(f.root, 'state.json'), JSON.stringify({setDigest: f.b, forgeSetSha: sha}));
  else fs.writeFileSync(path.join(f.root, 'quarantine'), '{}');
  const probe = faults(f.io);
  for (const command of ['install', 'switch', 'rollback']) await expect(f.run(command, {id: f.b, fs: probe.io})).rejects.toThrow(kind === 'stale' ? 'stale' : 'quarantined');
  expect(probe.count()).toBe(0);
});

it('recovery is idempotent and restores stale cache without weakening provenance', async () => {
  const f = await seeded(); await f.run('switch', {id: f.b});
  fs.writeFileSync(path.join(f.root, 'state.json'), JSON.stringify({setDigest: f.a, forgeSetSha: sha}));
  fs.writeFileSync(path.join(f.root, 'quarantine'), '{}');
  await f.run('recover'); agreement(f);
  const before = [f.read('state.json'), f.read('deploy.json')];
  await f.run('recover'); agreement(f);
  expect([f.read('state.json'), f.read('deploy.json')]).toEqual(before);
  expect(Object.keys(f.read('deploy.json'))).toEqual(['previous']);
});

it('keeps sha separate from digest, accepts verified replacement sha, and requires explicit unknown', async () => {
  const f = fixture(), a = f.bundle('one'); await f.run('install', {id: a});
  await expect(f.run('switch', {id: a})).rejects.toThrow('missing provenance');
  await f.run('switch', {id: a, unknown: true});
  expect(f.read('state.json').forgeSetSha).toBe('unknown');
  const b = f.bundle('two'); await f.run('install', {id: b, shaMeta: otherSha}); await f.run('switch', {id: b});
  expect(f.read('state.json').forgeSetSha).toBe(otherSha);
  await f.run('rollback'); expect(f.read('state.json').forgeSetSha).toBe(otherSha);
  await expect(f.run('install', {id: b, shaMeta: b})).rejects.toThrow('40 lowercase hex');
});

it('uses the same trust predicate for every ancestor and file with injected uid', async () => {
  const f = await seeded();
  expect(trusted(f.io.lstatSync(f.root), f.uid, true)).toBe(true);
  expect(trusted(f.io.lstatSync(f.root), 0, true)).toBe(false);
  const ancestors = [];
  for (let p = f.root; ; p = path.dirname(p)) { ancestors.push(p); if (p === path.dirname(p)) break; }
  for (const ancestor of ancestors) for (const kind of ['uid', 'group', 'world', 'symlink', 'missing', 'unreadable']) {
    const io = new Proxy(f.io, {get(target, key) {
      if (key !== 'lstatSync') return target[key];
      return name => {
        if (name !== ancestor) return target.lstatSync(name);
        if (kind === 'missing' || kind === 'unreadable') throw Object.assign(new Error(kind), {code: kind === 'missing' ? 'ENOENT' : 'EACCES'});
        const st = target.lstatSync(name);
        if (kind === 'uid') st.uid++;
        if (kind === 'group') st.mode |= 0o020;
        if (kind === 'world') st.mode |= 0o002;
        if (kind === 'symlink') st.isSymbolicLink = () => true;
        return st;
      };
    }});
    expect(() => trustDirectory(f.root, {fs: io, uid: f.uid})).toThrow();
  }
});

it('fails closed on oversized input and leaves an operator-visible inspection fallback', async () => {
  const f = fixture(), id = f.bundle('one');
  fs.truncateSync(path.join(f.source, payloads[0]), 8 * 1024 * 1024 + 1);
  await expect(f.run('install', {id})).rejects.toThrow('inspect the remote runner');
  expect(fs.existsSync(path.join(f.root, 'versions', id))).toBe(false);
});

it('writes the complete manifest before the version rename and never modifies an existing version', async () => {
  const f = fixture(), id = f.bundle('one'); let observed = false;
  const io = new Proxy(f.io, {get(target, key) {
    if (key === 'renameSync') return (from, to) => {
      if (to === path.join(f.root, 'versions', id)) {
        observed = true;
        expect(JSON.parse(fs.readFileSync(path.join(from, 'manifest.json')))).toEqual({digest: id, sha, files: payloads});
        expect(fs.readdirSync(from).sort()).toEqual([...payloads, 'manifest.json'].sort());
      }
      return target.renameSync(from, to);
    };
    return target[key];
  }});
  await f.run('install', {id, shaMeta: sha, fs: io}); expect(observed).toBe(true);
  await f.run('install', {id, shaMeta: sha});
  await expect(f.run('install', {id, shaMeta: otherSha})).rejects.toThrow('immutable');
});

it('flock refuses unavailable implementation and lock contention without running the writer', async () => {
  const f = fixture(); let called = false;
  for (const kind of ['unavailable', 'busy']) {
    const spawnImpl = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => {}; child.exitCode = 1;
      queueMicrotask(() => { if (kind === 'unavailable') child.emit('error', new Error('flock unavailable')); else child.emit('exit', 1); child.emit('close', 1); });
      return child;
    };
    await expect(flockLock(path.join(f.dir, 'lock'), () => { called = true; }, {fs: f.io, uid: f.uid, spawnImpl})).rejects.toThrow(/flock/);
  }
  expect(called).toBe(false);
});

it('parses CLI options and refuses unknown commands and incomplete options', async () => {
  expect(() => main(['status', '--invalid'])).toThrow('unknown');
  expect(() => main(['install', '--id'])).toThrow('incomplete');
  await expect(main(['invalid'])).rejects.toThrow('invalid command');
});

it('first-install crashes at every mutation recover an empty deployment or quarantine', async () => {
  const baseline = fixture(), id = baseline.bundle('one'), counter = faults(baseline.io);
  await baseline.run('install', {id, shaMeta: sha, fs: counter.io});
  for (let k = 1; k <= counter.count(); k++) {
    const f = fixture(), target = f.bundle('one'), probe = faults(f.io, k, 'crash');
    await expect(f.run('install', {id: target, shaMeta: sha, fs: probe.io})).rejects.toThrow('simulated process crash');
    try {
      await f.run('recover');
      expect(await f.run('status')).toEqual({current: null, previous: null});
      expect(fs.existsSync(path.join(f.root, 'state.json'))).toBe(false);
    } catch {
      expect(fs.existsSync(path.join(f.root, 'quarantine'))).toBe(true);
    }
  }
}, 30000);

it('preflight validates supplied source owner, size, symlinks and digest without writing', async () => {
  const f = fixture(), id = f.bundle('one'), probe = faults(f.io);
  await expect(f.run('preflight', {id: 'f'.repeat(64), fs: probe.io})).rejects.toThrow('source digest mismatch');
  fs.chmodSync(path.join(f.source, payloads[0]), 0o777);
  await expect(f.run('preflight', {id, fs: probe.io})).rejects.toThrow('untrusted');
  fs.chmodSync(path.join(f.source, payloads[0]), 0o755);
  fs.unlinkSync(path.join(f.source, payloads[0]));
  fs.symlinkSync(path.join(f.source, payloads[1]), path.join(f.source, payloads[0]));
  await expect(f.run('preflight', {id, fs: probe.io})).rejects.toThrow();
  fs.unlinkSync(path.join(f.source, payloads[0]));
  f.bundle('one'); fs.truncateSync(path.join(f.source, payloads[0]), 8 * 1024 * 1024 + 1);
  await expect(f.run('preflight', {id, fs: probe.io})).rejects.toThrow('oversized');
  expect(probe.count()).toBe(0);
});

it('flock holds one owner-checked file descriptor through the action and releases it afterward', async () => {
  const f = fixture(); let held = false, released = false;
  const spawnImpl = (command, argv, options) => {
    expect(command).toBe('flock'); expect(argv.slice(0, 3)).toEqual(['-n', '-x', '3']);
    expect(trusted(f.io.fstatSync(options.stdio[3]), f.uid)).toBe(true);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough();
    child.exitCode = null; child.kill = () => { throw new Error('unexpected kill'); };
    child.stdin.on('finish', () => {
      held = false; released = true; child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0);
    });
    queueMicrotask(() => { held = true; child.stdout.write('locked\n'); });
    return child;
  };
  const value = await flockLock(path.join(f.dir, 'lock'), async () => {
    expect(held).toBe(true); expect(released).toBe(false); return 'done';
  }, {fs: f.io, uid: f.uid, spawnImpl});
  expect(value).toBe('done'); expect(released).toBe(true);
});

it.each(['state.json', 'deploy.json'])('refuses a null %s record as incomplete evidence', async name => {
  const f = await seeded(); fs.writeFileSync(path.join(f.root, name), 'null');
  const probe = faults(f.io);
  for (const command of ['status', 'preflight', 'install', 'switch', 'rollback']) {
    await expect(f.run(command, {id: f.b, fs: probe.io})).rejects.toThrow('invalid');
  }
  expect(probe.count()).toBe(0);
  await expect(f.run('recover')).rejects.toThrow('invalid');
  expect(fs.existsSync(path.join(f.root, 'quarantine'))).toBe(true);
});
