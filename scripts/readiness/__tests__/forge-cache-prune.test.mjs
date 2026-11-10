// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {renameSync, symlinkSync, openSync, closeSync} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {resolveSettings, planPrune, scanCache, executePrune, readLiveEvidence} from '../forge-cache-prune.mjs';

const HOUR = 3_600_000, GiB = 1024 ** 3, now = Date.UTC(2026, 10, 9);
const hex = c => c.repeat(64), lock = hex('a');
let tmp, root, receipts;
beforeEach(async () => {
  tmp = await fs.mkdtemp(join(process.env.TMPDIR, 'forge-cache-prune-'));
  root = join(tmp, 'cache'); receipts = join(tmp, 'receipts');
  await fs.mkdir(root); await fs.mkdir(receipts);
});
afterEach(async () => { vi.unstubAllEnvs(); if (tmp) await fs.rm(tmp, {recursive: true, force: true}); });

const validEnv = {FORGE_CACHE_MAX_AGE_HOURS: '12', FORGE_CACHE_MAX_BYTES: String(200 * GiB),
  FORGE_CACHE_HIGH_WATER_PCT: '80'};
const settingFaults = Object.keys(validEnv).flatMap(variable =>
  ['missing', 'invalid'].map(fault => ({variable, fault})));
const faultyEnv = ({variable, fault}) => {
  const env = {...validEnv};
  if (fault === 'missing') delete env[variable];
  else env[variable] = 'garbage';
  return env;
};
const key = e => `${e.lock}/${e.name}`;
const keys = entries => entries.map(key).sort();
const entry = (c, age, bytes = 10, version = 5) => ({lock, name: `dev-v${version}-${hex(c)}`,
  path: join(root, lock, `dev-v${version}-${hex(c)}`), mtimeMs: now - age * HOUR, bytes});
// The pure planner receives the same explicit root as the scanner/executor so
// it can reject paths outside that boundary without accessing the filesystem.
const plan = (entries, options = {}) => planPrune({root, entries, now,
  settings: resolveSettings(validEnv), disk: {usedPct: 20, totalBytes: 1000, usedBytes: 200},
  live: {complete: true, profiles: new Set()}, ...options});
const settings = overrides => ({...resolveSettings(validEnv), ...overrides});
function expectDecision(result, prune, keep) {
  expect(keys(result.prune)).toEqual(keys(prune));
  expect(keys(result.keep)).toEqual(keys(keep));
  for (const e of [...result.prune, ...result.keep]) expect(e.reason).toEqual(expect.stringMatching(/\S/));
  for (const original of [...prune, ...keep]) {
    expect([...result.prune, ...result.keep].find(e => key(e) === key(original))).toMatchObject(original);
  }
}
async function materialize(c = 'b', age = 20, version = 5) {
  const e = entry(c, age, 10, version);
  await fs.mkdir(e.path, {recursive: true});
  await fs.writeFile(join(e.path, 'payload'), 'cache');
  await fs.utimes(e.path, e.mtimeMs / 1000, e.mtimeMs / 1000);
  return (await scanCache(root)).find(p => p.name === e.name);
}
const exists = async path => fs.lstat(path).then(() => true, e => {
  if (e.code === 'ENOENT') return false;
  throw e;
});
async function json(path, value) {
  await fs.mkdir(join(path, '..'), {recursive: true});
  await fs.writeFile(path, JSON.stringify(value));
}
async function child(name, age, kind = 'file', contents = '1234567890') {
  const path = join(root, lock, name);
  await fs.mkdir(join(root, lock), {recursive: true});
  if (kind === 'directory') {
    await fs.mkdir(path);
    await fs.writeFile(join(path, 'payload'), contents);
  } else if (kind === 'symlink') await fs.symlink(contents, path);
  else await fs.writeFile(path, contents);
  const mtime = (now - age * HOUR) / 1000;
  if (kind === 'symlink') await fs.lutimes(path, mtime, mtime);
  else await fs.utimes(path, mtime, mtime);
  return {lock, name, path, mtimeMs: (await fs.lstat(path)).mtimeMs,
    bytes: kind === 'symlink' ? (await fs.lstat(path)).size : Buffer.byteLength(contents)};
}
async function reserve(run = `r-${'1'.repeat(32)}`, worker = 'worker-active') {
  await json(join(receipts, worker, 'reservation.json'), {run, writerGuard: 1});
  return run;
}
const record = siblings => ({lock, inputDigest: hex('b'), manifestDigest: hex('c'),
  manifest: siblings ? {siblings: {frontierui: {sha: 'd'.repeat(40)}}} : {}});

describe('resolveSettings', () => {
  it('refuses entirely missing bounds and names the first missing variable', () => {
    expect(() => resolveSettings({})).toThrow(/FORGE_CACHE_MAX_AGE_HOURS/);
  });
  it.each(settingFaults)('fails closed for $fault $variable', fault => {
    expect(() => resolveSettings(faultyEnv(fault))).toThrow(fault.variable);
  });
  it('reads each environment setting and records its non-default source', () => {
    const s = resolveSettings({FORGE_CACHE_MAX_AGE_HOURS: '18', FORGE_CACHE_MAX_BYTES: '4096',
      FORGE_CACHE_HIGH_WATER_PCT: '90'});
    expect(s).toMatchObject({maxAgeHours: 18, maxBytes: 4096, highWaterPct: 90, minAgeMs: HOUR});
    for (const k of ['maxAgeHours', 'maxBytes', 'highWaterPct']) {
      expect(s.sources[k]).toEqual(expect.stringMatching(/\S/));
      expect(s.sources[k]).not.toBe('default');
    }
  });
  it.each([['1', 6], ['1000000', 24]])('clamps age %s to %i hours', (raw, expected) => {
    expect(resolveSettings({...validEnv, FORGE_CACHE_MAX_AGE_HOURS: raw}).maxAgeHours).toBe(expected);
  });
  it.each(Object.keys(validEnv).flatMap(variable =>
    ['', ' ', 'garbage', '12hours', 'NaN', 'Infinity', '-Infinity'].map(raw => ({variable, raw}))))
  ('rejects $variable=$raw without a default', ({variable, raw}) => {
    expect(() => resolveSettings({...validEnv, [variable]: raw})).toThrow(variable);
  });
  it.each(['0', '-1', '1e999', String(Number.MAX_SAFE_INTEGER + 1)])
  ('rejects nonpositive, overflowing or unsafe size caps %s', raw => {
    expect(() => resolveSettings({...validEnv, FORGE_CACHE_MAX_BYTES: raw})).toThrow('FORGE_CACHE_MAX_BYTES');
  });
  it.each(['-1', '101'])('rejects out-of-range high water %s', raw => {
    expect(() => resolveSettings({...validEnv, FORGE_CACHE_HIGH_WATER_PCT: raw})).toThrow('FORGE_CACHE_HIGH_WATER_PCT');
  });
  it('keeps the one-hour hard floor despite an unrecognized minimum-age override', () => {
    expect(resolveSettings({...validEnv, FORGE_CACHE_MIN_AGE_MS: '0'}).minAgeMs).toBe(HOUR);
  });
});

describe('planPrune', () => {
  it.each(settingFaults)('refuses planning with $fault $variable in the environment', fault => {
    const env = faultyEnv(fault);
    for (const variable of Object.keys(validEnv)) vi.stubEnv(variable, env[variable]);
    const old = entry('b', 30);
    let result, error;
    try {
      result = planPrune({root, entries: [old], now,
        disk: {usedPct: 99, usedBytes: 990, totalBytes: 1000},
        live: {complete: true, profiles: new Set()}});
    } catch (caught) { error = caught; }
    if (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(fault.variable);
    } else {
      expectDecision(result, [], [old]);
      expect(result.refused).toContain(fault.variable);
    }
  });
  it.each(['age', 'size', 'high-water'])('all direct-child names obey %s and exact live/minimum-age protection', pressure => {
    const named = (name, age, bytes) => ({...entry('b', age, bytes), name, path: join(root, lock, name)});
    const old = named('dev-v3-x', 20, 30), eligible = named('junk', 3, 30);
    const liveEntry = named('.unknown-live', 30, 30), infant = named('.unknown-young', 0.5, 30);
    const options = {live: {complete: true, profiles: new Set([key(liveEntry)])}};
    if (pressure === 'size') options.settings = settings({maxBytes: 1});
    if (pressure === 'high-water') options.disk = {usedPct: 99, usedBytes: 990, totalBytes: 1000};
    expectDecision(plan([old, eligible, liveEntry, infant], options),
      pressure === 'age' ? [old] : [old, eligible], pressure === 'age' ? [eligible, liveEntry, infant] : [liveEntry, infant]);
  });
  it.each(['junk', '.warm-inputs-orphan'])('counts protected %s bytes toward maxBytes', async name => {
    const eligible = entry('b', 3, 10);
    await child(name, 0.5, 'file', JSON.stringify({profile: hex('f')}));
    const protectedEntries = await scanCache(root);
    expectDecision(plan([eligible, ...protectedEntries], {settings: settings({maxBytes: 50})}),
      [eligible], protectedEntries);
  });
  it.each(['age', 'size', 'high-water'])('old indexes inherit live/young v5 protection under %s pressure', async pressure => {
    const liveProfile = await materialize('b', 30), youngProfile = await materialize('c', 0.5);
    const liveIndex = await child('.warm-inputs-live', 30, 'file', JSON.stringify({profile: hex('b')}));
    const youngIndex = await child('.warm-inputs-young', 30, 'file', JSON.stringify({profile: hex('c')}));
    const orphan = await child('.warm-inputs-orphan', 30, 'file', JSON.stringify({profile: hex('f')}));
    const malformed = await child('.warm-inputs-malformed', 30, 'file', '{');
    const options = {live: {complete: true, profiles: new Set([key(liveProfile)])}};
    if (pressure === 'size') options.settings = settings({maxBytes: 1});
    if (pressure === 'high-water') options.disk = {usedPct: 99, usedBytes: 990, totalBytes: 1000};
    const entries = await scanCache(root);
    expect(keys(entries)).toEqual(keys([liveProfile, youngProfile, liveIndex, youngIndex, orphan, malformed]));
    // Use scanned metadata, without imposing a new public index representation.
    const selected = names => entries.filter(e => names.includes(e.name));
    expectDecision(plan(entries, options), selected([orphan.name, malformed.name]),
      selected([liveProfile.name, youngProfile.name, liveIndex.name, youngIndex.name]));
  });
  it.each([3, 4, 12])('dev-v%i profiles with unrelated digests obey age, size, high-water, minimum-age and live protection', version => {
    const old = entry('b', 20, 100, version), eligible = entry('c', 3, 300, version);
    const infant = entry('d', 0.5, 300, version), protectedProfile = entry('e', 20, 300, version);
    const current = entry('f', 20);
    const live = {complete: true, profiles: new Set([key(current), key(protectedProfile)])};
    const entries = [old, eligible, infant, protectedProfile, current];
    expectDecision(plan(entries, {live}), [old], [eligible, infant, protectedProfile, current]);
    for (const pressure of [
      {settings: settings({maxBytes: 1})},
      {disk: {usedPct: 99, usedBytes: 990, totalBytes: 1000}},
    ]) expectDecision(plan(entries, {live, ...pressure}), [old, eligible], [infant, protectedProfile, current]);
  });
  it('age: prunes older profiles inside a hot lock while keeping younger profiles', () => {
    const old = entry('b', 13), young = entry('c', 11), boundary = entry('d', 12);
    expectDecision(plan([young, old, boundary]), [old], [young, boundary]);
  });
  it('size cap: prunes oldest first until retained bytes fit the cap', () => {
    const oldest = entry('b', 10, 40), middle = entry('c', 8, 40), newest = entry('d', 2, 40);
    expectDecision(plan([newest, oldest, middle], {settings: settings({maxBytes: 50})}),
      [oldest, middle], [newest]);
  });
  it('high-water: reaches the five-point hysteresis target using oldest eligible profiles', () => {
    const oldest = entry('b', 10, 60), middle = entry('c', 8, 40), newer = entry('d', 2, 100);
    const infant = entry('e', 0.5, 500), disk = {usedPct: 85, usedBytes: 850, totalBytes: 1000};
    const result = plan([infant, newer, middle, oldest], {disk});
    expectDecision(result, [oldest, middle], [newer, infant]);
    expect((disk.usedBytes - result.prune.reduce((n, e) => n + e.bytes, 0)) / disk.totalBytes * 100).toBe(75);
  });
  it('high-water: does not reclaim at the threshold itself', () => {
    const e = entry('b', 2, 100);
    expectDecision(plan([e], {disk: {usedPct: 80, usedBytes: 800, totalBytes: 1000}}), [], [e]);
  });
  it.each(['age', 'size', 'high-water'])('live-run exclusion and minimum age survive %s pressure', pressure => {
    const live = entry('b', 30, 300), infant = entry('c', 0.5, 300), eligible = entry('d', 3, 300);
    const options = {live: {complete: true, profiles: new Set([key(live)])}};
    if (pressure === 'age') options.settings = settings({maxAgeHours: 2});
    if (pressure === 'size') options.settings = settings({maxBytes: 1});
    if (pressure === 'high-water') options.disk = {usedPct: 99, usedBytes: 990, totalBytes: 1000};
    expectDecision(plan([infant, live, eligible], options), [eligible], [live, infant]);
  });
  it.each([20, 99])('fail closed: incomplete live evidence refuses all deletion at %i%% disk usage', usedPct => {
    const e = entry('b', 40, 900);
    const result = plan([e], {settings: settings({maxBytes: 1}),
      disk: {usedPct, usedBytes: usedPct * 10, totalBytes: 1000}, live: {complete: false, profiles: new Set()}});
    expectDecision(result, [], [e]);
    expect(result.refused).toEqual(expect.stringMatching(/\S/));
  });
  it('bad input: malformed lock, traversal name or an inexact path can never enter prune', () => {
    const valid = entry('b', 30);
    const invalid = [
      {...valid, lock: 'A'.repeat(64)}, {...valid, lock: 'a'.repeat(63)},
      ...['.', '..', '../escape', 'nested/child'].map(name => ({...valid, name, path: join(root, lock, name)})),
      {...valid, path: join(tmp, 'elsewhere', lock, valid.name)},
      {...valid, path: join(root, lock, 'nested', valid.name)},
      {...valid, path: `${root}/${lock}/../${lock}/${valid.name}`},
    ];
    for (const e of invalid) expect(plan([e], {settings: settings({maxBytes: 1}),
      disk: {usedPct: 99, usedBytes: 990, totalBytes: 1000}}).prune).toEqual([]);
  });
  it('is pure: does not mutate input entries, settings, disk or live profiles', () => {
    const entries = [Object.freeze(entry('b', 20)), Object.freeze(entry('c', 2))];
    const live = {complete: true, profiles: new Set([key(entries[1])])};
    const options = {settings: Object.freeze(settings({})), disk: Object.freeze({usedPct: 20,
      usedBytes: 200, totalBytes: 1000}), live};
    const before = structuredClone({entries, ...options});
    Object.freeze(entries);
    expectDecision(plan(entries, options), [entries[0]], [entries[1]]);
    expect({entries, ...options}).toEqual(before);
  });
});

describe('scanCache', () => {
  it('scans every direct child of a real lock, including unknown names, files, indexes and symlinks', async () => {
    const legacy = [await materialize('b', 20, 3), await materialize('c', 20, 4), await materialize('d', 20, 12)];
    const names = [`dev-v-${hex('e')}`, `dev-vx-${hex('e')}`, `dev-v3-${'E'.repeat(64)}`,
      `dev-v4-${'e'.repeat(63)}`, `dev-v4-${'e'.repeat(65)}`, `dev-v3-${hex('e')}\n`,
      `dev-v3-${hex('e')}-extra`, `other-v3-${hex('e')}`, 'dev-v3-x', 'junk', '.hidden'];
    for (const name of names) {
      await fs.mkdir(join(root, lock, name));
      const unknown = {...entry('e', 20), name, path: join(root, lock, name)};
      expectDecision(plan([unknown]), [unknown], []);
    }
    await fs.mkdir(join(root, legacy[0].name));
    await fs.mkdir(join(root, 'invalid-lock', legacy[0].name), {recursive: true});
    await fs.mkdir(join(root, lock, 'nested', legacy[0].name), {recursive: true});
    await fs.symlink(legacy[0].path, join(root, lock, 'linked'));
    await fs.writeFile(join(root, lock, 'plain-file'), '1234567');
    await json(join(root, lock, '.warm-inputs-orphan'), {profile: hex('f')});
    const found = await scanCache(root);
    expect(keys(found)).toEqual([...legacy.map(key), ...names.concat('nested', 'linked', 'plain-file',
      '.warm-inputs-orphan').map(name => `${lock}/${name}`)].sort());
    expect(found.find(e => e.name === 'plain-file').bytes).toBe(7);
    expect(found.find(e => e.name === '.warm-inputs-orphan').bytes)
      .toBe((await fs.lstat(join(root, lock, '.warm-inputs-orphan'))).size);
  });
  it('sums nested payloads without following symlinks and never enters root-level symlink locks', async () => {
    const e = await materialize();
    await fs.mkdir(join(e.path, 'nested'));
    await fs.writeFile(join(e.path, 'nested', 'data'), '1234567');
    const outside = join(tmp, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'secret'), 'x'.repeat(100));
    await fs.symlink(outside, join(e.path, 'linked-dir'));
    await fs.symlink(join(outside, 'secret'), join(e.path, 'linked-file'));
    await fs.symlink(outside, join(root, lock, `dev-v5-${hex('c')}`));
    await fs.symlink(join(root, lock), join(root, hex('d')));
    await fs.writeFile(join(root, lock, `dev-v5-${hex('e')}`), 'not a directory');
    await fs.mkdir(join(root, 'bad-lock', e.name), {recursive: true});
    await fs.mkdir(join(root, lock, 'bad-profile'));
    await fs.mkdir(join(root, e.name));
    await fs.mkdir(join(root, lock, 'extra', `dev-v5-${hex('f')}`), {recursive: true});
    const found = await scanCache(root);
    expect(keys(found)).toEqual([e.name, `dev-v5-${hex('c')}`, `dev-v5-${hex('e')}`,
      'bad-profile', 'extra'].map(name => `${lock}/${name}`).sort());
    expect(found.find(p => p.name === `dev-v5-${hex('e')}`).bytes).toBe(15);
    expect(found.find(p => p.name === e.name)).toMatchObject({lock, name: e.name, path: e.path, bytes: 12,
      mtimeMs: (await fs.lstat(e.path)).mtimeMs});
  });
});

describe('executePrune', () => {
  // Forge uses util-linux flock. Darwin fixtures use the same kernel flock
  // protocol through Python, just as the existing Forge runner does. Applying
  // acquires all 129 leases, so allow these real subprocesses 20 seconds.
  const leaseSpawn = (command, args, options) => command === '/usr/bin/flock' && process.platform === 'darwin'
    ? spawn('/usr/bin/python3', ['-I', '-c', 'import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'], options)
    : spawn(command, args, options);

  it('applies to aged arbitrary files, directories and orphan indexes, leaving root-level non-lock entries untouched', async () => {
    const candidates = [await child('junk', 30), await child('dev-v3-x', 30, 'directory'),
      await child('.hidden', 30), await child('.warm-inputs-orphan', 30, 'file', '{')];
    const topFile = join(root, 'top-level-junk'), topDir = join(root, 'not-a-lock');
    await fs.writeFile(topFile, 'root sentinel');
    await fs.mkdir(topDir); await fs.writeFile(join(topDir, 'payload'), 'root directory sentinel');
    const result = await executePrune(plan(candidates), {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(keys(result.deleted)).toEqual(keys(candidates));
    for (const e of candidates) expect(await exists(e.path)).toBe(false);
    expect(await fs.readFile(topFile, 'utf8')).toBe('root sentinel');
    expect(await fs.readFile(join(topDir, 'payload'), 'utf8')).toBe('root directory sentinel');
  }, 20_000);

  it('unlinks aged direct-child symlinks without traversing targets and preserves young symlinks', async () => {
    const outside = join(tmp, 'outside'); await fs.mkdir(outside);
    const sentinel = join(outside, 'sentinel'); await fs.writeFile(sentinel, 'outside');
    const oldDirLink = await child(`dev-v5-${hex('b')}`, 30, 'symlink', outside);
    const oldFileLink = await child('linked-file', 30, 'symlink', sentinel);
    const dangling = await child('dangling', 30, 'symlink', join(tmp, 'missing'));
    const youngLink = await child('young-link', 0.5, 'symlink', outside);
    const result = await executePrune(plan([oldDirLink, oldFileLink, dangling, youngLink]),
      {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(keys(result.deleted)).toEqual(keys([oldDirLink, oldFileLink, dangling]));
    for (const e of [oldDirLink, oldFileLink, dangling]) expect(await exists(e.path)).toBe(false);
    expect((await fs.lstat(youngLink.path)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('outside');
  }, 20_000);

  it.each([3, 4, 12])('pruning dev-v%i with a different digest preserves the index of a live v5 profile', async version => {
    const legacy = await materialize('d', 30, version), current = await materialize('b', 30);
    const marker = await child('.warm-inputs-live', 30, 'file', JSON.stringify({profile: hex('b')}));
    const run = await reserve(); await json(join(receipts, `${run}.running`), record(false));
    const live = await readLiveEvidence({receipts});
    const result = await executePrune(plan([legacy, current], {live}),
      {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(keys(result.deleted)).toEqual(keys([legacy]));
    expect(await exists(legacy.path)).toBe(false);
    expect(await fs.readFile(join(current.path, 'payload'), 'utf8')).toBe('cache');
    expect(await fs.readFile(marker.path, 'utf8')).toBe(JSON.stringify({profile: hex('b')}));
  }, 20_000);

  it('pruning a legacy profile preserves the index pointing to a young v5 profile with the same digest', async () => {
    const legacy = await materialize('b', 30, 3), current = await materialize('b', 0.5);
    const marker = await child('.warm-inputs-young', 30, 'file', JSON.stringify({profile: hex('b')}));
    const result = await executePrune(plan([legacy, current]),
      {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(keys(result.deleted)).toEqual(keys([legacy]));
    expect(await exists(current.path)).toBe(true);
    expect(await exists(marker.path)).toBe(true);
  }, 20_000);

  it('rechecks live protection for an aged index when a reservation appears after planning', async () => {
    const current = await materialize('b', 30);
    const marker = await child('.warm-inputs-newly-live', 30, 'file', JSON.stringify({profile: hex('b')}));
    const result = plan([marker]);
    // An explicit candidate exercises executor protection independently of scanner/planner filtering.
    result.prune = [{...marker, reason: 'Expired age'}]; result.keep = [];
    const run = await reserve(); await json(join(receipts, `${run}.running`), record(false));
    const applied = await executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(applied.deleted).toEqual([]);
    expect(keys(applied.skipped)).toEqual(keys([marker]));
    expect(await exists(marker.path)).toBe(true);
    expect(await fs.readFile(join(current.path, 'payload'), 'utf8')).toBe('cache');
  }, 20_000);

  it('fails closed when apply omits receipts, preserving profiles and indexes without spawning', async () => {
    const e = await materialize(), marker = join(root, lock, '.warm-inputs-one');
    await json(marker, {profile: hex('b'), archiveDigest: hex('f')});
    let spawned = false;
    await expect(executePrune(plan([e]), {root, apply: true, spawnProcess() {
      spawned = true;
      throw new Error('Must refuse before spawning');
    }})).rejects.toThrow(/Apply requires receipts.*preserving cache.*repair/);
    expect(spawned).toBe(false);
    expect(await fs.readFile(join(e.path, 'payload'), 'utf8')).toBe('cache');
    expect(await exists(marker)).toBe(true);
  }, 20_000);

  it('applies retention to legacy profiles with a different digest from the live profile', async () => {
    const legacy = [await materialize('d', 20, 3), await materialize('d', 20, 4), await materialize('d', 20, 12)];
    const current = await materialize();
    const run = await reserve();
    await json(join(receipts, `${run}.running`), record(false));
    // Plan before reservation evidence to also exercise the executor's live-name check.
    const result = await executePrune(plan([...legacy, current]), {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(keys(result.deleted)).toEqual(keys(legacy));
    expect(keys(result.skipped)).toEqual(keys([current]));
    for (const e of legacy) expect(await exists(e.path)).toBe(false);
    expect(await fs.readFile(join(current.path, 'payload'), 'utf8')).toBe('cache');
  }, 20_000);

  it.each(['matching-digest', 'legacy-wrapper', 'missing-profile'])
  ('rechecks %s protection after planning and preserves every protected candidate', async fault => {
    const entries = [await materialize('b', 30, 3), await materialize('b', 30, 4),
      await child('.warm-inputs-matching', 30, 'file', JSON.stringify({profile: hex('b')}))];
    if (fault !== 'matching-digest') entries.push(await child('arbitrary', 30));
    const planned = plan(await scanCache(root));
    const run = await reserve();
    if (fault === 'legacy-wrapper') await json(join(receipts, 'worker-active', 'reservation.json'), {run});
    const active = record(false);
    if (fault === 'missing-profile') delete active.manifest;
    await json(join(receipts, `${run}.running`), active);
    const applied = await executePrune(planned, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(applied.deleted).toEqual([]);
    expect(keys(applied.skipped)).toEqual(keys(entries));
    for (const e of entries) expect(await exists(e.path)).toBe(true);
  }, 20_000);

  it('anchors deletion when the checked parent is replaced by an outside symlink before delete', async () => {
    const e = await materialize();
    // Match metadata outside too: only the directory anchor should defend this.
    delete e.ino; delete e.dev;
    const outside = join(tmp, 'outside'), target = join(outside, e.name);
    await fs.mkdir(target, {recursive: true});
    await fs.writeFile(join(target, 'sentinel'), 'outside');
    await fs.utimes(target, e.mtimeMs / 1000, e.mtimeMs / 1000);
    const saved = join(tmp, 'saved-lock');
    let substituted = false;
    await expect(executePrune(plan([e]), {root, receipts, apply: true, spawnProcess(command, args, options) {
      if (command !== process.execPath) return leaseSpawn(command, args, options);
      substituted = true;
      renameSync(join(root, lock), saved);
      symlinkSync(outside, join(root, lock));
      return spawn(command, args, options);
    }})).rejects.toThrow(/refused/);
    expect(substituted).toBe(true);
    expect(await fs.readFile(join(target, 'sentinel'), 'utf8')).toBe('outside');
    expect(await fs.readFile(join(saved, e.name, 'payload'), 'utf8')).toBe('cache');
  }, 20_000);

  it('preserves a newly reserved profile between planning evidence and deletion', async () => {
    const e = await materialize();
    const result = plan([e], {live: await readLiveEvidence({receipts})});
    const guard = openSync(join(receipts, '.worker-active-1.writer'), 'w+', 0o600);
    try {
      const held = spawnSync('/usr/bin/python3', ['-I', '-c',
        'import fcntl; fcntl.flock(3, fcntl.LOCK_SH | fcntl.LOCK_NB)'],
      {stdio: ['ignore', 'pipe', 'pipe', guard]});
      expect(held.status).toBe(0);
      const run = await reserve(`r-${'2'.repeat(32)}`, 'worker-active-1');
      await json(join(receipts, `${run}.running`), record(false));
      await expect(executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn})).rejects.toThrow(/refused/);
      expect(await fs.readFile(join(e.path, 'payload'), 'utf8')).toBe('cache');
    } finally { closeSync(guard); }
  }, 20_000);

  it('excludes reservation writers after live evidence until deletion finishes and then releases them', async () => {
    const e = await materialize(), result = plan([e]);
    let attempted = false;
    const guardPath = join(receipts, '.worker-active-128.writer');
    const attempt = () => {
      const fd = openSync(guardPath, 'r+');
      try {
        return spawnSync('/usr/bin/python3', ['-I', '-c',
          'import fcntl,os,sys; fcntl.flock(3, fcntl.LOCK_SH | fcntl.LOCK_NB); os.mkdir(sys.argv[1])',
          join(receipts, 'worker-active-128')], {stdio: ['ignore', 'pipe', 'pipe', fd]}).status;
      } finally { closeSync(fd); }
    };
    await executePrune(result, {root, receipts, apply: true, spawnProcess(command, args, options) {
      if (command === process.execPath) {
        attempted = true;
        expect(attempt()).not.toBe(0);
      }
      return leaseSpawn(command, args, options);
    }});
    expect(attempted).toBe(true);
    expect(await exists(e.path)).toBe(false);
    expect(await exists(join(receipts, 'worker-active-128'))).toBe(false);
    expect(attempt()).toBe(0);
  }, 20_000);

  it('refuses an unsafe writer guard without deleting cache', async () => {
    const e = await materialize();
    await fs.symlink(join(tmp, 'untrusted'), join(receipts, '.worker-active.writer'));
    await expect(executePrune(plan([e]), {root, receipts, apply: true, spawnProcess: leaseSpawn})).rejects.toThrow();
    expect(await fs.readFile(join(e.path, 'payload'), 'utf8')).toBe('cache');
  }, 20_000);

  it('dry-run deletes neither profiles nor their warm-input indexes', async () => {
    const e = await materialize(), marker = join(root, lock, '.warm-inputs-one');
    await json(marker, {profile: hex('b'), archiveDigest: hex('f')});
    await executePrune(plan([e]), {root, apply: false});
    expect(await fs.readFile(join(e.path, 'payload'), 'utf8')).toBe('cache');
    expect(await exists(marker)).toBe(true);
  }, 20_000);
  it('apply deletes only planned profiles and planned aged indexes', async () => {
    const old = await materialize(), young = await materialize('c', 2);
    const removed = await child('.warm-inputs-old', 20, 'file', JSON.stringify({profile: hex('b')}));
    const unplanned = await child('.warm-inputs-unplanned', 20, 'file', JSON.stringify({profile: hex('b')}));
    const retained = await child('.warm-inputs-retained', 2, 'file', JSON.stringify({profile: hex('c')}));
    const result = plan((await scanCache(root)).filter(e => e.name !== unplanned.name));
    expect(keys(result.prune)).toEqual(keys([old, removed]));
    const applied = await executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(keys(applied.deleted)).toEqual(keys([old, removed]));
    expect(await exists(old.path)).toBe(false); expect(await exists(removed.path)).toBe(false);
    expect(await exists(young.path)).toBe(true); expect(await exists(retained.path)).toBe(true);
    expect(await exists(unplanned.path)).toBe(true);
  }, 20_000);
  it('a 30-minute index protects its 30-hour profile and every index pointing at it', async () => {
    const old = await materialize('b', 30);
    const marker = await child('.warm-inputs-young', 0.5, 'file', JSON.stringify({profile: hex('b')}));
    const aged = await child('.warm-inputs-aged', 40, 'file', JSON.stringify({profile: hex('b')}));
    const result = plan(await scanCache(root));
    expectDecision(result, [], [old, marker, aged]);
    const applied = await executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(applied.deleted).toEqual([]);
    expect(await exists(old.path)).toBe(true);
    expect(await exists(marker.path)).toBe(true);
    expect(await exists(aged.path)).toBe(true);
  }, 20_000);
  it.each([2, 40])('removes a %ih index only after its 30-hour profile in the same apply', async age => {
    const old = await materialize('b', 30);
    const marker = await child('.warm-inputs-aged', age, 'file', JSON.stringify({profile: hex('b')}));
    const result = plan(await scanCache(root));
    expectDecision(result, [old, marker], []);
    const applied = await executePrune(result, {root, receipts, apply: true, spawnProcess(command, args, options) {
      if (command === process.execPath && JSON.parse(args.at(-1)).name === marker.name) {
        expect(() => openSync(old.path, 'r')).toThrow(/ENOENT/);
      }
      return leaseSpawn(command, args, options);
    }});
    expect(applied.deleted.map(e => e.name)).toEqual([old.name, marker.name]);
    expect(await exists(old.path)).toBe(false);
    expect(await exists(marker.path)).toBe(false);
  }, 20_000);
  it.each(['young', 'live', 'within-bounds', 'changed-after-scan'])
  ('keeps an old index while its profile is retained: %s', async retention => {
    const profile = await materialize('b', retention === 'young' ? 0.5 : retention === 'within-bounds' ? 2 : 30);
    const marker = await child('.warm-inputs-old', 40, 'file', JSON.stringify({profile: hex('b')}));
    const result = plan(await scanCache(root), retention === 'live'
      ? {live: {complete: true, profiles: new Set([key(profile)])}} : {});
    if (retention === 'changed-after-scan') {
      await fs.utimes(profile.path, (now - 29 * HOUR) / 1000, (now - 29 * HOUR) / 1000);
    } else expectDecision(result, [], [profile, marker]);
    const applied = await executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(applied.deleted).toEqual([]);
    expect(await exists(profile.path)).toBe(true);
    expect(await exists(marker.path)).toBe(true);
  }, 20_000);
  it('rechecks young indexes added after planning before deleting their profile', async () => {
    const old = await materialize('b', 30);
    const result = plan(await scanCache(root));
    const marker = await child('.warm-inputs-new', 0.5, 'file', JSON.stringify({profile: hex('b')}));
    const applied = await executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(applied.deleted).toEqual([]);
    expect(keys(applied.skipped)).toEqual(keys([old]));
    expect(await exists(old.path)).toBe(true);
    expect(await exists(marker.path)).toBe(true);
  }, 20_000);
  it('preserves a planned index whose mtime changed since scan even when still aged', async () => {
    const old = await materialize('b', 30);
    const marker = await child('.warm-inputs-changed', 20, 'file', JSON.stringify({profile: hex('b')}));
    const result = plan(await scanCache(root));
    expect(keys(result.prune)).toEqual(keys([old, marker]));
    await fs.utimes(marker.path, (now - 19 * HOUR) / 1000, (now - 19 * HOUR) / 1000);
    const applied = await executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(keys(applied.deleted)).toEqual(keys([old]));
    expect(keys(applied.skipped)).toEqual(keys([marker]));
    expect(await exists(old.path)).toBe(false);
    expect(await exists(marker.path)).toBe(true);
  }, 20_000);
  it('skips a profile whose mtime changed after scan and preserves its index', async () => {
    const e = await materialize(), result = plan([e]), marker = join(root, lock, '.warm-inputs-old');
    await json(marker, {profile: hex('b'), archiveDigest: hex('f')});
    await fs.utimes(e.path, now / 1000, now / 1000);
    await executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(await exists(e.path)).toBe(true); expect(await exists(marker)).toBe(true);
  }, 20_000);
  it('does not follow or delete a symlink swapped in after scan', async () => {
    const e = await materialize(), result = plan([e]), saved = join(tmp, 'saved');
    await fs.rename(e.path, saved); await fs.symlink(saved, e.path);
    await executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect((await fs.lstat(e.path)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(join(saved, 'payload'), 'utf8')).toBe('cache');
  }, 20_000);
  it('skips a regular file swapped in after scan', async () => {
    const e = await materialize(), result = plan([e]);
    await fs.rm(e.path, {recursive: true}); await fs.writeFile(e.path, 'replacement');
    await executePrune(result, {root, receipts, apply: true, spawnProcess: leaseSpawn});
    expect(await fs.readFile(e.path, 'utf8')).toBe('replacement');
  }, 20_000);
  it.each(['traversal', 'outside', 'depth', 'traversal-name', 'bad-lock', 'linked-lock'])
  ('refuses forged %s paths even in an explicitly supplied prune plan', async kind => {
    const e = await materialize(), outside = join(tmp, 'outside', lock, e.name);
    await fs.mkdir(outside, {recursive: true}); await fs.writeFile(join(outside, 'payload'), 'outside');
    let forged = {...e};
    if (kind === 'traversal') forged.path = `${root}/../outside/${lock}/${e.name}`;
    if (kind === 'outside') forged.path = outside;
    if (kind === 'depth') forged.path = join(root, lock, 'nested', e.name);
    if (kind === 'traversal-name') { forged.name = '../unexpected'; forged.path = join(root, lock, forged.name); }
    if (kind === 'bad-lock') { forged.lock = 'invalid'; forged.path = join(root, forged.lock, e.name); }
    if (['depth', 'traversal-name', 'bad-lock'].includes(kind)) await fs.mkdir(forged.path, {recursive: true});
    if (kind === 'linked-lock') {
      await fs.rename(join(root, lock), join(tmp, 'saved-lock'));
      await fs.symlink(join(tmp, 'saved-lock'), join(root, lock));
    }
    // Keep mtime valid so an unrelated stale-entry guard cannot mask a bad path check.
    await fs.utimes(forged.path, e.mtimeMs / 1000, e.mtimeMs / 1000);
    // Refusal may be returned as a skip or thrown; neither permits deletion.
    try { await executePrune({prune: [{...forged, reason: 'age'}], keep: []}, {root, receipts, apply: true, spawnProcess: leaseSpawn}); }
    catch (error) { expect(error).toBeInstanceOf(Error); }
    expect(await exists(forged.path)).toBe(true);
    expect(await fs.readFile(join(outside, 'payload'), 'utf8')).toBe('outside');
    expect(await fs.readFile(join(e.path, 'payload'), 'utf8')).toBe('cache');
  }, 20_000);
});

describe('CLI settings refusal', () => {
  it.each(settingFaults)('exits nonzero and preserves cache for $fault $variable', async fault => {
    const old = await materialize('b', 30);
    const marker = await child('.warm-inputs-old', 30, 'file', JSON.stringify({profile: hex('b')}));
    const env = {...process.env, ...validEnv};
    if (fault.fault === 'missing') delete env[fault.variable];
    else env[fault.variable] = 'garbage';
    const cli = spawnSync(process.execPath, [new URL('../forge-cache-prune.mjs', import.meta.url).pathname,
      `--root=${root}`, `--receipts=${receipts}`, '--apply', '--json'],
    {env, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024});
    expect(cli.error).toBeUndefined();
    expect(cli.signal).toBeNull();
    expect(await fs.readFile(join(old.path, 'payload'), 'utf8')).toBe('cache');
    expect(await exists(marker.path)).toBe(true);
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toContain(fault.variable);
  }, 20_000);
});

describe('live reservation compatibility', () => {
  it.each([false, true])('protects every matching profile version and its index with siblings=%s', async siblings => {
    const digest = siblings ? 'c' : 'b';
    const run = await reserve(); await json(join(receipts, `${run}.running`), record(siblings));
    const profiles = [3, 4, 5, 12].map(version => entry(digest, 30, 10, version));
    const index = await child('.warm-inputs-matching', 30, 'file', JSON.stringify({profile: hex(digest)}));
    const scanned = await scanCache(root);
    const unrelated = entry('f', 30);
    const live = await readLiveEvidence({receipts});
    expect(live.complete).toBe(true);
    expectDecision(plan([...profiles, ...scanned, unrelated], {live}), [unrelated], [...profiles, ...scanned]);
  });

  it.each(['legacy-wrapper', 'missing-manifest', 'missing-digest'])
  ('protects the whole lock for %s, counting its bytes under size pressure', async fault => {
    const run = await reserve();
    if (fault === 'legacy-wrapper') await json(join(receipts, 'worker-active', 'reservation.json'), {run});
    const active = record(false);
    if (fault === 'missing-manifest') delete active.manifest;
    if (fault === 'missing-digest') delete active.inputDigest;
    await json(join(receipts, `${run}.running`), active);
    const protectedEntries = [entry('b', 30, 100, 3), entry('c', 30, 100, 4),
      await child('.warm-inputs-unrelated', 30), await child('arbitrary', 30)];
    const other = {...entry('f', 3, 10), lock: hex('e')};
    other.path = join(root, other.lock, other.name);
    const live = await readLiveEvidence({receipts});
    expect(live.complete).toBe(true);
    expect(live.locks).toEqual(new Set([lock]));
    expectDecision(plan([...protectedEntries, other], {live, settings: settings({maxBytes: 100})}),
      [other], protectedEntries);
    expectDecision(plan([...protectedEntries, other], {live,
      disk: {usedPct: 90, usedBytes: 900, totalBytes: 1000}}), [other], protectedEntries);
  });

  it.each(['missing', 'invalid'])('refuses unknown %s lock with an operator repair message', async fault => {
    const run = await reserve();
    await json(join(receipts, 'worker-active', 'reservation.json'), {run});
    const active = record(false);
    if (fault === 'missing') delete active.lock;
    else active.lock = '../outside';
    await json(join(receipts, `${run}.running`), active);
    const live = await readLiveEvidence({receipts});
    expect(live.complete).toBe(false);
    expect(live.refused).toMatch(/preserving cache.*repair/);
    expect(plan([entry('b', 30)], {live}).prune).toEqual([]);
  });
});

describe('readLiveEvidence', () => {
  it('an empty readable receipts directory is complete with no protected profiles', async () => {
    expect(await readLiveEvidence({receipts})).toMatchObject({complete: true, profiles: new Set()});
  });
  it.each(['prepared', 'running', 'receipt'].flatMap(suffix => [false, true].map(siblings => [suffix, siblings])))
  ('reads %s records and selects the digest with manifest.siblings=%s', async (suffix, siblings) => {
    const run = await reserve(); await json(join(receipts, `${run}.${suffix}`), record(siblings));
    const result = await readLiveEvidence({receipts});
    expect(result.complete).toBe(true);
    expect(result.profiles).toEqual(new Set([`${lock}/dev-v5-${hex(siblings ? 'c' : 'b')}`]));
  });
  it('unions numbered and legacy reservations including warm runs, ignoring inactive records', async () => {
    const a = await reserve(), b = await reserve(`warm-${'2'.repeat(32)}`, 'worker-active-2');
    await json(join(receipts, `${a}.running`), record(false));
    await json(join(receipts, `${b}.prepared`), {...record(true), lock: hex('e')});
    await json(join(receipts, `r-${'3'.repeat(32)}.receipt`), {...record(false), lock: hex('f')});
    expect(await readLiveEvidence({receipts})).toMatchObject({complete: true,
      profiles: new Set([`${lock}/dev-v5-${hex('b')}`, `${hex('e')}/dev-v5-${hex('c')}`])});
  });
  it.each(['missing-record', 'malformed-record', 'unreadable-record', 'malformed-reservation',
    'unreadable-reservation', 'missing-reservation', 'invalid-run', 'invalid-digest'])
  ('fail closed on %s even when another active run has valid evidence', async fault => {
    const good = await reserve(); await json(join(receipts, `${good}.running`), record(false));
    const run = await reserve(`warm-${'2'.repeat(32)}`, 'worker-active-1');
    const reservation = join(receipts, 'worker-active-1', 'reservation.json'), file = join(receipts, `${run}.prepared`);
    if (fault === 'malformed-record') await fs.writeFile(file, '{');
    if (fault === 'unreadable-record') await fs.mkdir(file); // EISDIR, independent of uid/mode.
    if (fault === 'malformed-reservation') await fs.writeFile(reservation, '{');
    if (fault === 'unreadable-reservation') { await fs.unlink(reservation); await fs.mkdir(reservation); }
    if (fault === 'missing-reservation') await fs.unlink(reservation);
    if (fault === 'invalid-run') await json(reservation, {run: '../escape'});
    if (fault === 'invalid-digest') await json(file, {...record(false), inputDigest: 'bad'});
    expect((await readLiveEvidence({receipts})).complete).toBe(false);
  });
  it('fail closed when the receipts directory cannot be read', async () => {
    expect((await readLiveEvidence({receipts: join(tmp, 'missing')})).complete).toBe(false);
  });
});

describe('forge-setup.sh installs the cache-retention timer and service (replacing cron cache pruning)', () => {
  const sectionOf = (setup, name, tag) => {
    const match = setup.match(new RegExp(`cat > /etc/systemd/system/${name.replace('.', '\\.')} <<'${tag}'\\n([\\s\\S]*?)\\n${tag}\\n`));
    expect(match, `${name} heredoc present`).not.toBeNull();
    return match[1];
  };
  const unitLines = text => text.split('\n').filter(line => line && !line.startsWith('#'));
  let setup;
  beforeEach(async () => { setup = await fs.readFile(new URL('../forge-setup.sh', import.meta.url), 'utf8'); });

  it('service is a root oneshot running the fixed installed pruner with --apply at idle priority and explicit settings', () => {
    const service = unitLines(sectionOf(setup, 'forge-cache-prune.service', 'CACHE_SERVICE'));
    expect(service).toEqual([
      '[Unit]',
      'Description=Prune expired Forge dependency cache profiles',
      'After=local-fs.target',
      '[Service]',
      'Type=oneshot',
      'User=root',
      'Environment=FORGE_CACHE_MAX_AGE_HOURS=12',
      'Environment=FORGE_CACHE_MAX_BYTES=214748364800',
      'Environment=FORGE_CACHE_HIGH_WATER_PCT=80',
      'ExecStart=/usr/bin/env node /usr/local/libexec/forge-cache-prune.mjs --apply',
      'Nice=19',
      'IOSchedulingClass=idle',
    ]);
  });

  it('the Environment= values installed by setup are exactly accepted by the pruner settings resolver', () => {
    const service = sectionOf(setup, 'forge-cache-prune.service', 'CACHE_SERVICE');
    const env = Object.fromEntries([...service.matchAll(/^Environment=(\w+)=(.*)$/gm)].map(m => [m[1], m[2]]));
    expect(Object.keys(env).sort()).toEqual(Object.keys(validEnv).sort());
    vi.stubEnv('FORGE_CACHE_MAX_AGE_HOURS', env.FORGE_CACHE_MAX_AGE_HOURS);
    vi.stubEnv('FORGE_CACHE_MAX_BYTES', env.FORGE_CACHE_MAX_BYTES);
    vi.stubEnv('FORGE_CACHE_HIGH_WATER_PCT', env.FORGE_CACHE_HIGH_WATER_PCT);
    expect(() => resolveSettings()).not.toThrow();
  });

  it('timer fires 2min after boot then every 15min, is not persistent, and activates the service', () => {
    const timer = unitLines(sectionOf(setup, 'forge-cache-prune.timer', 'CACHE_TIMER'));
    expect(timer).toEqual([
      '[Unit]',
      'Description=Check Forge cache retention every 15 minutes',
      '[Timer]',
      'OnBootSec=2min',
      'OnUnitActiveSec=15min',
      'AccuracySec=1min',
      'Persistent=false',
      'Unit=forge-cache-prune.service',
      '[Install]',
      'WantedBy=timers.target',
    ]);
  });

  it('reloads systemd then enables the timer, and bundles the pruner into /usr/local/libexec', () => {
    const timerHeredoc = setup.indexOf("CACHE_TIMER\nsystemctl daemon-reload\nsystemctl enable --now forge-cache-prune.timer\n");
    expect(timerHeredoc).toBeGreaterThan(setup.indexOf("<<'CACHE_SERVICE'"));
    expect(setup).toContain('"forge-warm-base.mjs", "forge-exec-limits.mjs", "forge-cache-prune.mjs"}');
    expect(setup).toContain('for filename in ["forge-exec-run.mjs", "forge-warm-base.mjs", "forge-exec-limits.mjs", "forge-cache-prune.mjs"]:');
  });

  it('the cron job no longer owns cache retention', () => {
    const cron = setup.match(/<<'PRUNE'\n([\s\S]*?)\nPRUNE\n/)[1];
    expect(cron).not.toContain('/srv/forge-cache');
    expect(cron).not.toContain('1209600');
    expect(cron).not.toContain('forge-cache-prune');
  });
});
