import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allocateCardNumber, loadNumberAtBirthSettings } from '../card-number-allocator.mjs';
import { tryAcquireNumberingLock } from '../../readiness/drain-lock.mjs';

const roots = [];
const fixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'card-number-')); roots.push(cwd);
  mkdirSync(join(cwd, 'backlog'));
  return { id: 'x000001', cwd, statePath: join(cwd, 'state', 'reservations.json'), lockRoot: join(cwd, 'locks'),
    settings: { value: { enabled: 'on', remote: 'best-effort' }, source: 'settings file' }, log: () => {} };
};
const offline = () => { throw new Error('offline'); };
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

describe('atomic birth numbering', () => {
  for (const count of [2, 8]) it(`${count} parallel processes get distinct reservations`, async () => {
    const opts = fixture();
    const url = pathToFileURL(resolve('scripts/lib/card-number-allocator.mjs')).href;
    const code = `import { allocateCardNumber } from ${JSON.stringify(url)};
      console.log(JSON.stringify(allocateCardNumber({...JSON.parse(process.argv[1]),
        git: () => { throw Error('offline'); }, log: () => {}})));`;
    const results = await Promise.all(Array.from({ length: count }, (_, i) => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', code, JSON.stringify({ ...opts, id: `x${String(i).padStart(6, '0')}` })])));
    const allocations = results.map((r) => JSON.parse(r.stdout));
    expect(allocations.every((r) => r.ok)).toBe(true);
    expect(new Set(allocations.map((r) => r.num)).size).toBe(count);
    const ids = JSON.parse(readFileSync(opts.statePath)).ids;
    expect(Object.keys(ids)).toHaveLength(count);
    expect(new Set(Object.values(ids)).size).toBe(count);
  });

  it('skips local, main, host and remote reservations, persisting before return', () => {
    const opts = fixture();
    writeFileSync(join(opts.cwd, 'backlog/012-local.md'), '');
    mkdirSync(join(opts.cwd, 'state'));
    writeFileSync(opts.statePath, JSON.stringify([{ num: 35, timestamp: new Date().toISOString() }]));
    const git = (args) => args[0] === 'ls-tree' ? 'backlog/030-main.md\n'
      : args[0] === 'ls-remote' ? 'abc\trefs/number-reservations/040\n'
      : args[0] === 'hash-object' ? 'abc' : '';
    expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: true, num: '041' });
    expect(JSON.parse(readFileSync(opts.statePath, 'utf8')).reservations.some((r) => r.num === 41)).toBe(true);
  });

  it('fails closed on a held lock or unusable state directory', () => {
    const opts = fixture();
    tryAcquireNumberingLock(opts.lockRoot, 'test-holder');
    expect(allocateCardNumber({ ...opts, git: offline, waitMs: 0 })).toMatchObject({ ok: false });
    const other = fixture();
    writeFileSync(join(other.cwd, 'state'), 'a file cannot be a directory');
    expect(allocateCardNumber({ ...other, git: offline })).toMatchObject({ ok: false });
  });

  it('required remote fails closed; best-effort logs its host-only reservation', () => {
    const opts = fixture(); const logs = [];
    expect(allocateCardNumber({ ...opts, settings: { value: { enabled: 'on', remote: 'required' }, source: 'default' }, git: offline })).toMatchObject({ ok: false });
    expect(allocateCardNumber({ ...opts, git: offline, log: (s) => logs.push(s) }).ok).toBe(true);
    expect(logs.join('\n')).toContain('host-only');
    expect(logs.join('\n')).toContain('settings file');
  });

  it('off avoids allocation, and settings retain their source', () => {
    expect(loadNumberAtBirthSettings({ file: {}, env: {} }).source).toBe('default');
    expect(loadNumberAtBirthSettings({ file: { backlog: { cardNumbering: { atBirth: 'on' } } }, env: {} }).source).toBe('settings file');
    const settings = loadNumberAtBirthSettings({ file: {}, env: { WE_NUMBER_AT_BIRTH: 'off' } });
    expect(settings).toMatchObject({ value: { enabled: 'off' }, source: 'env WE_NUMBER_AT_BIRTH' });
    const logs = [];
    expect(allocateCardNumber({ ...fixture(), settings, log: (s) => logs.push(s), git: () => { throw Error('must not run'); } })).toMatchObject({ ok: false });
    expect(logs.join('')).toContain('env WE_NUMBER_AT_BIRTH');
  });
});

it('declares settings through the registry without duplicate ownership', async () => {
  const { readDeclaredSettings } = await import('../settings-files.mjs');
  const settings = readDeclaredSettings();
  expect(settings.errors).toEqual([]);
  expect(settings.duplicates).toEqual([]);
  expect(settings.owners['backlog.cardNumbering.atBirth']).toBe('settings/number-at-birth.json');
});

it('prunes old and landed entries while retaining a monotonic high-water mark', () => {
  const opts = fixture(); mkdirSync(join(opts.cwd, 'state'));
  writeFileSync(opts.statePath, JSON.stringify({ highest: 90, reservations: [
    { num: 90, timestamp: '2000-01-01T00:00:00Z' },
    { num: 20, timestamp: new Date().toISOString() },
  ] }));
  const git = (args) => { if (args[0] === 'ls-tree') return 'backlog/020-landed.md'; throw Error('offline'); };
  expect(allocateCardNumber({ ...opts, git }).num).toBe('091');
  expect(JSON.parse(readFileSync(opts.statePath, 'utf8')).reservations.map((e) => e.num)).toEqual([91]);
  expect(allocateCardNumber({ ...opts, id: 'x000002', git }).num).toBe('092');
});

it('retries confirmed remote clashes and fails closed on required push outage', () => {
  const opts = fixture(); let pushed = 0;
  const git = (args) => {
    if (args[0] === 'ls-tree') return '';
    if (args[0] === 'ls-remote') return pushed ? 'abc\trefs/number-reservations/001' : '';
    if (args[0] === 'hash-object') return 'abc';
    if (args[0] === 'push' && pushed++ === 0) throw Error('already exists');
    return '';
  };
  expect(allocateCardNumber({ ...opts, git }).num).toBe('002');
  const required = { value: { enabled: 'on', remote: 'required' }, source: 'settings file' };
  const outage = (args) => { if (args[0] === 'push') throw Error('permission denied'); return ''; };
  expect(allocateCardNumber({ ...fixture(), settings: required, git: outage })).toMatchObject({ ok: false });
});

it('two hosts sharing a real bare origin cannot replace each other’s blob reservations', async () => {
  const { execFileSync } = await import('node:child_process');
  const opts = fixture(); const origin = join(opts.cwd, 'origin.git');
  const run = (cwd, args, extra = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...extra });
  run(opts.cwd, ['init', '--bare', origin]);
  const host = (name) => {
    const cwd = join(opts.cwd, name); mkdirSync(cwd); mkdirSync(join(cwd, 'backlog'));
    run(cwd, ['init', '-q']); run(cwd, ['remote', 'add', 'origin', origin]);
    return { ...opts, id: name === 'host-a' ? 'x000001' : 'x000002', cwd, statePath: join(cwd, 'state.json'), lockRoot: join(cwd, 'locks'),
      settings: { value: { enabled: 'on', remote: 'required' }, source: 'settings file' },
      git: (args, extra) => run(cwd, args, extra) };
  };
  const a = host('host-a'); const b = host('host-b');
  expect(allocateCardNumber(a)).toMatchObject({ ok: true, num: '001' });
  const claim = run(a.cwd, ['ls-remote', 'origin', 'refs/number-reservations/001']);
  // Hide the first claim from B's initial read to force the real create-only rejection.
  let reads = 0; const realGit = b.git;
  b.git = (args, extra) => args[0] === 'ls-remote' && args[2] === 'refs/number-reservations/*' && reads++ === 0 ? '' : realGit(args, extra);
  expect(allocateCardNumber(b)).toMatchObject({ ok: true, num: '002' });
  expect(run(a.cwd, ['ls-remote', 'origin', 'refs/number-reservations/001'])).toBe(claim);
  rmSync(a.statePath);
  expect(allocateCardNumber(a)).toMatchObject({ ok: true, num: '001', replayed: true });
});

it.each(['local', 'main', 'host', 'remote'])('never reissues the highest number from %s', (plane) => {
  const opts = fixture();
  if (plane === 'local') writeFileSync(join(opts.cwd, 'backlog/075-local.md'), '');
  if (plane === 'host') {
    mkdirSync(join(opts.cwd, 'state'));
    writeFileSync(opts.statePath, JSON.stringify([{ num: 75, timestamp: new Date().toISOString() }]));
  }
  const git = (args) => args[0] === 'ls-tree' && plane === 'main' ? 'backlog/075-main.md'
    : args[0] === 'ls-remote' && plane === 'remote' ? 'abc\trefs/number-reservations/075'
    : args[0] === 'hash-object' ? 'abc' : '';
  expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: true, num: '076' });
});

// A remote with immutable blob refs, including reads after a create-only rejection.
const fakeRemote = () => {
  const refs = new Map(); const blobs = new Map(); let serial = 0;
  const git = (args, options) => {
    if (args[0] === 'hash-object') { const oid = `blob${++serial}`; blobs.set(oid, options.input); return oid; }
    if (args[0] === 'push') {
      const [oid, ref] = args[2].split(':');
      if (refs.has(ref)) throw Error('already exists');
      refs.set(ref, oid); return '';
    }
    if (args[0] === 'ls-remote') return [...refs].filter(([ref]) => args[2].endsWith('*')
      ? ref.startsWith(args[2].slice(0, -1)) : ref === args[2]).map(([ref, oid]) => `${oid}\t${ref}`).join('\n');
    if (args[0] === 'cat-file') return blobs.get(args.at(-1));
    return '';
  };
  return { git, refs, blobs };
};

for (const mode of ['required', 'best-effort']) it(`never rebinds an offline claim after a remote clash (${mode})`, () => {
  const a = { ...fixture(), id: 'xaaaaaa' }; const b = { ...fixture(), id: 'xbbbbbb' };
  const remote = fakeRemote();
  expect(allocateCardNumber({ ...a, git: offline })).toMatchObject({ ok: true, num: '001' });
  expect(allocateCardNumber({ ...b, git: remote.git })).toMatchObject({ ok: true, num: '001' });
  const originalClaim = remote.refs.get('refs/number-reservations/001');
  const saved = readFileSync(a.statePath, 'utf8');
  const result = allocateCardNumber({ ...a, git: remote.git,
    settings: { value: { enabled: 'on', remote: mode }, source: 'test' } });
  expect(result).toMatchObject({ ok: false, reason: expect.any(String) });
  expect(result.num).toBeUndefined();
  expect(JSON.parse(readFileSync(a.statePath)).ids).toEqual(JSON.parse(saved).ids);
  expect(allocateCardNumber({ ...a, git: offline })).toMatchObject({ ok: false });
  expect(JSON.parse(saved).ids[a.id]).toBe('001');
  expect(remote.refs.get('refs/number-reservations/001')).toBe(originalClaim);
  expect(remote.refs.has(`refs/card-ids/${a.id}`)).toBe(false);
});

for (const mode of ['required', 'best-effort']) describe(`verified replay (${mode})`, () => {
  const setup = () => {
    const opts = { ...fixture(), settings: { value: { enabled: 'on', remote: mode }, source: 'test' } };
    const remote = fakeRemote();
    expect(allocateCardNumber({ ...opts, git: remote.git })).toMatchObject({ ok: true, num: '001' });
    return { opts, remote };
  };
  it.each(['local', 'main'])('rejects a number used by a %s card, with or without host state', (plane) => {
    const { opts, remote } = setup();
    if (plane === 'local') writeFileSync(join(opts.cwd, 'backlog/001-card.md'), '');
    const git = (args, extra) => args[0] === 'ls-tree' && plane === 'main'
      ? 'backlog/001-card.md' : remote.git(args, extra);
    expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: false });
    rmSync(opts.statePath);
    expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: false });
  });
  it('rejects unverified replay during an outage', () => {
    const { opts } = setup();
    expect(allocateCardNumber({ ...opts, git: offline })).toMatchObject({ ok: false });
  });
  it.each(['foreign owner', 'foreign id', 'malformed id record', 'host owner conflict', 'uncreatable reservation'])('rejects %s without changing the binding', (fault) => {
    const { opts, remote } = setup();
    const ref = 'refs/number-reservations/001';
    const row = JSON.parse(remote.blobs.get(remote.refs.get(ref)));
    if (fault === 'foreign owner') row.owner = 'another-owner';
    if (fault === 'foreign id') row.id = 'xbbbbbb';
    remote.blobs.set(remote.refs.get(ref), JSON.stringify(row));
    const idRef = `refs/card-ids/${opts.id}`;
    if (fault === 'malformed id record') remote.blobs.set(remote.refs.get(idRef), 'null');
    if (fault === 'host owner conflict') {
      const record = JSON.parse(remote.blobs.get(remote.refs.get(idRef)));
      record.by = 'another-owner';
      remote.blobs.set(remote.refs.get(idRef), JSON.stringify(record));
    }
    if (fault === 'uncreatable reservation') remote.refs.delete(ref);
    const saved = readFileSync(opts.statePath, 'utf8');
    const git = (args, extra) => {
      if (fault === 'uncreatable reservation' && args[0] === 'push') throw Error('denied');
      return remote.git(args, extra);
    };
    expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: false, reason: expect.any(String) });
    expect(readFileSync(opts.statePath, 'utf8')).toBe(saved);
  });
  it('returns the same number after verifying a happy replay', () => {
    const { opts, remote } = setup();
    expect(allocateCardNumber({ ...opts, git: remote.git })).toMatchObject({ ok: true, num: '001', replayed: true });
  });
});

it('can replay an explicitly host-only binding while still offline in best-effort mode', () => {
  const opts = fixture();
  expect(allocateCardNumber({ ...opts, git: offline })).toMatchObject({ ok: true, num: '001' });
  expect(allocateCardNumber({ ...opts, git: offline })).toMatchObject({ ok: true, num: '001', replayed: true });
});

it('requires remote verification after a host-only binding has been published', () => {
  const opts = fixture(); const remote = fakeRemote();
  expect(allocateCardNumber({ ...opts, git: offline })).toMatchObject({ ok: true, num: '001' });
  expect(allocateCardNumber({ ...opts, git: remote.git })).toMatchObject({ ok: true, num: '001', replayed: true });
  expect(allocateCardNumber({ ...opts, git: offline })).toMatchObject({ ok: false });
});

it('recreates a missing remote reservation before publishing an offline host id', () => {
  const opts = fixture(); const remote = fakeRemote(); const calls = [];
  expect(allocateCardNumber({ ...opts, git: offline })).toMatchObject({ num: '001' });
  const git = (args, extra) => { calls.push(args); return remote.git(args, extra); };
  expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: true, num: '001', replayed: true });
  const claim = JSON.parse(remote.blobs.get(remote.refs.get('refs/number-reservations/001')));
  const saved = JSON.parse(readFileSync(opts.statePath));
  expect(claim).toMatchObject({ num: '001', owner: saved.reservations.find((r) => Number(r.num) === 1).owner });
  expect(Number.isFinite(Date.parse(claim.timestamp))).toBe(true);
  expect(JSON.parse(remote.blobs.get(remote.refs.get(`refs/card-ids/${opts.id}`))))
    .toMatchObject({ id: opts.id, num: '001' });
  expect(calls.filter(([command]) => command === 'push').map((args) => args[2].split(':')[1]))
    .toEqual(['refs/number-reservations/001', `refs/card-ids/${opts.id}`]);
});

it('fetches and verifies its recorded owner before publishing a missing id record', () => {
  const opts = fixture(); const remote = fakeRemote(); const calls = [];
  expect(allocateCardNumber({ ...opts, git: remote.git })).toMatchObject({ num: '001' });
  remote.refs.delete(`refs/card-ids/${opts.id}`);
  const git = (args, extra) => { calls.push(args); return remote.git(args, extra); };
  expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: true, num: '001', replayed: true });
  expect(calls).toContainEqual(['fetch', 'origin', 'refs/number-reservations/001']);
  expect(calls).toContainEqual(['cat-file', 'blob', remote.refs.get('refs/number-reservations/001')]);
  expect(calls.filter(([command]) => command === 'push').map((args) => args[2].split(':')[1]))
    .toEqual([`refs/card-ids/${opts.id}`]);
});

it('requires a valid birth id and defaults to required remote', () => {
  const opts = fixture();
  for (const id of [undefined, '001', 'xABCDEF', 'xshort'])
    expect(allocateCardNumber({ ...opts, id, git: offline })).toMatchObject({ ok: false });
  const settings = loadNumberAtBirthSettings({ file: {}, env: {} });
  expect(settings).toEqual({ value: { enabled: 'on', remote: 'required' }, source: 'default' });
  expect(allocateCardNumber({ ...opts, settings, git: offline })).toMatchObject({ ok: false });
});

it('replays host and remote birth records, including after host state loss', () => {
  const opts = fixture(); const remote = fakeRemote(); const logs = [];
  const first = allocateCardNumber({ ...opts, git: remote.git, log: (s) => logs.push(s) });
  expect(first).toMatchObject({ ok: true, num: '001' });
  expect(allocateCardNumber({ ...opts, git: remote.git })).toMatchObject({ num: '001', replayed: true });
  expect(allocateCardNumber({ ...opts, id: 'x000002', git: remote.git })).toMatchObject({ num: '002' });
  const row = JSON.parse(remote.blobs.get(remote.refs.get('refs/card-ids/x000001')));
  expect(Object.keys(row).sort()).toEqual(['at', 'by', 'id', 'num', 'source']);
  expect(row).toMatchObject({ id: opts.id, num: '001', source: 'birth' });
  expect(Date.parse(row.at)).toBeGreaterThan(0);
  expect(row.by).toBeTruthy();
  rmSync(opts.statePath);
  expect(allocateCardNumber({ ...opts, git: remote.git })).toMatchObject({ ok: true, num: '001', replayed: true });
  expect(JSON.parse(readFileSync(opts.statePath)).ids[opts.id]).toBe('001');
  expect(logs.join('\n')).toContain('backlog.cardNumbering.atBirth');
});

it('includes retained id mappings in the high-water mark and rejects corrupt state', () => {
  const opts = fixture(); mkdirSync(join(opts.cwd, 'state'));
  writeFileSync(opts.statePath, JSON.stringify({ highest: 0, reservations: [], ids: { x000002: '041' } }));
  expect(allocateCardNumber({ ...opts, git: offline })).toMatchObject({ num: '042' });
  writeFileSync(opts.statePath, JSON.stringify({ highest: 0, reservations: [], ids: { x000002: 'bad' } }));
  expect(allocateCardNumber({ ...opts, git: offline })).toMatchObject({ ok: false });
});

it('burns a reserved gap when another host wins the same id and replays its number', () => {
  const opts = fixture(); const remote = fakeRemote(); const logs = [];
  const row = { id: opts.id, num: '041', by: 'other-host', at: new Date().toISOString(), source: 'birth' };
  const git = (args, extra) => {
    if (args[0] === 'push' && args[2].endsWith(`:refs/card-ids/${opts.id}`)) {
      remote.blobs.set('winner', JSON.stringify(row)); remote.refs.set(`refs/card-ids/${opts.id}`, 'winner');
    }
    return remote.git(args, extra);
  };
  expect(allocateCardNumber({ ...opts, git, log: (s) => logs.push(s) })).toMatchObject({ ok: true, num: '041', replayed: true });
  expect(logs.join('\n')).toMatch(/burned.*001/);
  expect(remote.refs.has('refs/number-reservations/001')).toBe(true);
  expect(JSON.parse(readFileSync(opts.statePath)).ids[opts.id]).toBe('041');
  expect(JSON.parse(readFileSync(opts.statePath)).reservations.map((r) => r.num)).toContain(1);
});

it('fails closed if the id record push has an outage in required mode', () => {
  const opts = fixture(); const remote = fakeRemote();
  const git = (args, extra) => {
    if (args[0] === 'push' && args[2].includes(':refs/card-ids/')) throw Error('outage');
    return remote.git(args, extra);
  };
  expect(allocateCardNumber({ ...opts, settings: loadNumberAtBirthSettings({ file: {}, env: {} }), git })).toMatchObject({ ok: false });
  expect(remote.refs.has('refs/number-reservations/001')).toBe(true);
});

it.each(['required', 'best-effort'])('refuses remote mappings that conflict with either host id or host number (%s)', (mode) => {
  for (const ids of [{ x000001: '002' }, { x000002: '001' }]) {
    const opts = { ...fixture(), settings: { value: { enabled: 'on', remote: mode }, source: 'test' } }; const remote = fakeRemote();
    expect(allocateCardNumber({ ...opts, git: remote.git })).toMatchObject({ num: '001' });
    writeFileSync(opts.statePath, JSON.stringify({ highest: 2, reservations: [], ids }));
    expect(allocateCardNumber({ ...opts, git: remote.git })).toMatchObject({ ok: false });
    expect(JSON.parse(readFileSync(opts.statePath)).ids).toEqual(ids);
  }
});

it('file settings and env overrides retain the remote setting and their sources', () => {
  const file = { backlog: { cardNumbering: { atBirth: 'off', atBirthRemote: 'best-effort' } } };
  expect(loadNumberAtBirthSettings({ file, env: {} })).toEqual({
    value: { enabled: 'off', remote: 'best-effort' }, source: 'settings file',
  });
  expect(loadNumberAtBirthSettings({ file, env: { WE_NUMBER_AT_BIRTH: 'on' } })).toEqual({
    value: { enabled: 'on', remote: 'best-effort' }, source: 'env WE_NUMBER_AT_BIRTH',
  });
});
