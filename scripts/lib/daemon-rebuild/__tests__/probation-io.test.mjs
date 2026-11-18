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
const registered = [{ id: 'X', entry: 'x.mjs' }, { id: 'Y', entry: 'y.mjs' }];
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
  writeFileSync(join(root, 'x.mjs'), "import './dep.mjs';\n");
  writeFileSync(join(root, 'dep.mjs'), 'export default 1;');
  writeFileSync(join(root, 'y.mjs'), 'export default 0;');
  git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'good']);
  writeFileSync(join(root, 'dep.mjs'), 'export default 2;');
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
      [id, { Label: id, WorkingDirectory: path, ProgramArguments: ['node', 'x.mjs'] }]));
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
        WorkingDirectory: root, ProgramArguments: ['node', 'x.mjs'] }) })).toThrow(/roster|identity/);
  });
  it('changed CommonJS required dependency is included and owes proof', async () => {
    const m = await load();
    writeFileSync(join(root, 'entry.cjs'), "module.exports = require('./required.cjs');");
    writeFileSync(join(root, 'required.cjs'), 'module.exports = 1;');
    git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'cjs before']);
    writeFileSync(join(root, 'required.cjs'), 'module.exports = 2;');
    git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-m', 'cjs after']);
    const roster = [{ id: 'CJS', entry: 'entry.cjs' }];
    expect(m.readClosure(root, roster[0], head)).toEqual({ complete: true, files: {
      'entry.cjs': git(['rev-parse', head + ':entry.cjs']),
      'required.cjs': git(['rev-parse', head + ':required.cjs']),
    } });
    expect(await m.createProbationObserver({ ...opts, registered: roster }).adopt(previous(), adopted()))
      .toMatchObject({ action: 'pending', owed: ['CJS'] });
  });
  it('CommonJS extensionless require tracks dep.js before dep.mjs and changing dep.js owes proof', async () => {
    const m = await load();
    writeFileSync(join(root, 'entry.cjs'), "module.exports = require('./dep');");
    writeFileSync(join(root, 'dep.js'), 'module.exports = 1;');
    git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'require collision before']);
    writeFileSync(join(root, 'dep.js'), 'module.exports = 2;');
    git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-m', 'require collision after']);
    expect(execFileSync(process.execPath, ['-p', "require.resolve('./dep')"],
      { cwd: root, encoding: 'utf8' }).trim()).toBe(join(root, 'dep.js'));
    const roster = [{ id: 'CJS', entry: 'entry.cjs' }];
    expect(m.readClosure(root, roster[0], head)).toEqual({ complete: true, files: {
      'entry.cjs': git(['rev-parse', head + ':entry.cjs']), 'dep.js': git(['rev-parse', head + ':dep.js']),
    } });
    expect(await m.createProbationObserver({ ...opts, registered: roster }).adopt(previous(), adopted()))
      .toMatchObject({ action: 'pending', owed: ['CJS'] });
  });
  it.each(['mjs only', 'cjs only', 'directory', 'JSON', 'native', 'symlink'])(
    'CommonJS extensionless require fails closed for unsupported resolution: %s', async mode => {
      const m = await load();
      writeFileSync(join(root, 'entry.cjs'), "module.exports = require('./target');");
      if (mode === 'directory') {
        mkdirSync(join(root, 'target'));
        writeFileSync(join(root, 'target/index.js'), 'module.exports = 1;');
      } else if (mode === 'symlink') {
        symlinkSync('dep.mjs', join(root, 'target'));
        writeFileSync(join(root, 'target.js'), 'module.exports = 1;');
      } else {
        const ext = { 'mjs only': 'mjs', 'cjs only': 'cjs', JSON: 'json', native: 'node' }[mode];
        writeFileSync(join(root, `target.${ext}`), '1');
      }
      git(['add', '.']); const sha = git(['commit-tree', git(['write-tree']), '-m', 'unsupported require']);
      expect(m.readClosure(root, { entry: 'entry.cjs' }, sha)).toEqual({ complete: false });
    });
  it.each([
    ["require('./loaded.cjs')", true],
    ["module.require('./loaded.cjs')", false],
    ["module['require']('./loaded.cjs')", false],
    ['module["require"]("./loaded.cjs")', false],
    ['module[`require`]("./loaded.cjs")', false],
    ["module['requ\\u0069re']('./loaded.cjs')", false],
    ["module['re' + 'quire']('./loaded.cjs')", false],
    ["module[loader]('./loaded.cjs')", false],
    ['module[`${loader}`]("./loaded.cjs")', false],
    ["globalThis['require']('./loaded.cjs')", false],
    ["const load = module['require']; load('./loaded.cjs')", false],
  ])('CommonJS loader-form gate includes dependency or fails closed and retains changed dependency debt: %s',
    async (source, complete) => {
      const m = await load();
      writeFileSync(join(root, 'entry.cjs'), source);
      writeFileSync(join(root, 'loaded.cjs'), 'module.exports = 1;');
      git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'loader form before']);
      writeFileSync(join(root, 'loaded.cjs'), 'module.exports = 2;');
      git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-m', 'loader form after']);
      const roster = [{ id: 'CJS', entry: 'entry.cjs' }];
      expect(m.readClosure(root, roster[0], head)).toEqual(complete ? { complete: true, files: {
        'entry.cjs': git(['rev-parse', head + ':entry.cjs']), 'loaded.cjs': git(['rev-parse', head + ':loaded.cjs']),
      } } : { complete: false });
      expect(await m.createProbationObserver({ ...opts, registered: roster }).adopt(previous(), adopted()))
        .toMatchObject({ action: 'pending', owed: ['CJS'] });
    });
  it.each(['require(target)', 'module.require(target)', "require.resolve('./required.cjs')"])
    ('unresolved CommonJS form %s fails closed', async source => {
      const m = await load();
      writeFileSync(join(root, 'y.mjs'), source); git(['add', '.']);
      const sha = git(['commit-tree', git(['write-tree']), '-m', 'unresolved require']);
      expect(m.readClosure(root, registered[1], sha)).toEqual({ complete: false });
    });
  it.each([
    'import"./dep.mjs";',
    "import'./dep.mjs';",
    'import\n"./dep.mjs";',
    'export*from"./dep.mjs";',
    "export * /*c*/ from\n './dep.mjs';",
    'import{default as value}from"./dep.mjs";',
    'import(`./dep.mjs`);',
    'import(\n`./dep.mjs`\n);',
    "require('./dep.mjs');",
    'require("./dep.mjs");',
    'require /*c*/ ( /*c*/ `./dep.mjs` /*c*/ );',
    "require( //c\n './dep.mjs'\n);",
    'import /* comment */ "./dep.mjs";',
    'import // comment\n "./dep.mjs";',
    "export { default } from /*c*/ './dep.mjs';",
    "import /*c*/ ( /*c*/ './dep.mjs' /*c*/ );",
    "import( // comment\n './dep.mjs' // comment\n );",
  ])('commented import includes its dependency and owes proof: %s', async source => {
    const m = await load();
    writeFileSync(join(root, 'x.mjs'), source);
    writeFileSync(join(root, 'dep.mjs'), 'export default 1;');
    git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'comment before']);
    writeFileSync(join(root, 'dep.mjs'), 'export default 2;');
    git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-m', 'comment after']);
    expect(m.readClosure(root, registered[0], head)).toEqual({ complete: true, files: {
      'x.mjs': git(['rev-parse', head + ':x.mjs']), 'dep.mjs': git(['rev-parse', head + ':dep.mjs']),
    } });
    expect(await m.createProbationObserver(opts).adopt(previous(), adopted()))
      .toMatchObject({ action: 'pending', owed: ['X'] });
    writeFileSync(join(root, 'x.mjs'), source.replaceAll('./dep.mjs', '../outside.mjs'));
    writeFileSync(join(dir, 'outside.mjs'), 'export default 1;');
    git(['add', '.']); const outside = git(['commit-tree', git(['write-tree']), '-m', 'outside import']);
    expect(m.readClosure(root, registered[0], outside)).toEqual({ complete: false });
  });
  it('regex character-class slashes preserve the following import and owe proof for its changed dependency', async () => {
    const m = await load();
    writeFileSync(join(root, 'x.mjs'), "const re = /[//]/; import './dep.mjs';");
    writeFileSync(join(root, 'dep.mjs'), 'export default 1;');
    git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'regex before']);
    writeFileSync(join(root, 'dep.mjs'), 'export default 2;');
    git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-m', 'regex after']);
    expect(m.readClosure(root, registered[0], head)).toEqual({ complete: true, files: {
      'x.mjs': git(['rev-parse', head + ':x.mjs']), 'dep.mjs': git(['rev-parse', head + ':dep.mjs']),
    } });
    expect(await m.createProbationObserver(opts).adopt(previous(), adopted()))
      .toMatchObject({ action: 'pending', owed: ['X'] });
  });
  it.each([
    'import`./dep.mjs`;', 'export * from `./dep.mjs`;',
    "import('./dep.mjs' + suffix);", 'import(`./${target}.mjs`);',
    "require('./dep.mjs' + suffix);", 'require(`./${target}.mjs`);',
    'import"./missing.mjs";', 'import"./dep";', 'require("package-name");',
    'import"./dep.mjs"; import"./missing.mjs";',
  ])('unknown or unsupported dependency syntax fails closed: %s', async source => {
    const m = await load();
    writeFileSync(join(root, 'x.mjs'), source); git(['add', '.']);
    const sha = git(['commit-tree', git(['write-tree']), '-m', 'incomplete syntax']);
    expect(m.readClosure(root, registered[0], sha)).toEqual({ complete: false });
  });
  it('ignores loader-looking text in comments, strings, templates and regexes', async () => {
    const m = await load();
    writeFileSync(join(root, 'y.mjs'), [
      '// import"./missing.mjs";', '/* require("./missing.mjs"); */',
      'const text = \'import"./missing.mjs"\';',
      'const template = `require("./missing.mjs")`;', 'const re = /require("missing")/;',
    ].join('\n'));
    git(['add', '.']); const sha = git(['commit-tree', git(['write-tree']), '-m', 'inert text']);
    expect(m.readClosure(root, registered[1], sha)).toEqual({ complete: true,
      files: { 'y.mjs': git(['rev-parse', sha + ':y.mjs']) } });
  });
  it('unreadable comment syntax refuses a complete closure', async () => {
    const m = await load();
    writeFileSync(join(root, 'x.mjs'), "/* unterminated comment hiding import './dep.mjs';");
    git(['add', '.']); const sha = git(['commit-tree', git(['write-tree']), '-m', 'unreadable syntax']);
    expect(m.readClosure(root, registered[0], sha)).toEqual({ complete: false });
  });
  it.each(['preserved', 'reverted'])('successive freezes retain unproven X debt when its files are %s', async mode => {
    const m = await load(), observer = m.createProbationObserver(opts);
    expect(await observer.adopt(previous(), adopted())).toMatchObject({ action: 'pending', owed: ['X'] });
    const first = adopted();
    if (mode === 'reverted') writeFileSync(join(root, 'dep.mjs'), 'export default 1;');
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
  it('snapshots runtime JSON names across directories so a changed config owes proof', async () => {
    const m = await load();
    writeFileSync(join(root, 'y.mjs'), "export const config = 'runtime.json';");
    mkdirSync(join(root, 'config')); mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'config/runtime.json'), '{"value":1}');
    writeFileSync(join(root, 'other/runtime.json'), '{}');
    git(['add', '.']); good = git(['commit-tree', git(['write-tree']), '-m', 'json before']);
    writeFileSync(join(root, 'config/runtime.json'), '{"value":2}');
    git(['add', '.']); head = git(['commit-tree', git(['write-tree']), '-m', 'json after']);
    expect(m.readClosure(root, registered[1], head)).toEqual({ complete: true, files: {
      'y.mjs': git(['rev-parse', head + ':y.mjs']),
      'config/runtime.json': git(['rev-parse', head + ':config/runtime.json']),
      'other/runtime.json': git(['rev-parse', head + ':other/runtime.json']),
    } });
    expect(await m.createProbationObserver(opts).adopt(previous(), adopted()))
      .toMatchObject({ action: 'pending', owed: ['Y'] });
  });
  it('shared-entry registrations retain distinct identities selected by differing process arguments', async () => {
    const { ownDaemonId } = await load();
    const roster = [
      { id: 'X', entry: 'x.mjs', args: ['--pass=x'] },
      { id: 'Y', entry: 'x.mjs', args: ['--pass=y'] },
    ];
    for (const id of ['X', 'Y']) {
      expect(ownDaemonId(root, 'x.mjs', { registered: roster, env: {},
        argv: ['node', join(root, 'x.mjs'), `--pass=${id.toLowerCase()}`] })).toBe(id);
    }
    expect(ownDaemonId(root, 'x.mjs', { registered: roster, env: {},
      argv: ['node', join(root, 'x.mjs'), '--pass=unknown'] })).toBeNull();
    expect(ownDaemonId(root, 'x.mjs', { registered: roster, env: {},
      argv: ['node', join(root, 'x.mjs'), '--pass=x', '--extra'] })).toBeNull();
  });
  it('XPC_SERVICE_NAME selects one shared-entry registration even when process arguments match both', async () => {
    const { ownDaemonId } = await load();
    const roster = ['X', 'Y'].map(id => ({ id, entry: 'x.mjs', args: [] }));
    expect(ownDaemonId(root, 'x.mjs', { registered: roster, env: { XPC_SERVICE_NAME: 'Y' },
      argv: ['node', join(root, 'x.mjs')] })).toBe('Y');
    expect(ownDaemonId(root, 'y.mjs', { registered: roster, env: { XPC_SERVICE_NAME: 'Y' },
      argv: ['node', join(root, 'y.mjs')] })).toBeNull();
  });
  it('unknown XPC_SERVICE_NAME falls back to an unambiguous argument match', async () => {
    const { ownDaemonId } = await load();
    const roster = ['X', 'Y'].map(id => ({ id, entry: 'x.mjs', args: [`--pass=${id}`] }));
    expect(ownDaemonId(root, 'x.mjs', { registered: roster, env: { XPC_SERVICE_NAME: 'unknown' },
      argv: ['node', join(root, 'x.mjs'), '--pass=X'] })).toBe('X');
  });
  it('ambiguous shared-entry identity cannot satisfy an owed proof through persistence', async () => {
    const m = await load();
    const observer = m.createProbationObserver(opts);
    await observer.adopt(previous(), adopted());
    const roster = ['X', 'Y'].map(id => ({ id, entry: 'x.mjs', args: [] }));
    for (const identityEnv of [{}, { XPC_SERVICE_NAME: 'unknown' }]) {
      const id = m.ownDaemonId(root, 'x.mjs', { registered: roster, env: identityEnv,
        argv: ['node', join(root, 'x.mjs')] });
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
        return { complete: true, files: { 'x.mjs': 'c'.repeat(40) } };
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
  it('failed closure reads owe proof and unresolved relative imports are incomplete', async () => {
    const m = await load();
    expect(m.readClosure(root, registered[0], 'f'.repeat(40)).complete).toBe(false);
    writeFileSync(join(root, 'y.mjs'), "import './missing.mjs';"); git(['add', '.']);
    const broken = git(['commit-tree', git(['write-tree']), '-m', 'missing import']);
    expect(m.readClosure(root, registered[1], broken).complete).toBe(false);
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
    writeFileSync(join(root, 'dep.mjs'), 'uncommitted');
    expect(m.readClosure(root, registered[0], good)).toEqual({ complete: true, files: {
      'x.mjs': git(['rev-parse', good + ':x.mjs']), 'dep.mjs': git(['rev-parse', good + ':dep.mjs']) } });
  });
});
