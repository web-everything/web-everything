// @vitest-environment node
/** @file Contract and execution tests for the Forge remote runner. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { constants, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync, statSync, readdirSync, renameSync, cpSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import {
  isAllowedCommand, filterEnv, validateRunId,
  runRemote as timedRunRemote, main as runRemoteCli, parseArgs,
} from '../remote-exec.mjs';
import { createRunner, digestInput, digestArgv } from '../forge-exec-run.mjs';
import * as remoteManifestAPI from '../remote-exec.mjs';
import * as forgeManifestAPI from '../forge-exec-run.mjs';
import { adaptLegacyRemoteResult, resolveAdmissionPolicy, runWithRemoteDecision } from '../heavy-admission.mjs';
import {materializeWorktree} from '../forge-exec-bases.mjs';
import {scanMaterializedGuards} from './fixtures/forge-git-guards.mjs';
import {cachedPublicGitExec} from './fixtures/forge-public-git.mjs';
import {scanDiffBranchCoverage} from '../../lib/diff-branch-coverage.mjs';

vi.mock('../forge-telemetry.mjs', async importOriginal => {
  const actual=await importOriginal();
  const {easternTimestamp}=await import('../forge-exec-run.mjs');
  return {...actual,readForgeTelemetry:async()=>({sampledAtET:easternTimestamp(Date.now()),
    cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]})};
});

// Retain every exact legacy/security assertion while checking the added result field.
async function runRemote(options) {
  const {timings, ...legacy} = await timedRunRemote(options);
  expect(Array.isArray(timings)).toBe(true);
  expect(timings.at(-1)).toMatchObject({stage:'total',ms:expect.any(Number),startedAtET:expect.any(String)});
  return legacy;
}

const argv = ['npm', 'run', 'test:unit', '--', 'a.test.mjs'];
const runId = 'abcdef-1';
const allowedEnv = {
  CI: 'true', NODE_ENV: 'test', TZ: 'UTC', LANG: 'C', LC_ALL: 'C', FORCE_COLOR: '0', NO_COLOR: '1',
};
const forbiddenEnv = {
  GITHUB_TOKEN: 'secret-token-marker', ANTHROPIC_API_KEY: 'secret-key-marker',
  SECRET: 'secret-secret-marker', PASSWORD: 'secret-password-marker',
  LOGIN: 'secret-login-marker', AUTH: 'secret-auth-marker',
  CREDENTIAL: 'secret-credential-marker', mixedCaseToken: 'secret-mixed-marker',
  HOME: 'private-home-marker', PATH: 'private-path-marker', OTHER: 'private-other-marker',
};
let cwd;
beforeEach(() => {
  // Task scratch must stay under the launcher-provided TMPDIR.
  cwd = realpathSync(mkdtempSync(join(process.env.TMPDIR, 'remote-exec-test-')));
  writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const sshText = (call) => call.args.join(' ');
const isCleanup = (call) => call.file === 'ssh' && sshText(call).endsWith(' finish');
const isReceipt = isCleanup;
const isPrepare = (call) => call.file === 'ssh' && sshText(call).endsWith(' prepare');
const isRun = (call) => call.file === 'ssh' && sshText(call).endsWith(' run');
const callsOf = (exec) => exec.mock.calls.map(([call]) => call);
const nonceOf = (input) => JSON.parse(input).nonce;

function fixture({ probeCode = 0, copyCode = 0, prepareCode = 0, runCode = 0, receipt, receiptCode = 0 } = {}) {
  let state;
  const exec = vi.fn(async (call) => {
    if (call.file === 'git') {
      if (call.args.join(' ') === 'rev-parse HEAD') return {code:0,stdout:Buffer.from('a'.repeat(40)+'\n')};
      if (call.args.includes('-i')) return {code:0, stdout:Buffer.alloc(0)};
      const files = ['package-lock.json', 'a.test.mjs'];
      const records = call.args.includes('--stage') ? files.map(name => {
        const content = readFileSync(join(cwd, name));
        const oid = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
        return `100644 ${oid} 0\t${name}`;
      }) : files;
      return { code: 0, stdout: Buffer.from(records.join('\0') + '\0') };
    }
    if (call.file === 'rsync') return { code: copyCode, stdout: '' };
    if (call.file === 'ssh' && sshText(call).endsWith(' bases')) return {code:254,stdout:''};
    if (isPrepare(call)) {
      state = JSON.parse(call.input);
      state.run = 'r-' + state.nonce;
      return { code: prepareCode, stdout: JSON.stringify({run: state.run, capabilities:{siblings:1,commandClasses:1,gitWorktree:2}}) };
    }
    if (isRun(call)) { state = {...state, ...JSON.parse(call.input)}; return {code: runCode, stdout: ''}; }
    if (isReceipt(call)) {
      const value = {v:1, nonce:state.nonce, run:state.run, inputDigest:state.inputDigest,
        argvDigest:state.argvDigest, lock:state.lock, manifestDigest:state.manifestDigest,
        ...(state.siblingShas ? {siblingShas:state.siblingShas} : {}), phase:'test', code:runCode};
      return {code:receiptCode, stdout: typeof receipt === 'function' ? receipt(state.nonce, value, state) : receipt ?? JSON.stringify(value)};
    }
    if (call.file === 'ssh' && call.args.at(-1) === 'true') return {code:probeCode, stdout:''};
    throw new Error(`Unexpected exec call: ${JSON.stringify(call)}`);
  });
  const local = vi.fn(async () => 7);
  const listFiles = vi.fn(async () => ['package-lock.json', 'a.test.mjs']);
  writeFileSync(join(cwd, 'a.test.mjs'), 'fixture');
  return {exec, local, listFiles, argv:[...argv], cwd, lockRoot:join(cwd,'heavy'), env:{...allowedEnv,...forbiddenEnv}, runId};
}
// Simulate umask 077 without changing the test worker's process-wide umask.
function restrictiveStageFs() {
  return {...filesystem,
    mkdir:(path, options) => filesystem.mkdir(path, {...options, mode:0o700}),
    writeFile:(path, data, options) => filesystem.writeFile(path, data, {...options, mode:0o600}),
  };
}
function expectStageModes(root, executable) {
  const visit = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory,name), st = statSync(path);
      if (st.isDirectory()) {
        expect(st.mode & 0o7777).toBe(0o755);
        visit(path);
      } else {
        expect(st.mode & 0o7777, `staged file must never remain 0600: ${name}`).not.toBe(0o600);
        expect(st.mode & 0o7777).toBe(path === join(root,executable) ? 0o755 : 0o644);
      }
    }
  };
  visit(root);
}
function expectNoSecrets(exec) {
  const transport = JSON.stringify(callsOf(exec).map(({args,input}) => ({args,input})));
  for (const value of Object.values(forbiddenEnv)) expect(transport).not.toContain(value);
}
function realRemoteFixture(files) {
  const f = fixture();
  f.listFiles.mockResolvedValue(files);
  const root = join(cwd, 'server');
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const npmCli = realpathSync(spawnSync('which', ['npm'], {encoding:'utf8'}).stdout.trim());
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const name of ['user.npmrc','global.npmrc']) writeFileSync(join(cwd,name),'');
  symlinkSync(process.execPath, join(bin,'node'));
  writeFileSync(join(bin,'npm'), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(npmCli)} --offline --cache=${quote(join(cwd,'npm-cache'))} --userconfig=${quote(join(cwd,'user.npmrc'))} --globalconfig=${quote(join(cwd,'global.npmrc'))} "$@"\n`, {mode:0o755});
  const runner = createRunner({testRoot:root, testPath:`${bin}:/usr/bin:/bin`});
  const runs = [];
  let serverRun;
  const fake = f.exec;
  f.exec = vi.fn(async call => {
    if (isPrepare(call)) {
      const result = await runner.prepare(JSON.parse(call.input));
      serverRun = result.run;
      return {code:0, stdout:JSON.stringify(result)};
    }
    if (call.file === 'rsync') {
      const args = call.args.filter((arg,i,all) => !arg.startsWith('--rsync-path=') && arg !== '-e' && all[i-1] !== '-e');
      args[args.length-1] = join(root,'runs',serverRun,'work') + '/';
      const result = spawnSync('rsync',args,{cwd:call.cwd,input:call.input,encoding:'utf8',timeout:10000});
      return {code:result.status,stdout:result.stdout};
    }
    if (isRun(call)) {
      const result = await runner.run(JSON.parse(call.input));
      runs.push({status:result.code,stdout:result.stdout,stderr:result.stderr});
      return {code:result.code,stdout:result.stdout};
    }
    if (isReceipt(call)) return {code:0,stdout:JSON.stringify(await runner.finish(JSON.parse(call.input)))};
    return fake(call);
  });
  return {...f,root,bin,runs, get serverRun(){return serverRun;}};
}

describe('remote snapshot regressions', () => {
  it.each(['root', 'workspace'].flatMap(kind => ['dependencies', 'devDependencies', 'optionalDependencies'].map(field => [kind, field])))
  ('matches clean npm after removing %s %s with an unchanged lock and a primed cache', async (kind, field) => {
    const files = ['package.json', 'package-lock.json', 'packages/worker/package.json', 'probe.cjs', 'dependency.tgz'];
    const source = join(cwd, 'source');
    mkdirSync(join(source, 'package'), {recursive:true});
    writeFileSync(join(source, 'package/package.json'), JSON.stringify({name:'cache-dependency', version:'1.0.0'}));
    const packed = spawnSync('tar', ['-czf', join(cwd, 'dependency.tgz'), '-C', source, 'package'], {encoding:'utf8'});
    expect(packed.status, packed.stderr).toBe(0);
    const manifest = {name:'fixture', version:'1.0.0', workspaces:['packages/*'], scripts:{'test:unit':'node probe.cjs'}};
    const worker = {name:'worker', version:'1.0.0'};
    const changed = kind === 'root' ? manifest : worker;
    changed[field] = {'cache-dependency':kind === 'root' ? 'file:dependency.tgz' : 'file:../../dependency.tgz'};
    mkdirSync(join(cwd, 'packages/worker'), {recursive:true});
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(cwd, 'packages/worker/package.json'), JSON.stringify(worker));
    writeFileSync(join(cwd, 'probe.cjs'), `
const {createRequire} = require('node:module');
const probe = createRequire(require('node:path').resolve(${JSON.stringify(kind === 'root' ? 'package.json' : 'packages/worker/package.json')}));
console.log('RESOLVED ' + probe('cache-dependency/package.json').version);
`);
    const f = realRemoteFixture(files);
    const locked = spawnSync(join(f.bin, 'npm'), ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd, encoding:'utf8', timeout:20000});
    expect(locked.status, locked.stderr).toBe(0);
    const lock = readFileSync(join(cwd, 'package-lock.json'));
    const lockHash = createHash('sha256').update(lock).digest('hex');
    for (const state of ['cold', 'warm']) {
      expect(await runRemote(f), `${state}: ${f.runs.at(-1)?.stderr}`).toEqual({mode:'remote', code:0});
      expect(f.runs.at(-1).stdout).toContain('RESOLVED 1.0.0');
      expect(readdirSync(join(f.root, 'cache', lockHash))).toHaveLength(1);
    }
    delete changed[field];
    writeFileSync(join(cwd, kind === 'root' ? 'package.json' : 'packages/worker/package.json'), JSON.stringify(changed));
    // Real npm accepts removal without rewriting the lock. Root removals omit
    // the package; workspace behavior is pinned to the actual clean install.
    const clean = spawnSync(join(f.bin, 'npm'), ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd, encoding:'utf8', timeout:20000});
    expect(clean.status, clean.stderr).toBe(0);
    expect(readFileSync(join(cwd, 'package-lock.json'))).toEqual(lock);
    const probe = spawnSync(process.execPath, ['probe.cjs'], {cwd, encoding:'utf8', timeout:10000});
    expect([0, 1]).toContain(probe.status);
    if (kind === 'root') {
      expect(probe.status).toBe(1);
      expect(probe.stderr).toContain('MODULE_NOT_FOUND');
    }
    for (const state of ['previously primed', 'repeated removed input', 'cold']) {
      if (state === 'cold') rmSync(join(f.root, 'cache'), {recursive:true, force:true});
      expect(await runRemote(f), `${state}: ${f.runs.at(-1)?.stderr}`).toEqual({mode:'remote', code:probe.status});
      if (probe.status === 1) expect(f.runs.at(-1).stderr).toContain('MODULE_NOT_FOUND');
      else expect(f.runs.at(-1).stdout).toContain('RESOLVED 1.0.0');
      expect(readdirSync(join(f.root, 'cache', lockHash))).toHaveLength(state === 'cold' ? 1 : 2);
    }
    expect(f.local).not.toHaveBeenCalled();
  }, 120000);

  it('rejects real npm shrinkwrap precedence before caching and installs the next lock-only input cold', async () => {
    const files = ['package.json', 'package-lock.json', 'probe.cjs', 'dependency-1.tgz', 'dependency-2.tgz'];
    const dependencies = { 'cache-dependency': '*' };
    writeFileSync(join(cwd,'package.json'), JSON.stringify({
      name:'fixture', version:'1.0.0', dependencies, scripts:{'test:unit':'node probe.cjs'},
    }));
    writeFileSync(join(cwd,'probe.cjs'), "console.log('RESOLVED ' + require('cache-dependency/package.json').version)");
    for (const version of [1, 2]) {
      const source = join(cwd, `source-${version}`);
      mkdirSync(join(source,'package'), {recursive:true});
      writeFileSync(join(source,'package/package.json'), JSON.stringify({name:'cache-dependency',version:`${version}.0.0`}));
      const archive = `dependency-${version}.tgz`;
      const packed = spawnSync('tar', ['-czf',join(cwd,archive),'-C',source,'package'], {encoding:'utf8'});
      expect(packed.status, packed.stderr).toBe(0);
      writeFileSync(join(cwd,version === 1 ? 'package-lock.json' : 'npm-shrinkwrap.json'), JSON.stringify({
        name:'fixture', version:'1.0.0', lockfileVersion:3, packages:{
          '':{name:'fixture',version:'1.0.0',dependencies},
          'node_modules/cache-dependency':{version:`${version}.0.0`,resolved:`file:${archive}`,
            integrity:'sha512-'+createHash('sha512').update(readFileSync(join(cwd,archive))).digest('base64')},
        },
      }));
    }
    const f = realRemoteFixture(files);
    // Establish the actual npm precedence using only local tarballs, without a registry.
    const baseline = spawnSync(join(f.bin,'npm'), ['ci','--ignore-scripts','--no-audit','--no-fund'], {cwd,encoding:'utf8',timeout:20000});
    expect(baseline.status, baseline.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd,'node_modules/cache-dependency/package.json'),'utf8')).version).toBe('2.0.0');
    const npmWrapper = readFileSync(join(f.bin,'npm'),'utf8');
    // Create the install-log parent only when npm runs, after snapshot verification.
    writeFileSync(join(f.bin,'npm'), npmWrapper.replace('#!/bin/bash\n', '#!/bin/bash\nmkdir -p "$HOME"\nprintf "%s\\n" "$*" >> "$HOME/install.log"\n'));
    const runner = createRunner({testRoot:f.root,testPath:`${f.bin}:/usr/bin:/bin`});
    const lock = createHash('sha256').update(readFileSync(join(cwd,'package-lock.json'))).digest('hex');
    for (const dual of [true, false]) {
      const nonce = (dual ? 'b' : 'c').repeat(32);
      const prepared = await runner.prepare({nonce});
      const work = join(f.root,'runs',prepared.run,'work');
      for (const file of [...files,...(dual ? ['npm-shrinkwrap.json'] : [])]) writeFileSync(join(work,file),readFileSync(join(cwd,file)));
      const manifest = await remoteManifestAPI.buildManifest({cwd:work, exec:f.exec, listFiles:async () => files});
      const request = {...prepared,nonce,argv,env:{CI:'true'},lock,argvDigest:digestArgv(argv),inputDigest:await digestInput(work),
        manifest:forgeManifestAPI.manifestWire(manifest),manifestDigest:manifest.manifestDigest};
      try {
        if (dual) {
          await expect(runner.run(request)).rejects.toThrow(/shrinkwrap/i);
          expect(existsSync(join(work,'.forge-home/install.log'))).toBe(false);
          expect(existsSync(join(f.root,'cache',lock))).toBe(false);
        } else {
          const result = await runner.run(request);
          expect(result, result.stderr).toMatchObject({code:0});
          expect(result.stdout).toContain('RESOLVED 1.0.0');
          const installs = readFileSync(join(work,'.forge-home/install.log'),'utf8');
          expect(installs).toContain('ci --include=dev --ignore-scripts --no-audit --no-fund');
          expect(installs).not.toContain('--dry-run');
          expect(existsSync(join(f.root,'cache',lock,'dev-v5-'+request.inputDigest,'dependencies.tar'))).toBe(true);
        }
      } finally { await runner.finish(request); }
    }
  }, 120000);
  it.each(['parent', 'nested parent', 'leaf', 'dangling parent'])('rejects a %s symlink before invoking rsync', async (kind) => {
    const f = fixture();
    // Use an ordinary name so credential exclusion cannot mask the symlink guard.
    const external = join(cwd,'external');
    mkdirSync(external);
    writeFileSync(join(external,'payload.txt'),'SYNTHETIC_PRIVATE_MARKER');
    let file = 'fixtures/payload.txt';
    if (kind === 'nested parent') {
      mkdirSync(join(cwd,'fixtures'));
      symlinkSync(external,join(cwd,'fixtures','nested'));
      file = 'fixtures/nested/payload.txt';
    } else if (kind === 'leaf') {
      mkdirSync(join(cwd,'fixtures'));
      symlinkSync(join(external,'payload.txt'),join(cwd,file));
    } else symlinkSync(kind === 'dangling parent' ? join(cwd,'absent') : external,join(cwd,'fixtures'));
    f.listFiles.mockResolvedValue(['package-lock.json',file]);
    expect(await runRemote(f)).toEqual({mode:'fallback',reason:'copy-failed'});
    expect(callsOf(f.exec).filter(call=>call.file==='rsync')).toHaveLength(0);
    expect(callsOf(f.exec).some(isRun)).toBe(false);
  });
  it.each(['directory', 'missing'])('rejects a %s inventory leaf before invoking rsync', async kind => {
    const f = fixture();
    if (kind === 'directory') mkdirSync(join(cwd,'fixtures'));
    f.listFiles.mockResolvedValue(['package-lock.json','fixtures']);
    expect(await runRemote(f)).toEqual({mode:'fallback',reason:'copy-failed'});
    expect(callsOf(f.exec).filter(call=>call.file==='rsync')).toHaveLength(0);
  });
  it('rejects dual lockfiles at the client even if shrinkwrap is omitted from the inventory', async () => {
    const f = fixture();
    writeFileSync(join(cwd,'npm-shrinkwrap.json'),'shrinkwrap');
    expect(await runRemote(f)).toEqual({mode:'fallback',reason:'copy-failed'});
    expect(callsOf(f.exec).filter(call=>call.file==='rsync')).toHaveLength(0);
  });
  it.each(['snapshot', 'stale remote'])('falls back when a %s receipt says 97 and npm ci fails before the command', async (source) => {
    writeFileSync(join(cwd, '.exit-code'), '97\n');
    const f = realRemoteFixture(['package-lock.json', '.exit-code']);
    if (source === 'stale remote') {
      mkdirSync(join(f.root, runId), {recursive:true});
      writeFileSync(join(f.root, runId, '.exit-code'), '97\n');
    }
    const transport = f.exec;
    const receiptPresence = [];
    f.exec = vi.fn(async (call) => {
      if (call.file === 'rsync') receiptPresence.push(existsSync(join(f.root, 'runs', f.serverRun, 'work', '.exit-code')));
      const result = await transport(call);
      // Observe the snapshot and failed runner before cleanup can hide a receipt.
      if (call.file === 'rsync' || isRun(call)) receiptPresence.push(existsSync(join(f.root, 'runs', f.serverRun, 'work', '.exit-code')));
      return result;
    });
    writeFileSync(join(f.bin, 'npm'), '#!/bin/bash\nif [ "$1" = ci ]; then echo INJECTED_INSTALL_FAILURE >&2; exit 1; fi\necho COMMAND_RAN\n', { mode: 0o755 });
    const log = vi.fn();
    expect(await runRemoteCli({ ...f, log })).toBe(124);
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0].status).toBe(97);
    expect(f.runs[0].stderr).toContain('INJECTED_INSTALL_FAILURE');
    expect(f.runs[0].stdout).not.toContain('COMMAND_RAN');
    expect(receiptPresence).toEqual([false, false, false]);
    if(source === 'stale remote') expect(readFileSync(join(f.root,runId,'.exit-code'),'utf8')).toBe('97\n');
    expect(f.local).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ambiguous-result'));
    expect(callsOf(f.exec).find((call) => call.file === 'rsync').input).not.toContain('.exit-code');
    expect(existsSync(join(f.root, 'runs', f.serverRun))).toBe(false);
  });

  it('confirms command exit 97 with a fresh receipt on cold and warm caches', async () => {
    const f = realRemoteFixture(['package-lock.json']);
    writeFileSync(join(f.bin, 'npm'), '#!/bin/bash\nif [ "$1" = ci ]; then exit 0; fi\necho COMMAND_RAN\nexit 97\n', { mode: 0o755 });
    for (const state of ['cold', 'warm']) {
      expect(await runRemote(f), state).toEqual({ mode: 'remote', code: 97 });
      expect(f.runs.at(-1).stdout).toContain('COMMAND_RAN');
      expect(f.local).not.toHaveBeenCalled();
    }
  });

  it('preserves nested workspace dependencies across cold and warm runs', async () => {
    const workspace = "packages/deep/worker's space";
    const files = ['package.json', 'package-lock.json', `${workspace}/package.json`, 'probe.cjs'];
    // Local tarballs force real npm to install conflicting versions without a registry.
    for (const version of [1, 2]) {
      const source = join(cwd, `source-${version}`);
      mkdirSync(join(source, 'package'), { recursive: true });
      writeFileSync(join(source, 'package/package.json'), JSON.stringify({ name: 'cache-dependency', version: `${version}.0.0` }));
      const archive = `dependency-${version}.tgz`;
      const packed = spawnSync('tar', ['-czf', join(cwd, archive), '-C', source, 'package'], { encoding: 'utf8' });
      expect(packed.status, packed.stderr).toBe(0);
      files.push(archive);
    }
    mkdirSync(join(cwd, workspace), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0', workspaces: [workspace],
      dependencies: { 'cache-dependency': 'file:dependency-1.tgz' },
      scripts: { 'test:unit': 'node probe.cjs' },
    }));
    writeFileSync(join(cwd, workspace, 'package.json'), JSON.stringify({
      name: 'worker', version: '1.0.0', dependencies: { 'cache-dependency': 'file:../../../dependency-2.tgz' },
    }));
    writeFileSync(join(cwd, 'probe.cjs'), `
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const worker = createRequire(require('node:path').resolve(${JSON.stringify(workspace)}, 'package.json'));
const versions = [require('cache-dependency/package.json').version, worker('cache-dependency/package.json').version];
assert.deepEqual(versions, ['1.0.0', '2.0.0']);
assert.equal(require('worker/package.json').name, 'worker');
console.log('RESOLVED ' + versions.join(','));
`);
    const f = realRemoteFixture(files);
    const locked = spawnSync(join(f.bin, 'npm'), ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', timeout: 20000 });
    expect(locked.status, locked.stderr).toBe(0);
    const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
    expect(lock.packages[`${workspace}/node_modules/cache-dependency`].version).toBe('2.0.0');
    for (const state of ['cold', 'warm']) {
      const result = await runRemote(f);
      expect(result, `${state}: ${f.runs.at(-1)?.stderr}`).toEqual({ mode: 'remote', code: 0 });
      expect(f.runs.at(-1).stdout).toContain('RESOLVED 1.0.0,2.0.0');
      expect(existsSync(join(f.root, 'runs', f.serverRun))).toBe(false);
    }
  }, 120000);

  it('reuses an empty dependency snapshot and falls back if the archive is corrupt', async () => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0', scripts: { 'test:unit': 'node -e "console.log(\'COMMAND_RAN\')"' },
    }));
    writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    }));
    const f = realRemoteFixture(['package.json', 'package-lock.json']);
    for (const state of ['cold', 'warm']) {
      expect(await runRemote(f), `${state}: ${f.runs.at(-1)?.stderr}`).toEqual({ mode: 'remote', code: 0 });
      expect(f.runs.at(-1).stdout).toContain('COMMAND_RAN');
    }
    const hash = createHash('sha256').update(readFileSync(join(cwd, 'package-lock.json'))).digest('hex');
    const inputDigest = await digestInput(cwd, ['package.json', 'package-lock.json']);
    writeFileSync(join(f.root, 'cache', hash, 'dev-v5-'+inputDigest, 'dependencies.tar'), 'corrupt archive');
    const log = vi.fn();
    expect(await runRemoteCli({ ...f, log })).toBe(124);
    expect(f.local).not.toHaveBeenCalled();
    expect(f.runs.at(-1).stdout).not.toContain('COMMAND_RAN');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ambiguous-result'));
    expect(existsSync(join(f.root, 'runs', f.serverRun))).toBe(false);
  }, 120000);

  it('copies rsync comment-like and shell-special filenames literally through the real transport', async () => {
    const files = ['#required-fixture.json', ';required-fixture.json', 'two words', "quote'`$()", '--option', 'é\u2028fixture', '＃invisible\u200b', 'tab\tfile', 'trailing '];
    const f = realRemoteFixture(['package-lock.json', ...files]);
    writeFileSync(join(f.bin, 'npm'), '#!/bin/bash\nexit 0\n', {mode:0o755});
    for (const file of files) writeFileSync(join(cwd, file), `contents: ${file}`);
    // Inspect the real rsync result before allowing the mocked remote command.
    const transport = f.exec;
    const transferred = new Map();
    let nonce;
    f.exec = vi.fn(async (call) => {
      if (isRun(call)) {
        nonce = nonceOf(call.input);
        for (const file of files) {
          const path = join(f.root, 'runs', f.serverRun, 'work', file);
          transferred.set(file, existsSync(path) ? readFileSync(path, 'utf8') : null);
        }
      }
      return transport(call);
    });
    expect(await runRemote(f)).toEqual({ mode: 'remote', code: 0 });
    for (const file of files) {
      expect(transferred.get(file), file).toBe(file === 'tab\tfile' ? null : `contents: ${file}`);
    }
    const sent = JSON.parse(callsOf(f.exec).find(isRun).input);
    expect(Buffer.from(sent.manifest.excluded, 'base64')).toEqual(Buffer.from('tab\tfile\0'));
    expect(Buffer.from(sent.manifest.paths, 'base64').includes(Buffer.from('tab\tfile\0'))).toBe(false);
  });

  it.each(['root', 'workspace'])('rejects a changed %s manifest against an unchanged lock on both warm and cold caches', async (kind) => {
    const manifest = { name: 'fixture', version: '1.0.0', workspaces: ['packages/*'], scripts: { 'test:unit': 'node -e "console.log(\'COMMAND_RAN\')"' } };
    const worker = { name: 'worker', version: '1.0.0' };
    const packages = {
      '': { name: 'fixture', version: '1.0.0', workspaces: manifest.workspaces },
      'packages/worker': worker,
      'node_modules/worker': { resolved: 'packages/worker', link: true },
    };
    const files = ['package.json', 'package-lock.json', 'packages/worker/package.json', 'vendor/missing-lock-dependency/package.json'];
    mkdirSync(join(cwd, 'vendor/missing-lock-dependency'), { recursive: true });
    writeFileSync(join(cwd, 'vendor/missing-lock-dependency/package.json'), JSON.stringify({ name: 'missing-lock-dependency', version: '1.0.0' }));
    mkdirSync(join(cwd, 'packages/worker'), { recursive: true });
    writeFileSync(join(cwd, 'packages/worker/package.json'), JSON.stringify(worker));
    let changedManifest = manifest;
    let changedPath = join(cwd, 'package.json');
    if (kind === 'workspace') {
      changedManifest = worker;
      changedPath = join(cwd, 'packages/worker/package.json');
    }
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages }));
    const f = realRemoteFixture(files);
    // Populate, then prove a valid cache hit can still execute.
    for (const attempt of [1, 2]) {
      expect(await runRemote(f), `valid attempt ${attempt}: ${f.runs.at(-1)?.stderr}`).toEqual({ mode: 'remote', code: 0 });
      expect(f.runs.at(-1).stdout).toContain('COMMAND_RAN');
    }
    changedManifest.dependencies = { 'missing-lock-dependency': kind === 'root' ? 'file:vendor/missing-lock-dependency' : 'file:../../vendor/missing-lock-dependency' };
    writeFileSync(changedPath, JSON.stringify(changedManifest));
    const validation = spawnSync(join(f.bin, 'npm'), ['ci', '--dry-run', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', timeout: 20000 });
    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toContain('Missing: missing-lock-dependency@1.0.0 from lock file');
    for (const state of ['warm', 'cold']) {
      if (state === 'cold') rmSync(join(f.root, 'cache'), { recursive: true, force: true });
      const log = vi.fn();
      expect(await runRemoteCli({ ...f, log }), state).toBe(124);
      expect(f.local).not.toHaveBeenCalled();
      expect(f.runs.at(-1).status, f.runs.at(-1).stderr).toBe(97);
      expect(f.runs.at(-1).stderr).toContain('npm ci');
      expect(f.runs.at(-1).stdout).not.toContain('COMMAND_RAN');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ambiguous-result'));
    }
  }, 120000);
});

describe('isAllowedCommand', () => {
  it.each([
    ['npx','vitest','run','a.test.mjs'], ['npx','vitest','related','a.test.mjs','--run'],
    ['npm','run','test:integration:vitest'], ['npm','run','test:coverage'],
  ].map(argv=>[argv]))('keeps new class %j local with an old runner before copying bytes', async command => {
    const f=fixture(),exec=f.exec;
    f.exec=vi.fn(async call=>{
      const reply=await exec(call);
      if(isPrepare(call))return {...reply,stdout:JSON.stringify({run:JSON.parse(reply.stdout).run,capabilities:{siblings:1}})};
      return reply;
    });
    expect(await runRemote({...f,argv:command})).toEqual({mode:'not-started',terminated:true,reason:'forge-runner-too-old'});
    expect(callsOf(f.exec).some(call=>call.file==='rsync'||isRun(call))).toBe(false);
    expect(callsOf(f.exec).filter(isCleanup)).toHaveLength(1);
  });

  it.each(['--help','-h','--version','-v','--passWithNoTests','--pass-with-no-tests','--changed','--shard','--bail']
    .flatMap(flag => [flag, flag+'=true', flag+'=false', flag+'=']))
  ('rejects arguments outside the allowlist: %s on both sides before transport', async arg => {
    const command = ['npm','run','test:unit','--','a.test.mjs',arg];
    expect(isAllowedCommand(command)).toBe(false);
    expect(forgeManifestAPI.allowedCommand(command)).toBe(false);
    const f = fixture();
    expect(await runRemote({...f,argv:command})).toEqual({mode:'fallback',reason:'command-not-allowed'});
    expect(f.exec).not.toHaveBeenCalled();
  });
  const discoveryFlags = ['--config','--root','--dir','--project','--workspace','--include','--exclude','--dangerouslyIgnoreUnhandledErrors','-c','-r'];
  it.each(discoveryFlags.flatMap(flag => [[flag], [flag+'=other'], ...(flag.startsWith('--') ? [] : [[flag+'other']])]))
  ('refuses discovery-changing argument %s on both sides before execution', async arg => {
    const command = ['npm','run','test:unit','--','a.test.mjs',arg];
    expect(isAllowedCommand(command)).toBe(false);
    expect(forgeManifestAPI.allowedCommand(command)).toBe(false);
    const f = fixture();
    expect(await runRemote({...f,argv:command})).toEqual({mode:'fallback',reason:'command-not-allowed'});
    expect(f.exec).not.toHaveBeenCalled();
  });
  it.each([
    ['--run'], ['--silent'], ['--no-color'],
    ...['default','dot','verbose','basic','tap'].map(value => ['--reporter='+value]),
    ['-t','two words'], ['--testNamePattern=two words'],
    ['scripts/a.test.mjs', 'filter*.[test]'],
  ].map(args => [args]))('allows supported arguments on both sides: %j', args => {
    const command = ['npm','run','test:unit','--',...args];
    expect(isAllowedCommand(command)).toBe(true);
    expect(forgeManifestAPI.allowedCommand(command)).toBe(true);
  });
  it('allows positional filters and combined supported runner options on both sides', () => {
    const command = ['npm','run','test:unit','--','scripts/a.test.mjs','--reporter=verbose','--run','--silent','--no-color','-t','case'];
    expect(isAllowedCommand(command)).toBe(true);
    expect(forgeManifestAPI.allowedCommand(command)).toBe(true);
  });

  it.each(['--help', '--version', '--config', '--run', '--shard=1/2', '-h', '-t', '-pattern'])
  ('rejects dash-prefixed separate -t values: %s', async value => {
    const command = ['npm','run','test:unit','--','-t',value];
    expect(isAllowedCommand(command)).toBe(false);
    expect(forgeManifestAPI.allowedCommand(command)).toBe(false);
    const f = fixture();
    expect(await runRemote({...f,argv:command})).toEqual({mode:'fallback',reason:'command-not-allowed'});
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each([
    '--shard=1/2', '--bail=1', '--unknown', '--RUN', '--Silent', '--noColor',
    '--test-name-pattern=case', '--TestNamePattern=case', '--reporter=json', '--reporter=DOT',
    '--reporter', '--run=true', '--silent=false', '--no-color=true', '-t', '-tcase',
    '--testNamePattern', '--', '--CONFIG=other', '--dangerously-ignore-unhandled-errors',
  ])('fails closed for unsupported option spelling or missing value: %s', async arg => {
    const command = ['npm','run','test:unit','--','a.test.mjs',arg];
    expect(isAllowedCommand(command)).toBe(false);
    expect(forgeManifestAPI.allowedCommand(command)).toBe(false);
    const f = fixture();
    expect(await runRemote({...f,argv:command})).toEqual({mode:'fallback',reason:'command-not-allowed'});
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each(['test:unit', 'check:standards'])('rejects npm options before the argument separator for %s', (script) => {
    for (const args of [
      ['--script-shell=/usr/bin/true'], ['--script-shell', '/usr/bin/true'],
      ['--ignore-scripts'], ['--if-present'], ['--help'], ['--workspace=other'],
      ['a.test.mjs', '--script-shell=/usr/bin/true'],
      ['--script-shell=/usr/bin/true', '--', 'a.test.mjs'],
      ['—', '--script-shell=/usr/bin/true'], ['--\u200b', '--help'],
    ]) {
      expect(isAllowedCommand(['npm', 'run', script, ...args]), JSON.stringify(args)).toBe(false);
      expect(isAllowedCommand(['npm', 'run', script, ...args])).toBe(false);
    }
    expect(isAllowedCommand(['npm', 'run', script, '--', '--script-shell=/usr/bin/true'])).toBe(false);
  });
  it.each(['test:unit', 'check:standards'])('allows exactly the npm run %s prefix, including extra args', (script) => {
    expect(isAllowedCommand(['npm', 'run', script])).toBe(true);
    const args = script === 'check:standards' ? ['--local', '--files=a.test.mjs'] : ['a.test.mjs'];
    expect(isAllowedCommand(['npm', 'run', script, '--', ...args])).toBe(true);
  });
  it.each([
    [], null, undefined, {}, 'npm run test:unit', ['npm'], ['npm', 'run'],
    ['npm', 'run', 'build'], ['sh', '-c', 'npm run test:unit'], ['npx', 'vitest'],
    ['npm', 'run', 'test:unit-extra'], ['npm', 'run', 'check:standards-extra'],
    ['env', 'npm', 'run', 'test:unit'], ['npm', 'test'],
  ].map((value) => [value]))('fails closed for disallowed or incomplete argv: %j', (value) => {
    expect(isAllowedCommand(value)).toBe(false);
  });
});

describe('filterEnv', () => {
  it.each(['HEAD', 'origin/main', 'refs/heads/fix.v1', 'a'.repeat(40)])('forwards safe coverage base %s accepted by the worker', base => {
    const env = filterEnv({DIFF_COVERAGE_BASE:base});
    expect(env).toEqual({DIFF_COVERAGE_BASE:base});
    expect(forgeManifestAPI.allowedEnv(env)).toBe(true);
  });
  it.each(['', '-HEAD', 'HEAD..main', 'main branch', 'HEAD\n', 'HEAD\0', 'HEAD\t', '$(id)', 'HEAD;id', 'HEAD~1', 'main//branch', '.hidden', 'branch.lock', 'main/', 123])
  ('refuses invalid coverage base with a local fallback reason before forwarding: %j', async base => {
    const env = {DIFF_COVERAGE_BASE:base};
    expect(() => filterEnv(env)).toThrow('Invalid DIFF_COVERAGE_BASE: use local fallback');
    expect(forgeManifestAPI.allowedEnv(env)).toBe(false);
    const f = fixture();
    expect(await runRemote({...f,env})).toEqual({mode:'fallback',reason:'invalid-diff-coverage-base'});
    expect(f.exec).not.toHaveBeenCalled();
  });
  it('keeps exactly the allowlist and drops secret names, HOME, PATH, and unknown names', () => {
    const env = { ...allowedEnv, ...forbiddenEnv };
    expect(filterEnv(env)).toEqual(allowedEnv);
    expect(env).toEqual({ ...allowedEnv, ...forbiddenEnv });
  });
  it('does not promote inherited or differently cased names into the allowlist', () => {
    expect(filterEnv(Object.assign(Object.create({ CI: 'inherited' }), { ci: 'lowercase', TZ: 'UTC' })))
      .toEqual({ TZ: 'UTC' });
    expect(filterEnv({})).toEqual({});
  });
});

describe('validateRunId', () => {
  it.each(['abcdef', 'abcdef-1', '0abcde', `a${'-'.repeat(63)}`])('accepts valid boundary/id %s', (id) => {
    expect(validateRunId(id)).toBe(true);
  });
  it.each([
    '', 'abcde', `a${'b'.repeat(64)}`, '-abcde', 'ABCDEF', 'abc_def', '../abcdef',
    'abcdef/x', 'abcdef\n', 'abcdef;id', '$(id)', null, undefined, 123456,
  ])('rejects malformed, oversized, or non-string id %j', (id) => {
    expect(validateRunId(id)).toBe(false);
  });
});

describe('runRemote', () => {
  it('falls back locally for check:standards -- --unknown before any staging or transfer', async () => {
    const f = fixture();
    f.argv = ['npm', 'run', 'check:standards', '--', '--unknown'];
    const stage = vi.fn(filesystem.mkdtemp);
    const options = {...f, fs:{...filesystem, mkdtemp:stage}};
    expect(await runRemote(options)).toEqual({mode:'fallback', reason:'command-not-allowed'});
    const log = vi.fn();
    const decision = await runWithRemoteDecision({
      ...f, log, policy:resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always'}}}),
      remoteExec:async () => adaptLegacyRemoteResult(await runRemote(options)),
    });
    expect(decision).toEqual({handled:false});
    expect(log).toHaveBeenCalledWith(expect.stringContaining('command-not-allowed'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
    expect(stage).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.listFiles).not.toHaveBeenCalled();
  });
  it.each(['bound','wrong nonce','wrong run','started','missing started','extra field','non-Git command'])('accepts only protected not-started Git HEAD refusal and never retries: %s',async kind=>{
    const f=fixture({runCode:254,receipt:(_nonce,value)=>{
      const reply={v:1,nonce:value.nonce,run:value.run,phase:'rejected',reason:'git-head-unavailable',siblings:false,started:false};
      if(kind==='wrong nonce')reply.nonce='0'.repeat(32);
      if(kind==='wrong run')reply.run='r-'+'0'.repeat(32);
      if(kind==='started')reply.started=true;
      if(kind==='missing started')delete reply.started;
      if(kind==='extra field')reply.code=0;
      return JSON.stringify(reply);
    }});
    if(kind!=='non-Git command')f.argv=['npm','run','check:standards'];
    expect(await runRemote(f)).toEqual(kind==='bound'?{mode:'not-started',terminated:true,reason:'git-head-unavailable'}:{mode:'unconfirmed',reason:'ambiguous-result'});
    expect(callsOf(f.exec).filter(isPrepare)).toHaveLength(1);
    expect(callsOf(f.exec).filter(isRun)).toHaveLength(1);
    expect(callsOf(f.exec).filter(isCleanup)).toHaveLength(1);
  });
  it('falls back through Mac admission after a protected unavailable-HEAD receipt',async()=>{
    const f=fixture({runCode:254,receipt:(_nonce,value)=>JSON.stringify({v:1,nonce:value.nonce,run:value.run,
      phase:'rejected',reason:'git-head-unavailable',siblings:false,started:false})});
    f.argv=['npm','run','check:standards'];
    const log=vi.fn();
    expect(await runWithRemoteDecision({argv:f.argv,cwd,env:{},lockRoot:join(cwd,'heavy'),log,loadPerCore:()=>0,
      policy:resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always'}}}),
      remoteExec:async options=>runRemote({...f,...options}),
    })).toEqual({handled:false});
    expect(log.mock.calls.some(([message])=>message.includes('git-head-unavailable'))).toBe(true);
  });
  it('refuses a Mac HEAD change during snapshot construction before prepare or transport',async()=>{
    const f=fixture(),execute=f.exec;let reads=0;
    f.argv=['npm','run','check:standards'];
    f.exec=vi.fn(async call=>call.file==='git'&&call.args.join(' ')==='rev-parse HEAD'
      ?{code:0,stdout:Buffer.from((++reads===1?'a':'b').repeat(40)+'\n')}:execute(call));
    expect(await runRemote(f)).toEqual({mode:'fallback',reason:'copy-failed'});
    expect(callsOf(f.exec).some(call=>isPrepare(call)||isRun(call)||call.file==='rsync')).toBe(false);
  });
  it('preserves forge-busy from prepare without transferring bytes or asking an unknown run to finish',async()=>{
    const f=fixture(),execute=f.exec;
    f.exec=vi.fn(async call=>isPrepare(call)?{code:254,stdout:JSON.stringify({reason:'forge-busy'})}:execute(call));
    expect(await runRemote(f)).toEqual({mode:'not-started',terminated:true,reason:'forge-busy'});
    expect(callsOf(f.exec).some(c=>c.file==='rsync'||isRun(c)||isCleanup(c))).toBe(false);
  });
  it.each(['forge-exec-2','root','forge-exec-3','forge-exec-01'])('rsync targets only a valid server-reserved pool member: %s',async slot=>{
    const f=fixture(),execute=f.exec;
    f.exec=vi.fn(async call=>{
      const result=await execute(call);
      if(isPrepare(call)){const p=JSON.parse(result.stdout);p.slot=slot;p.capabilities.workers=['forge-exec-1','forge-exec-2'];return {...result,stdout:JSON.stringify(p)};}
      return result;
    });
    const result=await runRemote(f),copies=callsOf(f.exec).filter(c=>c.file==='rsync');
    if(slot==='forge-exec-2'){
      expect(result).toEqual({mode:'remote',code:0});
      expect(copies).toHaveLength(1);
      expect(copies[0].args).toContain('--rsync-path=sudo -u forge-exec-2 rsync');
      expect(copies[0].args.at(-1)).toMatch(/^forge:\/srv\/forge-exec\/slot-2\/r-[a-f0-9]{32}\/work\/$/);
    }else{expect(result).toEqual({mode:'fallback',reason:'copy-failed'});expect(copies).toHaveLength(0);}
  });
  it.each(['bound', 'wrong nonce', 'wrong run', 'malformed', 'missing started', 'started', 'unknown reason', 'extra field', 'invalid JSON'])
  ('accepts only bound pre-run protected rejection: %s', async kind => {
    const f = fixture({runCode:1, receipt:(_nonce, value) => {
      const reply = {v:1,nonce:value.nonce,run:value.run,phase:'rejected',reason:'snapshot-rejected',siblings:true,started:false};
      if (kind === 'wrong nonce') reply.nonce = '0'.repeat(32);
      if (kind === 'wrong run') reply.run = 'r-'+'0'.repeat(32);
      if (kind === 'malformed') reply.siblings = 'true';
      if (kind === 'missing started') delete reply.started;
      if (kind === 'started') reply.started = true;
      if (kind === 'unknown reason') reply.reason = 'unknown';
      if (kind === 'extra field') reply.code = 0;
      return kind === 'invalid JSON' ? '{' : JSON.stringify(reply);
    }});
    expect(await runRemote(f)).toEqual(kind === 'bound'
      ? {mode:'not-started',terminated:true,reason:'forge-rejected:snapshot-rejected'}
      : {mode:'unconfirmed',reason:'ambiguous-result'});
  });

  it('aborts not-started before rsync when an ancestor is redirected to different bytes at staging open', async () => {
    const f = fixture();
    const source = join(cwd,'fixtures');
    const alternate = join(cwd,'alternate');
    mkdirSync(source); mkdirSync(alternate);
    writeFileSync(join(source,'a.test.mjs'),'fixture');
    writeFileSync(join(alternate,'a.test.mjs'),'different private bytes');
    f.listFiles.mockResolvedValue(['fixtures/a.test.mjs','package-lock.json']);
    let redirected = false, openedDifferentBytes = false;
    f.fs = {...filesystem, open:async (path, flags) => {
      if (Buffer.from(path).equals(Buffer.from(join(source,'a.test.mjs')))) {
        renameSync(source,join(cwd,'original-fixtures'));
        symlinkSync(alternate,source);
        redirected = true;
        const fd = await filesystem.open(path,flags);
        openedDifferentBytes = (await fd.readFile('utf8')) === 'different private bytes';
        await fd.close();
      }
      return filesystem.open(path,flags);
    }};
    expect(await runRemote(f)).toEqual({mode:'not-started',terminated:true,reason:'snapshot-staging-failed'});
    expect(redirected).toBe(true);
    expect(openedDifferentBytes).toBe(true);
    expect(callsOf(f.exec).some(call => call.file === 'rsync' || isRun(call))).toBe(false);
  });

  it('stages primary files as 0644/0755 and subdirectories as 0755 under a 0700 root despite restrictive creation modes', async () => {
    const f = fixture();
    mkdirSync(join(cwd,'sub/dir'), {recursive:true});
    writeFileSync(join(cwd,'sub/dir/run.js'), 'executable');
    chmodSync(join(cwd,'sub/dir/run.js'), 0o711);
    f.listFiles.mockResolvedValue(['package-lock.json','a.test.mjs','sub/dir/run.js']);
    f.fs = restrictiveStageFs();
    const fake = f.exec;
    let copied = false;
    f.exec = vi.fn(async call => {
      if (call.file === 'rsync') {
        copied = true;
        expect(statSync(call.cwd).mode & 0o7777).toBe(0o700);
        expectStageModes(call.cwd, 'sub/dir/run.js');
        expect(statSync(join(call.cwd,'sub')).mode & 0o7777).toBe(0o755);
        expect(statSync(join(call.cwd,'sub/dir')).mode & 0o7777).toBe(0o755);
        const destination = join(cwd,'copied');
        mkdirSync(destination);
        chmodSync(destination,0o755);
        const args = call.args.filter((arg,i,all) => !arg.startsWith('--rsync-path=') && arg !== '-e' && all[i-1] !== '-e');
        args[args.length-1] = destination+'/';
        const result = spawnSync('rsync',args,{cwd:call.cwd,input:call.input,timeout:10000});
        expect(result.status,result.stderr?.toString()).toBe(0);
        expect(statSync(destination).mode & 0o7777).toBe(0o755);
        expect(statSync(call.cwd).mode & 0o7777).toBe(0o700);
        expectStageModes(destination,'sub/dir/run.js');
      }
      return fake(call);
    });
    const result = await runRemote(f);
    const transport = await Promise.allSettled(f.exec.mock.results.map(call => call.type === 'throw' ? Promise.reject(call.value) : call.value));
    expect(transport.filter(call => call.status === 'rejected').map(call => call.reason?.stack ?? String(call.reason)), JSON.stringify(result)).toEqual([]);
    expect(result, JSON.stringify(result)).toEqual({mode:'remote',code:0});
    expect(copied).toBe(true);
  });

  it.each(['mode','bytes'])('refuses staged %s corruption before prepare or rsync', async fault => {
    const f = fixture();
    let corrupted = false;
    f.fs = {...filesystem, chmod:async (path, mode) => {
      await filesystem.chmod(path, mode);
      if (statSync(path).isFile()) {
        corrupted = true;
        if (fault === 'mode') await filesystem.chmod(path, 0o600);
        else await filesystem.writeFile(path, 'corrupt staged bytes');
      }
    }};
    expect(await runRemote(f)).toEqual({mode:'not-started',terminated:true,reason:'snapshot-staging-failed'});
    expect(corrupted).toBe(true);
    expect(callsOf(f.exec).some(call => call.file === 'rsync' || isPrepare(call))).toBe(false);
  });

  it('sends only verified staged bytes when a live file becomes private after manifest build', async () => {
    const f = fixture();
    const transport = f.exec;
    let staging;
    f.exec = vi.fn(async call => {
      if (isPrepare(call)) writeFileSync(join(cwd, 'a.test.mjs'), 'private bytes');
      if (call.file === 'rsync') {
        staging = call.cwd;
        expect(readFileSync(join(staging, 'a.test.mjs'), 'utf8')).toBe('fixture');
        expect(staging).not.toBe(cwd);
        expect(statSync(staging).mode & 0o777).toBe(0o700);
      }
      return transport(call);
    });
    expect(await runRemote(f)).toEqual({mode:'remote', code:0});
    expect(staging).toBeDefined();
    expect(existsSync(staging)).toBe(false);
  });

  it.each(['private bytes', 'symlink', 'directory', 'missing', 'unreadable'])
  ('aborts not-started without transmission when injected fs swaps a source to %s after the manifest read', async kind => {
    const f = fixture();
    let staging;
    const source = join(cwd, 'a.test.mjs');
    const fs = {...filesystem, mkdtemp:vi.fn(async prefix => {
      staging = await filesystem.mkdtemp(prefix);
      return staging;
    }), open:vi.fn(async (path, flags) => {
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      if (kind === 'unreadable') throw Object.assign(new Error('unreadable'), {code:'EACCES'});
      return filesystem.open(path, flags);
    }), readFile:vi.fn(async path => {
      const data = await filesystem.readFile(path);
      if (Buffer.from(path).equals(Buffer.from(join(cwd, 'package-lock.json')))) {
        rmSync(source);
        if (kind === 'symlink') symlinkSync(join(cwd, 'package-lock.json'), source);
        else if (kind === 'directory') mkdirSync(source);
        else if (kind !== 'missing') writeFileSync(source, 'private bytes');
      }
      return data;
    })};
    expect(await runRemote({...f, fs})).toEqual({mode:'not-started', terminated:true, reason:'snapshot-staging-failed'});
    expect(callsOf(f.exec).some(call => call.file === 'rsync' || isPrepare(call) || isRun(call))).toBe(false);
    expect(staging).toBeDefined();
    expect(existsSync(staging)).toBe(false);
  });

  it.each([{prepareCode:1}, {copyCode:1}, {runCode:1}, {receiptCode:1}])
  ('removes the staging directory after transport failure %j', async options => {
    const f = fixture(options);
    const fs = {...filesystem, mkdtemp:vi.fn(filesystem.mkdtemp)};
    await runRemote({...f, fs});
    expect(fs.mkdtemp).toHaveBeenCalledOnce();
    expect(existsSync(await fs.mkdtemp.mock.results[0].value)).toBe(false);
  });

  it('admits local execution for a Git-ignored test through the real legacy adapter', async () => {
    const f = fixture();
    const exec = f.exec;
    f.exec = vi.fn(async call => call.file === 'git' && call.args.includes('-i')
      ? {code:0, stdout:Buffer.from('scripts/__tests__/ignored.test.mjs\0')}
      : exec(call));
    const result = await runWithRemoteDecision({
      argv:f.argv, cwd, env:{}, lockRoot:join(cwd,'heavy'), log:vi.fn(), loadPerCore:() => 0,
      policy:resolveAdmissionPolicy({platform:{remote:{enabled:true, mode:'always'}}}),
      remoteExec:async options => adaptLegacyRemoteResult(await runRemote({...f, ...options})),
    });
    expect(result).toEqual({handled:false});
    expect(callsOf(f.exec).some(call => isPrepare(call) || call.file === 'rsync' || isRun(call))).toBe(false);
  });

  it('never transmits unlisted children when a validated file becomes a directory during prepare', async () => {
    const f = fixture();
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'kept.mjs'), 'selected nested file');
    f.listFiles.mockResolvedValue(['package-lock.json', 'a.test.mjs', 'src/kept.mjs']);
    const exec = f.exec;
    const destination = join(cwd, 'transport-target');
    mkdirSync(destination);
    let copied;
    f.exec = vi.fn(async call => {
      if (isPrepare(call)) {
        rmSync(join(cwd, 'a.test.mjs'));
        mkdirSync(join(cwd, 'a.test.mjs', 'nested'), {recursive:true});
        for (const name of ['.env', '.env.example', 'unlisted.txt', 'nested/.env.local', 'nested/unlisted.txt']) {
          writeFileSync(join(cwd, 'a.test.mjs', name), 'must never leave the client');
        }
      }
      if (call.file === 'rsync') {
        const args = call.args.filter((arg, i, all) => !arg.startsWith('--rsync-path=') && arg !== '-e' && all[i-1] !== '-e');
        args[args.length-1] = destination + '/';
        copied = spawnSync('rsync', args, {cwd:call.cwd, input:call.input, encoding:'utf8', timeout:10000});
        return {code:copied.status, stdout:copied.stdout};
      }
      return exec(call);
    });
    await runRemote(f);
    expect(copied, 'the real rsync transfer must be exercised').toBeDefined();
    expect(copied.error).toBeUndefined();
    expect(readFileSync(join(destination, 'package-lock.json'), 'utf8')).toContain('lockfileVersion');
    expect(readFileSync(join(destination, 'src', 'kept.mjs'), 'utf8')).toBe('selected nested file');
    expect(readFileSync(join(destination, 'a.test.mjs'), 'utf8')).toBe('fixture');
    expect(readdirSync(destination, {recursive:true}).sort()).toEqual(['a.test.mjs', 'package-lock.json', 'src', 'src/kept.mjs']);
  });

  it.each(['scripts/__tests__/.env.local/hidden.test.mjs','scripts/__tests__/.env.local/hidden.js','hidden.spec.ts','dist/hidden.test.mjs','build/hidden.test.mjs'])
  ('falls back for a Git-ignored test instead of certifying remote success: %s', async name => {
    spawnSync('git',['init','--quiet'],{cwd});
    writeFileSync(join(cwd,'.gitignore'), name+'\n');
    mkdirSync(join(cwd, ...name.split('/').slice(0,-1)),{recursive:true});
    writeFileSync(join(cwd,name),'must run');
    const f = fixture();
    const fake = f.exec;
    f.exec = vi.fn(async call => call.file === 'git'
      ? remoteManifestAPI.defaultExec(call) : fake(call));
    expect(await runRemote(f)).toEqual({mode:'fallback',reason:'ignored-test-file'});
    expect(callsOf(f.exec).some(call => isPrepare(call) || call.file === 'rsync' || isRun(call))).toBe(false);
  });
  it('allows ignored non-tests and dependency/Git internals', async () => {
    spawnSync('git',['init','--quiet'],{cwd});
    writeFileSync(join(cwd,'.gitignore'),'secret.txt\nnode_modules/\n');
    writeFileSync(join(cwd,'secret.txt'),'ignored asset');
    mkdirSync(join(cwd,'node_modules'));
    writeFileSync(join(cwd,'node_modules','dependency.test.mjs'),'dependency');
    const f = fixture();
    const fake = f.exec;
    f.exec = vi.fn(async call => call.file === 'git'
      ? remoteManifestAPI.defaultExec(call) : fake(call));
    expect(await runRemote(f)).toEqual({mode:'remote',code:0});
  });
  it.each([
    {code:1,stdout:Buffer.alloc(0)}, {code:0,stdout:''},
    {code:0,stdout:Buffer.from('unterminated')},
    {code:0,stdout:Buffer.alloc(4*1024*1024+1)},
  ])('fails closed for unavailable, malformed or oversized ignored inventory %#', async result => {
    const f = fixture();
    const fake = f.exec;
    f.exec = vi.fn(async call => call.file === 'git' && call.args.includes('-i') ? result : fake(call));
    expect(await runRemote(f)).toEqual({mode:'fallback',reason:'copy-failed'});
    expect(callsOf(f.exec).some(isPrepare)).toBe(false);
  });

  it.each([[], ['--','--files=scripts/readiness/remote-exec.mjs']].flatMap(args => [[args,true],[args,false]]))('full-ships ignored coverage despite a warm base and preserves both guards and explicit scope: %j (dirty: %s)', async (args, dirty) => {
    const f = fixture({runCode:1}),original=f.exec;
    const git=(...args)=>{
      const result=spawnSync('git',args,{cwd,encoding:'utf8',timeout:10000});
      expect(result.status,result.stderr).toBe(0);return result.stdout.trim();
    };
    git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    const tier='scripts/lib/disposition-judge.mjs';
    mkdirSync(join(cwd,'scripts/lib'),{recursive:true});
    writeFileSync(join(cwd,'.gitignore'),'coverage/\n');
    writeFileSync(join(cwd,tier),'export const changed = false;\n');
    git('add','.');git('commit','-m','public base');
    const base=git('rev-parse','HEAD'),baseRoot=join(cwd,'forge-base'),snapshot=join(cwd,'forge-work');
    mkdirSync(baseRoot);mkdirSync(snapshot);
    git('clone','--bare','.',join(baseRoot,'repo.git'));
    git('--git-dir',join(baseRoot,'repo.git'),'update-ref','refs/remotes/origin/main',base);
    writeFileSync(join(cwd,tier),'export const changed = true;\n');
    git('add',tier);git('commit','-m','published Mac change');
    const head=git('rev-parse','HEAD');
    // Public main is ahead of the warm content base; seed its transport fixture.
    rmSync(join(baseRoot,'repo.git'),{recursive:true});
    git('clone','--bare','.',join(baseRoot,'repo.git'));
    git('--git-dir',join(baseRoot,'repo.git'),'update-ref','refs/remotes/origin/main',head);
    const warm=forgeManifestAPI.manifestWire(await remoteManifestAPI.buildManifest({cwd,exec:remoteManifestAPI.defaultExec,listFiles:async()=>['a.test.mjs','package-lock.json',tier]}));
    const warmDigest=forgeManifestAPI.digestManifest(warm);
    if (dirty) writeFileSync(join(cwd,tier),'export const changed = 2;\n');
    mkdirSync(join(cwd,'coverage'));
    const loc={start:{line:1,column:0},end:{line:1,column:40}};
    const report=JSON.stringify({[tier]:{branchMap:{0:{loc,locations:[loc,loc]}},b:{0:[0,0]}}});
    writeFileSync(join(cwd,'coverage/coverage-final.json'),report);
    writeFileSync(join(cwd,'coverage/private.json'),'must not ship');
    f.env.DIFF_COVERAGE_BASE=base;
    const localCoverage=scanDiffBranchCoverage(cwd,{base});
    expect(localCoverage).toMatchObject({status:'fail',total:2,exercised:0,ok:false});
    if (!dirty) expect(scanMaterializedGuards(cwd).coverage.status).toBe('no-scope');
    const artifacts=['reports/new.md','src/_data/researchTopics/new.json','src/_includes/research-descriptions/new.njk'];
    for(const name of artifacts){mkdirSync(join(cwd,name,'..'),{recursive:true});writeFileSync(join(cwd,name),'new artifact');}
    f.listFiles.mockResolvedValue(['a.test.mjs','package-lock.json',tier,...artifacts]);
    let observed;
    f.exec=vi.fn(async call=>{
      if(call.file==='git')return remoteManifestAPI.defaultExec(call);
      if(call.file==='ssh'&&sshText(call).endsWith(' bases'))return {code:0,stdout:JSON.stringify({delta:1,bases:[{sha:head,manifestDigest:warmDigest}]})};
      if(call.file==='ssh'&&sshText(call).endsWith(' base-manifest'))return {code:0,stdout:JSON.stringify(warm)};
      if(call.file==='rsync')cpSync(call.cwd,snapshot,{recursive:true,preserveTimestamps:true});
      if(isRun(call)){
        const request=JSON.parse(call.input);
        expect(forgeManifestAPI.allowedEnv(request.env)).toBe(true);
        expect(request.env.DIFF_COVERAGE_BASE).toBe(base);
        expect(request.baseSha).toBeUndefined();
        const entries=forgeManifestAPI.splitPaths(Buffer.from(request.manifest.paths,'base64'));
        const coverageIndex=entries.findIndex(path=>path.equals(Buffer.from('coverage/coverage-final.json')));
        expect(coverageIndex).toBeGreaterThanOrEqual(0);
        expect(request.manifest.hashes[coverageIndex]).toBe(createHash('sha256').update(report).digest('hex'));
        expect(request.manifest.tracked[coverageIndex]).toBe(false);
        expect(readFileSync(join(snapshot,'coverage/coverage-final.json'),'utf8')).toBe(report);
        expect(statSync(join(snapshot,'coverage/coverage-final.json')).mtimeMs).toBeCloseTo(statSync(join(cwd,'coverage/coverage-final.json')).mtimeMs,0);
        expect(existsSync(join(snapshot,'coverage/private.json'))).toBe(false);
        await materializeWorktree({work:snapshot,root:baseRoot,head:request.manifest.git.head,
          manifest:request.manifest,manifestDigest:request.manifestDigest,exec:cachedPublicGitExec});
        observed=scanMaterializedGuards(snapshot);
        observed.coverage=scanDiffBranchCoverage(snapshot,{base:request.env.DIFF_COVERAGE_BASE});
      }
      return original(call);
    });
    f.argv = ['npm','run','check:standards',...args];
    expect(await runRemote(f)).toEqual({mode:'remote',code:1});
    expect(observed.coverage).toMatchObject({status:'fail',total:2,exercised:0,ok:false});
    expect(observed.coverage).toEqual(localCoverage);
    expect(observed.artifacts.errors.map(e=>e.descriptor.file)).toEqual(['reports','src/_data/researchTopics','src/_includes/research-descriptions']);
    expect(spawnSync('git',['rev-parse','HEAD'],{cwd:snapshot,encoding:'utf8'}).stdout.trim()).toBe(head);
    expect(spawnSync('git',['merge-base','--is-ancestor','HEAD','origin/main'],{cwd:snapshot}).status).toBe(0);
    expect(callsOf(f.exec).some(isPrepare)).toBe(true);
    expect(callsOf(f.exec).some(call=>call.file==='ssh'&&sshText(call).endsWith(' base-manifest'))).toBe(true);
    expect(JSON.parse(callsOf(f.exec).find(isRun).input).manifest.git.head).toBe(head);
    expect(JSON.stringify(callsOf(f.exec))).not.toContain('verify-marker');
    expect(f.local).not.toHaveBeenCalled();
  });
  it.each([undefined,1])('requires exact-HEAD worktree capability before transferring a standards snapshot to an old runner (version=%s)',async version=>{
    const f=fixture(),original=f.exec;
    f.argv=['npm','run','check:standards'];
    f.exec=vi.fn(async call=>{
      const result=await original(call);
      if(isPrepare(call)){
        const prepared=JSON.parse(result.stdout);
        if(version===undefined)delete prepared.capabilities.gitWorktree;else prepared.capabilities.gitWorktree=version;
        return {...result,stdout:JSON.stringify(prepared)};
      }
      return result;
    });
    expect(await runRemote(f)).toEqual({mode:'not-started',terminated:true,reason:'forge-runner-too-old'});
    expect(callsOf(f.exec).some(c=>c.file==='rsync'||isRun(c))).toBe(false);
    expect(callsOf(f.exec).filter(isCleanup)).toHaveLength(1);
  });
  it.each([{code:1,stdout:''},{code:0,stdout:''},{code:0,stdout:'invalid-head'}])('refuses standards before prepare when logical HEAD evidence is unavailable: %j',async evidence=>{
    const f=fixture(),original=f.exec;f.argv=['npm','run','check:standards'];
    f.exec=vi.fn(call=>call.file==='git'&&call.args.join(' ')==='rev-parse HEAD'?evidence:original(call));
    expect(await runRemote(f)).toEqual({mode:'fallback',reason:'copy-failed'});
    expect(callsOf(f.exec).some(c=>isPrepare(c)||c.file==='rsync'||isRun(c))).toBe(false);
  });
  it.each(['0\n', '97\n', `${'f'.repeat(32)}:0\n`])('refuses local rerun for an unbound receipt %j', async (receipt) => {
    const f = fixture({ runCode: receipt === '97\n' ? 97 : 0, receipt });
    const log = vi.fn();
    expect(await runRemoteCli({ ...f, log })).toBe(124);
    expect(f.local).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ambiguous-result'));
  });

  it('rejects a prior valid receipt when the caller reuses the run id', async () => {
    let priorReceipt;
    const f = fixture({ receipt: (_nonce, value, request) => priorReceipt ??= JSON.stringify({...value, manifestDigest:request.manifestDigest}) });
    expect(await runRemote(f)).toEqual({ mode: 'remote', code: 0 });
    const log = vi.fn();
    expect(await runRemoteCli({ ...f, log })).toBe(124);
    const nonces = callsOf(f.exec).filter(isRun).map((call) => nonceOf(call.input));
    expect(nonces[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(nonces[1]).not.toBe(nonces[0]);
    expect(f.local).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ambiguous-result'));
  });

  it('falls back before transfer or execution when stale receipt removal fails', async () => {
    const f = fixture({ prepareCode: 1 });
    expect(await runRemoteCli({ ...f, log: vi.fn() })).toBe(7);
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
    expect(callsOf(f.exec).some(isRun)).toBe(false);
  });

  it('falls back before copying when literal inventory framing exceeds the byte limit', async () => {
    const f = fixture();
    // Prefix and NUL are part of the 4 MiB transport budget.
    f.listFiles.mockResolvedValue(['a'.repeat(4 * 1024 * 1024 - 2)]);
    const log = vi.fn();
    expect(await runRemoteCli({ ...f, log })).toBe(7);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('copy-failed'));
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
  });

  it.each(['test:unit', 'check:standards'])('falls back before transport for %s when the snapshot requires an outside-allowlist sibling', async (command) => {
    const f = fixture();
    const file = 'blocks/__tests__/unit/resource-loader/ResourceLoader.test.ts';
    f.argv = ['npm', 'run', command, '--', command === 'check:standards' ? '--files='+file : file];
    f.listFiles.mockResolvedValue(['package-lock.json', 'vitest.shared.ts']);
    writeFileSync(join(cwd, 'vitest.shared.ts'), "export const fuiPlugsRoot = resolve(repoRoot, '../frontierui/outside');\n");
    const log = vi.fn();
    expect(await runRemoteCli({ ...f, log })).toBe(7);
    expect(f.local).toHaveBeenCalledWith(f.argv);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unsupported-sibling-dependency'));
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
  });
  it('falls back without exec for a command outside the allowlist', async () => {
    const f = fixture();
    expect(await runRemote({ ...f, argv: ['npm', 'run', 'build'] }))
      .toEqual({ mode: 'fallback', reason: 'command-not-allowed' });
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.local).not.toHaveBeenCalled();
  });
  it('falls back when the forge probe fails, without copying or running', async () => {
    const f = fixture({ probeCode: 255 });
    expect(await runRemote(f)).toEqual({ mode: 'fallback', reason: 'forge-unreachable' });
    expect(callsOf(f.exec)).toContainEqual(expect.objectContaining({ file: 'ssh', args: ['forge', 'true'] }));
    expect(callsOf(f.exec).some((call) => call.file === 'rsync' || isRun(call))).toBe(false);
  });
  it('reports copy-failed and attempts cleanup after an unsuccessful rsync', async () => {
    const f = fixture({ copyCode: 23 });
    expect(await runRemote(f)).toEqual({ mode: 'fallback', reason: 'copy-failed' });
    expect(callsOf(f.exec).some(isRun)).toBe(false);
    expect(callsOf(f.exec).filter(isCleanup)).toHaveLength(1);
    expect(JSON.parse(callsOf(f.exec).find(isCleanup).input).run).toMatch(/^r-/);
    expectNoSecrets(f.exec);
  });
  it.each([0, 3, 97, 254])('returns confirmed remote exit code %s and cleans up after reading the receipt', async (code) => {
    const f = fixture({ runCode: code });
    expect(await runRemote(f)).toEqual({ mode: 'remote', code });
    const calls = callsOf(f.exec);
    const run = calls.find(isRun);
    expect(run).toMatchObject({ file: 'ssh', inherit: true, input: expect.any(String) });
    expect(calls.filter(isReceipt)).toHaveLength(1);
    expect(calls.findIndex(isReceipt)).toBeGreaterThan(calls.findIndex(isRun));
    expect(calls.filter(isCleanup)).toHaveLength(1);
    expect(JSON.parse(calls.find(isCleanup).input).run).toMatch(/^r-/);
    expect(f.local).not.toHaveBeenCalled();
    expectNoSecrets(f.exec);
  });
  it.each([
    { runCode: 0, receipt: '' }, { runCode: 0, receipt: 'not-a-number\n' },
    { runCode: 0, receipt: '0oops\n' }, { runCode: 0, receipt: '0\n3\n' },
    { runCode: 0, receipt: (nonce) => `${nonce}:3\n` }, { runCode: 3, receipt: (nonce) => `${nonce}:0\n` },
    { runCode: 0, receiptCode: 1 },
    { runCode: 255 }, { runCode: 255, receipt: (nonce) => `${nonce}:0\n` },
    ...['0\n\n', '0\r\n', '0\u2028', '00\n', '-1\n', '256\n', '0\ntrailing', '0'.repeat(100)].map((suffix) => ({
      runCode: 0, receipt: (nonce) => `${nonce}:${suffix}`,
    })),
  ])('fails closed with ambiguous-result and attempts cleanup for %j', async (scenario) => {
    const f = fixture(scenario);
    expect(await runRemote(f)).toEqual({ mode: 'unconfirmed', reason: 'ambiguous-result' });
    expect(callsOf(f.exec).some(isCleanup)).toBe(true);
    expectNoSecrets(f.exec);
  });
  it('uses the injected file list as rsync stdin, excludes node_modules, and selects the restricted rsync user', async () => {
    const f = fixture();
    mkdirSync(join(cwd,'src'));
    writeFileSync(join(cwd,'src/a file.mjs'),'fixture');
    f.listFiles.mockResolvedValue(['package-lock.json', 'src/a file.mjs', 'node_modules/secret.js', 'src/node_modules/nested.js', '.exit-code', 'src/.exit-code', '.exit-code/forged']);
    await runRemote({ ...f, host: 'custom-forge' });
    expect(f.listFiles).toHaveBeenCalledWith(cwd);
    const calls = callsOf(f.exec);
    expect(calls).toContainEqual(expect.objectContaining({ file: 'ssh', args: ['custom-forge', 'true'] }));
    const copy = calls.find((call) => call.file === 'rsync');
    expect(copy.args.join(' ')).toMatch(/--files-from(?:=|\s)-/);
    expect(copy.args).toContain('--from0');
    expect(copy.args).toEqual(expect.arrayContaining(['--no-recursive','--no-dirs','--no-links','--safe-links']));
    expect(copy.args).not.toContain('--no-implied-dirs');
    expect(copy.args).not.toContain('-r');
    expect(copy.args).not.toContain('--delete');
    expect(copy.args).not.toContain('-L');
    expect(copy.args).toContain('--exclude=.exit-code');
    expect(calls.findIndex(isPrepare)).toBeLessThan(calls.indexOf(copy));
    expect(sshText(calls.find(isPrepare))).toBe('custom-forge sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs prepare');
    const input = copy.input.toString('latin1');
    expect(input.split('\0')).toEqual(['./package-lock.json', './src/a file.mjs', '']);
    expect(copy.args.join(' ')).toMatch(/--rsync-path(?:=|\s)sudo -u forge-exec rsync/);
    expect(copy.args.join(' ')).toMatch(/custom-forge:\/srv\/forge-exec\/r-[a-f0-9]+\/work\//);
    expect(input).toContain('package-lock.json');
    expect(input).toContain('src/a file.mjs');
    expect(input).not.toContain('node_modules');
    expectNoSecrets(f.exec);
  });
  it('defaults to git ls-files -co --exclude-standard when listFiles is omitted', async () => {
    const { listFiles, ...f } = fixture();
    await runRemote(f);
    expect(callsOf(f.exec)).toContainEqual(expect.objectContaining({
      file: 'git', args: expect.arrayContaining(['ls-files', '-co', '--exclude-standard']),
    }));
    expect(callsOf(f.exec).find((call) => call.file === 'rsync').input.toString('latin1')).toContain('a.test.mjs');
  });
});

describe('runRemoteCli', () => {
  it.each([
    ['npm', 'run', 'build'],
    ['npm', 'run', 'test:unit', '--script-shell=/usr/bin/true'],
    ['npm', 'run', 'check:standards', '--ignore-scripts'],
  ])('refuses disallowed argv without remote or local execution: %j', async (...command) => {
    const f = { ...fixture(), argv: command };
    await expect(runRemoteCli(f)).rejects.toThrow('command-not-allowed');
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.local).not.toHaveBeenCalled();
  });
  it.each([
    ['forge-unreachable', {}, { probeCode: 255 }],
    ['copy-failed', {}, { copyCode: 23 }],
    ['ambiguous-result', {}, { receipt: '' }],
  ])('logs %s and admits local execution only before remote start', async (reason, overrides, scenario) => {
    const f = { ...fixture(scenario), ...overrides };
    const log = vi.fn();
    expect(await runRemoteCli({ ...f, log })).toBe(reason === 'ambiguous-result' ? 124 : 7);
    if (reason === 'ambiguous-result') expect(f.local).not.toHaveBeenCalled();
    else {
      expect(f.local).toHaveBeenCalledTimes(1);
      expect(f.local).toHaveBeenCalledWith(f.argv);
    }
    expect(log.mock.calls.some((args) => args.some((message) => typeof message === 'string' && message.includes(reason)))).toBe(true);
    expectNoSecrets(f.exec);
  });
  it.each([0, 3])('returns remote code %s without running locally', async (code) => {
    const f = fixture({ runCode: code });
    expect(await runRemoteCli({ ...f, log: vi.fn() })).toBe(code);
    expect(f.local).not.toHaveBeenCalled();
  });
});

describe('explicit remote CLI decision', () => {
  it.each([
    ['unconfirmed', {mode:'unconfirmed', reason:'ambiguous-result'}, 124],
    ['malformed', {mode:'remote', code:'0'}, 124],
    ['missing', undefined, 124],
    ['remote success', {mode:'remote', code:0}, 0],
    ['remote failure', {mode:'remote', code:23}, 23],
  ])('%s exits without a local rerun even when remote defaults are disabled', async (_name, result, code) => {
    const remoteExec = vi.fn(async () => result), local = vi.fn();
    expect(await remoteManifestAPI.main({argv,cwd,lockRoot:join(cwd,'heavy'), remoteExec, local, log:vi.fn()})).toBe(code);
    expect(remoteExec).toHaveBeenCalledTimes(1);
    expect(local).not.toHaveBeenCalled();
  });
  it('thrown remote execution exits 124 without a local rerun', async () => {
    const local = vi.fn();
    await expect(remoteManifestAPI.main({argv,cwd,lockRoot:join(cwd,'heavy'), remoteExec:async () => {throw new Error('disconnected');}, local, log:vi.fn()})).resolves.toBe(124);
    expect(local).not.toHaveBeenCalled();
  });
  it('timeout exits 124 without a local rerun', async () => {
    vi.useFakeTimers();
    const local = vi.fn();
    try {
      const pending = remoteManifestAPI.main({argv,cwd,lockRoot:join(cwd,'heavy'), timeoutMs:10, remoteExec:() => new Promise(() => {}), local, log:vi.fn()});
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(1010);
      expect(await pending).toBe(124);
      expect(local).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(['not-started', 'cancelled'])('confirmed %s may enter local admission', async mode => {
    const local = vi.fn(async () => 7);
    expect(await remoteManifestAPI.main({argv,cwd,lockRoot:join(cwd,'heavy'), remoteExec:async () => ({mode, terminated:true}), local, log:vi.fn()})).toBe(7);
    expect(local).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledWith(argv);
  });
});

describe('parseArgs', () => {
  it('parses host/run-id options and preserves command args after the separator', () => {
    expect(parseArgs(['--host=x', '--run-id=abcdef-1', '--', ...argv]))
      .toEqual({ host: 'x', runId: 'abcdef-1', argv });
  });
});

describe('forge-setup.sh', () => {
  function directorySetup() {
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    const body = setup.match(/python3 - <<'DIRECTORIES'\n([\s\S]*?)\nDIRECTORIES/);
    expect(body, 'setup must use descriptor-anchored directory operations').not.toBeNull();
    return body[1];
  }

  it.each(['0','129','not-a-number'])('rejects FORGE_EXEC_SLOTS=%s before setup',slots=>{
    const setup=readFileSync(new URL('../forge-setup.sh',import.meta.url),'utf8');
    const guard=setup.slice(setup.indexOf('set -euo pipefail'),setup.indexOf('export FORGE_EXEC_SLOTS'));
    const result=spawnSync('bash',['-c',guard],{encoding:'utf8',timeout:10000,env:{...process.env,FORGE_EXEC_SLOTS:slots}});
    expect(result.status).not.toBe(0);expect(result.stderr).toContain('FORGE_EXEC_SLOTS must be 1..128');
  });
  it.each([
    ['invalid or shared worker identity',"pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=0, pw_gid=os.getgid())"],
    ['invalid or shared worker identity',"original_pwd = pwd.getpwnam\npwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=5001, pw_gid=original_pwd(name).pw_gid) if name.startswith('forge-exec-') else original_pwd(name)"],
    ['invalid or shared worker identity',`# Duplicate primary GID with distinct worker UIDs and matching named groups.
original_pwd, original_grp = pwd.getpwnam, grp.getgrnam
pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=original_pwd(name).pw_uid, pw_gid=6001) if name.startswith('forge-exec-') else original_pwd(name)
grp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=6001, gr_mem=[]) if name.startswith('forge-exec-') else original_grp(name)`],
    ['invalid or shared worker identity',"original_grp = grp.getgrnam\ngrp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=9999, gr_mem=[]) if name.startswith('forge-exec-') else original_grp(name)"],
    ['slot groups must be private',"original_grp = grp.getgrnam\ngrp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=original_grp(name).gr_gid, gr_mem=['intruder'])"],
    ['slot groups must be private',"os.getgrouplist = lambda name, gid: [gid, 6001] if name == 'ops' else [gid]"],
    ['slot users must not have supplementary groups',"os.getgrouplist = lambda name, gid: [gid, 9999] if name.startswith('forge-exec-') else [gid]"],
  ])('rejects setup identity evidence: %s (%s)',(message,override)=>{
    const srv=join(cwd,'srv');mkdirSync(srv);
    const body=directorySetup();
    const harness=directoryHarness(body,srv).replace(body.replaceAll('"/srv"',JSON.stringify(srv)),override+'\n'+body.replaceAll('"/srv"',JSON.stringify(srv)));
    const result=spawnSync('python3',['-c',harness],{encoding:'utf8',timeout:10000});
    expect(result.status).not.toBe(0);expect(result.stderr).toContain('RuntimeError: '+message);
  });

  it.each(['forge-exec', 'forge-exec/.cache'])('rejects a symlink at %s without changing its target', (path) => {
    const srv = join(cwd, 'srv');
    const target = join(cwd, 'target');
    mkdirSync(srv);
    mkdirSync(target, { mode: 0o755 });
    if (path.includes('/')) mkdirSync(join(srv, 'forge-exec'));
    symlinkSync(target, join(srv, path));
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    const body = setup.match(/python3 - <<'DIRECTORIES'\n([\s\S]*?)\nDIRECTORIES/);
    // The legacy branch lets the real symlink regression discriminate the old
    // shell setup too, rather than failing only because its implementation differs.
    const script = body
      ? `python3 - <<'DIRECTORIES'\n${directoryHarness(body[1], srv)}\nDIRECTORIES`
      : `set -euo pipefail\nchown() { :; }\n${setup.slice(setup.indexOf('\nfi\n') + 4, setup.indexOf('# ops')).replaceAll('/srv/forge-exec', join(srv, 'forge-exec'))}`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).not.toBe(0);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
    expect(existsSync(join(target, '.cache'))).toBe(false);
  });

  // Exercise the real no-follow opens and modes without requiring root or a system account.
  function directoryHarness(body, srv) {
    return `import os, grp, pwd, types
original_fstat = os.fstat
owners = {}
os.fstat = lambda fd: types.SimpleNamespace(st_uid=0, st_mode=original_fstat(fd).st_mode)
os.fchown = lambda fd, uid, gid: owners.__setitem__(original_fstat(fd).st_ino, (uid, gid))
os.environ['FORGE_EXEC_SLOTS'] = '2'
os.getgrouplist = lambda name, gid: [gid]
grp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=6000+int(name.rsplit('-', 1)[1]) if name.startswith('forge-exec-') else os.getgid(), gr_mem=[])
pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=5000+int(name.rsplit('-', 1)[1]) if name.startswith('forge-exec-') else 0, pw_gid=6000+int(name.rsplit('-', 1)[1]) if name.startswith('forge-exec-') else os.getgid())
${body.replaceAll('"/srv"', JSON.stringify(srv))}
assert owners[os.stat(${JSON.stringify(join(srv, 'forge-exec'))}).st_ino] == (0, os.getgid())
assert owners[os.stat(${JSON.stringify(join(srv, 'forge-exec/.cache'))}).st_ino] == (0, os.getgid())
for k in (1, 2):
    path = ${JSON.stringify(join(srv, 'forge-exec'))} + '/slot-' + str(k)
    assert owners[os.stat(path).st_ino] == (0, 6000+k)
    assert os.stat(path).st_mode & 0o7777 == 0o710`;
  }

  it('keeps parent entries protected on rerun and freezes the parent before opening the cache', () => {
    const body = directorySetup();
    const srv = join(cwd, 'srv');
    mkdirSync(srv);
    const harness = directoryHarness(body, srv).replace('original_fstat = os.fstat', `original_open = os.open
def checked_open(path, flags, *args, **kwargs):
    if path == '.cache':
        assert flags & os.O_NOFOLLOW
        assert os.stat(${JSON.stringify(join(srv, 'forge-exec'))}).st_mode & 0o7777 == 0o700
        assert owners.get(os.stat(${JSON.stringify(join(srv, 'forge-exec'))}).st_ino) == (0, os.getgid())
    return original_open(path, flags, *args, **kwargs)
os.open = checked_open
original_fstat = os.fstat`);
    for (const attempt of [1, 2]) {
      const result = spawnSync('python3', ['-c', harness], { encoding: 'utf8' });
      expect(result.status, `attempt ${attempt}: ${result.stderr}`).toBe(0);
      expect(statSync(join(srv, 'forge-exec')).mode & 0o7777).toBe(0o755);
      expect(statSync(join(srv, 'forge-exec/.cache')).mode & 0o7777).toBe(0o700);
    }
  });

  it('rejects a cache swapped to a symlink immediately before opening it', () => {
    const srv = join(cwd, 'srv');
    const target = join(cwd, 'target');
    mkdirSync(srv);
    mkdirSync(target, { mode: 0o755 });
    const harness = directoryHarness(directorySetup(), srv).replace('original_fstat = os.fstat', `original_open = os.open
def swapping_open(path, flags, *args, **kwargs):
    if path == '.cache':
        os.rename('.cache', '.cache.saved', src_dir_fd=kwargs['dir_fd'], dst_dir_fd=kwargs['dir_fd'])
        os.symlink(${JSON.stringify(target)}, '.cache', dir_fd=kwargs['dir_fd'])
    return original_open(path, flags, *args, **kwargs)
os.open = swapping_open
original_fstat = os.fstat`);
    const result = spawnSync('python3', ['-c', harness], { encoding: 'utf8' });
    expect(result.status, result.stderr).not.toBe(0);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
    // A failed migration leaves the root closed, so an operator can repair it.
    expect(statSync(join(srv, 'forge-exec')).mode & 0o7777).toBe(0o700);
  });

  it.each([0o775, 0o757])('refuses a writable trusted parent (mode %s)', (mode) => {
    const srv = join(cwd, 'srv');
    mkdirSync(srv, { mode });
    // mkdir respects umask, so explicitly expose the untrusted write bits.
    // The harness changes only its scratch parent before executing setup.
    const forced = directoryHarness(directorySetup(), srv).replace('original_fstat = os.fstat', `os.chmod(${JSON.stringify(srv)}, ${mode})\noriginal_fstat = os.fstat`);
    const unsafe = spawnSync('python3', ['-c', forced], { encoding: 'utf8' });
    expect(unsafe.status, unsafe.stderr).not.toBe(0);
    expect(unsafe.stderr).toContain('/srv must be root-owned');
    expect(existsSync(join(srv, 'forge-exec'))).toBe(false);
  });

  it('creates the restricted user, run root and cache with strict bash and idempotency guards', () => {
    const setup = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
    expect(setup).toContain('set -euo pipefail');
    expect(setup).toMatch(/\buseradd\b[^\n]*\bforge-exec\b/);
    expect(setup).toContain('/srv/forge-exec');
    expect(setup).toContain('.cache');
    expect(setup).toMatch(/\bid\s+(?:-[a-zA-Z]+\s+)*forge-exec\b/);
    expect(setup).toContain('os.mkdir("forge-exec", 0o700, dir_fd=with_parent)');
    expect(setup).toContain('os.mkdir(".cache", 0o700, dir_fd=root)');
  });
});

describe('receipt field binding', () => {
  function expectValidReceipt(value) {
    const {phase,code,...expected} = value;
    expect(phase).toBe('test');
    expect(remoteManifestAPI.verifyReceipt(JSON.stringify(value),expected,code)).toBe(true);
  }
  it.each(['v','nonce','run','inputDigest','argvDigest','lock','manifestDigest','phase','code'])('rejects mismatched %s', async field => {
    let baseline;
    const f = fixture({receipt: (_nonce,value) => {
      baseline = {...value};
      return JSON.stringify({...value,[field]:field === 'v' ? 2 : field === 'code' ? 1 : 'wrong'});
    }});
    expect(await runRemote(f)).toEqual({mode:'unconfirmed',reason:'ambiguous-result'});
    // Assert outside transport callbacks: runRemote deliberately catches IO
    // exceptions, so a failing positive control inside one could be swallowed.
    expectValidReceipt(baseline);
  });
  it('rejects install-phase evidence even with matching status', async () => {
    let baseline;
    expect(await runRemote(fixture({runCode:97,receipt:(_n,v)=>{
      baseline = {...v};
      return JSON.stringify({...v,phase:'install'});
    }})))
      .toEqual({mode:'unconfirmed',reason:'ambiguous-result'});
    expectValidReceipt(baseline);
  });
});


// Manifest acceptance contract (Round 1):
// buildManifest({cwd, exec, fs?}) -> {entries:[{path:Buffer, sha256, executable:boolean, tracked:boolean}],
//   excluded:Buffer[], manifestDigest}. fs defaults to node:fs/promises; injected
//   lstat/readFile/readdir use Buffer paths and readdir({encoding:'buffer'}).
// isTestFile(path:Buffer) -> boolean is the shared test-file predicate.
// Wire manifest v2 = {v:2, paths:base64(NUL-terminated entries), hashes:string[],
//   executable:boolean[], tracked:boolean[], excluded:base64(NUL-terminated excluded paths)}.
// manifestDigest = sha256(JSON.stringify(wire manifest)) in that property order.
// entries and excluded are separately strictly byte-sorted. Excluded tests must
// throw; identity/keyword names outside a forbidden component remain selected.
// Namespace access keeps absent future exports as explicit contract assertion
// failures, rather than preventing collection of the behavioural regressions.
describe('certified snapshot equals selected inventory: client acceptance', () => {
  const sha = value => createHash('sha256').update(value).digest('hex');
  const nul = paths => Buffer.concat(paths.flatMap(path => [path, Buffer.from([0])]));
  const wire = manifest => ({
    v:2,
    paths:nul(manifest.entries.map(entry => entry.path)).toString('base64'),
    hashes:manifest.entries.map(entry => entry.sha256),
    executable:manifest.entries.map(entry => entry.executable),
    tracked:manifest.entries.map(entry => entry.tracked),
    excluded:nul(manifest.excluded).toString('base64'),
  });
  async function build(options) {
    expect(remoteManifestAPI.buildManifest, 'export the single inventory builder').toBeTypeOf('function');
    return remoteManifestAPI.buildManifest({exec:gitInventory([]), ...options});
  }
  it.each(['parent','leaf'])('rejects an allowlisted ignored coverage input with a %s symlink', async kind => {
    const outside=join(cwd,'outside');
    mkdirSync(outside);
    writeFileSync(join(outside,'coverage-final.json'),'private bytes');
    if(kind==='parent')symlinkSync(outside,join(cwd,'coverage'));
    else {
      mkdirSync(join(cwd,'coverage'));
      symlinkSync(join(outside,'coverage-final.json'),join(cwd,'coverage/coverage-final.json'));
    }
    const exec=vi.fn(async call=>({code:0,stdout:call.args.includes('-i')?Buffer.from('coverage/coverage-final.json\0'):Buffer.alloc(0)}));
    await expect(build({cwd,exec})).rejects.toThrow('Unsafe inventory component');
  });
  function gitInventory(paths, stage = Buffer.alloc(0), tree = {code:0, stdout:Buffer.alloc(0)}) {
    return vi.fn(async call => {
      expect(call.file).toBe('git');
      expect(call.args).toContain('-z');
      if (call.args[0] === 'ls-tree') {
        expect(call.args).toEqual(['ls-tree', '-r', '-z', 'origin/main']);
        if (tree instanceof Error) throw tree;
        return tree;
      }
      return {code:0, stdout:call.args.includes('-i') ? Buffer.alloc(0) : call.args.includes('-s') || call.args.includes('--stage') ? stage : nul(paths)};
    });
  }
  // This stub certifies only what the client sends, including the new binding.
  // It deliberately accepts the old protocol too, so omission is observable.
  function acceptingTransport(paths, stage = Buffer.alloc(0)) {
    let state;
    return vi.fn(async call => {
      if (call.file === 'git') return {code:0, stdout:call.args.includes('-i') ? Buffer.alloc(0) : call.args.includes('-s') || call.args.includes('--stage') ? stage : nul(paths)};
      if (isPrepare(call)) {
        state = JSON.parse(call.input);
        return {code:0, stdout:JSON.stringify({run:'r-'+state.nonce})};
      }
      if (isRun(call)) {state = JSON.parse(call.input); return {code:0, stdout:''};}
      if (isReceipt(call)) {
        const receipt = {v:1, nonce:state.nonce, run:state.run, inputDigest:state.inputDigest,
          argvDigest:state.argvDigest, lock:state.lock, phase:'test', code:0};
        if (state.manifestDigest !== undefined) receipt.manifestDigest = state.manifestDigest;
        return {code:0, stdout:JSON.stringify(receipt)};
      }
      return {code:0, stdout:''};
    });
  }

  it('selects identity and key-word tests, refusing tracked credential tests without transmitting them', async () => {
    const paths = ['identity.test.mjs', 'key-management.spec.ts', 'package-lock.json'].map(value => Buffer.from(value));
    for (const path of paths.slice(0, -1)) writeFileSync(Buffer.concat([Buffer.from(cwd+'/'), path]), 'assertion');
    const manifest = await build({cwd, exec:gitInventory(paths, Buffer.from(paths.map(path => `100644 ${'a'.repeat(40)} 0\t${path}\0`).join('')))});
    expect(manifest.entries.map(entry => entry.path)).toEqual([...paths].sort(Buffer.compare));
    expect(manifest.excluded).toEqual([]);
    for (const entry of manifest.entries) {
      expect(Buffer.isBuffer(entry.path)).toBe(true);
      expect(entry.sha256).toBe(sha(readFileSync(Buffer.concat([Buffer.from(cwd+'/'), entry.path]))));
      expect(entry.executable).toBe(false);
    }
    expect(manifest.manifestDigest).toBe(sha(JSON.stringify(wire(manifest))));
    const credential = Buffer.from('check-credentials.test.mjs');
    writeFileSync(join(cwd, credential.toString()), 'must run locally');
    await expect(build({cwd, exec:gitInventory([...paths, credential],
      Buffer.from(`100644 ${'a'.repeat(40)} 0\t${credential}\0`))}))
      .rejects.toMatchObject({message:'Excluded source: use local fallback', code:'excluded-source-file'});
  });

  it.each(['credentials.test.mjs', 'fixture.key/identity.test.mjs', '.env/identity.spec.ts', '__tests__/credentials.js', 'credentials-check.test.mjs', '.envrc/identity.test.mjs', '__tests__/credentials-backup.js'])
  ('fails closed instead of silently dropping a test excluded by the secret rule: %s', async name => {
    const f = fixture();
    const parts = name.split('/');
    if (parts.length > 1) mkdirSync(join(cwd, parts[0]));
    writeFileSync(join(cwd, name), 'must run');
    f.listFiles.mockResolvedValue(['package-lock.json', name]);
    expect(await runRemote(f)).toEqual({mode:'not-started', terminated:true, reason:'excluded-source-file'});
    expect(callsOf(f.exec).some(isRun)).toBe(false);
    expect(callsOf(f.exec).some(call => call.file === 'rsync')).toBe(false);
    expect(await runRemoteCli({...f, log:vi.fn()})).toBe(7);
    expect(f.local).toHaveBeenCalledTimes(1);
  });

  it.each(['credentials.test.mjs', 'fixture.key/identity.test.mjs', '.env/identity.spec.ts', '__tests__/credentials.js', 'credentials-check.test.mjs', '.envrc/identity.test.mjs', '__tests__/credentials-backup.js'])
  ('runs locally before prepare or rsync when an excluded component contains a test: %s', async name => {
    const f = fixture();
    // Establish that this transport can certify the ordinary snapshot. A later
    // fallback must come from the excluded test, not an unrelated fixture error.
    expect(await runRemote(f)).toEqual({mode:'remote', code:0});
    f.exec.mockClear();
    const parts = name.split('/');
    if (parts.length > 1) mkdirSync(join(cwd, parts[0]));
    writeFileSync(join(cwd, name), 'must run locally');
    f.listFiles.mockResolvedValue(['package-lock.json', 'a.test.mjs', name]);

    expect(await runRemote(f)).toEqual({mode:'not-started', terminated:true, reason:'excluded-source-file'});
    expect(await runRemoteCli({...f, log:vi.fn()})).toBe(7);
    expect(f.local).toHaveBeenCalledTimes(1);
    expect(f.local).toHaveBeenCalledWith(f.argv);
    const calls = callsOf(f.exec);
    expect(calls.some(isPrepare)).toBe(false);
    expect(calls.some(call => call.file === 'rsync')).toBe(false);
    expect(calls.some(isRun)).toBe(false);
  });

  it.each([
    'node_modules/dependency.js', '.git/config', '.env', '.env.local', '.envrc', '.environment',
    '.secrets/value', '.ssh/config', '.aws/config', '.claude/config.json', '.codex/config.toml',
    '.npmrc', '.netrc', 'credentials', 'credentials.json', 'credentials-backup.json',
    'private.pem', 'private.key', '.exit-code',
  ].flatMap(name => [name, `nested/${name}`]))
  ('preserves former transport exclusions in the manifest and rsync inventory: %s', async name => {
    mkdirSync(join(cwd, name, '..'), {recursive:true});
    writeFileSync(join(cwd, name), 'DO_NOT_TRANSMIT');
    const paths = [Buffer.from('package-lock.json'), Buffer.from(name)];
    const manifest = await build({cwd, exec:gitInventory(paths)});
    expect(manifest.entries.map(entry => entry.path)).toEqual([Buffer.from('package-lock.json')]);
    expect(manifest.excluded).toEqual([Buffer.from(name)]);
    const exec = acceptingTransport(paths);
    expect(await runRemote({argv, cwd, runId, exec})).toEqual({mode:'remote', code:0});
    const copy = callsOf(exec).find(call => call.file === 'rsync');
    expect(copy.input).toEqual(Buffer.from('./package-lock.json\0'));
    const sent = JSON.parse(callsOf(exec).find(isRun).input);
    expect(sent.manifest).toEqual(wire(manifest));
  });

  it.each([
    '.gemini/oauth_creds.json', '.config/gh/hosts.yml', '.azure/accessTokens.json',
    '.unknown/config.json', 'src/.hidden', '.github/.private/config',
    'id_rsa', 'backup_rsa_old', 'id_dsa.pub', 'id_ecdsa', 'id_ed25519.pub',
    'cert.pem', 'cert.key', 'cert.p12', 'cert.pfx', 'cert.jks', 'cert.keystore',
    'secrets.json', 'tokens.json', 'creds.json', 'credential.json', 'passwd.txt',
    'password.txt', 'oauth.json', 'apikey.json', 'api-key.json', 'ACCESS_TOKEN.json',
    'api_key.json', 'API_KEY.json', 'api key.json', 'api.key.json',
    'secréts.json', 'tóken.json', 'créds.json', 'íd_backup', 'cert.pém', 'nested/sécrets/hosts.yml',
    '.netrc', '.npmrc', '.env', '.env.production',
  ])('excludes credential class path %s from entries and rsync inventory', async name => {
    mkdirSync(join(cwd, ...name.split('/').slice(0,-1)), {recursive:true});
    writeFileSync(join(cwd, name), 'DO_NOT_TRANSMIT');
    const paths = ['package-lock.json', name].map(value => Buffer.from(value));
    const manifest = await build({cwd, exec:gitInventory(paths)});
    expect(manifest.excluded).toEqual([Buffer.from(name)]);
    expect(manifest.entries.map(entry => entry.path)).toEqual([Buffer.from('package-lock.json')]);
    const exec = acceptingTransport(paths);
    expect(await runRemote({argv, cwd, runId, exec})).toEqual({mode:'remote', code:0});
    expect(callsOf(exec).find(call => call.file === 'rsync').input).toEqual(Buffer.from('./package-lock.json\0'));
    expect(JSON.parse(callsOf(exec).find(isRun).input).manifest).toEqual(wire(manifest));
  });

  it.each([
    ...['mjs','js','ts','tsx','jsx','css','md','html'].map(ext => `secret-example.${ext}`),
    'credentials.md', 'credentials.ts', 'secrets.md', 'src/tokens.ts',
    'untracked-secret.ts', 'secret-directory/safe.md', 'check-credentials.test.mjs',
  ])('refuses excluded source %s before transmitting any snapshot', async name => {
    mkdirSync(join(cwd, name, '..'), {recursive:true});
    writeFileSync(join(cwd,name), 'DO_NOT_TRANSMIT');
    const paths = [Buffer.from(name), Buffer.from('package-lock.json')];
    const stage = Buffer.from(`100644 ${'a'.repeat(40)} 0\t${name}\0`);
    for (const index of [stage, Buffer.alloc(0)]) {
      await expect(build({cwd, exec:gitInventory(paths, index)}))
        .rejects.toMatchObject({message:'Excluded source: use local fallback', code:'excluded-source-file'});
      const exec = acceptingTransport(paths, index);
      expect(await runRemote({argv, cwd, runId, exec}))
        .toEqual({mode:'not-started', terminated:true, reason:'excluded-source-file'});
      const local = vi.fn(async () => 7);
      expect(await runRemoteCli({argv, cwd, runId, exec, local, lockRoot:join(cwd,'heavy'), log:vi.fn()})).toBe(7);
      expect(local).toHaveBeenCalledWith(argv);
      expect(callsOf(exec).some(isPrepare)).toBe(false);
      expect(callsOf(exec).some(call => call.file === 'rsync')).toBe(false);
      expect(callsOf(exec).some(isRun)).toBe(false);
    }
  });

  it.each([
    'id_custom', 'nested/ID_BACKUP', 'id_custom/hosts.yml',
    'ｓｅｃｒｅｔｓ.json', 'to\u200bken.json', 'cert.pem.', 'nested/cert.KEY...',
    'secret-directory ./hosts.yml', 'nested/ｉｄ_custom', 'cert.pem   ',
    'secrеts.json', 'nested/ѕafe/hosts.yml', 'safe\u0001.json', 'safe\u007f.json',
    'nested/sa\u0085fe/hosts.yml', 'toκen.json', 'ıd_custom',
    '.gitignore/hosts.yml', '.prettierrc-local/hosts.yml',
    'nested/.gitattributes/hosts.yml', 'nested/.eslintrc.json/hosts.yml',
  ])('excludes normalized or unsafe component %s from entries and transport', async name => {
    mkdirSync(join(cwd, name, '..'), {recursive:true});
    writeFileSync(join(cwd,name), 'DO_NOT_TRANSMIT');
    const paths = [Buffer.from('package-lock.json'), Buffer.from(name)];
    const manifest = await build({cwd, exec:gitInventory(paths)});
    expect(manifest.entries.map(entry => entry.path)).toEqual([Buffer.from('package-lock.json')]);
    expect(manifest.excluded).toEqual([Buffer.from(name)]);
    const exec = acceptingTransport(paths);
    expect(await runRemote({argv, cwd, runId, exec})).toEqual({mode:'remote', code:0});
    expect(callsOf(exec).find(call => call.file === 'rsync').input).toEqual(Buffer.from('./package-lock.json\0'));
  });

  const blob = data => createHash('sha1').update(`blob ${Buffer.byteLength(data)}\0`).update(data).digest('hex');
  const indexRecord = (name, data) => Buffer.from(`100644 ${blob(data)} 0\t${name}\0`);
  const treeRecord = (name, data) => Buffer.from(`100644 blob ${blob(data)}\t${name}\0`);

  it.each([
    '.claude/skills/x/SKILL.md', '.eleventy.js',
    '.claude/secrets.md', '.secret.js', 'secret-directory/.hidden.md',
    'private.key/safe.md', 'secret.key/safe.js', '.env.local.js',
    '.netrc/safe.md', '.npmrc/safe.js',
  ])('silently excludes tracked forbidden source %s and proceeds remotely without public evidence', async name => {
    mkdirSync(join(cwd, name, '..'), {recursive:true});
    writeFileSync(join(cwd, name), 'DO_NOT_TRANSMIT');
    const paths = ['package-lock.json', name].map(value => Buffer.from(value));
    const stage = indexRecord(name, 'DO_NOT_TRANSMIT');
    const inventory = gitInventory(paths, stage, new Error('must not read public evidence'));
    const manifest = await build({cwd, exec:inventory});
    expect(manifest.entries.map(entry => entry.path)).toEqual([Buffer.from('package-lock.json')]);
    expect(manifest.excluded).toEqual([Buffer.from(name)]);
    expect(callsOf(inventory).some(call => call.args[0] === 'ls-tree')).toBe(false);
    const exec = acceptingTransport(paths, stage);
    expect(await runRemote({argv, cwd, runId, exec})).toEqual({mode:'remote', code:0});
    expect(callsOf(exec).find(call => call.file === 'rsync').input).toEqual(Buffer.from('./package-lock.json\0'));
    expect(JSON.parse(callsOf(exec).find(isRun).input).manifest).toEqual(wire(manifest));
  });

  it('keeps .githooks in the remote snapshot so remote check:standards sees hook files', async () => {
    const name = '.githooks/pre-commit';
    mkdirSync(join(cwd, '.githooks'), {recursive:true});
    writeFileSync(join(cwd, name), '#!/bin/sh\n');
    const manifest = await build({cwd, exec:gitInventory(['package-lock.json', name].map(value => Buffer.from(value)))});
    expect(manifest.entries.map(entry => entry.path.toString())).toContain(name);
    expect(manifest.excluded.map(entry => entry.toString())).not.toContain(name);
  });

  it.each(['.claude/skills/x/SKILL.test.md', '.eleventy.test.js', '.claude/secrets.test.js', 'private.key/safe.test.js'])
  ('still refuses excluded test %s before transmitting a snapshot', async name => {
    const paths = ['package-lock.json', name].map(value => Buffer.from(value));
    const exec = acceptingTransport(paths, indexRecord(name, 'must run locally'));
    await expect(build({cwd, exec})).rejects.toMatchObject({code:'excluded-source-file'});
    expect(await runRemote({argv, cwd, runId, exec}))
      .toEqual({mode:'not-started', terminated:true, reason:'excluded-source-file'});
    expect(callsOf(exec).some(call => call.file === 'rsync' || isPrepare(call) || isRun(call))).toBe(false);
  });

  it.each(['id_custom.md', 'id_backup/safe.js'])
  ('requires public evidence for credential-name-only source %s', async name => {
    mkdirSync(join(cwd, name, '..'), {recursive:true});
    writeFileSync(join(cwd, name), 'public');
    const paths = [Buffer.from(name)];
    const stage = indexRecord(name, 'public');
    await expect(build({cwd, exec:gitInventory(paths, stage)}))
      .rejects.toMatchObject({code:'excluded-source-file'});
    const manifest = await build({cwd, exec:gitInventory(paths, stage,
      {code:0, stdout:treeRecord(name, 'public')})});
    expect(manifest.entries.map(entry => entry.path)).toEqual(paths);
    expect(manifest.excluded).toEqual([]);
  });

  it('keeps tracked credential JSON excluded from entries', async () => {
    const paths = [Buffer.from('secret-example.json')];
    const stage = Buffer.from(`100644 ${'a'.repeat(40)} 0\tsecret-example.json\0`);
    const manifest = await build({cwd, exec:gitInventory(paths, stage)});
    expect(manifest.entries).toEqual([]);
    expect(manifest.excluded).toEqual(paths);
  });

  it.each(['mjs','js','ts','tsx','jsx','css','md','html'])
  ('allows public credential-named .%s source with matching index and working bytes', async ext => {
    const names = [`credentials.${ext}`, `secret-directory/safe.${ext}`];
    mkdirSync(join(cwd, 'secret-directory'));
    for (const name of names) writeFileSync(join(cwd, name), 'public');
    const exec = gitInventory(names.map(name => Buffer.from(name)), Buffer.concat(names.map(name => indexRecord(name, 'public'))),
      {code:0, stdout:Buffer.concat(names.map(name => treeRecord(name, 'public')))});
    const manifest = await build({cwd, exec});
    expect(manifest.entries.map(entry => entry.path.toString())).toEqual(names);
    expect(manifest.excluded).toEqual([]);
    expect(callsOf(exec).filter(call => call.args[0] === 'ls-tree')).toHaveLength(1);
  });

  it.each(['modified', 'untracked', 'new', 'staged-different'])
  ('refuses %s credential source despite public evidence where available', async kind => {
    const name = 'credentials.md';
    writeFileSync(join(cwd, name), kind === 'modified' ? 'private' : 'public');
    const stage = kind === 'untracked' ? Buffer.alloc(0) : indexRecord(name, kind === 'staged-different' ? 'private' : 'public');
    const tree = {code:0, stdout:kind === 'new' ? Buffer.alloc(0) : treeRecord(name, 'public')};
    await expect(build({cwd, exec:gitInventory([Buffer.from(name)], stage, tree)}))
      .rejects.toMatchObject({message:'Excluded source: use local fallback', code:'excluded-source-file'});
  });

  it.each([
    {code:128, stdout:Buffer.alloc(0)}, new Error('unreadable origin/main'),
    {code:0, stdout:Buffer.from('malformed\0')},
    {code:0, stdout:Buffer.alloc(4 * 1024 * 1024 + 1)},
    {code:0, stdout:treeRecord('credentials.md', 'public').subarray(0, -1)},
  ])('refuses credential source when origin/main evidence is unavailable or incomplete: %s', async tree => {
    writeFileSync(join(cwd, 'credentials.md'), 'public');
    await expect(build({cwd, exec:gitInventory([Buffer.from('credentials.md')], indexRecord('credentials.md', 'public'), tree)}))
      .rejects.toMatchObject({code:'excluded-source-file'});
  });

  it.each(['secrets.json', 'credentials.yaml', 'secret.pem', 'credentials', '.secrets/safe.md', 'secret.key/safe.md'])
  ('keeps public tracked non-source or forbidden-component path %s excluded', async name => {
    const paths = [Buffer.from(name)];
    const exec = gitInventory(paths, indexRecord(name, 'public'), {code:0, stdout:treeRecord(name, 'public')});
    const manifest = await build({cwd, exec});
    expect(manifest.entries).toEqual([]);
    expect(manifest.excluded).toEqual(paths);
    expect(callsOf(exec).some(call => call.args[0] === 'ls-tree')).toBe(false);
  });

  it.each(['.github/workflows/ci.yml','.husky/pre-commit','.vscode/settings.json','.storybook/main.ts','.changeset/change.md',
    '.gitignore','.gitattributes','.editorconfig','.nvmrc','.node-version','.prettierrc.json','.eslintrc.cjs','.gitkeep','.nycrc.json'])
  ('retains safe dot component %s', async name => {
    mkdirSync(join(cwd,...name.split('/').slice(0,-1)), {recursive:true});
    writeFileSync(join(cwd,name), 'safe');
    const paths = [Buffer.from(name)];
    const manifest = await build({cwd, exec:gitInventory(paths)});
    expect(manifest.entries.map(entry => entry.path)).toEqual(paths);
    expect(manifest.excluded).toEqual([]);
  });

  it('records excluded non-test secrets explicitly rather than losing inventory evidence', async () => {
    writeFileSync(join(cwd, '.env'), 'DO_NOT_COPY');
    const manifest = await build({cwd, exec:gitInventory(['.env', 'package-lock.json'].map(value => Buffer.from(value)))});
    expect(manifest.entries.map(entry => entry.path)).toEqual([Buffer.from('package-lock.json')]);
    expect(manifest.excluded).toEqual([Buffer.from('.env')]);
  });

  it('rejects undecodable test names before filesystem access or remote execution', async () => {
    const path = Buffer.concat([Buffer.from('raw-'), Buffer.from([0xff]), Buffer.from('.test.mjs')]);
    await expect(build({cwd, listFiles:async () => [path, Buffer.from('raw-�.test.mjs')]}))
      .rejects.toThrow('Input digest mismatch: undecodable test name');
    const f = fixture();
    f.listFiles.mockResolvedValue([path]);
    expect(await runRemote(f)).toEqual({mode:'fallback', reason:'copy-failed'});
    expect(callsOf(f.exec).some(isPrepare)).toBe(false);
    expect(callsOf(f.exec).some(call => call.file === 'rsync')).toBe(false);
    expect(callsOf(f.exec).some(isRun)).toBe(false);
  });

  it.each([['é.test.mjs', 'e\u0301.test.mjs'], ['A.test.mjs', 'a.test.mjs'], ['ß.test.mjs', 'SS.test.mjs']])
  ('rejects colliding client test names %s and %s', async (a, b) => {
    await expect(build({cwd, listFiles:async () => [a,b]})).rejects.toThrow('test name collision');
  });

  it('carries 0xff byte paths through buildManifest without requiring APFS filename support', async () => {
    const path = Buffer.concat([Buffer.from('raw-'), Buffer.from([0xff]), Buffer.from('.txt')]);
    const data = Buffer.from('raw test content');
    const fs = {
      lstat:vi.fn(async value => ({isDirectory:()=>Buffer.from(value).equals(Buffer.from(cwd)),
        isFile:()=>!Buffer.from(value).equals(Buffer.from(cwd)), isSymbolicLink:()=>false, mode:0o100755})),
      readFile:vi.fn(async value => {
        expect(Buffer.isBuffer(value)).toBe(true);
        expect(value).toEqual(Buffer.concat([Buffer.from(cwd+'/'), path]));
        return data;
      }),
    };
    const manifest = await build({cwd, exec:gitInventory([path]), fs});
    expect(manifest.entries).toEqual([{path, sha256:sha(data), executable:true,tracked:false}]);
    expect(manifest.manifestDigest).toBe(sha(JSON.stringify(wire(manifest))));
    expect(fs.readFile).toHaveBeenCalled();
  });

  it('uses exactly the manifest bytes for rsync stdin, selected digest, and run request', async () => {
    const paths = ['identity.test.mjs', 'key-management.spec.ts', 'é.test.mjs', 'package-lock.json'].map(value => Buffer.from(value));
    for (const path of paths.slice(0, 3)) writeFileSync(Buffer.concat([Buffer.from(cwd+'/'), path]), 'must run');
    const stage = Buffer.from(paths.map(path => `100644 ${'a'.repeat(40)} 0\t${path}\0`).join(''));
    const manifest = await build({cwd, exec:gitInventory(paths, stage)});
    const exec = acceptingTransport(paths, stage);
    expect(await runRemote({argv, cwd, runId, exec})).toEqual({mode:'remote', code:0});
    const copy = callsOf(exec).find(call => call.file === 'rsync');
    expect(copy.args).toEqual(expect.arrayContaining(['--from0','--files-from=-']));
    expect(Buffer.isBuffer(copy.input)).toBe(true);
    expect(copy.input).toEqual(Buffer.concat(manifest.entries.flatMap(({path}) => [Buffer.from('./'),path,Buffer.from([0])])));
    const sent = JSON.parse(callsOf(exec).find(isRun).input);
    expect(sent.manifest).toEqual(wire(manifest));
    expect(sent.manifestDigest).toBe(manifest.manifestDigest);
    expect(sent.inputDigest).toBe(await digestInput(cwd, manifest.entries.map(entry => entry.path)));
    // No second git inventory query may select a different snapshot.
    expect(callsOf(exec).filter(call => call.file === 'git' && call.args.includes('-co'))).toHaveLength(1);
    // The former credential-named test must now refuse the entire remote
    // snapshot; keep proving that no credential entry reaches either transport.
    const credential = Buffer.from('check-credentials.spec.ts');
    writeFileSync(join(cwd, credential.toString()), 'must run locally');
    const excludedPaths = [...paths, credential];
    const excludedStage = Buffer.concat([stage, Buffer.from(`100644 ${'a'.repeat(40)} 0\t${credential}\0`)]);
    await expect(build({cwd, exec:gitInventory(excludedPaths, excludedStage)}))
      .rejects.toMatchObject({message:'Excluded source: use local fallback', code:'excluded-source-file'});
    const refused = acceptingTransport(excludedPaths, excludedStage);
    expect(await runRemote({argv, cwd, runId, exec:refused}))
      .toEqual({mode:'not-started', terminated:true, reason:'excluded-source-file'});
    expect(callsOf(refused).some(call => call.file === 'rsync' || isPrepare(call) || isRun(call))).toBe(false);
  });

  it('transports and digests an actual 0xff filename byte-exactly when the filesystem supports it', async ctx => {
    const path = Buffer.concat([Buffer.from('raw-'),Buffer.from([0xff]),Buffer.from('.txt')]);
    const absolute = Buffer.concat([Buffer.from(cwd+'/'),path]);
    try {writeFileSync(absolute, 'raw assertion');}
    catch (error) {
      // APFS can report EPERM for invalid UTF-8 even in a writable directory.
      if (!['EILSEQ', 'EINVAL', 'ENOTSUP'].includes(error.code)
        && !(process.platform === 'darwin' && error.code === 'EPERM')) throw error;
      ctx.skip(); return;
    }
    if (!readdirSync(cwd, {encoding:'buffer'}).some(name => name.equals(path))) {ctx.skip(); return;}
    const paths = [path, Buffer.from('package-lock.json')];
    const exec = acceptingTransport(paths);
    expect(await runRemote({argv, cwd, runId, exec})).toEqual({mode:'remote', code:0});
    const ordered = [...paths].sort(Buffer.compare);
    expect(callsOf(exec).find(call => call.file === 'rsync').input)
      .toEqual(Buffer.concat(ordered.flatMap(name => [Buffer.from('./'),name,Buffer.from([0])])));
    const sent = JSON.parse(callsOf(exec).find(isRun).input);
    expect(Buffer.from(sent.manifest.paths, 'base64')).toEqual(nul(ordered));
    expect(sent.inputDigest).toBe(await digestInput(cwd, ordered));
    writeFileSync(absolute, 'changed assertion');
    expect(await digestInput(cwd, ordered)).not.toBe(sent.inputDigest);
  });

  it('resolves an injected gitlink and sends its tests, or falls back before certification', async () => {
    mkdirSync(join(cwd, 'vendor'));
    writeFileSync(join(cwd, 'vendor/nested.test.mjs'), 'submodule assertion');
    const stage = Buffer.from('160000 '+ 'a'.repeat(40)+' 0\tvendor\0');
    const transport = acceptingTransport([Buffer.from('package-lock.json'), Buffer.from('vendor')], stage);
    const exec = vi.fn(async call => {
      if (call.file === 'git' && call.cwd === join(cwd,'vendor')) return {code:0,
        stdout:call.args.includes('-s') || call.args.includes('--stage')
          ? Buffer.from('100644 '+ 'b'.repeat(40)+' 0\tnested.test.mjs\0')
          : Buffer.from('nested.test.mjs\0')};
      return transport(call);
    });
    const result = await runRemote({argv, cwd, runId, exec});
    if (result.mode === 'fallback') {
      expect(['copy-failed','gitlink-unsupported']).toContain(result.reason);
      expect(callsOf(exec).some(isRun)).toBe(false);
    } else {
      expect(result).toEqual({mode:'remote', code:0});
      const sent = JSON.parse(callsOf(exec).find(isRun).input);
      expect(Buffer.from(sent.manifest.paths,'base64').includes(Buffer.from('vendor/nested.test.mjs\0'))).toBe(true);
      expect(callsOf(exec).find(call => call.file === 'rsync').input.includes(Buffer.from('./vendor/nested.test.mjs\0'))).toBe(true);
    }
    // Gitlink classification must be based on the index, not guessed from a directory.
    expect(callsOf(exec).some(call => call.file === 'git' && (call.args.includes('-s') || call.args.includes('--stage')))).toBe(true);
  });

  it.each(['missing', 'wrong'])('rejects a %s manifestDigest in an otherwise matching green receipt', async kind => {
    let baseline;
    const f = fixture({receipt:(_nonce,value) => {
      baseline = {...value};
      const changed = {...value};
      if (kind === 'missing') delete changed.manifestDigest;
      else changed.manifestDigest = '0'.repeat(64);
      return JSON.stringify(changed);
    }});
    expect(await runRemote(f)).toEqual({mode:'unconfirmed', reason:'ambiguous-result'});
    const {phase,code,...expected} = baseline;
    expect(phase).toBe('test');
    expect(remoteManifestAPI.verifyReceipt(JSON.stringify(baseline),expected,code)).toBe(true);
  });
});


describe('allowlisted sibling snapshots', () => {
  let parent, sibling;
  function git(...args) {
    const result = spawnSync('git', ['-C', sibling, ...args], {encoding:'utf8'});
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  function siblingsFixture() {
    const f = fixture();
    parent = realpathSync(mkdtempSync(join(process.env.TMPDIR, 'remote-siblings-')));
    const repo = join(parent, 'work');
    sibling = join(parent, 'frontierui');
    mkdirSync(repo); mkdirSync(sibling);
    for (const subtree of ['plugs', 'webtheme']) {
      mkdirSync(join(sibling, subtree));
      writeFileSync(join(sibling, subtree, 'index.js'), `export const value = '${subtree}';`);
    }
    mkdirSync(join(sibling, 'webtheme/sub/dir'), {recursive:true});
    writeFileSync(join(sibling, 'webtheme/sub/dir/x.md'), 'nested sibling');
    writeFileSync(join(sibling, 'plugs', 'credentials.txt'), 'PRIVATE');
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
    for (const name of ['package-lock.json', 'a.test.mjs']) writeFileSync(join(repo,name), readFileSync(join(cwd,name)));
    writeFileSync(join(repo, 'vitest.shared.ts'), "resolve(repoRoot, '../frontierui/plugs'); resolve(repoRoot, '../frontierui/webtheme');");
    const fake = f.exec;
    f.cwd = repo;
    f.listFiles.mockResolvedValue(['a.test.mjs', 'package-lock.json', 'vitest.shared.ts']);
    f.exec = vi.fn(async call => {
      if (call.file === 'git' && call.cwd === sibling) {
        const result = spawnSync('git', call.args, {cwd:sibling, maxBuffer:4*1024*1024});
        return {code:result.status, stdout:result.stdout};
      }
      return fake(call);
    });
    return f;
  }
  afterEach(() => {if (parent) rmSync(parent, {recursive:true,force:true}); parent=undefined;});

  it('counts exact staged primary and sibling payload bytes, excluding private leaves',async()=>{
    const f=siblingsFixture();
    const primary=['a.test.mjs','package-lock.json','vitest.shared.ts'];
    const siblingFiles=['plugs/index.js','webtheme/index.js','webtheme/sub/dir/x.md'];
    // Read independently named fixture inputs, never the manifest or timing total.
    const bytes=[...primary.map(name=>readFileSync(join(f.cwd,name))),
      ...siblingFiles.map(name=>readFileSync(join(sibling,name)))].reduce((sum,data)=>sum+data.length,0);
    const result=await timedRunRemote(f);
    expect(result).toMatchObject({mode:'remote',code:0});
    expect(result.timings.find(stage=>stage.stage==='rsync')).toMatchObject({
      shipMode:'full',fileCount:6,bytesSent:bytes,deltaFileCount:0,deltaBytes:0});
    const copies=callsOf(f.exec).filter(call=>call.file==='rsync');
    expect(copies).toHaveLength(2);
    expect(copies[1].input.toString()).not.toContain('credentials.txt');
  });

  it('allows implied directories for both rsync calls and anchors nested inventory paths', async () => {
    const f = siblingsFixture();
    mkdirSync(join(f.cwd, 'sub/dir'), {recursive:true});
    writeFileSync(join(f.cwd, 'sub/dir/x.md'), 'nested primary');
    f.listFiles.mockResolvedValue(['a.test.mjs', 'package-lock.json', 'vitest.shared.ts', 'sub/dir/x.md']);
    expect(await runRemote(f)).toEqual({mode:'remote',code:0});
    const copies = callsOf(f.exec).filter(call => call.file === 'rsync');
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.args).not.toContain('--no-implied-dirs');
      expect(copy.args).toEqual(expect.arrayContaining(['--no-recursive','--no-dirs','--no-links','--safe-links']));
      expect(copy.args.at(-2)).toBe('./');
    }
    expect(copies[0].input.toString().split('\0')).toContain('./sub/dir/x.md');
    expect(copies[1].input.toString().split('\0')).toContain('./webtheme/sub/dir/x.md');
  });

  it('stages both trees with public leaf modes inside a private root and preserves Forge directory access through real rsync', async () => {
    const f = siblingsFixture();
    chmodSync(join(sibling,'plugs/index.js'), 0o755);
    git('add','.');
    git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','executable');
    chmodSync(join(f.cwd,'a.test.mjs'), 0o711);
    f.fs = restrictiveStageFs();
    const fake = f.exec;
    let copies = 0;
    f.exec = vi.fn(async call => {
      if (call.file === 'rsync') {
        copies++;
        expect(statSync(join(call.cwd,'..')).mode & 0o7777).toBe(0o700);
        expect(statSync(call.cwd).mode & 0o7777).toBe(0o755);
        const executable = call.args.at(-1).endsWith('/frontierui/') ? 'plugs/index.js' : 'a.test.mjs';
        expectStageModes(call.cwd, executable);
        const destination = join(parent,`copy-${copies}`);
        mkdirSync(destination);
        chmodSync(destination,0o755);
        const args = call.args.filter((arg,i,all) => !arg.startsWith('--rsync-path=') && arg !== '-e' && all[i-1] !== '-e');
        args[args.length-1] = destination+'/';
        const result = spawnSync('rsync',args,{cwd:call.cwd,input:call.input,timeout:10000});
        expect(result.status,result.stderr?.toString()).toBe(0);
        expect(statSync(destination).mode & 0o7777).toBe(0o755);
        expectStageModes(destination,executable);
      }
      return fake(call);
    });
    const result = await runRemote(f);
    const transport = await Promise.allSettled(f.exec.mock.results.map(call => call.type === 'throw' ? Promise.reject(call.value) : call.value));
    expect(transport.filter(call => call.status === 'rejected').map(call => call.reason?.stack ?? String(call.reason)), JSON.stringify(result)).toEqual([]);
    expect(result, JSON.stringify(result)).toEqual({mode:'remote',code:0});
    expect(copies).toBe(2);
  });

  it('ships both tracked sibling subtrees from private staging and binds their SHA in the receipt', async () => {
    const f = siblingsFixture();
    const sha = git('rev-parse', 'HEAD');
    const fake = f.exec;
    let copies = 0;
    f.exec = vi.fn(async call => {
      if (call.file === 'rsync' && call.args.at(-1).endsWith('/frontierui/')) {
        copies++;
        expect(statSync(call.cwd).mode & 0o777).toBe(0o755);
        expect(statSync(join(call.cwd,'..')).mode & 0o777).toBe(0o700);
        expect(readFileSync(join(call.cwd, 'plugs/index.js'), 'utf8')).toContain('plugs');
        expect(call.input.toString()).toContain('./webtheme/index.js\0');
        expect(call.input.toString()).not.toContain('credentials');
        expect(existsSync(join(call.cwd,'plugs/credentials.txt'))).toBe(false);
      }
      return fake(call);
    });
    expect(await runRemote(f)).toEqual({mode:'remote',code:0});
    expect(copies).toBe(1);
    const sent = JSON.parse(callsOf(f.exec).find(isRun).input);
    expect(sent.siblingShas).toEqual({frontierui:sha});
    expect(sent.manifest.siblings.frontierui.sha).toBe(sha);
    expect(sent.manifestDigest).toBe(forgeManifestAPI.digestManifest(sent.manifest));
    expect(remoteManifestAPI.verifyReceipt(JSON.stringify({...sent, manifest:undefined, argv:undefined, env:undefined,
      phase:'test',code:0,siblingShas:{frontierui:'0'.repeat(40)}}),
      {v:1,nonce:sent.nonce,run:sent.run,inputDigest:sent.inputDigest,argvDigest:sent.argvDigest,lock:sent.lock,
        manifestDigest:sent.manifestDigest,siblingShas:sent.siblingShas},0)).toBe(false);
  });

  it('resolves ../frontierui from work after real rsync and Forge verification', async () => {
    const f=siblingsFixture();
    const bin=join(parent,'bin'), server=join(parent,'server');
    mkdirSync(bin);
    symlinkSync(process.execPath,join(bin,'node'));
    writeFileSync(join(bin,'npm'), `#!/bin/bash
if [ "$1" = ci ]; then mkdir -p node_modules; exit 0; fi
node -e "const fs=require('fs'); for(const name of ['plugs','webtheme']) {if(!fs.readFileSync('../frontierui/'+name+'/index.js','utf8').includes(name)) process.exit(1);}"
`,{mode:0o755});
    const runner=createRunner({testRoot:server,testPath:bin+':/usr/bin:/bin'});
    const fake=f.exec;
    let run;
    f.exec=vi.fn(async call => {
      if (isPrepare(call)) {
        const reply=await runner.prepare(JSON.parse(call.input)); run=reply.run;
        return {code:0,stdout:JSON.stringify(reply)};
      }
      if (call.file==='rsync') {
        const args=call.args.filter((arg,i,all)=>!arg.startsWith('--rsync-path=') && arg!=='-e' && all[i-1]!=='-e');
        args[args.length-1]=join(server,'runs',run,call.args.at(-1).endsWith('/frontierui/')?'frontierui':'work')+'/';
        const result=spawnSync('rsync',args,{cwd:call.cwd,input:call.input,timeout:10000});
        return {code:result.status,stdout:result.stdout};
      }
      if (isRun(call)) {const result=await runner.run(JSON.parse(call.input)); return {...result};}
      if (isReceipt(call)) return {code:0,stdout:JSON.stringify(await runner.finish(JSON.parse(call.input)))};
      return fake(call);
    });
    expect(await runRemote(f)).toEqual({mode:'remote',code:0});
    expect(existsSync(join(server,'runs',run))).toBe(false);
  });
  it.each(['dirty','staged','untracked','missing','symlink','root symlink','gitlink','unresolvable'])
  ('refuses %s sibling evidence before rsync', async fault => {
    const f = siblingsFixture();
    if (fault === 'dirty' || fault === 'staged') writeFileSync(join(sibling,'plugs/index.js'), 'changed');
    if (fault === 'staged') git('add','.');
    if (fault === 'untracked') writeFileSync(join(sibling,'untracked'), 'new');
    if (fault === 'missing' || fault === 'symlink') rmSync(join(sibling,'plugs'), {recursive:true});
    if (fault === 'symlink') symlinkSync(join(sibling,'webtheme'), join(sibling,'plugs'));
    if (fault === 'root symlink') {
      const target = join(parent,'target');
      renameSync(sibling,target); symlinkSync(target,sibling);
    }
    if (fault === 'gitlink') {
      git('rm','-r','plugs'); git('update-index','--add','--cacheinfo',`160000,${git('rev-parse','HEAD')},plugs`);
      git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','gitlink');
      mkdirSync(join(sibling,'plugs'));
    }
    if (fault === 'unresolvable') rmSync(join(sibling,'.git'), {recursive:true});
    expect(await runRemote(f)).toMatchObject({mode:'not-started',terminated:true,reason:'sibling-inventory-failed'});
    expect(callsOf(f.exec).some(call => call.file === 'rsync' || isRun(call))).toBe(false);
  });
  it.each(['bytes','symlink','directory'])('refuses a sibling swapped to %s after inventory before any rsync', async kind => {
    const f = siblingsFixture();
    f.fs = {...filesystem, mkdtemp:async prefix => {
      if (kind === 'bytes') writeFileSync(join(sibling,'plugs/index.js'), 'SWAPPED');
      else {
        const original=join(parent,'original-plugs');
        renameSync(join(sibling,'plugs'),original);
        if (kind === 'symlink') symlinkSync(original,join(sibling,'plugs'));
        else cpSync(original,join(sibling,'plugs'),{recursive:true});
      }
      return filesystem.mkdtemp(prefix);
    }};
    expect(await runRemote(f)).toMatchObject({mode:'not-started',reason:'snapshot-staging-failed'});
    expect(callsOf(f.exec).some(call => call.file === 'rsync')).toBe(false);
  });

  it.each(['credentials.txt','CREDENTIALS.txt','cre\u200bdentials.txt','crédentials.txt','.env','private.key'])
  ('applies the shared exclusion policy to sibling path %s', async name => {
    const f=siblingsFixture();
    writeFileSync(join(sibling,'webtheme',name),'PRIVATE');
    git('add','.'); git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','excluded');
    expect(await runRemote(f)).toEqual({mode:'remote',code:0});
    const request=JSON.parse(callsOf(f.exec).find(isRun).input);
    expect(Buffer.from(request.manifest.siblings.frontierui.excluded,'base64').includes(Buffer.from(`webtheme/${name}\0`))).toBe(true);
    expect(callsOf(f.exec).filter(call=>call.file==='rsync').every(call=>!call.input.includes(Buffer.from(name)))).toBe(true);
  });
  it('refuses an oversized sibling inventory before staging or transmission with local fallback', async () => {
    const f=siblingsFixture(), fake=f.exec;
    f.exec=vi.fn(async call => call.file==='git' && call.cwd===sibling && call.args[0]==='ls-files' && call.args.includes('--')
      ? {code:0,stdout:Buffer.alloc(4*1024*1024+1,97)} : fake(call));
    expect(await runRemote(f)).toEqual({mode:'not-started',terminated:true,reason:'sibling-inventory-failed'});
    expect(callsOf(f.exec).some(call=>call.file==='rsync' || isPrepare(call) || isRun(call))).toBe(false);
  });
  it('falls back locally as not-started when the installed Forge runner lacks sibling capability', async () => {
    const f = siblingsFixture(), fake=f.exec;
    f.exec = vi.fn(async call => {
      const result = await fake(call);
      if (isPrepare(call)) result.stdout=JSON.stringify({run:JSON.parse(result.stdout).run});
      return result;
    });
    expect(await runRemote(f)).toEqual({mode:'not-started',terminated:true,reason:'forge-runner-too-old'});
    expect(callsOf(f.exec).some(call => call.file === 'rsync' || isRun(call))).toBe(false);
    expect(await runRemoteCli({...f,log:vi.fn()})).toBe(7);
    expect(f.local).toHaveBeenCalledOnce();
  });
});


describe('offload stage evidence', () => {
  it('records ordered stages with an injected clock and Eastern offset, including transfer counts', async () => {
    const f=fixture({receipt:(_nonce,value,state)=>JSON.stringify({...value,manifestDigest:state.manifestDigest,timings:{installMs:12,runMs:34}})});
    let now=Date.parse('2026-07-01T12:00:00Z');
    const result=await timedRunRemote({...f,clock:()=>{const value=now;now+=10;return value;}});
    expect(result.mode).toBe('remote');
    expect(result.timings.map(value=>value.stage)).toEqual(['manifest-build','mac-stage-and-rehash','forge-prepare','rsync','forge-install','forge-run','finish-receipt','total']);
    for(const stage of result.timings) {
      expect(stage.startedAtET).toMatch(/^2026-07-01T08:00:\d{2}\.\d{3}-04:00$/);
      expect(Number.isInteger(stage.ms) && stage.ms>=0).toBe(true);
    }
    expect(result.timings.find(s=>s.stage==='forge-install').ms).toBe(12);
    expect(result.timings.find(s=>s.stage==='forge-run').ms).toBe(34);
    const bytes=Buffer.byteLength('fixture')+Buffer.byteLength('{"lockfileVersion":3,"packages":{}}\n');
    expect(result.timings.find(s=>s.stage==='rsync')).toMatchObject({shipMode:'full',fileCount:2,bytesSent:bytes});
  });
  it('formats winter timestamps with the Eastern standard offset even for early fallback', async () => {
    const result=await timedRunRemote({argv:[],clock:()=>Date.parse('2026-01-01T12:00:00Z')});
    expect(result.timings).toEqual([{stage:'total',startedAtET:'2026-01-01T07:00:00.000-05:00',ms:0}]);
  });
  it.each([undefined,{installMs:0,runMs:42}])('accepts optional exact runner timings %j', timings => {
    const expected={v:1,nonce:'a'.repeat(32),run:'r-'+'b'.repeat(32),inputDigest:'c'.repeat(64),argvDigest:'d'.repeat(64),lock:'e'.repeat(64),manifestDigest:'f'.repeat(64)};
    expect(remoteManifestAPI.verifyReceipt(JSON.stringify({...expected,phase:'test',code:0,...(timings?{timings}:{})}),expected,0)).toBe(true);
  });
  it.each([null,[],{installMs:'1',runMs:2},{installMs:1.5,runMs:2},{installMs:-1,runMs:2},{installMs:1},{installMs:1,runMs:2,extra:3}])('rejects malformed optional receipt timings %j', timings=>{
    const expected={v:1,nonce:'a'.repeat(32),run:'r-'+'b'.repeat(32),inputDigest:'c'.repeat(64),argvDigest:'d'.repeat(64),lock:'e'.repeat(64),manifestDigest:'f'.repeat(64)};
    expect(remoteManifestAPI.verifyReceipt(JSON.stringify({...expected,phase:'test',code:0,timings}),expected,0)).toBe(false);
  });
});


it('CLI prints one compact timing table to stderr after remote completion',async()=>{
  const stderr=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
  const timings=[{stage:'total',startedAtET:'2026-01-01T07:00:00.000-05:00',ms:12}];
  try {
    expect(await runRemoteCli({argv,cwd,lockRoot:join(cwd,'heavy'),remoteExec:async()=>({mode:'remote',code:0,timings}),log:vi.fn()})).toBe(0);
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr.mock.calls[0][0]).toContain('total');
    expect(stderr.mock.calls[0][0]).toContain('12');
    expect(stderr.mock.calls[0][0]).toContain('2026-01-01T07:00:00.000-05:00');
  }finally{stderr.mockRestore();}
});


it('includes an attempted manifest stage on failure and measures old-runner wall run time',async()=>{
  const failed=fixture();failed.listFiles.mockResolvedValue(['missing-leaf']);
  expect((await timedRunRemote(failed)).timings.map(t=>t.stage)).toEqual(['manifest-build','total']);
  const completed=await timedRunRemote(fixture());
  expect(completed.timings.find(t=>t.stage==='forge-run')).toMatchObject({ms:expect.any(Number)});
  expect(completed.timings.find(t=>t.stage==='forge-install')).toBeUndefined();
});
