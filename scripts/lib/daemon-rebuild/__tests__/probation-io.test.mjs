import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, basename } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { withWriteLock, cloneLockDirs } from '../../daemon-clone-lock.mjs';

const load = () => import('../probation-io.mjs');
const at = Date.parse('2026-11-15T12:00:00Z');
const iso = n => new Date(n).toISOString();
let dir, root, env, git, good, head, opts;
const registered = [{ id: 'X', entry: 'workers/x.mjs' }, { id: 'Y', entry: 'services/y.mjs' }];
const processRecord = (daemonId, pid) => ({ daemonId, pid, bootHead: head, tickHead: head,
  startedAt: iso(at + 1), lastTickDoneAt: iso(at + 2) });
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'probation-io-'));
  root = join(dir, 'clone'); mkdirSync(root);
  env = { ...process.env, WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks') };
  git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root,
    encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim();
  git(['init', '-q']);
  mkdirSync(join(root, 'workers')); mkdirSync(join(root, 'services'));
  writeFileSync(join(root, 'workers/x.mjs'), "import './dep.mjs';\n");
  writeFileSync(join(root, 'workers/dep.mjs'), 'export default 1;');
  writeFileSync(join(root, 'services/y.mjs'), 'export default 0;');
  git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'good']);
  writeFileSync(join(root, 'workers/dep.mjs'), 'export default 2;');
  git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-p', good, '-m', 'adopt']);
  git(['reset', '--hard', head]);
  opts = { root, env, registered, now: () => at + 3, log: { error() {} }, lockOpts: { timeoutMs: 1000, pollMs: 5 } };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const previous = () => ({ head: good, at: iso(at - 100) });
const adopted = () => ({ head, at: iso(at) });

describe('R986 report-only probation persistence', () => {
  it('unions every canonical clone alias group so all registered daemons owe proof', async () => {
    const m = await load();
    const alias = join(dir, 'alias'); symlinkSync(root, alias, 'dir');
    const plists = Object.fromEntries([['com.we.X', root], ['com.we.Y', alias]].map(([id, path]) =>
      [id, { Label: id, WorkingDirectory: path, ProgramArguments: ['node', 'workers/x.mjs'] }]));
    const roster = m.registeredDaemons(root, { env: { WE_LAUNCH_AGENTS_DIR: dir },
      readdir: () => Object.keys(plists).map(id => `${id}.plist`),
      exec: (_, args) => JSON.stringify(plists[basename(args.at(-1), '.plist')]) });
    expect(roster.map(d => d.id).sort()).toEqual(['com.we.X', 'com.we.Y']);
    expect(await m.createProbationObserver({ ...opts, registered: roster }).adopt(previous(), adopted()))
      .toMatchObject({ action: 'pending', owed: ['com.we.Y', 'com.we.X'] });
  });
  it('refuses a roster when a plist with a non-matching filename also runs from this clone', async () => {
    const m = await load();
    const files = { 'com.we.X.plist': { Label: 'com.we.X', WorkingDirectory: root, ProgramArguments: ['node', 'workers/x.mjs'] },
      'custom-name.plist': { Label: 'com.we.Y', WorkingDirectory: root, ProgramArguments: ['node', 'workers/x.mjs'] } };
    expect(() => m.registeredDaemons(root, { env: { WE_LAUNCH_AGENTS_DIR: dir },
      readdir: () => Object.keys(files),
      exec: (_, args) => JSON.stringify(files[basename(args.at(-1))]) })).toThrow(/roster incomplete/);
  });
  it.each(['null', 'throw'])('refuses every unreadable plist when exec returns %s', async mode => {
    const m = await load();
    expect(() => m.registeredDaemons(root, { env: { WE_LAUNCH_AGENTS_DIR: dir },
      readdir: () => ['com.we.X.plist', 'other.plist'],
      exec: (_, args) => {
        if (basename(args.at(-1)) === 'other.plist') {
          if (mode === 'throw') throw new Error('permission or timeout');
          return null;
        }
        return JSON.stringify({ Label: 'com.we.X', WorkingDirectory: root, ProgramArguments: ['node', 'workers/x.mjs'] });
      } })).toThrow('daemon roster incomplete: unreadable plist');
  });
  it('has no dependency on the production clone lock', () => {
    expect(readFileSync(join(process.cwd(), 'scripts/lib/daemon-rebuild/probation-io.mjs'), 'utf8')).not.toContain('daemon-clone-lock');
  });
  it.each(['duplicate discovery', 'ambiguous label'])('refuses an incomplete roster on %s', async mode => {
    const m = await load();
    expect(() => m.registeredDaemons(root, { env: { WE_LAUNCH_AGENTS_DIR: dir },
      readdir: () => mode === 'duplicate discovery' ? ['com.we.X.plist', 'com.we.X.plist'] : ['com.we.X.plist'],
      exec: () => JSON.stringify({ Label: mode === 'ambiguous label' ? 'com.we.Y' : 'com.we.X',
        WorkingDirectory: root, ProgramArguments: ['node', 'workers/x.mjs'] }) })).toThrow(/roster|identity/);
  });
  it.each(['docs/agent/reviewer-expectations.md', 'scripts/lib/policy.mjs', 'config.json', 'unrelated.cjs'])(
    'any tracked change to %s changes every daemon snapshot and owes proof', async file => {
      const m = await load();
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), 'before');
      git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'baseline']);
      writeFileSync(join(root, file), 'after');
      git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-p', good, '-m', 'changed']);
      for (const daemon of registered) {
        const before = m.readClosure(root, daemon, good), after = m.readClosure(root, daemon, head);
        expect(before.complete).toBe(true);
        expect(after).toEqual({ complete: true, files: {
          '.tree': git(['rev-parse', `${head}^{tree}`]),
          [daemon.entry]: git(['rev-parse', `${head}:${daemon.entry}`]),
        } });
        expect(after.files['.tree']).not.toBe(before.files['.tree']);
        expect(after.files[daemon.entry]).toBe(before.files[daemon.entry]);
      }
      expect(await m.createProbationObserver(opts).adopt(previous(), adopted()))
        .toMatchObject({ action: 'pending', owed: ['X', 'Y'] });
      expect(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).owed).toEqual(['X', 'Y']);
    });
  it('distinct commits with identical trees give equal snapshots and owe no proof', async () => {
    const m = await load();
    head = git(['commit-tree', git(['rev-parse', `${good}^{tree}`]), '-p', good, '-m', 'same tree']);
    expect(head).not.toBe(good);
    for (const daemon of registered)
      expect(m.readClosure(root, daemon, head)).toEqual(m.readClosure(root, daemon, good));
    expect(await m.createProbationObserver(opts).adopt(previous(), adopted())).toMatchObject({ action: 'pass' });
  });
  it('symlink target changes cannot bypass probation debt for an external entry target', async () => {
    const m = await load(), target = join(dir, 'target.mjs');
    writeFileSync(target, 'export default 1;');
    rmSync(join(root, registered[0].entry));
    symlinkSync('../../target.mjs', join(root, registered[0].entry));
    git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'symlink baseline']);
    writeFileSync(target, 'export default 2;');
    head = git(['commit-tree', git(['write-tree']), '-p', good, '-m', 'external target changed']);
    expect(readFileSync(join(root, registered[0].entry), 'utf8')).toBe('export default 2;');
    expect(git(['rev-parse', `${head}^{tree}`])).toBe(git(['rev-parse', `${good}^{tree}`]));
    expect(git(['rev-parse', `${head}:${registered[0].entry}`]))
      .toBe(git(['rev-parse', `${good}:${registered[0].entry}`]));
    for (const sha of [good, head]) {
      expect(m.readClosure(root, registered[0], sha)).toEqual({ complete: false });
      expect(m.readClosure(root, registered[1], sha).complete).toBe(true);
    }
    expect(await m.createProbationObserver(opts).adopt(previous(), adopted()))
      .toMatchObject({ action: 'pending', owed: ['X'] });
    expect(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).owed).toEqual(['X']);
  });
  it.each(['preserved', 'reverted'])('successive freezes retain every daemon debt when worker changes are %s', async mode => {
    const m = await load(), observer = m.createProbationObserver(opts);
    expect(await observer.adopt(previous(), adopted())).toMatchObject({ action: 'pending', owed: ['X', 'Y'] });
    const first = adopted();
    if (mode === 'reverted') writeFileSync(join(root, 'workers/dep.mjs'), 'export default 1;');
    writeFileSync(join(root, 'unrelated.txt'), 'second adoption');
    git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-p', head, '-m', 'second']);
    expect(await observer.adopt(first, { head, at: iso(at + 1) }))
      .toMatchObject({ action: 'pending', owed: ['X', 'Y'] });
    const record = JSON.parse(readFileSync(m.probationPath(root, env), 'utf8'));
    expect(record.provenGood).toBe(good);
    expect(record.records).toEqual({});
  });
  it.each(['status', 'adopt', 'proof'])('held probation lock times out %s without changing record bytes', async method => {
    const m = await load(), observer = m.createProbationObserver({ ...opts, lockOpts: { timeoutMs: 20, pollMs: 2 } });
    await observer.adopt(previous(), adopted());
    const file = m.probationPath(root, env), before = readFileSync(file, 'utf8');
    writeFileSync(`${file}.lock`, `${process.pid}\n`);
    const result = await (method === 'adopt' ? observer.adopt(previous(), adopted()) :
      method === 'proof' ? observer.proof(processRecord('X', 101)) : observer.status());
    expect(result).toMatchObject({ status: 'invalid', action: 'pending',
      reason: expect.stringMatching(/timed out.*operator recovery required/) });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('adopt, proof and status succeed while the clone write lock is held', async () => {
    const m = await load(), observer = m.createProbationObserver(opts);
    const result = await withWriteLock(root, async () => {
      expect(await observer.adopt(previous(), adopted())).toMatchObject({ status: 'valid', action: 'pending' });
      expect(await observer.proof(processRecord('X', 101))).toMatchObject({ status: 'valid' });
      expect(await observer.proof(processRecord('Y', 202))).toMatchObject({ action: 'pass' });
      expect(await observer.status()).toMatchObject({ action: 'pass' });
    }, { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'fixture-writer' });
    expect(result.ok).toBe(true);
  });
  it('observer proof preserves a pending adoption writer-priority claim byte for byte', async () => {
    const m = await load(), observer = m.createProbationObserver(opts);
    await observer.adopt(previous(), adopted());
    const base = cloneLockDirs(root, env.WE_DAEMON_CLONE_LOCK_ROOT).base;
    mkdirSync(base, { recursive: true });
    const claim = join(base, 'writer-claim.json');
    const bytes = JSON.stringify({ owner: 'pending-adoption', pid: process.pid, count: 3,
      heldBy: 'tick', since: iso(Date.now()), lastAt: iso(Date.now()) }) + '\n';
    writeFileSync(claim, bytes);
    expect(await observer.proof(processRecord('X', 101))).toMatchObject({ status: 'valid' });
    expect(readFileSync(claim, 'utf8')).toBe(bytes);
  });
  it('shared-entry registrations retain distinct identities selected by differing process arguments', async () => {
    const { ownDaemonId } = await load();
    const roster = [
      { id: 'X', entry: 'workers/x.mjs', args: ['--pass=x'] },
      { id: 'Y', entry: 'workers/x.mjs', args: ['--pass=y'] },
    ];
    for (const id of ['X', 'Y']) {
      expect(ownDaemonId(root, 'workers/x.mjs', { registered: roster, env: {},
        argv: ['node', join(root, 'workers/x.mjs'), `--pass=${id.toLowerCase()}`] })).toBe(id);
    }
    expect(ownDaemonId(root, 'workers/x.mjs', { registered: roster, env: {},
      argv: ['node', join(root, 'workers/x.mjs'), '--pass=unknown'] })).toBeNull();
    expect(ownDaemonId(root, 'workers/x.mjs', { registered: roster, env: {},
      argv: ['node', join(root, 'workers/x.mjs'), '--pass=x', '--extra'] })).toBeNull();
  });
  it('XPC_SERVICE_NAME selects one shared-entry registration even when process arguments match both', async () => {
    const { ownDaemonId } = await load();
    const roster = ['X', 'Y'].map(id => ({ id, entry: 'workers/x.mjs', args: [] }));
    expect(ownDaemonId(root, 'workers/x.mjs', { registered: roster, env: { XPC_SERVICE_NAME: 'Y' },
      argv: ['node', join(root, 'workers/x.mjs')] })).toBe('Y');
    expect(ownDaemonId(root, 'services/y.mjs', { registered: roster, env: { XPC_SERVICE_NAME: 'Y' },
      argv: ['node', join(root, 'services/y.mjs')] })).toBeNull();
  });
  it('an explicit unregistered XPC_SERVICE_NAME is another service and gets no identity', async () => {
    const { ownDaemonId } = await load();
    const roster = ['X', 'Y'].map(id => ({ id, entry: 'workers/x.mjs', args: [`--pass=${id}`] }));
    const argv = ['node', join(root, 'workers/x.mjs'), '--pass=X'];
    expect(ownDaemonId(root, 'workers/x.mjs', { registered: roster, env: { XPC_SERVICE_NAME: 'unknown' }, argv })).toBeNull();
    // Terminal-style placeholders ('0', empty, absent) are not a service label: argv matching still applies.
    for (const label of ['0', '', undefined]) {
      expect(ownDaemonId(root, 'workers/x.mjs', { registered: roster, env: { XPC_SERVICE_NAME: label }, argv })).toBe('X');
    }
  });
  it('ambiguous shared-entry identity cannot satisfy an owed proof through persistence', async () => {
    const m = await load();
    const observer = m.createProbationObserver(opts);
    await observer.adopt(previous(), adopted());
    const roster = ['X', 'Y'].map(id => ({ id, entry: 'workers/x.mjs', args: [] }));
    for (const identityEnv of [{}, { XPC_SERVICE_NAME: 'unknown' }]) {
      const id = m.ownDaemonId(root, 'workers/x.mjs', { registered: roster, env: identityEnv,
        argv: ['node', join(root, 'workers/x.mjs')] });
      expect(id).toBeNull();
      expect(await observer.proof(processRecord(id, 101))).toMatchObject({ action: 'pending', owed: ['X', 'Y'] });
      expect(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).records).toEqual({});
    }
    expect(await observer.status()).toMatchObject({ action: 'pending', owed: ['X', 'Y'] });
  });
  it('freezes all registered daemons at adoption; each must supply its own proof', async () => {
    const m = await load();
    const observer = m.createProbationObserver(opts);
    expect(await observer.adopt(previous(), adopted())).toMatchObject({ action: 'pending', owed: ['X', 'Y'] });
    expect(await observer.proof(processRecord('Y', 202))).toMatchObject({ action: 'pending', owed: ['X'] });
    expect(await observer.proof(processRecord('X', 101))).toMatchObject({ action: 'pass' });
    const persisted = JSON.parse(readFileSync(m.probationPath(root, env), 'utf8'));
    expect(persisted.owed).toEqual(['X', 'Y']);
    expect(persisted.records.X.boot.pid).toBe(101);
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(persisted.provenGood).toBe(good);
    expect(await observer.adopt(adopted(), adopted())).toMatchObject({ action: 'pass' });
  });
  it.each(['empty object', 'truncated JSON', 'directory', 'wrong version', 'dangling symlink'])(
    'adoption preserves invalid persisted %s and requires operator recovery', async mode => {
      const m = await load(), observer = m.createProbationObserver(opts);
      await observer.adopt(previous(), adopted());
      const file = m.probationPath(root, env);
      const valid = JSON.parse(readFileSync(file, 'utf8'));
      rmSync(file);
      const bytes = mode === 'empty object' ? '{}' : mode === 'truncated JSON' ? '{"version":' :
        JSON.stringify({ ...valid, version: 999 });
      if (mode === 'directory') mkdirSync(file);
      else if (mode === 'dangling symlink') symlinkSync(join(dir, 'missing'), file);
      else writeFileSync(file, bytes);
      // A later head with identical closures would pass if the corrupt debt were discarded.
      const next = { head: 'e'.repeat(40), at: iso(at + 1) };
      let closureReads = 0;
      const later = m.createProbationObserver({ ...opts, readClosure() {
        closureReads++;
        return { complete: true, files: { 'workers/x.mjs': 'c'.repeat(40) } };
      } });
      expect(await later.adopt(adopted(), next)).toMatchObject({ status: 'invalid', action: 'pending',
        reason: expect.stringContaining('operator recovery required') });
      expect(closureReads).toBe(0);
      expect(await observer.status()).toMatchObject({ status: 'invalid', action: 'pending' });
      if (mode === 'directory') expect(lstatSync(file).isDirectory()).toBe(true);
      else if (mode === 'dangling symlink') expect(lstatSync(file).isSymbolicLink()).toBe(true);
      else expect(readFileSync(file, 'utf8')).toBe(bytes);
    });
  it('missing, unreadable and invalid files report invalid, never pass or empty', async () => {
    const m = await load(), observer = m.createProbationObserver(opts);
    expect(await observer.status()).toMatchObject({ status: 'invalid', action: 'pending' });
    await observer.adopt(previous(), adopted());
    const file = m.probationPath(root, env);
    writeFileSync(file, '{}');
    expect(await observer.proof(processRecord('X', 101))).toMatchObject({ status: 'invalid', action: 'pending' });
    expect(readFileSync(file, 'utf8')).toBe('{}');
    rmSync(file); mkdirSync(file);
    expect(await observer.status()).toMatchObject({ status: 'invalid', action: 'pending' });
  });
  it('failed Git reads and missing or outside entries are incomplete and owe proof', async () => {
    const m = await load();
    for (const sha of ['f'.repeat(40), 'bad-sha', '--all', null])
      expect(m.readClosure(root, registered[0], sha)).toEqual({ complete: false });
    expect(m.readClosure(join(dir, 'missing-repo'), registered[0], head)).toEqual({ complete: false });
    for (const entry of ['missing.mjs', 'workers', '../outside.mjs', '/outside.mjs'])
      expect(m.readClosure(root, { entry }, head)).toEqual({ complete: false });
    const observer = m.createProbationObserver({ ...opts, readClosure: () => ({ complete: false }) });
    expect(await observer.adopt(previous(), adopted())).toMatchObject({ owed: ['X', 'Y'] });
  });
  it('concurrent process proofs serialize under the probation lock without losing either record', async () => {
    const m = await load(), observer = m.createProbationObserver(opts);
    await observer.adopt(previous(), adopted());
    const lock = `${m.probationPath(root, env)}.lock`;
    writeFileSync(lock, `${process.pid}\n`);
    const children = ['X', 'Y'].map((id, i) => {
      const code = `import { createProbationObserver } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib/daemon-rebuild/probation-io.mjs')).href)};
        process.send('ready');
        const result = await createProbationObserver({ ...${JSON.stringify({ root, env, lockOpts: { timeoutMs: 2000, pollMs: 2 } })}, now: () => ${at + 3} })
          .proof(${JSON.stringify(processRecord(id, 101 + i))});
        process.exit(result.status === 'valid' ? 0 : 1);`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const ready = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject);
        child.once('exit', () => reject(new Error(`worker exited before ready: ${stderr}`))); });
      const done = new Promise((resolve, reject) => { child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr))); });
      return { child, ready, done };
    });
    try {
      await Promise.all(children.map(c => c.ready));
      expect(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).records).toEqual({});
      rmSync(lock);
      await Promise.all(children.map(c => c.done));
      expect(await observer.status()).toMatchObject({ action: 'pass' });
      expect(Object.keys(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).records).sort()).toEqual(['X', 'Y']);
    } finally { for (const { child } of children) if (child.exitCode === null) child.kill(); }
  });
  it('closure snapshots use immutable tree and entry IDs, independent of working-tree bytes', async () => {
    const m = await load();
    writeFileSync(join(root, 'workers/dep.mjs'), 'uncommitted');
    expect(m.readClosure(root, registered[0], good)).toEqual({ complete: true, files: {
      '.tree': git(['rev-parse', `${good}^{tree}`]),
      'workers/x.mjs': git(['rev-parse', good + ':workers/x.mjs']) } });
  });
});
