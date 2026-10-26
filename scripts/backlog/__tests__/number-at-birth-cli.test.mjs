import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, delimiter, resolve } from 'node:path';
import { tryAcquireNumberingLock, releaseNumberingLockIfOwned } from '../../readiness/drain-lock.mjs';

it('real scaffold and file-item CLIs birth numeric cards; off/outage use hashes; required refuses outages and lock contention', () => {
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
  case 'fetch': case 'ls-tree': break;
  default: process.exit(1);
}
fs.writeFileSync(file, JSON.stringify(state));
`, { mode: 0o755 });
    const run = (env = {}, operation = 'scaffold') => JSON.parse(execFileSync(process.execPath,
      [join(root, operation === 'scaffold' ? 'scripts/backlog.mjs' : 'scripts/operations/run.mjs'), operation,
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
    run({}, 'file-item');
    const names = readdirSync(join(root, 'backlog'));
    expect(names).toContain('002-born-numbered.md');
    const second = readFileSync(join(root, 'backlog/002-born-numbered.md'), 'utf8');
    const secondId = second.match(/^bornAs: (x[0-9a-z]{6})$/m)[1];
    const nextRefs = JSON.parse(readFileSync(join(root, 'remote.json'), 'utf8')).refs;
    expect(nextRefs['refs/card-ids/' + secondId]).toBe(nextRefs['refs/number-reservations/002']);
    const off = run({ WE_NUMBER_AT_BIRTH: 'off' });
    expect(off.num).toMatch(/^x[0-9a-z]{6}$/);
    expect(readFileSync(join(root, off.file), 'utf8')).not.toContain('bornAs:');
    const outage = run({ BIRTH_REMOTE_DOWN: '1' });
    expect(outage.num).toMatch(/^x[0-9a-z]{6}$/);
    const missingMain = run({ BIRTH_MAIN_DOWN: '1' });
    expect(missingMain.num).toMatch(/^x[0-9a-z]{6}$/);
    const before = readdirSync(join(root, 'backlog'));
    for (const operation of ['scaffold', 'file-item']) {
      expect(() => run({ BIRTH_REMOTE_DOWN: '1', WE_CARD_NUMBERING_REMOTE: 'required' }, operation)).toThrow();
      expect(() => run({ BIRTH_MAIN_DOWN: '1', WE_CARD_NUMBERING_REMOTE: 'required' }, operation)).toThrow();
      expect(readdirSync(join(root, 'backlog'))).toEqual(before);
    }
    const lockRoot = join(home, '.claude', 'drain-locks');
    const owner = 'birth-cli-test-holder';
    expect(tryAcquireNumberingLock(lockRoot, owner).ok).toBe(true);
    const remoteBefore = readFileSync(join(root, 'remote.json'), 'utf8');
    try {
      for (const operation of ['scaffold', 'file-item']) {
        // The transport is healthy: only contention may cause this refusal.
        expect(() => run({ WE_CARD_NUMBERING_REMOTE: 'required' }, operation)).toThrow();
        expect(readdirSync(join(root, 'backlog'))).toEqual(before);
        expect(readFileSync(join(root, 'remote.json'), 'utf8')).toBe(remoteBefore);
      }
    } finally { expect(releaseNumberingLockIfOwned(lockRoot, owner)).toBe(true); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
