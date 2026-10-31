import { it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, delimiter, resolve } from 'node:path';
import { tryAcquireNumberingLock, releaseNumberingLockIfOwned } from '../../readiness/drain-lock.mjs';
import { handNumberedNewItems } from '../../check-standards-rules.mjs';

const collisionRoots = [];
afterEach(() => collisionRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function collisionCli(kind, { reservedSource = false, rejectPush = false, offline = false, noop = false, lastNumber = false, exhausted = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'collision-cli-')));
  collisionRoots.push(root);
  cpSync('scripts', join(root, 'scripts'), { recursive: true, filter: (p) => basename(p) !== '__tests__' });
  cpSync('skills-src/conveyor/daemon-manifest.mjs', join(root, 'skills-src/conveyor/daemon-manifest.mjs'));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  mkdirSync(join(root, 'backlog'));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'bin'));
  const original = { '074-incoming.md': '---\nkind: task\ntitle: Legacy incoming\n---\nAuthored body\n' };
  if (kind === 'renumber' && !noop) original['074-existing.md'] = '---\n---\nKeeper body\n';
  if (lastNumber) original['99999-last.md'] = '---\n---\nLast supported number\n';
  for (const [name, text] of Object.entries(original)) writeFileSync(join(root, 'backlog', name), text);
  const stateFile = join(root, 'remote.json');
  // 076 is an untraced gap: it may be a legacy card deleted before reservation refs existed.
  const refs = Object.fromEntries(['075', '077', '079']
    .map((num) => ['refs/number-reservations/' + num, 'a'.repeat(40)]));
  if (reservedSource) refs['refs/number-reservations/074'] = 'a'.repeat(40);
  if (exhausted) refs['refs/number-reservations/99999'] = 'a'.repeat(40);
  writeFileSync(stateFile, JSON.stringify({ refs, calls: [], pushes: [], blobs: {} }));
  // Observe the real CLI's filesystem at the transport boundary, before accepting a claim.
  // Unknown commands fail; this fixture never delegates to live Git or touches .git.
  writeFileSync(join(root, 'bin/git'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2), file = process.env.COLLISION_REMOTE_FILE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
state.calls.push(args); save();
switch (args[0]) {
  case 'ls-files': break;
  case 'remote': process.stdout.write('origin\\n'); break;
  case 'fetch': if (process.env.COLLISION_OFFLINE === '1') process.exit(1); break;
  case 'update-ref': break;
  case 'ls-tree':
    process.stdout.write(args.includes('published-fixture') ? 'backlog/074-incoming.md\\0backlog/074-existing.md\\0'
      : args.includes('keeper-fixture') ? 'backlog/074-existing.md\\0'
      : 'backlog/078-canonical.md\\0'); break;
  case 'ls-remote': process.stdout.write(Object.entries(state.refs).map(([ref, oid]) => oid + '\\t' + ref + '\\n').join('')); break;
  case 'hash-object': {
    const raw = fs.readFileSync(0, 'utf8'), oid = crypto.createHash('sha1').update(raw).digest('hex');
    state.blobs[oid] = raw; process.stdout.write(oid + '\\n'); break;
  }
  case 'push': {
    const dir = path.join(process.cwd(), 'backlog');
    const files = Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
    state.pushes.push({ args, files }); save();
    if (process.env.COLLISION_REJECT_PUSH === '1') process.exit(1);
    const claims = args.slice(args.indexOf('origin') + 1).map(s => s.split(':'));
    if (claims.some(([, ref]) => state.refs[ref])) process.exit(1);
    claims.forEach(([oid, ref]) => state.refs[ref] = oid); break;
  }
  default: process.stderr.write('unexpected Git command: ' + args.join(' ')); process.exit(1);
}
save();
`, { mode: 0o755 });
  return {
    original, refs,
    files: () => Object.fromEntries(readdirSync(join(root, 'backlog')).map(name => [name, readFileSync(join(root, 'backlog', name), 'utf8')])),
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    run: (extra = []) => JSON.parse(execFileSync(process.execPath,
      kind === 'yield' ? [join(root, 'scripts/backlog.mjs'), 'yield', '074-incoming', '--force', '--json', ...extra]
        : [join(root, 'scripts/backlog-renumber-collisions.mjs'), '--no-git', '--json', ...extra],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
        env: { ...process.env, HOME: join(root, 'home'), PATH: join(root, 'bin') + delimiter + process.env.PATH,
          COLLISION_REMOTE_FILE: stateFile, COLLISION_REJECT_PUSH: rejectPush ? '1' : '0',
          COLLISION_OFFLINE: offline ? '1' : '0' } })),
  };
}

it.each([false, true])('renumber CLI no-op makes no remote call (offline=%s)', (offline) => {
  const cli = collisionCli('renumber', { noop: true, offline });
  expect(cli.run()).toEqual({ renumbered: [], writes: 0, deletes: 0, noop: true });
  expect(cli.state().calls.filter(([command]) => ['remote', 'fetch', 'ls-remote', 'push'].includes(command))).toEqual([]);
  expect(cli.files()).toEqual(cli.original);
});

it.each([
  ['base-owned', ['--base-nums=074']],
  ['entirely published', ['--onto-ref=published-fixture']],
  ['base-owned and published', ['--base-nums=074', '--onto-ref=published-fixture']],
])('renumber CLI skips remote calls for %s duplicate groups', (_kind, flags) => {
  const cli = collisionCli('renumber', { offline: true });
  expect(cli.run(flags)).toEqual({ renumbered: [], writes: 0, deletes: 0, noop: true });
  expect(cli.state().calls.filter(([command]) => ['remote', 'fetch', 'ls-remote', 'push'].includes(command))).toEqual([]);
  expect(cli.files()).toEqual(cli.original);
});

it('renumber CLI still checks remote constraints for an incoming collision with a published base keeper', () => {
  const cli = collisionCli('renumber', { offline: true });
  expect(() => cli.run(['--base-nums=074', '--onto-ref=keeper-fixture'])).toThrow(/high-water mark unavailable/);
  expect(cli.state().calls.some(([command]) => command === 'fetch')).toBe(true);
  expect(cli.files()).toEqual(cli.original);
});

it.each(['yield', 'renumber'])('%s CLI takes a fresh number above the frontier, never an untraced gap, and claims before writing', (kind) => {
  const cli = collisionCli(kind);
  const result = cli.run();
  if (kind === 'yield') expect(result).toMatchObject({ num: '080', to: '080-incoming' });
  else expect(result.renumbered).toEqual([expect.objectContaining({ oldName: '074-incoming.md', newNum: '080', newName: '080-incoming.md' })]);
  const state = cli.state();
  expect(state.pushes).toHaveLength(1);
  expect(state.pushes[0].files).toEqual(cli.original);
  expect(state.pushes[0].args).toEqual(['push', '--atomic', '--force-with-lease=refs/number-reservations/080:',
    'origin', expect.stringMatching(/^[a-f0-9]{40}:refs\/number-reservations\/080$/)]);
  expect(state.refs).toEqual({ ...cli.refs, 'refs/number-reservations/080': expect.stringMatching(/^[a-f0-9]{40}$/) });
  expect(state.refs['refs/number-reservations/076']).toBeUndefined();
  const { '074-incoming.md': incoming, ...keepers } = cli.original;
  expect(cli.files()).toEqual({ ...keepers, '080-incoming.md': incoming });
});

it.each(['yield', 'renumber'])('%s CLI does not let an unreserved local 99999 card raise the shared frontier', (kind) => {
  const cli = collisionCli(kind, { lastNumber: true });
  const result = cli.run();
  const nums = kind === 'yield' ? [result.num] : result.renumbered.map((move) => move.newNum);
  expect(nums).toEqual(['080']);
  expect(Object.keys(cli.state().refs)).not.toContain('refs/number-reservations/99999');
});

it.each(['yield', 'renumber'])('%s CLI refuses a reserved source without bornAs before any claim or rewrite', (kind) => {
  const cli = collisionCli(kind, { reservedSource: true });
  expect(() => cli.run()).toThrow(/immutable birth number/);
  expect(cli.files()).toEqual(cli.original);
  expect(cli.state()).toMatchObject({ refs: cli.refs, pushes: [], blobs: {} });
});

it.each(['yield', 'renumber'])('%s CLI leaves every file unchanged when the target claim loses a race', (kind) => {
  const cli = collisionCli(kind, { rejectPush: true });
  expect(() => cli.run()).toThrow();
  expect(cli.state().pushes).toHaveLength(1);
  expect(cli.state().pushes[0].files).toEqual(cli.original);
  expect(cli.state().refs).toEqual(cli.refs);
  expect(cli.files()).toEqual(cli.original);
});

it.each(['yield', 'renumber'])('%s CLI refuses unavailable remote evidence before any claim or rewrite', (kind) => {
  const cli = collisionCli(kind, { offline: true });
  expect(() => cli.run()).toThrow(/high-water mark unavailable/);
  expect(cli.files()).toEqual(cli.original);
  expect(cli.state()).toMatchObject({ refs: cli.refs, pushes: [], blobs: {} });
});

it.each(['yield', 'renumber'])('%s CLI refuses an exhausted number range before any claim or rewrite', (kind) => {
  const cli = collisionCli(kind, { exhausted: true });
  expect(() => cli.run()).toThrow(/exhausted/);
  expect(cli.files()).toEqual(cli.original);
  expect(cli.state()).toMatchObject({ refs: cli.refs, pushes: [], blobs: {} });
});

it('renumber CLI dry-run plans the fresh target without claiming or rewriting', () => {
  const cli = collisionCli('renumber');
  expect(cli.run(['--dry-run'])).toMatchObject({ dryRun: true, renumbered: [expect.objectContaining({ newNum: '080' })] });
  expect(cli.files()).toEqual(cli.original);
  expect(cli.state()).toMatchObject({ refs: cli.refs, pushes: [], blobs: {} });
});

it('legacy scaffold retains numeric allocation and refusals; file-item births hashes without remote allocation', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'birth-cli-')));
  try {
    cpSync('scripts', join(root, 'scripts'), { recursive: true, filter: (p) => basename(p) !== '__tests__' });
    for (const dir of ['skills-src', 'schemas', 'src']) symlinkSync(resolve(dir), join(root, dir), 'dir');
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(root, 'backlog'));
    const home = join(root, 'home'); mkdirSync(home);
    const bin = join(root, 'bin'); mkdirSync(bin);
    // Hermetic Git transport: no live fetch/push, including when production defaults change.
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs'), crypto = require('node:crypto');
const args = process.argv.slice(2), file = process.env.BIRTH_REMOTE_FILE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { refs: {}, blobs: {} };
if (process.env.BIRTH_REMOTE_DOWN === '1') process.exit(1);
if (process.env.BIRTH_MAIN_DOWN === '1' && ['fetch', 'ls-tree'].includes(args[0])) process.exit(1);
switch(args[0]) {
  case 'ls-remote': process.stdout.write(Object.entries(state.refs).map(([ref, oid]) => oid + '\\t' + ref + '\\n').join('')); break;
  case 'hash-object': {
    const raw = fs.readFileSync(0, 'utf8'), oid = crypto.createHash('sha1').update(raw).digest('hex');
    state.blobs[oid] = raw; process.stdout.write(oid + '\\n'); break;
  }
  case 'push': {
    const claims = args.slice(args.indexOf('origin') + 1).map(s => s.split(':'));
    if (claims.some(([, ref]) => state.refs[ref])) process.exit(1);
    claims.forEach(([oid, ref]) => state.refs[ref] = oid); break;
  }
  case 'cat-file': process.stdout.write(state.blobs[args[2]]); break;
  case 'fetch': case 'ls-tree': case 'update-ref': break;
  default: process.exit(1);
}
fs.writeFileSync(file, JSON.stringify(state));
`, { mode: 0o755 });
    const run = (env = {}, operation = 'scaffold', args = []) => JSON.parse(execFileSync(process.execPath,
      [join(root, operation === 'file-item' ? 'scripts/operations/run.mjs' : 'scripts/backlog.mjs'), operation, ...args,
        '--kind=task', '--title=Born numbered', '--queue=false', '--json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, PATH: bin + delimiter + process.env.PATH,
          BIRTH_REMOTE_FILE: join(root, 'remote.json'), WE_NUMBER_AT_BIRTH: 'on',
          WE_OPERATION_ALLOW_STALE: '1', ...env } }));
    const numeric = run();
    expect(numeric.num).toMatch(/^\d+$/);
    const content = readFileSync(join(root, numeric.file), 'utf8');
    const bornAs = content.match(/^bornAs: (x[0-9a-z]{6})$/m)[1];
    const refs = JSON.parse(readFileSync(join(root, 'remote.json'), 'utf8')).refs;
    expect(refs['refs/card-ids/' + bornAs]).toBe(refs['refs/number-reservations/' + numeric.num]);
    expect(readdirSync(join(root, 'backlog'))).toEqual([`${numeric.num}-born-numbered.md`]);
    expect(() => run({}, 'yield', [`${numeric.num}-born-numbered`, '--force'])).toThrow(/immutable birth number/);
    expect(readFileSync(join(root, numeric.file), 'utf8')).toBe(content);
    const expectHashFileItem = (env = {}) => {
      const before = readdirSync(join(root, 'backlog'));
      const remoteBefore = readFileSync(join(root, 'remote.json'), 'utf8');
      const { verdict: card } = run(env, 'file-item');
      expect(card.num).toMatch(/^x[0-9a-z]{6}$/);
      expect(card.id).toBe(`${card.num}-born-numbered`);
      expect(card.rel).toBe(`backlog/${card.id}.md`);
      expect(card.abs).toBe(join(root, card.rel));
      expect(readFileSync(card.abs, 'utf8')).toBe(card.content);
      expect(card.content).not.toContain('bornAs:');
      expect(handNumberedNewItems([card], [])).toEqual([]);
      expect(readdirSync(join(root, 'backlog')).sort()).toEqual([...before, `${card.id}.md`].sort());
      expect(readFileSync(join(root, 'remote.json'), 'utf8')).toBe(remoteBefore);
      expect(readFileSync(join(root, numeric.file), 'utf8')).toBe(content);
    };
    expectHashFileItem();
    const off = run({ WE_NUMBER_AT_BIRTH: 'off' });
    expect(off.num).toMatch(/^x[0-9a-z]{6}$/);
    expect(readFileSync(join(root, off.file), 'utf8')).not.toContain('bornAs:');
    const outage = run({ BIRTH_REMOTE_DOWN: '1' });
    expect(outage.num).toMatch(/^x[0-9a-z]{6}$/);
    const missingMain = run({ BIRTH_MAIN_DOWN: '1' });
    expect(missingMain.num).toMatch(/^x[0-9a-z]{6}$/);
    const before = readdirSync(join(root, 'backlog'));
    for (const env of [{ BIRTH_REMOTE_DOWN: '1' }, { BIRTH_MAIN_DOWN: '1' }]) {
      expect(() => run({ ...env, WE_CARD_NUMBERING_REMOTE: 'required' })).toThrow();
      expect(readdirSync(join(root, 'backlog'))).toEqual(before);
    }
    // Numbering settings and remote availability apply to the legacy CLI, not hash-first file-item.
    for (const env of [
      { WE_NUMBER_AT_BIRTH: 'off' },
      { BIRTH_REMOTE_DOWN: '1' }, { BIRTH_MAIN_DOWN: '1' },
      { BIRTH_REMOTE_DOWN: '1', WE_CARD_NUMBERING_REMOTE: 'required' },
      { BIRTH_MAIN_DOWN: '1', WE_CARD_NUMBERING_REMOTE: 'required' },
    ]) expectHashFileItem(env);
    const lockRoot = join(home, '.claude', 'drain-locks');
    const owner = 'birth-cli-test-holder';
    expect(tryAcquireNumberingLock(lockRoot, owner).ok).toBe(true);
    const remoteBefore = readFileSync(join(root, 'remote.json'), 'utf8');
    const beforeLock = readdirSync(join(root, 'backlog'));
    try {
      // The transport is healthy: only contention may cause the numeric CLI's refusal.
      expect(() => run({ WE_CARD_NUMBERING_REMOTE: 'required' })).toThrow();
      expect(readdirSync(join(root, 'backlog'))).toEqual(beforeLock);
      expect(readFileSync(join(root, 'remote.json'), 'utf8')).toBe(remoteBefore);
      expectHashFileItem({ WE_CARD_NUMBERING_REMOTE: 'required' });
    } finally { expect(releaseNumberingLockIfOwned(lockRoot, owner)).toBe(true); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
