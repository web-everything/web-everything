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
  return { cwd, statePath: join(cwd, 'state', 'reservations.json'), lockRoot: join(cwd, 'locks'),
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
    const results = await Promise.all(Array.from({ length: count }, () => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', code, JSON.stringify(opts)])));
    const allocations = results.map((r) => JSON.parse(r.stdout));
    expect(allocations.every((r) => r.ok)).toBe(true);
    expect(new Set(allocations.map((r) => r.num)).size).toBe(count);
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
    expect(loadNumberAtBirthSettings({ file: { numberAtBirth: { enabled: 'on' } }, env: {} }).source).toBe('settings file');
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
  expect(settings.owners['numberAtBirth.enabled']).toBe('settings/number-at-birth.json');
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
  expect(allocateCardNumber({ ...opts, git }).num).toBe('092');
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
    return { ...opts, cwd, statePath: join(cwd, 'state.json'), lockRoot: join(cwd, 'locks'),
      settings: { value: { enabled: 'on', remote: 'required' }, source: 'settings file' },
      git: (args, extra) => run(cwd, args, extra) };
  };
  const a = host('host-a'); const b = host('host-b');
  expect(allocateCardNumber(a)).toMatchObject({ ok: true, num: '001' });
  const claim = run(a.cwd, ['ls-remote', 'origin', 'refs/number-reservations/001']);
  // Hide the first claim from B's initial read to force the real create-only rejection.
  let reads = 0; const realGit = b.git;
  b.git = (args, extra) => args[0] === 'ls-remote' && reads++ === 0 ? '' : realGit(args, extra);
  expect(allocateCardNumber(b)).toMatchObject({ ok: true, num: '002' });
  expect(run(a.cwd, ['ls-remote', 'origin', 'refs/number-reservations/001'])).toBe(claim);
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
