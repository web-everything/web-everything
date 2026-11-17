// @vitest-environment node
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import {join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {deploy, payloads} from '../forge-deploy.mjs';

const moduleURL = new URL('../forge-deploy.mjs', import.meta.url);
const setup = fs.readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
let sandbox, root, source;
const a = 'abcdef0', b = '1234567';
const run = (command, options = {}) => deploy({root, source, command, stateDir: join(sandbox, 'state'), ...options});
const install = value => run('install', {sha: value});
const current = () => fs.readlinkSync(join(root, 'current'));
beforeEach(() => {
  sandbox = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'forge-deploy-'));
  // Model a trusted host prefix above the private fixture. Real temporary
  // ancestors include shared writable directories and belong to other UIDs.
  const ancestors = [];
  for (let parent = dirname(sandbox); ; parent = dirname(parent)) {
    ancestors.push(parent);
    if (parent === dirname(parent)) break;
  }
  const original = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation((name, ...args) => {
    const st = original(name, ...args);
    return ancestors.includes(name) ? Object.assign(st, {uid: process.getuid(), mode: st.mode & ~0o022}) : st;
  });
  // Subprocess CLI/crash/setup probes use the same explicit host-prefix model.
  const bootstrap = join(sandbox, 'trusted-prefix.mjs');
  fs.writeFileSync(bootstrap, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original = fs.lstatSync;
fs.lstatSync = (name, ...args) => {
  const st = original(name, ...args);
  return ${JSON.stringify(ancestors)}.includes(name) ? Object.assign(st, {uid: process.getuid(), mode: st.mode & ~0o022}) : st;
};
syncBuiltinESMExports();\n`);
  vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(bootstrap).href}`);
  root = join(sandbox, 'forge'); source = join(sandbox, 'bundles');
  fs.mkdirSync(source);
  for (const name of payloads) fs.writeFileSync(join(source, name), '#!/usr/bin/env node\n// ' + name + '\n', {mode: 0o755});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(sandbox, {recursive: true, force: true});
});

it('preserves the complete S0 state writer and untrusted-directory refusals byte for byte', () => {
  const start = setup.indexOf('        # S0:');
  const end = setup.indexOf('\n    finally:\n        os.close(dest)', start);
  expect(createHash('sha256').update(setup.slice(start, end)).digest('hex'))
    .toBe('78e4c7cef1e4570415bea844c63bc1aa72f2c80dfcc9700400fdd9f7309cb3d4');
});
it('dry-run install validates the set without creating the deploy root', () => {
  expect(run('install', {sha: a, dryRun: true})).toEqual({installed: a, dryRun: true});
  expect(fs.existsSync(root)).toBe(false);
});
it.each([0o020, 0o002])('refuses writable ancestor mode %s before creating the deploy root', bits => {
  fs.chmodSync(sandbox, 0o700 | bits);
  expect(() => install(a)).toThrow('untrusted directory: ' + sandbox);
  expect(fs.existsSync(root)).toBe(false);
});
it.each(['foreign', 'unreadable', 'symlink', 'group-writable', 'world-writable'])('refuses %s evidence at every ancestor, including /', kind => {
  const original = fs.lstatSync.getMockImplementation();
  const ancestors = [];
  for (let parent = sandbox; ; parent = dirname(parent)) {
    ancestors.push(parent);
    if (parent === dirname(parent)) break;
  }
  for (const ancestor of ancestors) {
    fs.lstatSync.mockImplementation((name, ...args) => {
      const st = original(name, ...args);
      if (name !== ancestor) return st;
      if (kind === 'unreadable') throw new Error('unreadable ancestor');
      if (kind === 'symlink') return {...st, isDirectory: () => false, isSymbolicLink: () => true};
      if (kind.endsWith('writable')) return Object.assign(st, {mode: st.mode | (kind === 'group-writable' ? 0o020 : 0o002)});
      return Object.assign(st, {uid: process.getuid() + 1});
    });
    expect(() => install(a)).toThrow(kind === 'symlink' ? 'unsafe directory' : kind === 'unreadable' ? 'unreadable ancestor' : 'untrusted directory');
    expect(fs.existsSync(root)).toBe(false);
  }
});
it('requires root ownership without an explicit test root override', () => {
  const original = fs.lstatSync.getMockImplementation();
  fs.lstatSync.mockImplementation((name, ...args) => Object.assign(original(name, ...args), {uid: 1}));
  expect(() => deploy({command: 'preflight'})).toThrow('untrusted directory: /;');
});
it('preflight creates a trusted initial layout, takes and releases the lock, and refuses a held lock', () => {
  expect(run('preflight')).toEqual({preflight: true});
  expect(fs.readdirSync(root)).toEqual(['versions']);
  fs.mkdirSync(join(root, '.deploy-lock'));
  expect(() => run('preflight')).toThrow('inspect');
  expect(fs.existsSync(join(root, '.deploy-lock'))).toBe(true);
  expect(() => run('preflight', {dryRun: true})).toThrow('omit --dry-run');
});
it.each(['ancestor', 'root', 'symlink'])('preflight refuses an unsafe %s before acquiring a lock', kind => {
  fs.mkdirSync(root);
  if (kind === 'ancestor') fs.chmodSync(sandbox, 0o722);
  else if (kind === 'root') fs.chmodSync(root, 0o777);
  else { fs.rmdirSync(root); fs.symlinkSync(source, root); }
  expect(() => run('preflight')).toThrow(kind === 'symlink' ? 'unsafe directory' : 'untrusted directory');
  expect(fs.existsSync(join(root, '.deploy-lock'))).toBe(false);
  expect(fs.readdirSync(source).sort()).toEqual([...payloads].sort());
});
it.each(['switch', 'rollback'])('%s refuses each unsafe payload without changing the pointer or record', command => {
  install(a); install(b);
  run('switch', {sha: b});
  if (command === 'rollback') run('switch', {sha: a});
  const record = fs.readFileSync(join(root, 'deploy.json'));
  const pointer = current();
  for (const name of payloads) {
    const file = join(root, 'versions', command === 'switch' ? a : b, name);
    for (const bits of [0o020, 0o002]) {
      fs.chmodSync(file, 0o755 | bits);
      expect(() => run(command, {sha: a})).toThrow('untrusted payload');
      fs.chmodSync(file, 0o755);
    }
    fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file);
    expect(() => run(command, {sha: a})).toThrow();
    fs.unlinkSync(file); fs.renameSync(file + '.saved', file);
    const original = fs.fstatSync;
    const spy = vi.spyOn(fs, 'fstatSync').mockImplementation(fd => {
      const st = original(fd);
      return st.ino === fs.statSync(file).ino ? Object.assign(st, {uid: process.getuid() + 1}) : st;
    });
    expect(() => run(command, {sha: a})).toThrow('untrusted payload');
    spy.mockRestore();
    expect(current()).toBe(pointer);
    expect(fs.readFileSync(join(root, 'deploy.json'))).toEqual(record);
    expect(fs.existsSync(join(root, '.deploy-lock'))).toBe(false);
  }
});
it('copies the complete set, stages then publishes it, and keeps existing versions immutable', () => {
  install(a);
  expect(run('status')).toEqual({current: null, previous: null});
  expect(fs.readdirSync(root)).toEqual(['versions']);
  for (const name of payloads) {
    expect(fs.readFileSync(join(root, 'versions', a, name))).toEqual(fs.readFileSync(join(source, name)));
    expect(fs.statSync(join(root, 'versions', a, name)).mode & 0o777).toBe(0o755);
  }
  install(a); // Identical setup reruns are safe.
  fs.writeFileSync(join(source, payloads[0]), 'changed');
  expect(() => install(a)).toThrow('different bytes');
  expect(fs.readFileSync(join(root, 'versions', a, payloads[0]), 'utf8')).toContain('#!/usr/bin/env node');
});
it('switch publishes current with one rename and exposes only a complete old or new set', () => {
  install(a); install(b); run('switch', {sha: a});
  let observed = false;
  const originalRename = fs.renameSync;
  let pointerRenames = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === join(root, 'current')) pointerRenames++;
    return originalRename(from, to);
  });
  run('switch', {sha: b, beforeSwitchRename() {
    observed = true;
    expect(current()).toBe(`versions/${a}`);
    const temporary = fs.readdirSync(root).filter(name => name.startsWith('.current-'));
    expect(temporary).toHaveLength(1);
    expect(fs.readlinkSync(join(root, temporary[0]))).toBe(`versions/${b}`);
    for (const name of payloads) expect(fs.readFileSync(join(root, 'current', name))).toEqual(fs.readFileSync(join(source, name)));
  }, afterSwitchRename() { expect(current()).toBe(`versions/${b}`); }});
  expect(observed).toBe(true);
  expect(run('status')).toEqual({current: b, previous: a});
  expect(pointerRenames).toBe(1);
  expect(fs.readdirSync(root).sort()).toEqual(['current', 'deploy.json', 'versions']);
});
it('failed install leaves old current and its record untouched', () => {
  install(a); run('switch', {sha: a});
  const record = fs.readFileSync(join(root, 'deploy.json'));
  fs.unlinkSync(join(source, payloads[4]));
  expect(() => install(b)).toThrow();
  expect(current()).toBe(`versions/${a}`);
  expect(fs.readFileSync(join(root, 'deploy.json'))).toEqual(record);
  expect(fs.readdirSync(join(root, 'versions'))).toEqual([a]);
});
it('rollback refuses without previous, switches back, and never deletes active or prior versions', () => {
  install(a);
  expect(() => run('rollback')).toThrow('no previous');
  run('switch', {sha: a});
  expect(() => run('rollback')).toThrow('no previous');
  install(b); run('switch', {sha: b});
  const record = fs.readFileSync(join(root, 'deploy.json'));
  expect(run('rollback', {dryRun: true}).target).toBe(a);
  expect(current()).toBe(`versions/${b}`);
  expect(fs.readFileSync(join(root, 'deploy.json'))).toEqual(record);
  expect(run('rollback')).toEqual({current: a, previous: b});
  expect(fs.readdirSync(join(root, 'versions')).sort()).toEqual([b, a].sort());
  expect(fs.realpathSync(join(root, 'current', payloads[0]))).toBe(join(root, 'versions', a, payloads[0]));
});
it.each(['../abcdef0', '..', '/abcdef0', 'abcdef0/x', 'abcdef0\\x', 'abc123', 'g'.repeat(40), 'a'.repeat(65)])
('refuses invalid or oversized sha %s before creating anything', value => {
  for (const command of ['install', 'switch']) expect(() => run(command, {sha: value})).toThrow('7-64 hex');
  expect(fs.existsSync(root)).toBe(false);
});
it('rejects symlinked root parents, versions, targets and payloads without writing outside root', () => {
  const alias = join(sandbox, 'alias'); fs.symlinkSync(source, alias);
  expect(() => deploy({command: 'install', root: join(alias, 'escape'), source, sha: a})).toThrow('unsafe directory');
  expect(() => deploy({command: 'install', root: sandbox + '/../escape', source, sha: a})).toThrow('traversal');
  install(a); run('switch', {sha: a});
  fs.symlinkSync(source, join(root, 'versions', b));
  expect(() => run('switch', {sha: b})).toThrow('unsafe directory');
  fs.unlinkSync(join(root, 'versions', b));
  fs.renameSync(join(root, 'versions'), join(root, 'saved'));
  fs.symlinkSync(join(root, 'saved'), join(root, 'versions'));
  expect(() => run('switch', {sha: a})).toThrow('unsafe directory');
  fs.unlinkSync(join(root, 'versions')); fs.renameSync(join(root, 'saved'), join(root, 'versions'));
  fs.unlinkSync(join(source, payloads[0])); fs.symlinkSync(join(root, 'versions', a, payloads[0]), join(source, payloads[0]));
  expect(() => install(b)).toThrow();
  expect(current()).toBe(`versions/${a}`);
  expect(fs.existsSync(join(source, 'escape'))).toBe(false);
});
it.each(['beforeSwitchRename', 'afterSwitchRename', 'afterStateWrite'])('recovers intent after a real process crash at %s', point => {
  install(a); run('switch', {sha: a});
  fs.writeFileSync(join(source, payloads[0]), 'distinct crash-recovery version');
  install(b);
  const code = `import {deploy} from ${JSON.stringify(moduleURL.href)}; deploy({root:${JSON.stringify(root)}, command:'switch', stateDir:${JSON.stringify(join(sandbox, 'state'))}, sha:'${b}', ${point}(){process.exit(42)}});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
  expect(child.status, child.stderr).toBe(42);
  const switched = point !== 'beforeSwitchRename';
  expect(current()).toBe(`versions/${switched ? b : a}`);
  expect(() => run('status')).toThrow('inspect');
  expect(() => run('switch', {sha: b})).toThrow('inspect');
  // Operator inspects the abandoned lock after the process has exited.
  fs.rmdirSync(join(root, '.deploy-lock'));
  const pending = fs.readFileSync(join(root, 'deploy.json'));
  expect(() => run('status', {dryRun: true})).toThrow('retry without --dry-run');
  expect(fs.readFileSync(join(root, 'deploy.json'))).toEqual(pending);
  const active = {current: switched ? b : a, previous: switched ? a : null};
  expect(run('status')).toEqual(active);
  expect(JSON.parse(fs.readFileSync(join(root, 'deploy.json')))).toEqual({schema: 1, ...active});
  const digest = createHash('sha256');
  for (const name of [...payloads].sort()) digest.update(name + '\0' + createHash('sha256')
    .update(fs.readFileSync(join(root, 'current', name))).digest('hex') + '\n');
  const telemetry = fs.readFileSync(join(sandbox, 'state', 'state.json'));
  expect(JSON.parse(telemetry).setDigest).toBe(digest.digest('hex'));
  expect(run('status')).toEqual(active);
  expect(fs.readFileSync(join(sandbox, 'state', 'state.json'))).toEqual(telemetry);
  if (switched) expect(run('rollback').current).toBe(a);
  else expect(run('switch', {sha: b}).previous).toBe(a);
});
it('fails closed on missing targets, malformed/oversized records and unsafe current links', () => {
  install(a);
  expect(() => run('switch', {sha: b})).toThrow('not installed');
  fs.writeFileSync(join(root, 'deploy.json'), '{}'); expect(() => run('status')).toThrow('invalid deploy record');
  fs.writeFileSync(join(root, 'deploy.json'), 'x'.repeat(4097)); expect(() => run('status')).toThrow('inspect');
  fs.unlinkSync(join(root, 'deploy.json')); fs.symlinkSync(source, join(root, 'current'));
  expect(() => run('status')).toThrow('escapes');
});
it('CLI supports install, switch, status, rollback refusal and unknown-option refusal', () => {
  const cli = args => spawnSync(process.execPath, [fileURLToPath(moduleURL), ...args, '--root', root, '--state-dir', join(sandbox, 'state')], {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
  expect(cli(['install', '--sha', a, '--source', source, '--dry-run']).status).toBe(0);
  expect(fs.existsSync(root)).toBe(false);
  expect(cli(['preflight']).status).toBe(0);
  expect(fs.existsSync(join(root, '.deploy-lock'))).toBe(false);
  expect(cli(['install', '--sha', a, '--source', source]).status).toBe(0);
  expect(cli(['switch', '--sha', a]).status).toBe(0);
  expect(JSON.parse(cli(['status']).stdout)).toEqual({current: a, previous: null});
  expect(cli(['rollback']).stderr).toContain('no previous');
  expect(cli(['status', '--unknown']).status).toBe(1);
});

it('setup wiring installs the host helper and fixed symlinks and supports a second provisioning pass', () => {
  const libexec = join(sandbox, 'libexec'); fs.mkdirSync(libexec);
  const start = setup.indexOf("import os, sys, secrets, hashlib, subprocess", setup.indexOf("<<'DEPLOY'"));
  const end = setup.indexOf('\nDEPLOY', start);
  const block = setup.slice(start, end)
    .replaceAll('/usr/local/libexec', libexec)
    .replaceAll('"/usr/local"', JSON.stringify(sandbox))
    .replaceAll('st.st_uid != 0', 'st.st_uid != os.getuid()')
    .replace('import os, sys, secrets, hashlib, subprocess', `import os, sys, secrets, hashlib, subprocess
os.fchown = lambda fd, uid, gid: None
original_run = subprocess.run
def run(args, **kwargs):
    return original_run([${JSON.stringify(process.execPath)}] + args[1:] + ["--root", ${JSON.stringify(join(libexec, 'forge'))}, "--state-dir", ${JSON.stringify(join(sandbox, 'state'))}], **kwargs)
subprocess.run = run`);
  for (let pass = 0; pass < 2; pass++) {
    // First provisioning publishes legacy files; repeats preserve the layout.
    for (const name of pass === 0 ? payloads : []) {
      const file = join(libexec, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.copyFileSync(join(source, name), file);
    }
    const result = spawnSync('python3', ['-c', block, fileURLToPath(moduleURL)], {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
    expect(result.status, result.stderr).toBe(0);
    for (const name of payloads) {
      expect(fs.readlinkSync(join(libexec, name))).toBe('forge/current/' + name);
      expect(fs.readFileSync(join(libexec, name))).toEqual(fs.readFileSync(join(source, name)));
    }
  }
});

it('rejects oversized payloads with an operator-visible inspection fallback', () => {
  fs.truncateSync(join(source, payloads[0]), 8 * 1024 * 1024 + 1);
  expect(() => run('install', {sha: a, dryRun: true})).toThrow('inspect');
  expect(fs.existsSync(root)).toBe(false);
});
it('actual setup bundles execute cache-prune and sweep CLI guards through fixed symlinks', () => {
  const start = setup.indexOf('        import re, json');
  const end = setup.indexOf('        installed = ', start);
  const bundler = setup.slice(start, end).split('\n').map(line => line.slice(8)).join('\n');
  const output = spawnSync('python3', ['-c', 'import os, sys\n' + bundler +
    '\nfor name in ["forge-cache-prune.mjs", "forge-exec-sweep.mjs"]:\n    open(os.path.join(sys.argv[2], name), "w").write(bundle(name))',
    fileURLToPath(new URL('../forge-exec-run.mjs', import.meta.url)), source],
  {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
  expect(output.status, output.stderr).toBe(0);
  install(a); run('switch', {sha: a});
  for (const name of ['forge-cache-prune.mjs', 'forge-exec-sweep.mjs']) {
    const link = join(sandbox, name); fs.symlinkSync(join(root, 'current', name), link);
    const result = spawnSync(process.execPath, [link, '--invalid-s1-probe'], {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
    expect(result.status, result.stderr).toBe(name === 'forge-cache-prune.mjs' ? 1 : 2);
    expect(result.stderr).toContain('--invalid-s1-probe');
  }
});

it.each(['foreign', 'writable', 'directory', 'symlink'])('install refuses %s source payloads before publishing a version', kind => {
  const file = join(source, payloads[0]);
  if (kind === 'foreign') {
    const original = fs.fstatSync;
    const ino = fs.statSync(file).ino;
    vi.spyOn(fs, 'fstatSync').mockImplementation(fd => {
      const st = original(fd);
      return st.ino === ino ? Object.assign(st, {uid: process.getuid() + 1}) : st;
    });
  } else if (kind === 'writable') fs.chmodSync(file, 0o666);
  else {
    fs.renameSync(file, file + '.saved');
    if (kind === 'directory') fs.mkdirSync(file);
    else fs.symlinkSync(file + '.saved', file);
  }
  expect(() => install(a)).toThrow();
  expect(fs.readdirSync(join(root, 'versions'))).toEqual([]);
});
it.each(['regular-current', 'escaping-current', 'missing-current', 'json', 'null', 'schema', 'missing-key',
  'missing-previous', 'missing-record-current', 'pending', 'oversized', 'record-symlink', 'record-writable', 'disagreement'])
('preflight refuses corrupt %s evidence and releases its lock', kind => {
  install(a); run('switch', {sha: a});
  const link = join(root, 'current'), file = join(root, 'deploy.json');
  const record = {schema: 1, current: a, previous: null};
  if (kind.endsWith('current') && ['regular-current', 'escaping-current', 'missing-current'].includes(kind)) {
    fs.unlinkSync(link);
    if (kind === 'regular-current') fs.writeFileSync(link, a);
    else fs.symlinkSync(kind === 'escaping-current' ? '../outside' : 'versions/' + b, link);
  } else if (kind === 'json') fs.writeFileSync(file, '{');
  else if (kind === 'null') fs.writeFileSync(file, 'null');
  else if (kind === 'oversized') fs.writeFileSync(file, 'x'.repeat(4097));
  else if (kind === 'record-symlink') { fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file); }
  else if (kind === 'record-writable') fs.chmodSync(file, 0o666);
  else {
    if (kind === 'schema') record.schema = 2;
    if (kind === 'missing-key') delete record.previous;
    if (kind === 'missing-previous') record.previous = b;
    if (kind === 'missing-record-current') record.current = b;
    if (kind === 'pending') record.pending = b;
    if (kind === 'disagreement') record.current = null;
    fs.writeFileSync(file, JSON.stringify(record));
  }
  expect(() => run('preflight')).toThrow();
  expect(fs.existsSync(join(root, '.deploy-lock'))).toBe(false);
});
it('switch and rollback publish the switched bytes digest and S0 telemetry schema atomically', () => {
  install(a);
  fs.writeFileSync(join(source, payloads[0]), 'new version'); install(b);
  const original = fs.renameSync;
  let publications = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === join(sandbox, 'state', 'state.json')) {
      expect(fs.statSync(from).mode & 0o777).toBe(0o644);
      publications++;
    }
    return original(from, to);
  });
  for (const target of [a, b, a]) {
    if (publications === 2) run('rollback'); else run('switch', {sha: target});
    const state = JSON.parse(fs.readFileSync(join(sandbox, 'state', 'state.json')));
    const hash = createHash('sha256');
    for (const name of [...payloads].sort()) hash.update(name + '\0' + createHash('sha256').update(fs.readFileSync(join(root, 'versions', target, name))).digest('hex') + '\n');
    expect(state).toEqual({schema: 1, forgeSetSha: null, setDigest: hash.digest('hex'), hostTier: 1,
      installedAtET: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}-0[45]:00$/)});
    expect(fs.readdirSync(join(sandbox, 'state'))).toEqual(['state.json']);
  }
  expect(publications).toBe(3);
});
it.each(['symlink', 'foreign', 'group-write', 'world-write', 'rename'])
('state writer refuses %s evidence and rolls back the link and deploy record', kind => {
  install(a); install(b); run('switch', {sha: a});
  const stateDir = join(sandbox, 'state');
  const before = fs.readFileSync(join(root, 'deploy.json'));
  const beforeState = fs.readFileSync(join(stateDir, 'state.json'));
  if (kind === 'symlink') { fs.renameSync(stateDir, stateDir + '.saved'); fs.symlinkSync(stateDir + '.saved', stateDir); }
  if (kind.endsWith('write')) fs.chmodSync(stateDir, kind === 'group-write' ? 0o775 : 0o757);
  if (kind === 'foreign') {
    const original = fs.lstatSync.getMockImplementation();
    fs.lstatSync.mockImplementation((name, ...args) => {
      const st = original(name, ...args);
      return name === stateDir ? Object.assign(st, {uid: process.getuid() + 1}) : st;
    });
  }
  if (kind === 'rename') {
    const original = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === join(stateDir, 'state.json')) throw new Error('state publication failed');
      return original(from, to);
    });
  }
  expect(() => run('switch', {sha: b})).toThrow();
  expect(current()).toBe('versions/' + a);
  expect(fs.readFileSync(join(root, 'deploy.json'))).toEqual(before);
  expect(fs.readFileSync(join(stateDir, 'state.json'))).toEqual(beforeState);
  expect(fs.existsSync(join(root, '.deploy-lock'))).toBe(false);
});
it('failed first state publication restores an absent current link', () => {
  install(a);
  const stateDir = join(sandbox, 'bad-state'); fs.mkdirSync(stateDir, {mode: 0o777}); fs.chmodSync(stateDir, 0o777);
  expect(() => run('switch', {sha: a, stateDir})).toThrow('untrusted directory');
  expect(fs.existsSync(join(root, 'current'))).toBe(false);
  expect(run('status')).toEqual({current: null, previous: null});
});

it.each([false, true])('repeat setup stages bundles and preserves all live entry links when rejected=%s', reject => {
  const libexec = join(sandbox, 'libexec'); fs.mkdirSync(libexec);
  root = join(libexec, 'forge');
  install(a); run('switch', {sha: a});
  for (const name of payloads) fs.symlinkSync('forge/current/' + name, join(libexec, name));
  const before = payloads.map(name => fs.readFileSync(join(libexec, name)));
  const inodes = payloads.map(name => fs.lstatSync(join(libexec, name)).ino);
  const start = setup.indexOf('import os, sys, secrets, tempfile', setup.indexOf("<<'WRAPPER'"));
  const end = setup.indexOf('\nWRAPPER', start);
  const block = setup.slice(start, end)
    .replaceAll('/usr/local/libexec', libexec)
    .replaceAll('"/usr/local"', JSON.stringify(sandbox))
    .replaceAll('st.st_uid != 0', 'st.st_uid != os.getuid()')
    .replace('stage = None', `stage = None
import subprocess
os.fchown = lambda fd, uid, gid: None
original_rename = os.rename
def rename(src, dst, **kwargs):
    assert dst not in ${JSON.stringify(payloads)} or kwargs.get("dst_dir_fd") != dest, "individual live entry publication refused"
    return original_rename(src, dst, **kwargs)
os.rename = rename
original_run = subprocess.run
def run(args, **kwargs):
    if args[2] == "install":
        stage = args[args.index("--source") + 1]
        assert all(os.path.isfile(os.path.join(stage, name)) for name in ${JSON.stringify(payloads)})
        ${reject ? 'raise RuntimeError("injected deployment rejection")' : 'pass'}
    return original_run([${JSON.stringify(process.execPath)}] + args[1:] + ["--root", ${JSON.stringify(root)}, "--state-dir", ${JSON.stringify(join(sandbox, 'state'))}], **kwargs)
subprocess.run = run`);
  const output = spawnSync('python3', ['-c', block, fileURLToPath(new URL('../forge-exec-run.mjs', import.meta.url))],
    {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
  expect(output.status, output.stderr).toBe(reject ? 1 : 0);
  if (reject) expect(output.stderr).toContain('injected deployment rejection');
  for (const [i, name] of payloads.entries()) {
    expect(fs.readlinkSync(join(libexec, name))).toBe('forge/current/' + name);
    expect(fs.lstatSync(join(libexec, name)).ino).toBe(inodes[i]);
    if (reject) expect(fs.readFileSync(join(libexec, name))).toEqual(before[i]);
    else expect(fs.readFileSync(join(libexec, name), 'utf8')).toContain('#!/usr/bin/env node');
  }
  expect(current() === 'versions/' + a).toBe(reject);
  expect(fs.readdirSync(libexec).some(name => name.startsWith('.forge-bundle-'))).toBe(false);
});

it('pending recovery refuses unsafe telemetry storage, preserves intent, and retries from the surviving link', () => {
  install(a); run('switch', {sha: a});
  fs.writeFileSync(join(source, payloads[0]), 'recovery target'); install(b);
  fs.unlinkSync(join(root, 'current')); fs.symlinkSync('versions/' + b, join(root, 'current'));
  const pending = JSON.stringify({schema: 1, current: a, previous: null, pending: b});
  fs.writeFileSync(join(root, 'deploy.json'), pending);
  const stateDir = join(sandbox, 'state');
  const stale = fs.readFileSync(join(stateDir, 'state.json'));
  fs.chmodSync(stateDir, 0o777);
  expect(() => run('status')).toThrow('untrusted directory');
  expect(current()).toBe('versions/' + b);
  expect(fs.readFileSync(join(root, 'deploy.json'), 'utf8')).toBe(pending);
  expect(fs.readFileSync(join(stateDir, 'state.json'))).toEqual(stale);
  expect(fs.existsSync(join(root, '.deploy-lock'))).toBe(false);
  fs.chmodSync(stateDir, 0o755);
  expect(run('preflight')).toEqual({preflight: true});
  expect(run('status')).toEqual({current: b, previous: a});
  const digest = createHash('sha256');
  for (const name of [...payloads].sort()) digest.update(name + '\0' + createHash('sha256')
    .update(fs.readFileSync(join(root, 'current', name))).digest('hex') + '\n');
  expect(JSON.parse(fs.readFileSync(join(stateDir, 'state.json'))).setDigest).toBe(digest.digest('hex'));
});
