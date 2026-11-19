// @vitest-environment node
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildManifest, runRemote, defaultExec, FORGE_MANIFEST_SIZE_EXCEPTIONS } from '../remote-exec.mjs';
import { resolveAdmissionPolicy, formatAdmissionPolicy } from '../heavy-admission.mjs';

let root, cwd, env, log;
const git = args => {
  const result = spawnSync('git', args, { cwd, env, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const write = (path, content) => fs.writeFile(join(cwd, path), content);
const commit = () => { git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); };
const build = options => buildManifest({ cwd, env, manifestMode: 'tracked', ...options });
const lines = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR, 'forge-tracked-')));
  cwd = join(root, 'repo'); await fs.mkdir(cwd);
  log = join(root, 'refusals.jsonl');
  env = { ...process.env, FORGE_MANIFEST_REFUSALS_LOG: log };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  git(['init', '-q']);
  await write('clean.txt', 'clean\n'); await write('package-lock.json', '{}');
  await write('.gitignore', 'coverage/\nignored/\n'); commit();
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

async function fallback(reason, options = {}) {
  const calls = [];
  const result = await runRemote({ cwd, env, manifestMode: 'tracked', argv: ['npx', 'vitest', 'run', 'clean.test.mjs'],
    log: () => {}, sshOptions: [], exec: async call => {
      calls.push(call);
      if (call.file === 'git') return defaultExec(call);
      if (call.file === 'ssh' && call.args.at(-1) === 'true') return { code: 0, stdout: Buffer.alloc(0) };
      if (call.file === 'ssh' && call.args.at(-1).endsWith(' bases')) return { code: 254, stdout: Buffer.alloc(0) };
      throw new Error('Remote dispatch must not start');
    }, ...options });
  expect(result).toMatchObject({ mode: 'not-started', terminated: true, reason });
  expect(calls.some(call => call.file === 'rsync' || call.file === 'ssh' && / (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
  return result;
}

it('admits a clean HEAD blob with the existing manifest hash', async () => {
  const manifest = await build();
  expect(manifest.entries.find(entry => entry.path.toString() === 'clean.txt')).toMatchObject({
    tracked: true, executable: false, sha256: createHash('sha256').update('clean\n').digest('hex'),
  });
});
it('untracked file falls back locally without dispatch and logs its path and HEAD', async () => {
  await write('scratch.txt', 'private'); await fallback('untracked');
  expect(await lines()).toEqual([expect.objectContaining({ mode: 'tracked', shadow: false, reason: 'untracked', path: 'scratch.txt', head: git(['rev-parse', 'HEAD']) })]);
});
it('staged-only addition falls back as untracked', async () => {
  await write('added.txt', 'new'); git(['add', 'added.txt']); await fallback('untracked');
});
it('dirty tracked bytes fall back without dispatch', async () => { await write('clean.txt', 'changed'); await fallback('dirty'); });
it('exec-bit flip falls back as dirty even with core.fileMode disabled', async () => {
  git(['config', 'core.fileMode', 'false']); await fs.chmod(join(cwd, 'clean.txt'), 0o755); await fallback('dirty');
});
it('missing tracked file fails closed as dirty', async () => { await fs.unlink(join(cwd, 'clean.txt')); await fallback('dirty'); });
it('caps files at 1 MiB and requires both exception path and HEAD oid', async () => {
  await write('large.txt', 'x'.repeat(1048577)); commit();
  await fallback('oversize');
  const oid = git(['rev-parse', 'HEAD:large.txt']);
  await expect(build({ sizeExceptions: [{ path: 'large.txt', oid }] })).resolves.toHaveProperty('entries');
  await expect(build({ sizeExceptions: [{ path: 'large.txt', oid: '0'.repeat(40) }] })).rejects.toMatchObject({ code: 'oversize' });
  await expect(build({ sizeExceptions: [{ path: 'other.txt', oid }] })).rejects.toMatchObject({ code: 'oversize' });
  expect(Object.isFrozen(FORGE_MANIFEST_SIZE_EXCEPTIONS)).toBe(true);
});
it('total byte cap refuses with an operator-visible local fallback error', async () => {
  await expect(build({ totalCap: 1 })).rejects.toMatchObject({ code: 'total-oversize', message: 'total-oversize: use local fallback' });
});
it('non-allowlisted binary falls back as binary-type', async () => { await write('binary.dat', Buffer.from([255, 254])); commit(); await fallback('binary-type'); });
it('allowlisted WebP binary is admitted', async () => {
  await write('image.webp', Buffer.from([255, 254])); commit();
  expect((await build()).entries.some(entry => entry.path.toString() === 'image.webp')).toBe(true);
});

const location = () => ({ start: { line: 1, column: 0 }, end: { line: 1, column: 5 } });
const coverageEntry = path => ({ path, statementMap: { 0: location() }, fnMap: { 0: { name: 'clean', decl: location(), loc: location(), line: 1 } },
  branchMap: { 0: { type: 'if', loc: location(), locations: [location()], line: 1 } }, s: { 0: 1 }, f: { 0: 0 }, b: { 0: [1] } });
async function coverage(value) { await fs.mkdir(join(cwd, 'coverage'), { recursive: true }); await write('coverage/coverage-final.json', JSON.stringify(value)); }
it.each(['text field', 'crafted counters'])('never ships forged coverage with %s in tracked mode', async fault => {
  const entry = coverageEntry('clean.txt');
  if (fault === 'text field') entry.text = 'private text';
  else entry.s[0] = 126879297332596; // Reversibly encodes "secret" despite being a safe integer.
  await coverage({ 'clean.txt': entry });
  const manifest = await build();
  expect(manifest.entries.map(entry => entry.path.toString())).not.toContain('coverage/coverage-final.json');
  for (const options of [
    { argv: ['npm', 'run', 'check:standards'] },
    { env: { ...env, DIFF_COVERAGE_BASE: git(['rev-parse', 'HEAD']) } },
  ]) await fallback('coverage-local', options);
  expect(await lines()).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
    mode: 'tracked', shadow: false, reason: 'coverage-local', path: 'coverage/coverage-final.json', head: git(['rev-parse', 'HEAD']),
  })));
});
it.each(['untracked', 'staged', 'HEAD'])('omits coverage even when %s rather than ignored', async state => {
  await write('.gitignore', 'ignored/\n'); commit();
  await coverage({ text: 'private' });
  if (state === 'staged') git(['add', 'coverage/coverage-final.json']);
  if (state === 'HEAD') commit();
  expect((await build()).entries.map(entry => entry.path.toString())).not.toContain('coverage/coverage-final.json');
});
it('omits oversized and malformed coverage without reading it in tracked mode', async () => {
  await coverage({});
  await fs.truncate(join(cwd, 'coverage/coverage-final.json'), 64 * 1024 * 1024 + 1);
  const disk = { ...fs, readFile: async (path, ...args) => {
    if (path.toString().endsWith('/coverage/coverage-final.json')) throw new Error('Coverage must not be read');
    return fs.readFile(path, ...args);
  } };
  expect((await build({ fs: disk })).entries.map(entry => entry.path.toString())).not.toContain('coverage/coverage-final.json');
});
it('refuses an unsupported coverage file symlink without dispatch', async () => {
  await fs.mkdir(join(cwd, 'coverage'));
  await fs.symlink('../clean.txt', join(cwd, 'coverage/coverage-final.json'));
  git(['add', '-f', 'coverage/coverage-final.json']); commit();
  await fallback('unshipped-symlink');
});
it('coverage-consuming tracked commands fall back locally even when the report is absent', async () => {
  await fallback('coverage-local', { argv: ['npm', 'run', 'check:standards'] });
  expect(await lines()).toEqual([expect.objectContaining({ reason: 'coverage-local' })]);
});
it('legacy still ships ignored coverage with text and crafted counters with shadow on or off', async () => {
  const value = { 'clean.txt': { ...coverageEntry('clean.txt'), text: 'private', s: { 0: 126879297332596 } } };
  await coverage(value);
  const baseline = await build({ manifestMode: 'legacy' });
  expect(await build({ manifestMode: 'legacy', shadow: true })).toEqual(baseline);
  expect(baseline.entries.find(entry => entry.path.toString() === 'coverage/coverage-final.json')).toMatchObject({
    sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'), tracked: false,
  });
});
it('ignored tests retain the existing refusal', async () => {
  await fs.mkdir(join(cwd, 'ignored')); await write('ignored/a.test.mjs', 'test'); await fallback('ignored-test-file');
});
it('legacy manifest is identical with shadow on/off and still ships untracked bytes', async () => {
  await write('scratch.txt', 'private');
  const baseline = await build({ manifestMode: 'legacy', env: { ...env, FORGE_MANIFEST_SHADOW: '0' } });
  const shadow = await build({ manifestMode: 'legacy', shadow: true });
  expect(shadow).toEqual(baseline);
  expect(shadow.entries.some(entry => entry.path.toString() === 'scratch.txt')).toBe(true);
  expect(await lines()).toEqual([expect.objectContaining({ shadow: true, mode: 'legacy', reason: 'untracked', path: 'scratch.txt' })]);
});
it('legacy with real Git logs one clean shadow verdict', async () => {
  await build({ manifestMode: 'legacy', shadow: true });
  expect(await lines()).toEqual([expect.objectContaining({ shadow: true, reason: null })]);
});
it('legacy with injected exec preserves the pre-shadow exec call sequence', async () => {
  const calls = [];
  const exec = call => { calls.push({ file: call.file, args: call.args }); return defaultExec(call); };
  const baseline = await build({ manifestMode: 'legacy', exec, env: { ...env, FORGE_MANIFEST_SHADOW: '0' } });
  const expected = calls.splice(0);
  expect(expected.length).toBeGreaterThan(0);
  expect(await build({ manifestMode: 'legacy', exec })).toEqual(baseline);
  expect(calls).toEqual(expected);
  expect(calls.some(call => call.args.includes('--full-tree'))).toBe(false);
  await expect(fs.stat(log)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('buildManifest defaults shadow off even with real IO', async () => {
  await build({ manifestMode: 'legacy' });
  await expect(fs.stat(log)).rejects.toMatchObject({ code: 'ENOENT' });
});
async function fakeTransport() {
  const bin = join(root, 'bin'), state = join(root, 'transport.json');
  await fs.mkdir(bin);
  // Real defaultExec and Git throughout. Only ssh/rsync executables are replaced;
  // their protected receipt echoes the request bindings just like the soak fixture.
  const script = `#!${process.execPath}
const fs = require('node:fs');
const stateFile = ${JSON.stringify(state)};
const command = process.argv.at(-1);
if (command === 'true') process.exit(0);
if (command.endsWith(' bases')) process.exit(254);
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (command.endsWith(' prepare')) {
    request.run = 'r-' + request.nonce;
    fs.writeFileSync(stateFile, JSON.stringify(request));
    console.log(JSON.stringify({run: request.run, capabilities: {commandClasses: 1}}));
  } else if (command.endsWith(' run')) {
    fs.writeFileSync(stateFile, JSON.stringify({...JSON.parse(fs.readFileSync(stateFile)), ...request}));
    console.log('Tests  1 passed (1)');
  } else if (command.endsWith(' finish')) {
    const s = JSON.parse(fs.readFileSync(stateFile));
    console.log(JSON.stringify({v: 1, nonce: s.nonce, run: s.run, inputDigest: s.inputDigest,
      argvDigest: s.argvDigest, lock: s.lock, manifestDigest: s.manifestDigest, phase: 'test', code: 0}));
  } else process.exit(1);
});
`;
  await fs.writeFile(join(bin, 'ssh'), script, { mode: 0o755 });
  await fs.writeFile(join(bin, 'rsync'), `#!${process.execPath}\nprocess.stdin.resume();\n`, { mode: 0o755 });
  vi.stubEnv('PATH', bin + ':' + process.env.PATH);
  await write('clean.test.mjs', '// selected test\n'); commit();
  await write('scratch.txt', 'untracked bytes');
  return async options => {
    const result = await runRemote({ cwd, env, manifestMode: 'legacy', argv: ['npx', 'vitest', 'run', 'clean.test.mjs'],
      transport: 'rsync', sshOptions: [], log: () => {}, ...options });
    expect(result).toMatchObject({ mode: 'remote', code: 0 });
    const request = JSON.parse(await fs.readFile(state, 'utf8'));
    expect(Buffer.from(request.manifest.paths, 'base64').toString().split('\0')).toContain('scratch.txt');
    return result;
  };
}
it('legacy runRemote with real Git and default IO logs the untracked shadow refusal and still runs remotely', async () => {
  const run = await fakeTransport();
  await run();
  expect(await lines()).toEqual([expect.objectContaining({ mode: 'legacy', shadow: true, reason: 'untracked', path: 'scratch.txt' })]);
});
it('legacy runRemote honors FORGE_MANIFEST_SHADOW=0 with real Git and default IO', async () => {
  const run = await fakeTransport();
  await run({ env: { ...env, FORGE_MANIFEST_SHADOW: '0' } });
  await expect(fs.stat(log)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('legacy runRemote with an injected exec adds no calls compared with shadow disabled', async () => {
  const run = await fakeTransport(), calls = [];
  const exec = call => {
    calls.push({ file: call.file, args: call.file === 'git' ? call.args : call.file === 'ssh' ? call.args.at(-1) : 'copy' });
    return defaultExec(call);
  };
  await run({ exec, env: { ...env, FORGE_MANIFEST_SHADOW: '0' } });
  const expected = calls.splice(0);
  await run({ exec });
  expect(calls).toEqual(expected);
  expect(calls.some(call => call.file === 'git' && call.args.includes('--full-tree'))).toBe(false);
  await expect(fs.stat(log)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['fs', 'listFiles'])('legacy runRemote with injected %s skips shadow even after Git binding', async kind => {
  const run = await fakeTransport();
  await run(kind === 'fs' ? { fs: { ...fs } }
    : { listFiles: async () => ['.gitignore', 'clean.txt', 'clean.test.mjs', 'package-lock.json', 'scratch.txt'] });
  await expect(fs.stat(log)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['fs', 'listFiles'])('legacy with injected %s skips shadow IO and logging', async kind => {
  const options = kind === 'fs' ? { fs: { ...fs } }
    : { listFiles: async () => ['.gitignore', 'clean.txt', 'package-lock.json'] };
  const baseline = await build({ ...options, manifestMode: 'legacy', env: { ...env, FORGE_MANIFEST_SHADOW: '0' } });
  expect(await build({ ...options, manifestMode: 'legacy' })).toEqual(baseline);
  await expect(fs.stat(log)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('log-write failure cannot alter a tracked refusal', async () => {
  await write('scratch.txt', 'private');
  await expect(build({ env: { ...env, FORGE_MANIFEST_REFUSALS_LOG: cwd } })).rejects.toMatchObject({ code: 'untracked' });
});
it('logs non-UTF-8 refusal paths losslessly as base64', async () => {
  const path = Buffer.from([0x78, 0xff]);
  // Some filesystem sandboxes refuse non-UTF-8 filenames. Supply the same raw Git
  // inventory record so the tracked refusal and log encoding still run unchanged.
  const exec = call => call.file === 'git' && call.args.includes('ls-files') && call.args.includes('-o')
    ? Promise.resolve({ code: 0, stdout: Buffer.concat([path, Buffer.from([0])]) }) : defaultExec(call);
  await expect(build({ exec })).rejects.toMatchObject({ code: 'untracked', manifestPath: path });
  expect((await lines())[0].path).toEqual({ base64: path.toString('base64') });
});
it('accepts SHA-256 repositories and hashes Git blobs with their object format', async () => {
  await fs.rm(join(cwd, '.git'), { recursive: true }); git(['init', '-q', '--object-format=sha256']); commit();
  await expect(build()).resolves.toHaveProperty('entries');
  await write('clean.txt', 'dirty'); await expect(build()).rejects.toMatchObject({ code: 'dirty' });
});
it('rejects malformed HEAD-tree evidence with a mode fallback', async () => {
  await fallback('mode', { exec: call => call.args.includes('--full-tree') ? Promise.resolve({ code: 0, stdout: Buffer.from('100600 blob ' + 'a'.repeat(40) + '\tclean.txt\0') })
    : call.file === 'git' ? defaultExec(call) : Promise.resolve({ code: 0, stdout: Buffer.alloc(0) }) });
});
it('resolves manifest setting through standard and platform with provenance', () => {
  expect(resolveAdmissionPolicy().settings.remote.manifest).toBe('legacy');
  for (const mode of ['tracked', 'legacy']) {
    const policy = resolveAdmissionPolicy({ platform: { remote: { manifest: mode } } });
    expect(policy.settings.remote.manifest).toBe(mode); expect(policy.invalid).toEqual([]);
    expect(formatAdmissionPolicy(policy)).toContain(`remote.manifest=${mode} (platform)`);
  }
  expect(resolveAdmissionPolicy({ platform: { remote: { manifest: 'unknown' } } }).invalid).toContain('platform.remote.manifest="unknown"');
});
it.each(['shared', 'private'])('env and checkout settings cannot downgrade platform tracked in a %s pool', pool => {
  const env = { WE_HEAVY_ADMISSION_REMOTE_MANIFEST: 'legacy', ...(pool === 'private' ? { LANE_POOL_ROOT: join(root, 'private-pool') } : {}) };
  for (const overrides of [{ env }, { env, tool: { remote: { manifest: 'legacy' } } }]) {
    const policy = resolveAdmissionPolicy({ platform: { remote: { manifest: 'tracked' } }, ...overrides });
    expect(policy.settings.remote.manifest).toBe('tracked');
    expect(policy.sources['remote.manifest']).toBe('platform');
    expect(formatAdmissionPolicy(policy)).toContain('remote.manifest=tracked (platform)');
    if (overrides.tool) expect(policy.ignored).toContainEqual(expect.stringContaining('tool.remote.manifest='));
  }
});

async function sibling(content, path = 'plugs/input.dat') {
  await write('vitest.shared.ts', "export const root = '../frontierui/plugs';\n"); commit();
  const main = cwd;
  cwd = join(root, 'frontierui');
  try {
    await fs.mkdir(join(cwd, 'plugs'), { recursive: true }); await fs.mkdir(join(cwd, 'webtheme'));
    git(['init', '-q']); await write(path, content); commit();
    return git(['rev-parse', `HEAD:${path}`]);
  } finally { cwd = main; }
}
it.each(['oversize', 'binary-type'])('tracked sibling refuses %s without dispatch and logs the manifest reason', async reason => {
  await sibling(reason === 'oversize' ? 'x'.repeat(1048577) : Buffer.from([255, 254]));
  await fallback(reason);
  expect(await lines()).toContainEqual(expect.objectContaining({ mode: 'tracked', reason, path: 'plugs/input.dat' }));
});
it('tracked sibling size exceptions require the exact path and oid', async () => {
  const oid = await sibling('x'.repeat(1048577));
  await expect(build({ sizeExceptions: [{ path: 'plugs/input.dat', oid }] })).resolves.toHaveProperty('siblings');
  for (const exception of [{ path: 'plugs/other.dat', oid }, { path: 'plugs/input.dat', oid: '0'.repeat(40) }])
    await expect(build({ sizeExceptions: [exception] })).rejects.toMatchObject({ code: 'oversize' });
});
it('tracked sibling and main files share the total byte cap', async () => {
  await sibling('x'.repeat(100));
  // Each inventory fits separately, but their combined bytes exceed this cap.
  await expect(build({ totalCap: 120 })).rejects.toMatchObject({ code: 'total-oversize' });
  expect(await lines()).toContainEqual(expect.objectContaining({ reason: 'total-oversize' }));
});
it('tracked sibling admits allowlisted binary assets', async () => {
  await sibling(Buffer.from([255, 254]), 'plugs/image.webp');
  expect((await build()).siblings.frontierui.entries[0].path.toString()).toBe('plugs/image.webp');
});
it.each(['oversize', 'binary'])('legacy sibling still ships %s bytes with the same inventory', async kind => {
  const content = kind === 'oversize' ? 'x'.repeat(1048577) : Buffer.from([255, 254]);
  await sibling(content);
  const manifest = await build({ manifestMode: 'legacy', env: { ...env, FORGE_MANIFEST_SHADOW: '0' }, totalCap: 1 });
  expect(manifest.siblings.frontierui.entries).toEqual([expect.objectContaining({ path: Buffer.from('plugs/input.dat'),
    sha256: createHash('sha256').update(content).digest('hex'), tracked: true })]);
  await expect(fs.stat(log)).rejects.toMatchObject({ code: 'ENOENT' });
});
