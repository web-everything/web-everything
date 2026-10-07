/** @file scripts/lib/__tests__/daemon-version-switch.test.mjs — S4 offline switching contracts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as api from '../daemon-version-switch.mjs';

describe('daemon version switching', () => {
  let fixture, clone, home, root, settings, deps, deps2, now;
  const lockDirs = () => fs.readdirSync(root).filter(name => name.startsWith('switch.lock.')).sort();
  const files = () => fs.readdirSync(root).filter(name => !name.startsWith('switch.lock.')).sort();
  const call = (name, extra = {}) => api[name]({ clone, home, settings, deps, ...extra });
  const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
  const state = () => json(join(root, 'state.json'));
  const writeState = value => fs.writeFileSync(join(root, 'state.json'), JSON.stringify(value));
  const version = (id, status = 'built', age = 0) => {
    const dir = join(root, 'versions', id);
    fs.mkdirSync(dir, { recursive: true });
    if (status) fs.writeFileSync(join(dir, '.version.json'), JSON.stringify({ id, sha: id, status, builtAt: new Date(now - age).toISOString() }));
  };
  const link = (name, id) => { fs.rmSync(join(root, name), { force: true }); fs.symlinkSync(`versions/${id}`, join(root, name)); };
  const current = () => fs.readlinkSync(join(root, 'current'));
  beforeEach(() => {
    fixture = fs.mkdtempSync(join(tmpdir(), 'daemon-switch-'));
    clone = join(fixture, 'daemon'); home = join(fixture, '.daemon-clones'); root = join(home, 'daemon');
    now = Date.parse('2026-10-07T12:00:00Z');
    settings = { enabled: { daemon: true }, keep: 2, retainMinAgeMs: 10000, probationMs: 1000, autoRollback: true };
    deps = { now: () => now, hostname: () => 'local', pidAlive: pid => pid === 123, alert: vi.fn(), health: vi.fn(async () => ({ ok: true })) };
    version('a', 'built', 100000); version('b', 'built', 50000); version('c');
    deps2 = { ...deps };
    link('current', 'a'); writeState({ adopted: 'a', retired: {}, hold: null, probation: null });
  });
  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

  it('switches relative links, retires the old version and starts probation', async () => {
    expect(await call('switchCurrent', { id: 'b', expectCurrent: 'a' })).toMatchObject({ status: 'switched' });
    expect(current()).toBe('versions/b');
    expect(fs.readlinkSync(join(root, 'previous'))).toBe('versions/a');
    expect(state()).toMatchObject({ adopted: 'b', retired: { a: new Date(now).toISOString() }, probation: { id: 'b', prev: 'a', since: new Date(now).toISOString() } });
    expect(await call('switchCurrent', { id: 'b', expectCurrent: 'b' })).toEqual({ status: 'noop' });
  });
  it('aborts a stale CAS without changing state or leaving temp links', async () => {
    const before = state(); link('current', 'c');
    expect(await call('switchCurrent', { id: 'b', expectCurrent: 'a' })).toEqual({ status: 'aborted', reason: 'current-moved', actual: 'c' });
    expect(current()).toBe('versions/c'); expect(state()).toEqual(before);
    expect(files()).toEqual(['current', 'state.json', 'versions']);
  });
  it('allows exactly one concurrent switch with the same expectation', async () => {
    const results = await Promise.all(['b', 'c'].map(id => call('switchCurrent', { id, expectCurrent: 'a' })));
    expect(results.filter(result => result.status === 'switched')).toHaveLength(1);
    expect(results.filter(result => ['aborted', 'busy'].includes(result.status))).toHaveLength(1);
  });
  it.each(['smoke-failed', 'rejected', null])('refuses non-built record %s', async status => {
    version('bad', status);
    expect(await call('switchCurrent', { id: 'bad', expectCurrent: 'a' })).toMatchObject({ status: 'refused' });
    expect(current()).toBe('versions/a');
  });
  it('recovers adopted from the real current record after a crash', async () => {
    deps.failAfterRename = () => { throw new Error('crash'); };
    await expect(call('switchCurrent', { id: 'b', expectCurrent: 'a' })).rejects.toThrow('crash');
    expect(current()).toBe('versions/b'); expect(state().adopted).toBe('a');
    expect(lockDirs()).toEqual(['switch.lock.0']); expect(fs.existsSync(join(root, 'switch.lock.0/released'))).toBe(true);
    expect(await call('reconcile')).toEqual({ status: 'reconciled' });
    expect(state().adopted).toBe('b'); expect(await call('reconcile')).toEqual({ status: 'ok' });
  });
  it('restores probation, retirement and rollback after a crash past the pointer rename', async () => {
    deps.failAfterRename = () => { throw new Error('crash'); };
    await expect(call('switchCurrent', { id: 'b', expectCurrent: 'a' })).rejects.toThrow('crash');
    delete deps.failAfterRename;
    expect(await call('reconcile')).toEqual({ status: 'reconciled' });
    expect(state()).toMatchObject({ adopted: 'b', retired: { a: new Date(now).toISOString() }, probation: { id: 'b', prev: 'a', since: new Date(now).toISOString() } });
    expect(state().pending).toBeUndefined();
    deps.health.mockResolvedValue({ ok: false, reason: 'unhealthy' });
    expect(await call('checkProbation')).toMatchObject({ status: 'switched' });
    expect(current()).toBe('versions/a'); expect(json(join(root, 'versions/b/.version.json')).status).toBe('rejected');
  });
  it('rolls back an unhealthy version after a crash even when reconcile has not run yet', async () => {
    deps.failAfterRename = () => { throw new Error('crash'); };
    await expect(call('switchCurrent', { id: 'b', expectCurrent: 'a' })).rejects.toThrow('crash');
    delete deps.failAfterRename;
    deps.health.mockResolvedValue({ ok: false, reason: 'unhealthy' });
    expect(await call('checkProbation')).toMatchObject({ status: 'switched' });
    expect(current()).toBe('versions/a');
  });
  it('restores the hold after a crashed rollback and discards an intent whose rename never happened', async () => {
    await call('switchCurrent', { id: 'b', expectCurrent: 'a' });
    deps.failAfterRename = () => { throw new Error('crash'); };
    await expect(call('rollback', { reason: 'broken', by: 'operator' })).rejects.toThrow('crash');
    expect(await call('reconcile')).toEqual({ status: 'reconciled' });
    expect(state()).toMatchObject({ adopted: 'a', probation: null, hold: { version: 'b', reason: 'broken', by: 'operator' } });
    delete deps.failAfterRename;
    deps.failBeforeRename = () => { throw new Error('early crash'); };
    await expect(call('switchCurrent', { id: 'c', expectCurrent: 'a' })).rejects.toThrow('early crash');
    delete deps.failBeforeRename;
    expect(current()).toBe('versions/a'); expect(state().pending).toBeTruthy();
    expect(await call('reconcile')).toEqual({ status: 'reconciled' });
    expect(state().pending).toBeUndefined(); expect(state().adopted).toBe('a');
    expect(await call('switchCurrent', { id: 'c', expectCurrent: 'a' })).toMatchObject({ status: 'switched' });
  });
  it('fails fast on a live lock and clears a lock older than 30 seconds', async () => {
    const lock = join(root, 'switch.lock.5'); fs.mkdirSync(lock); fs.utimesSync(lock, now / 1000, now / 1000);
    expect(await call('switchCurrent', { id: 'b', expectCurrent: 'a' })).toEqual({ status: 'busy' });
    fs.utimesSync(lock, (now - 30001) / 1000, (now - 30001) / 1000);
    expect(await call('switchCurrent', { id: 'b', expectCurrent: 'a' })).toMatchObject({ status: 'switched' });
    expect(lockDirs()).toEqual(['switch.lock.6']); // generations only ever grow; the old one is gone
  });
  it('lets the next caller in as soon as a holder releases, without waiting for expiry', async () => {
    expect(await call('switchCurrent', { id: 'b', expectCurrent: 'a' })).toMatchObject({ status: 'switched' });
    fs.utimesSync(join(root, 'switch.lock.0'), now / 1000, now / 1000); // fresh by the clock, so only `released` can admit us
    expect(fs.existsSync(join(root, 'switch.lock.0/released'))).toBe(true);
    expect(await call('rollback')).toMatchObject({ status: 'switched' });
    expect(lockDirs()).toEqual(['switch.lock.1']);
  });
  it('backs out when a stalled contender wakes after its generation number was removed and reused', async () => {
    fs.mkdirSync(join(root, 'switch.lock.0')); fs.writeFileSync(join(root, 'switch.lock.0/released'), '');
    deps2.fs = { ...fs, mkdirSync: (...args) => {
      // While we were stalled, generations 0 and 1 came and went and a holder is running as generation 2.
      if (args[0] === join(root, 'switch.lock.1')) {
        fs.rmSync(join(root, 'switch.lock.0'), { recursive: true }); fs.mkdirSync(join(root, 'switch.lock.2')); fs.utimesSync(join(root, 'switch.lock.2'), now / 1000, now / 1000);
      }
      return fs.mkdirSync(...args);
    } };
    expect(await api.switchCurrent({ clone, home, settings, deps: deps2, id: 'b', expectCurrent: 'a' })).toEqual({ status: 'busy' });
    expect(lockDirs()).toEqual(['switch.lock.2']); expect(current()).toBe('versions/a');
  });
  it('treats a vanished top generation as taken over, and ignores entries that are not canonical generation directories', async () => {
    fs.mkdirSync(join(root, 'switch.lock.0')); fs.writeFileSync(join(root, 'switch.lock.0/released'), '');
    deps2.fs = { ...fs, lstatSync: (...args) => {
      if (args[0] === join(root, 'switch.lock.0') && fs.existsSync(args[0])) { fs.rmSync(args[0], { recursive: true }); fs.mkdirSync(join(root, 'switch.lock.1')); fs.utimesSync(join(root, 'switch.lock.1'), now / 1000, now / 1000); }
      return fs.lstatSync(...args);
    } };
    expect(await api.switchCurrent({ clone, home, settings, deps: deps2, id: 'b', expectCurrent: 'a' })).toEqual({ status: 'busy' });
    fs.rmSync(join(root, 'switch.lock.1'), { recursive: true });
    for (const junk of ['switch.lock.junk', 'switch.lock.007', 'switch.lock.1.bak']) fs.writeFileSync(join(root, junk), '');
    fs.symlinkSync(fixture, join(root, 'switch.lock.9'));
    expect(await call('switchCurrent', { id: 'b', expectCurrent: 'a' })).toMatchObject({ status: 'switched' });
    expect(lockDirs().filter(name => !['switch.lock.junk', 'switch.lock.007', 'switch.lock.1.bak', 'switch.lock.9'].includes(name))).toEqual(['switch.lock.0']);
  });
  it('a corrupt record cannot wedge recovery, and a corrupt one is refused before any pointer moves', async () => {
    await call('switchCurrent', { id: 'b', expectCurrent: 'a' });
    fs.writeFileSync(join(root, 'versions/b/.version.json'), '{ not json');
    deps.health.mockResolvedValue({ ok: false });
    await expect(call('checkProbation')).rejects.toThrow(SyntaxError);
    expect(current()).toBe('versions/b'); expect(state().pending).toBeUndefined();
  });
  it('restores previous when a crash lands between the previous and current pointer renames', async () => {
    link('previous', 'c');
    const real = fs.renameSync; let renames = 0;
    deps.fs = { ...fs, renameSync: (...args) => { if (String(args[1]).endsWith('/current') && !renames++) throw new Error('crash'); return real(...args); } };
    await expect(call('switchCurrent', { id: 'b', expectCurrent: 'a' })).rejects.toThrow('crash');
    expect(fs.readlinkSync(join(root, 'previous'))).toBe('versions/a'); // already replaced; the old previous would be lost
    delete deps.fs;
    expect(await call('reconcile')).toEqual({ status: 'reconciled' });
    expect(current()).toBe('versions/a'); expect(fs.readlinkSync(join(root, 'previous'))).toBe('versions/c');
    expect(state().pending).toBeUndefined();
  });
  it('rejects the failed version in the same recoverable step as the probation rollback', async () => {
    await call('switchCurrent', { id: 'b', expectCurrent: 'a' });
    deps.health.mockResolvedValue({ ok: false, reason: 'unhealthy' });
    deps.failAfterRename = () => { throw new Error('crash'); };
    await expect(call('checkProbation')).rejects.toThrow('crash');
    delete deps.failAfterRename;
    expect(json(join(root, 'versions/b/.version.json')).status).toBe('built');
    expect(await call('reconcile')).toEqual({ status: 'reconciled' });
    expect(current()).toBe('versions/a');
    expect(json(join(root, 'versions/b/.version.json')).status).toBe('rejected');
    expect(state()).toMatchObject({ adopted: 'a', probation: null, hold: { version: 'b', by: 'probation', reason: 'unhealthy' } });
  });
  it('starts a recovered probation window at recovery time so a late recovery still gets a health check', async () => {
    deps.failAfterRename = () => { throw new Error('crash'); };
    await expect(call('switchCurrent', { id: 'b', expectCurrent: 'a' })).rejects.toThrow('crash');
    delete deps.failAfterRename;
    now += 5000; // longer than probationMs
    await call('reconcile');
    expect(state().probation).toMatchObject({ id: 'b', since: new Date(now).toISOString() });
    expect(await call('checkProbation')).toEqual({ status: 'probation-ok' });
    expect(deps.health).toHaveBeenCalledTimes(1);
  });
  const staleLock = (gen = 0) => {
    const lock = join(root, `switch.lock.${gen}`); fs.mkdirSync(lock);
    fs.utimesSync(lock, (now - 30001) / 1000, (now - 30001) / 1000); return lock;
  };
  it('lets exactly one of two contenders that both saw a stale lock take it over', async () => {
    const lock = staleLock();
    let rival;
    // The rival sees the same stale lock and completes a whole switch between our listing and our mkdir.
    deps2.fs = { ...fs, mkdirSync: (...args) => {
      if (!rival && args[0] === join(root, 'switch.lock.1')) rival = api.switchCurrent({ clone, home, settings, deps, id: 'c', expectCurrent: 'a' });
      return fs.mkdirSync(...args);
    } };
    expect(await api.switchCurrent({ clone, home, settings, deps: deps2, id: 'b', expectCurrent: 'a' })).toEqual({ status: 'busy' });
    expect(await rival).toMatchObject({ status: 'switched', id: 'c' });
    expect(current()).toBe('versions/c'); expect(state().adopted).toBe('c');
    expect(fs.existsSync(lock)).toBe(false);
    expect(lockDirs()).toEqual(['switch.lock.1']);
  });
  it('never removes or replaces a lock another process holds while we try to take over', async () => {
    const lock = staleLock();
    deps2.fs = { ...fs, mkdirSync: (...args) => {
      // Another process wins generation 1 first and holds it, fresh.
      if (args[0] === join(root, 'switch.lock.1')) { fs.mkdirSync(args[0]); fs.utimesSync(args[0], now / 1000, now / 1000); }
      return fs.mkdirSync(...args);
    } };
    expect(await api.switchCurrent({ clone, home, settings, deps: deps2, id: 'b', expectCurrent: 'a' })).toEqual({ status: 'busy' });
    expect(fs.statSync(join(root, 'switch.lock.1')).mtimeMs).toBe(now);
    expect(fs.existsSync(lock)).toBe(true); expect(current()).toBe('versions/a');
    expect(await call('switchCurrent', { id: 'b', expectCurrent: 'a' })).toEqual({ status: 'busy' });
  });
  it('keeps a long action fresh and makes a superseded holder stop', async () => {
    for (const id of ['x1', 'x2', 'x3', 'x4']) version(id, 'built', 500000);
    let removals = 0, rival;
    deps2.fs = { ...fs, rmSync: (...args) => {
      if (String(args[0]).includes('/versions/x')) {
        now += 20000; removals++;
        // 40s after acquisition but only 20s since the last renewal: still held.
        if (removals === 2) rival = api.switchCurrent({ clone, home, settings, deps, id: 'b', expectCurrent: 'a' });
        // Another process takes generation 1 over while we are mid-removal (e.g. we looked stale to it).
        if (removals === 3) { fs.rmSync(join(root, 'switch.lock.0'), { recursive: true }); fs.mkdirSync(join(root, 'switch.lock.1')); }
      }
      return fs.rmSync(...args);
    } };
    const result = await api.gc({ clone, home, settings, deps: deps2 });
    expect(await rival).toEqual({ status: 'busy' });
    expect(result).toEqual({ status: 'busy' }); // noticed the takeover before the fourth removal
    expect(['x1', 'x2', 'x3', 'x4'].filter(id => fs.existsSync(join(root, 'versions', id)))).toHaveLength(1);
  });
  it('GC respects protected versions, cleans stale pins and retains one failed build', async () => {
    link('previous', 'b');
    for (const id of ['live', 'dead', 'young', 'old', 'new1', 'new2']) version(id, 'built', id.startsWith('new') ? -1000 : 200000);
    version('bad-old', 'rejected', 2000); version('bad-new', 'smoke-failed', 1000);
    version('unknown', null); version('.building-x', null);
    writeState({ ...state(), retired: { young: new Date(now - 100).toISOString(), old: new Date(now - 20000).toISOString() } });
    await call('pin', { id: 'live', pid: 123, host: 'local' });
    await call('pin', { id: 'dead', pid: 999, host: 'local' });
    const result = await call('gc');
    expect(result.removed).toEqual(expect.arrayContaining(['dead', 'old', 'bad-old']));
    expect(result.removed[0]).toBe('bad-old');
    expect(result.kept.map(v => v.id)).toEqual(expect.arrayContaining(['a', 'b', 'live', 'young', 'new1', 'new2', 'bad-new', 'unknown']));
    expect(fs.existsSync(join(root, 'pins/local-999.json'))).toBe(false);
    expect(fs.existsSync(join(root, 'versions/.building-x'))).toBe(true);
    expect((await call('status')).versions.find(v => v.id === 'live').pinned).toBe(true);
    await call('unpin', { id: 'live', pid: 123, host: 'local' });
    expect(fs.existsSync(join(root, 'pins/local-123.json'))).toBe(false);
  });
  it('protects fresh remote pins, expires stale ones and preserves rejection protections', async () => {
    version('remote-fresh', 'built', 1000000); version('remote-stale', 'built', 1000000);
    await call('pin', { id: 'remote-stale', pid: 99, host: 'remote' });
    now += 10001;
    await call('pin', { id: 'remote-fresh', pid: 99, host: 'other' });
    version('bad-live', 'rejected', 30000); version('bad-young', 'rejected', 20000);
    version('bad-new', 'rejected', 10000);
    await call('pin', { id: 'bad-live', pid: 123, host: 'local' });
    writeState({ ...state(), retired: { 'bad-young': new Date(now).toISOString() } });
    const result = await call('gc');
    expect(result.removed).toContain('remote-stale');
    expect(result.kept).toEqual(expect.arrayContaining([
      { id: 'remote-fresh', why: 'pinned' }, { id: 'bad-live', why: 'pinned' },
      { id: 'bad-young', why: 'young' }, { id: 'bad-new', why: 'inspection' },
    ]));
    expect(fs.existsSync(join(root, 'pins/remote-99.json'))).toBe(false);
  });
  it('does not start probation when automatic rollback is disabled', async () => {
    settings.autoRollback = false;
    await call('switchCurrent', { id: 'b', expectCurrent: 'a' });
    expect(state().probation).toBe(null);
    expect(await call('checkProbation')).toEqual({ status: 'none' });
    expect(deps.health).not.toHaveBeenCalled();
  });
  it('does not clear a replacement pin on delayed unpin', async () => {
    await call('pin', { id: 'a', pid: 123, host: 'local' });
    await call('pin', { id: 'b', pid: 123, host: 'local' });
    await call('unpin', { id: 'a', pid: 123, host: 'local' });
    expect(json(join(root, 'pins/local-123.json')).id).toBe('b');
  });
  it('resolves the logical clone name and reports a complete read-only snapshot', async () => {
    const snapshot = await call('status', { clone: join(root, 'versions/a') });
    expect(snapshot).toMatchObject({ current: 'a', previous: null, adopted: 'a', hold: null, probation: null });
    expect(snapshot.versions).toContainEqual({ id: 'a', status: 'built', pinned: false, retiredAt: null });
    expect(fs.readdirSync(root).sort()).toEqual(['current', 'state.json', 'versions']);
  });
  it('rolls back even to a non-built target and records a hold', async () => {
    await call('switchCurrent', { id: 'b', expectCurrent: 'a' }); version('a', 'rejected');
    expect(await call('rollback', { reason: 'broken', by: 'operator' })).toMatchObject({ status: 'switched' });
    expect(current()).toBe('versions/a');
    expect(state()).toMatchObject({ probation: null, hold: { version: 'b', reason: 'broken', by: 'operator', until: 'main-moves' } });
  });
  it('rolls back failed probation, atomically rejects its record and alerts', async () => {
    await call('switchCurrent', { id: 'b', expectCurrent: 'a' });
    deps.health.mockResolvedValue({ ok: false, reason: 'unhealthy' });
    expect(await call('checkProbation')).toMatchObject({ status: 'switched' });
    expect(current()).toBe('versions/a'); expect(state().hold.by).toBe('probation');
    expect(json(join(root, 'versions/b/.version.json')).status).toBe('rejected');
    expect(deps.alert).toHaveBeenCalledTimes(1);
  });
  it('keeps healthy probation and expires it without rolling back', async () => {
    expect(await call('checkProbation')).toEqual({ status: 'none' });
    await call('switchCurrent', { id: 'b', expectCurrent: 'a' });
    expect(await call('checkProbation')).toEqual({ status: 'probation-ok' });
    now += 1001;
    expect(await call('checkProbation')).toEqual({ status: 'out-of-probation' });
    expect(state().probation).toBe(null); expect(current()).toBe('versions/b');
    expect(deps.health).toHaveBeenCalledTimes(1);
  });
  it('does not apply an old health result after current has moved', async () => {
    await call('switchCurrent', { id: 'b', expectCurrent: 'a' });
    deps.health = async () => { await call('switchCurrent', { id: 'c', expectCurrent: 'b' }); return { ok: false }; };
    expect(await call('checkProbation')).toMatchObject({ status: 'aborted' });
    expect(current()).toBe('versions/c'); expect(json(join(root, 'versions/b/.version.json')).status).toBe('built');
  });
  it('reports missing rollback targets and handles an initial null current', async () => {
    expect(await call('rollback')).toEqual({ status: 'no-previous' });
    fs.rmSync(join(root, 'current'));
    await call('switchCurrent', { id: 'b', expectCurrent: null });
    deps.health.mockResolvedValue({ ok: false });
    expect(await call('checkProbation')).toEqual({ status: 'no-previous' });
  });
  it('every export is dormant without filesystem access', async () => {
    for (const name of Object.keys(api)) {
      expect(await call(name, { settings: {}, id: '../bad', deps: { fs: new Proxy({}, { get() { throw new Error('filesystem touched'); } }) } })).toEqual({ status: 'disabled' });
    }
  });
  it.each(['../bad', 'a/b', 'a..b', '.', '', 'bad\\name'])('rejects unsafe id %j', async id => {
    await expect(call('switchCurrent', { id, expectCurrent: 'a' })).rejects.toThrow(/Invalid/);
    await expect(call('pin', { id, host: 'local', pid: 123 })).rejects.toThrow(/Invalid/);
    await expect(call('rollback', { to: id })).rejects.toThrow(/Invalid/);
  });
  it('refuses external directory and metadata symlinks', async () => {
    fs.symlinkSync(fixture, join(root, 'versions/outside'));
    await expect(call('switchCurrent', { id: 'outside', expectCurrent: 'a' })).rejects.toThrow(/Unsafe/);
    fs.rmSync(join(root, 'versions/b/.version.json'));
    fs.symlinkSync(join(root, 'state.json'), join(root, 'versions/b/.version.json'));
    await expect(call('switchCurrent', { id: 'b', expectCurrent: 'a' })).rejects.toThrow(/Unsafe/);
    expect(current()).toBe('versions/a');
  });
  it.each(['versions', 'pins', 'state.json', 'current'])('refuses an external %s symlink without modifying its target', async name => {
    const outside = join(fixture, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, 'sentinel'), 'untouched');
    fs.rmSync(join(root, name), { recursive: true, force: true });
    fs.symlinkSync(outside, join(root, name));
    await expect(call('gc')).rejects.toThrow(/Unsafe/);
    expect(fs.readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
    expect(fs.readdirSync(outside)).toEqual(['sentinel']);
  });
  it('CLI supports forced offline status, dry-run and switching in a temp home', () => {
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [resolve('scripts/lib/daemon-version.mjs'), ...args, `--clone=${clone}`, `--home=${home}`, '--json'], { encoding: 'utf8' }));
    expect(cli('status')).toEqual({ status: 'disabled' });
    expect(cli('status', '--force').current).toBe('a');
    expect(cli('switch', '--id=b', '--expect-current=a', '--force', '--dry-run').status).toBe('dry-run');
    expect(current()).toBe('versions/a');
    expect(cli('switch', '--id=b', '--expect-current=a', '--force').status).toBe('switched');
    expect(cli('status', '--force').adopted).toBe('b');
  });
});
