import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withWriteLock } from '../../daemon-clone-lock.mjs';

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
  opts = { root, env, registered, now: () => at + 3, log: { error() {} }, lockOpts: { waitMs: 1000, pollMs: 5 } };
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
  it.each(['duplicate discovery', 'ambiguous label'])('refuses an incomplete roster on %s', async mode => {
    const m = await load();
    expect(() => m.registeredDaemons(root, { env: { WE_LAUNCH_AGENTS_DIR: dir },
      readdir: () => mode === 'duplicate discovery' ? ['com.we.X.plist', 'com.we.X.plist'] : ['com.we.X.plist'],
      exec: () => JSON.stringify({ Label: mode === 'ambiguous label' ? 'com.we.Y' : 'com.we.X',
        WorkingDirectory: root, ProgramArguments: ['node', 'workers/x.mjs'] }) })).toThrow(/roster|identity/);
  });
  it('any tracked scoped file changes the snapshot and owes proof, while docs do not', async () => {
    const m = await load();
    const roster = [...registered, { id: 'Z', entry: 'workers/y.mjs' }];
    const paths = ['scripts/unrelated-sibling.mjs', 'scripts/unrelated.cjs', 'scripts/config.json',
      'scripts/alias-target.cjs', 'scripts/tab\tand\nnewline.bin', 'skills-src/brief.md', 'workers/nested/sibling.txt',
      'package.json', 'package-lock.json', 'docs/guide.md'];
    writeFileSync(join(root, 'workers/y.mjs'),
      "import { createRequire } from 'node:module'; const alias = createRequire(import.meta.url); alias('../scripts/alias-target.cjs');");
    for (const file of paths) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), 'before');
    }
    git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'scope baseline']);
    for (const file of paths) {
      writeFileSync(join(root, file), 'after');
      git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-m', file]);
      const owed = [];
      for (const daemon of roster) {
        const ownDir = daemon.entry.split('/')[0];
        const scoped = !file.startsWith('docs/') && (!file.startsWith('workers/') || ownDir === 'workers');
        if (scoped) owed.push(daemon.id);
        const before = m.readClosure(root, daemon, good), after = m.readClosure(root, daemon, head);
        expect(before.complete).toBe(true); expect(after.complete).toBe(true);
        expect(after.files).toEqual(Object.fromEntries(
          [...(ownDir === 'workers' ? ['workers/x.mjs', 'workers/dep.mjs', 'workers/y.mjs'] : ['services/y.mjs']),
            ...paths.filter(p => !p.startsWith('docs/') && (!p.startsWith('workers/') || ownDir === 'workers'))]
            .map(p => [p, git(['rev-parse', `${head}:${p}`])])));
        expect(after.files[file]).toBe(scoped ? git(['rev-parse', `${head}:${file}`]) : undefined);
        expect(after.files).toEqual(scoped ? { ...before.files, [file]: after.files[file] } : before.files);
        if (scoped) expect(after.files[file]).not.toBe(before.files[file]);
      }
      rmSync(env.WE_DAEMON_STATE_DIR, { recursive: true, force: true });
      expect(await m.createProbationObserver({ ...opts, registered: roster }).adopt(previous(), adopted()))
        .toMatchObject(owed.length ? { action: 'pending', owed } : { action: 'pass' });
      expect(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).owed).toEqual(owed);
      writeFileSync(join(root, file), 'before');
    }
  });
  it.each([
    ['workers/x.mjs', 'excluded'], ['workers/x.mjs', 'external'],
    ['workers/linked.mjs', 'excluded'], ['workers/linked.mjs', 'external'],
    ['scripts/linked.mjs', 'excluded'], ['scripts/linked.mjs', 'external'],
  ])('symlink target changes cannot bypass probation debt (%s, %s)', async (link, location) => {
    const m = await load();
    mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'scripts'));
    const target = location === 'excluded' ? join(root, 'docs/target.mjs') : join(dir, 'target.mjs');
    writeFileSync(target, 'export default 1;');
    rmSync(join(root, link), { force: true });
    symlinkSync(location === 'excluded' ? '../docs/target.mjs' : '../../target.mjs', join(root, link));
    git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'symlink baseline']);
    writeFileSync(target, 'export default 2;');
    git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-p', good, '-m', 'target changed']);
    expect(readFileSync(join(root, link), 'utf8')).toBe('export default 2;');
    expect(git(['rev-parse', `${head}:${link}`])).toBe(git(['rev-parse', `${good}:${link}`]));
    expect(git(['diff-tree', '--no-commit-id', '--name-only', '-r', good, head]))
      .toBe(location === 'excluded' ? 'docs/target.mjs' : '');
    const owed = link.startsWith('scripts/') ? ['X', 'Y'] : ['X'];
    for (const daemon of registered) {
      for (const sha of [good, head]) {
        const snapshot = m.readClosure(root, daemon, sha);
        if (owed.includes(daemon.id)) expect(snapshot).toEqual({ complete: false });
        else expect(snapshot.complete).toBe(true);
      }
    }
    expect(await m.createProbationObserver(opts).adopt(previous(), adopted()))
      .toMatchObject({ action: 'pending', owed });
    expect(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).owed).toEqual(owed);
  });
  it('a root-level daemon entry conservatively snapshots the whole repository', async () => {
    const m = await load();
    writeFileSync(join(root, 'entry.mjs'), 'export default 1;');
    git(['add', '.']); const sha = git(['commit-tree', git(['write-tree']), '-m', 'root entry']);
    expect(m.readClosure(root, { entry: 'entry.mjs' }, sha)).toEqual({ complete: true,
      files: Object.fromEntries(['entry.mjs', 'workers/x.mjs', 'workers/dep.mjs', 'services/y.mjs']
        .map(p => [p, git(['rev-parse', `${sha}:${p}`])])) });
  });
  it('oversized Git tree output is incomplete and owes proof pending operator inspection', async () => {
    const m = await load();
    const blob = git(['rev-parse', `${good}:workers/x.mjs`]);
    const input = Array.from({ length: 35000 }, (_, i) =>
      `100644 blob ${blob}\t${String(i).padStart(6, '0')}${'x'.repeat(220)}\n`).join('');
    expect(Buffer.byteLength(input)).toBeGreaterThan(8 * 1024 * 1024);
    const tree = execFileSync('git', ['mktree'], { cwd: root, input, encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['mktree'], { cwd: root,
      input: `040000 tree ${tree}\tscripts\n`, encoding: 'utf8' }).trim();
    expect(m.readClosure(root, { entry: 'scripts/000000' + 'x'.repeat(220) }, sha)).toEqual({ complete: false });
    const roster = ['X', 'Y'].map((id, i) => ({ id, entry: `scripts/${String(i).padStart(6, '0')}${'x'.repeat(220)}` }));
    expect(await m.createProbationObserver({ ...opts, registered: roster, readClosure: d => m.readClosure(root, d, sha) })
      .adopt(previous(), adopted())).toMatchObject({ action: 'pending', owed: ['X', 'Y'] });
  });
  it.each(['preserved', 'reverted'])('successive freezes retain unproven X debt when its files are %s', async mode => {
    const m = await load(), observer = m.createProbationObserver(opts);
    expect(await observer.adopt(previous(), adopted())).toMatchObject({ action: 'pending', owed: ['X'] });
    const first = adopted();
    if (mode === 'reverted') writeFileSync(join(root, 'workers/dep.mjs'), 'export default 1;');
    writeFileSync(join(root, 'unrelated.txt'), 'second adoption');
    git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-p', head, '-m', 'second']);
    expect(await observer.adopt(first, { head, at: iso(at + 1) }))
      .toMatchObject({ action: 'pending', owed: ['X'] });
    const record = JSON.parse(readFileSync(m.probationPath(root, env), 'utf8'));
    expect(record.provenGood).toBe(good);
    expect(record.records).toEqual({});
  });
  it('persistent lock contention exhausts five attempts and requests operator recovery without changing bytes', async () => {
    const m = await load(), observer = m.createProbationObserver(opts);
    await observer.adopt(previous(), adopted());
    const file = m.probationPath(root, env), before = readFileSync(file, 'utf8');
    await withWriteLock(root, async () => {
      expect(await observer.proof(processRecord('X', 101))).toMatchObject({ status: 'invalid', action: 'pending',
        reason: expect.stringMatching(/concurrent-mover.*5 attempts.*operator recovery required/) });
      expect(readFileSync(file, 'utf8')).toBe(before);
    }, { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'persistent-blocker' });
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
  it('unknown XPC_SERVICE_NAME falls back to an unambiguous argument match', async () => {
    const { ownDaemonId } = await load();
    const roster = ['X', 'Y'].map(id => ({ id, entry: 'workers/x.mjs', args: [`--pass=${id}`] }));
    expect(ownDaemonId(root, 'workers/x.mjs', { registered: roster, env: { XPC_SERVICE_NAME: 'unknown' },
      argv: ['node', join(root, 'workers/x.mjs'), '--pass=X'] })).toBe('X');
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
      expect(await observer.proof(processRecord(id, 101))).toMatchObject({ action: 'pending', owed: ['X'] });
      expect(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).records).toEqual({});
    }
    expect(await observer.status()).toMatchObject({ action: 'pending', owed: ['X'] });
  });
  it('freezes two registered daemons at adoption; Y cannot satisfy X, X own proof can', async () => {
    const m = await load();
    const observer = m.createProbationObserver(opts);
    expect(await observer.adopt(previous(), adopted())).toMatchObject({ action: 'pending', owed: ['X'] });
    expect(await observer.proof(processRecord('Y', 202))).toMatchObject({ action: 'pending', owed: ['X'] });
    expect(await observer.proof(processRecord('X', 101))).toMatchObject({ action: 'pass' });
    const persisted = JSON.parse(readFileSync(m.probationPath(root, env), 'utf8'));
    expect(persisted.owed).toEqual(['X']);
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
    expect(m.readClosure(root, registered[0], 'f'.repeat(40)).complete).toBe(false);
    for (const entry of ['missing.mjs', '../outside.mjs', '/outside.mjs'])
      expect(m.readClosure(root, { entry }, head)).toEqual({ complete: false });
    const observer = m.createProbationObserver({ ...opts, readClosure: () => ({ complete: false }) });
    expect(await observer.adopt(previous(), adopted())).toMatchObject({ owed: ['X', 'Y'] });
  });
  it('concurrent independent writers serialize under the real shared write lock without losing either record', async () => {
    const m = await load();
    const both = { ...opts, readClosure: () => ({ complete: false }) };
    const a = m.createProbationObserver(both), b = m.createProbationObserver(both);
    await a.adopt(previous(), adopted());
    let entered, release;
    const held = new Promise(r => { entered = r; });
    const blocker = withWriteLock(root, async () => { entered(); await new Promise(r => { release = r; }); },
      { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'fixture-blocker' });
    await held;
    const first = a.proof(processRecord('X', 101)), second = b.proof(processRecord('Y', 202));
    expect(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).records).toEqual({});
    const samples = [];
    const sample = () => {
      try { samples.push(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8'))); }
      catch (e) { samples.push({ error: e.message }); }
    };
    const timer = setInterval(sample, 1);
    let results;
    try { release(); await blocker; results = await Promise.all([first, second]); }
    finally { clearInterval(timer); sample(); }
    expect(samples.length).toBeGreaterThan(0);
    for (const snapshot of samples) {
      expect(snapshot.error).toBeUndefined();
      expect((await import('../probation.mjs')).validateProbation(snapshot, at + 3)).toBeNull();
    }
    for (const r of results) expect(r.status).toBe('valid');
    const onDisk = () => Object.keys(JSON.parse(readFileSync(m.probationPath(root, env), 'utf8')).records).sort();
    expect(await a.status()).toMatchObject({ action: 'pass' });
    expect(onDisk()).toEqual(['X', 'Y']);
  });
  it('closure snapshots use Git blob IDs at each SHA, independent of working-tree bytes', async () => {
    const m = await load();
    writeFileSync(join(root, 'workers/dep.mjs'), 'uncommitted');
    expect(m.readClosure(root, registered[0], good)).toEqual({ complete: true, files: {
      'workers/x.mjs': git(['rev-parse', good + ':workers/x.mjs']), 'workers/dep.mjs': git(['rev-parse', good + ':workers/dep.mjs']) } });
  });
});
