// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {deploy, contentDigest, flockLock, ID, main, payloads, readVersion, trusted, trustDirectory} from '../forge-deploy.mjs';

const sandboxes = [];
afterEach(() => { vi.useRealTimers(); for (const dir of sandboxes.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });
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
  f.b = f.bundle('two'); await f.run('install', {id: f.b, shaMeta: sha});
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
        await baseline.run(command, {id: baseline.target, shaMeta: sha, fs: counter.io});
        const bound = counter.count();
        expect(bound).toBeGreaterThan(0);
        for (let k = 1; k <= bound; k++) {
          const f = await prepare(), injected = faults(f.io, k, mode);
          const before = f.read('state.json').forgeSetSha;
          await expect(f.run(command, {id: f.target, shaMeta: sha, fs: injected.io})).rejects.toThrow();
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

it.each([
  ...['status', 'preflight', 'recover'].flatMap(command =>
    ['manifest', 'payload', 'state.json', 'deploy.json'].map(kind => [command, kind])),
  ['preflight', 'source'], ['install', 'source'], ['recover', 'transaction'],
])('%s opens %s evidence without blocking and rejects an injected FIFO before reading', async (command, kind) => {
  const f = await seeded();
  const name = kind === 'manifest' || kind === 'payload'
    ? path.join(f.root, 'versions', f.a, kind === 'manifest' ? 'manifest.json' : payloads[0])
    : kind === 'source' ? path.join(f.source, payloads[0])
    : path.join(f.root, kind === 'transaction' ? '.publish-fifo' : kind);
  if (kind === 'transaction') fs.writeFileSync(name, JSON.stringify({from: null, to: f.a}));
  const descriptors = new Set(), openedFlags = [];
  let inspected = 0, reads = 0, closed = 0;
  const io = new Proxy(f.io, {get(target, key) {
    if (key === 'openSync') return (file, flags, ...args) => {
      const fd = target.openSync(file, flags, ...args);
      if (file === name) { descriptors.add(fd); openedFlags.push(flags); }
      return fd;
    };
    if (key === 'fstatSync') return fd => {
      const st = target.fstatSync(fd);
      if (descriptors.has(fd)) {
        inspected++;
        st.mode = (st.mode & ~fs.constants.S_IFMT) | fs.constants.S_IFIFO;
        st.isFile = () => false;
        st.isFIFO = () => true;
      }
      return st;
    };
    if (key === 'readSync' || key === 'readFileSync') return (fd, ...args) => {
      if (descriptors.has(fd) || fd === name) { reads++; throw new Error('read attempted on FIFO'); }
      return target[key](fd, ...args);
    };
    if (key === 'closeSync') return fd => {
      if (descriptors.delete(fd)) closed++;
      return target.closeSync(fd);
    };
    return target[key];
  }});
  await expect(f.run(command, {id: f.b, shaMeta: sha, fs: io}))
    .rejects.toThrow('untrusted or oversized file; inspect the remote runner and run recover');
  expect(openedFlags).toHaveLength(1);
  expect(openedFlags[0] & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
  expect(openedFlags[0] & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
  expect(inspected).toBe(1);
  expect(reads).toBe(0);
  expect(closed).toBe(1);
  expect(descriptors.size).toBe(0);
  if (command === 'recover') expect(fs.existsSync(path.join(f.root, 'quarantine'))).toBe(true);
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
  const f = fixture(), a = f.bundle('one'); await f.run('install', {id: a, unknown: true});
  await expect(f.run('switch', {id: a})).rejects.toThrow('missing provenance');
  await f.run('switch', {id: a, unknown: true});
  expect(f.read('state.json').forgeSetSha).toBeNull();
  expect(f.read('deploy.json').provenance).toBe('unknown');
  const b = f.bundle('two'); await f.run('install', {id: b, shaMeta: otherSha}); await f.run('switch', {id: b});
  expect(f.read('state.json').forgeSetSha).toBe(otherSha);
  await expect(f.run('rollback')).rejects.toThrow('missing provenance');
  expect(f.read('state.json').forgeSetSha).toBe(otherSha);
  await f.run('rollback', {unknown: true}); expect(f.read('state.json').forgeSetSha).toBeNull();
  await expect(f.run('install', {id: b, shaMeta: b})).rejects.toThrow('40 lowercase hex');
});

it('refuses null-sha install and switch without explicit unknown, regardless of the prior verified sha', async () => {
  const f = await seeded(), id = f.bundle('unknown');
  const probe = faults(f.io);
  await expect(f.run('install', {id, fs: probe.io})).rejects.toThrow('missing provenance');
  expect(fs.existsSync(path.join(f.root, 'versions', id))).toBe(false);
  await f.run('install', {id, unknown: true});
  await expect(f.run('switch', {id, fs: probe.io})).rejects.toThrow('missing provenance');
  expect(probe.count()).toBe(0);
  expect(f.read('state.json').forgeSetSha).toBe(sha);
  expect(fs.readlinkSync(path.join(f.root, 'current'))).toBe(`versions/${f.a}`);
  await f.run('switch', {id, unknown: true});
  expect(f.read('state.json').forgeSetSha).toBeNull();
  await expect(f.run('switch', {id})).rejects.toThrow('missing provenance');
  await f.run('recover');
  expect(f.read('state.json').forgeSetSha).toBeNull();
});

it.each(['missing', 'different'])('quarantines null-sha recovery with %s digest evidence even with --unknown', async kind => {
  const f = await seeded(), id = f.bundle('unknown');
  await f.run('install', {id, unknown: true});
  // Model a crash after current commits, before state.json is published.
  fs.unlinkSync(path.join(f.root, 'current'));
  fs.symlinkSync(`versions/${id}`, path.join(f.root, 'current'));
  if (kind === 'missing') fs.unlinkSync(path.join(f.root, 'state.json'));
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(f.run('recover', {unknown: true})).rejects.toThrow('matching provenance');
    expect(fs.existsSync(path.join(f.root, 'quarantine'))).toBe(true);
    expect(fs.readlinkSync(path.join(f.root, 'current'))).toBe(`versions/${id}`);
    if (kind === 'different') expect(f.read('state.json').forgeSetSha).toBe(sha);
  }
});

it('preserves a saved verified sha for a null manifest only when its digest matches', async () => {
  const f = fixture(), id = f.bundle('unknown');
  await f.run('install', {id, unknown: true}); await f.run('switch', {id, unknown: true});
  const saved = {...f.read('state.json'), forgeSetSha: sha};
  fs.writeFileSync(path.join(f.root, 'state.json'), JSON.stringify(saved));
  await f.run('switch', {id, unknown: true});
  expect(f.read('state.json')).toEqual(saved);
  await f.run('recover', {unknown: true});
  expect(f.read('state.json')).toEqual(saved);
  expect(f.read('deploy.json')).toEqual({previous: null});
});

it('writes the exact S0 state shape with ET milliseconds, preserves tier, and keeps matching recovery timestamps', async () => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date('2026-01-15T17:00:00.123Z'));
  const f = await seeded();
  expect(f.read('state.json')).toEqual({schema: 1, forgeSetSha: sha, setDigest: f.a,
    hostTier: 1, installedAtET: '2026-01-15T12:00:00.123-05:00'});
  const saved = {...f.read('state.json'), hostTier: 3};
  fs.writeFileSync(path.join(f.root, 'state.json'), JSON.stringify(saved));
  vi.setSystemTime(new Date('2026-07-15T17:00:00.456Z'));
  await f.run('recover'); expect(f.read('state.json')).toEqual(saved);
  await f.run('switch', {id: f.b, unknown: true});
  expect(f.read('state.json')).toEqual({...saved, setDigest: f.b, installedAtET: '2026-07-15T13:00:00.456-04:00'});
  vi.setSystemTime(new Date('2026-07-16T17:00:00.789Z'));
  await f.run('rollback');
  expect(f.read('state.json')).toEqual({...saved, installedAtET: '2026-07-16T13:00:00.789-04:00'});
});

it('verified manifest sha wins over --unknown on both switch and recover', async () => {
  const f = await seeded();
  await f.run('switch', {id: f.b, unknown: true});
  await f.run('recover', {unknown: true});
  expect(f.read('state.json').forgeSetSha).toBe(sha);
  expect(f.read('deploy.json').provenance).toBeUndefined();
});

it('migrates the previous minimal cache to S0 without losing its verified sha', async () => {
  const f = await seeded();
  fs.writeFileSync(path.join(f.root, 'state.json'), JSON.stringify({setDigest: f.a, forgeSetSha: sha}));
  await f.run('recover');
  expect(f.read('state.json')).toMatchObject({schema: 1, forgeSetSha: sha, setDigest: f.a, hostTier: 1});
  expect(f.read('state.json').installedAtET).toMatch(/\.\d{3}-0[45]:00$/);
  const saved = f.read('state.json');
  await f.run('recover'); expect(f.read('state.json')).toEqual(saved);
});

it.each([
  ...['schema', 'forgeSetSha', 'setDigest', 'hostTier', 'installedAtET'].map(key => [
    `missing ${key}`, value => { delete value[key]; return value; },
  ]),
  ...[
    {extra: true}, {provenance: 'unknown'}, {schema: 2}, {schema: '1'},
    {hostTier: 0}, {hostTier: 1.5}, {hostTier: '1'}, {hostTier: Number.MAX_SAFE_INTEGER + 1},
    {forgeSetSha: 'unknown'}, {forgeSetSha: 40}, {setDigest: 'bad'}, {setDigest: 64},
    {installedAtET: '2026-07-15T12:00:00.000-05:00'}, {installedAtET: 'unreadable'}, {installedAtET: 0},
  ].map(invalid => [JSON.stringify(invalid), value => ({...value, ...invalid})]),
  ['null', () => null], ['array', () => []], ['string', () => 'state'], ['number', () => 1],
])('treats %s cache as stale, blocks writers, and recovers from current plus manifest', async (_label, invalidate) => {
  const f = await seeded();
  const saved = invalidate(f.read('state.json'));
  fs.writeFileSync(path.join(f.root, 'state.json'), JSON.stringify(saved));
  const probe = faults(f.io);
  const lock = vi.fn(() => { throw new Error('stale cache acquired writer lock'); });
  for (const command of ['status', 'preflight', 'install', 'switch', 'rollback']) {
    await expect(f.run(command, {id: f.b, fs: probe.io, lock})).rejects.toThrow('stale deploy: invalid state cache');
  }
  expect(probe.count()).toBe(0);
  expect(f.read('state.json')).toEqual(saved);
  expect(lock).not.toHaveBeenCalled();
  await f.run('recover');
  const repaired = f.read('state.json');
  expect(Object.keys(repaired).sort()).toEqual(['forgeSetSha', 'hostTier', 'installedAtET', 'schema', 'setDigest']);
  expect(repaired).toMatchObject({schema: 1, forgeSetSha: sha, setDigest: f.a, hostTier: 1});
  expect(repaired.installedAtET).toMatch(/\.\d{3}-0[45]:00$/);
  agreement(f);
  await f.run('switch', {id: f.b});
  agreement(f);
});

it('keeps explicit unknown SHA inside the exact state schema through recovery', async () => {
  const f = fixture(), id = f.bundle('unknown');
  await f.run('install', {id, unknown: true});
  await f.run('switch', {id, unknown: true});
  await f.run('recover');
  expect(Object.keys(f.read('state.json')).sort()).toEqual(['forgeSetSha', 'hostTier', 'installedAtET', 'schema', 'setDigest']);
  expect(f.read('state.json').forgeSetSha).toBeNull();
  expect(await f.run('status')).toEqual({current: id, previous: null});
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
  await expect(f.run('install', {id, shaMeta: sha})).rejects.toThrow('inspect the remote runner');
  expect(fs.existsSync(path.join(f.root, 'versions', id))).toBe(false);
});

it.each(['payload', 'manifest'])('bounds a growing %s read to limit+1, handles short reads and closes on rejection', async kind => {
  const f = await seeded(), limit = kind === 'payload' ? 8 * 1024 * 1024 : 16384;
  const name = path.join(f.root, 'versions', f.a, kind === 'payload' ? payloads[0] : 'manifest.json');
  let growingFd, buffer, total = 0, calls = 0, closed = false;
  const io = new Proxy(f.io, {get(target, key) {
    if (key === 'readFileSync') return () => { throw new Error('unbounded read'); };
    if (key === 'openSync') return (file, ...args) => {
      const fd = target.openSync(file, ...args);
      if (file === name) growingFd = fd;
      return fd;
    };
    if (key === 'fstatSync') return fd => {
      const st = target.fstatSync(fd);
      if (fd === growingFd) fs.truncateSync(name, limit + 4096);
      return st;
    };
    if (key === 'readSync') return (fd, bytes, offset, length, position) => {
      if (fd !== growingFd) return target.readSync(fd, bytes, offset, length, position);
      if (buffer) expect(bytes).toBe(buffer);
      buffer = bytes;
      expect(bytes.length).toBe(limit + 1);
      expect(offset).toBe(total);
      expect(length).toBe(limit + 1 - total);
      const count = target.readSync(fd, bytes, offset, Math.min(length, 4096), position);
      total += count; calls++;
      return count;
    };
    if (key === 'closeSync') return fd => {
      if (fd === growingFd) closed = true;
      return target.closeSync(fd);
    };
    return target[key];
  }});
  expect(() => readVersion(f.root, f.a, {fs: io, uid: f.uid})).toThrow('oversized file; inspect the remote runner and run recover');
  expect(total).toBe(limit + 1);
  expect(calls).toBeGreaterThan(1);
  expect(closed).toBe(true);
});

it.each(['payload', 'manifest'])('accepts a %s exactly at the read limit without readFileSync', async kind => {
  const f = await seeded(), limit = kind === 'payload' ? 8 * 1024 * 1024 : 16384;
  let id = f.a;
  if (kind === 'payload') {
    fs.writeFileSync(path.join(f.source, payloads[0]), Buffer.alloc(limit, 'x'));
    id = contentDigest(Object.fromEntries(payloads.map(name => [name, fs.readFileSync(path.join(f.source, name))])));
  } else {
    const name = path.join(f.root, 'versions', id, 'manifest.json');
    const content = fs.readFileSync(name);
    fs.writeFileSync(name, Buffer.concat([content, Buffer.alloc(limit - content.length, ' ')]));
  }
  const io = new Proxy(f.io, {get(target, key) {
    if (key === 'readFileSync') return () => { throw new Error('unbounded read'); };
    if (key === 'readSync') return (fd, bytes, offset, length, position) => target.readSync(fd, bytes, offset, Math.min(length, 65536), position);
    return target[key];
  }});
  if (kind === 'payload') await f.run('install', {id, shaMeta: sha, fs: io});
  expect(readVersion(f.root, id, {fs: io, uid: f.uid}).digest).toBe(id);
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
    expect(command).toBe('sh');
    expect(argv.slice(0, 5)).toEqual(['-c', 'flock -n -x 3 || exit 1; exec "$@"', 'forge-deploy-lock', process.execPath, '-e']);
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

it('refuses a null deploy.json record as incomplete evidence', async () => {
  const name = 'deploy.json';
  const f = await seeded(); fs.writeFileSync(path.join(f.root, name), 'null');
  const probe = faults(f.io);
  for (const command of ['status', 'preflight', 'install', 'switch', 'rollback']) {
    await expect(f.run(command, {id: f.b, fs: probe.io})).rejects.toThrow('invalid');
  }
  expect(probe.count()).toBe(0);
  await expect(f.run('recover')).rejects.toThrow('invalid');
  expect(fs.existsSync(path.join(f.root, 'quarantine'))).toBe(true);
});
