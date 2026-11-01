// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, readdir, utimes, realpath, rename, link} from 'node:fs/promises';
import {join} from 'node:path';
import micromatch from 'micromatch';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createRunner, digestInput, digestArgv, supervisorSource} from '../forge-exec-run.mjs';
import * as manifestAPI from '../forge-exec-run.mjs';
import {verifiedCopySource} from '../forge-exec-bases.mjs';
import {scanScope} from '../../lib/repo-scan-tests.mjs';
let root, runner, request, work;
const argv = ['npm','run','test:unit','--','two words',"a'b",'$(touch marker)','-t','line\nbreak'];
const hash = data => createHash('sha256').update(data).digest('hex');
// Legacy success fixtures bind the exact snapshot supplied in their run request.
async function snapshotBinding(base) {
  const entries = [];
  async function walk(prefix = Buffer.alloc(0)) {
    const absolute = prefix.length ? Buffer.concat([Buffer.from(base+'/'),prefix]) : Buffer.from(base);
    for (const name of await readdir(absolute,{encoding:'buffer'})) {
      const path = prefix.length ? Buffer.concat([prefix,Buffer.from('/'),name]) : name;
      const full = Buffer.concat([Buffer.from(base+'/'),path]);
      const info = await stat(full);
      if (info.isDirectory()) await walk(path);
      else entries.push({path,sha256:hash(await readFile(full)),executable:!!(info.mode & 0o111)});
    }
  }
  await walk();
  entries.sort((a,b) => Buffer.compare(a.path,b.path));
  const manifest = manifestAPI.manifestWire({entries,excluded:[]});
  return {manifest,manifestDigest:hash(JSON.stringify(manifest))};
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(process.env.TMPDIR,'forge-wrapper-')));
  const bin = join(root,'bin');
  await mkdir(bin);
  await symlink(process.execPath,join(bin,'node'));
  await writeFile(join(bin,'npm'), `#!/bin/bash
if [ "$1" = ci ]; then
  printf '%s\n' "$*|$NODE_ENV|$HOME" >> '${root}/install.log'
  if [ -f fail-install ]; then echo INJECTED_INSTALL_FAILURE >&2; exit 1; fi
  mkdir -p node_modules packages/deep/node_modules
  echo dev > node_modules/vitest
  echo nested > packages/deep/node_modules/dependency
  exit 0
fi
[ -f node_modules/vitest ] || exit 98
[ -f packages/deep/node_modules/dependency ] || exit 99
cat > stdin-seen
node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@" > argv-seen
printf '%s\n' "$*|$NODE_ENV" > task-seen
echo forged > .exit-code
printf '%s' "$VERIFY_SCAN_FILES" > scan-files-seen
echo '{"phase":"test","code":0}' > receipt.json
exit 3
`, {mode:0o755});
  runner = createRunner({testRoot:root,testPath:bin+':/usr/bin:/bin'});
  const prepared = await runner.prepare({nonce:'b'.repeat(32),label:'abcdef-1'});
  work = join(root,'runs',prepared.run,'work');
  await writeFile(join(work,'package-lock.json'),'lock');
  request = {nonce:'b'.repeat(32),run:prepared.run,argv,env:{NODE_ENV:'production',CI:'true'},lock:hash('lock'),
    ...await snapshotBinding(work),inputDigest:await digestInput(work),argvDigest:digestArgv(argv)};
});
afterEach(async () => {await rm(root,{recursive:true,force:true});});
describe('sibling root snapshot acceptance', () => {
  const siblingRoot = () => join(root,'runs',request.run,'frontierui');
  async function siblingSnapshot() {
    const sibling = siblingRoot();
    await mkdir(join(sibling,'plugs'),{recursive:true});
    await mkdir(join(sibling,'webtheme'),{recursive:true});
    await writeFile(join(sibling,'plugs','runtime.js'),'export const plug = true;\n');
    await writeFile(join(sibling,'webtheme','theme.js'),'export const theme = true;\n');
    const {manifest} = await snapshotBinding(sibling);
    request.manifest.siblings = {frontierui:{sha:'a'.repeat(40),...manifest}};
    request.manifestDigest = manifestAPI.digestManifest(request.manifest);
    request.siblingShas = {frontierui:'a'.repeat(40)};
    return sibling;
  }
  async function expectNoExecutionOrReceipt({siblings = true} = {}) {
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(join(work,'task-seen'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await runner.finish(request)).toEqual(siblings
      ? {v:1,nonce:request.nonce,run:request.run,phase:'rejected',reason:'snapshot-rejected',siblings:true,started:false}
      : null);
  }

  it('prepare creates an empty sibling root beside work with mode 0755 when requested', async () => {
    const prepared = await runner.prepare({nonce:request.nonce,siblings:true});
    const preparedWork = join(root,'runs',prepared.run,'work');
    const sibling = join(root,'runs',prepared.run,'frontierui');
    expect((await stat(sibling)).mode & 0o777).toBe(0o755);
    expect(await readdir(sibling)).toEqual([]);
    expect(await realpath(join(preparedWork,'..','frontierui'))).toBe(sibling);
  });

  it('accepts the matching sibling snapshot and binds its digest in the test receipt', async () => {
    const sibling = await siblingSnapshot();
    expect((await runner.run(request)).code).toBe(3);
    expect(await readFile(join(sibling,'plugs','runtime.js'),'utf8')).toBe('export const plug = true;\n');
    expect(await runner.finish(request)).toEqual({v:1,nonce:request.nonce,run:request.run,
      inputDigest:request.inputDigest,argvDigest:request.argvDigest,lock:request.lock,
      manifestDigest:request.manifestDigest,siblingShas:request.siblingShas,phase:'test',code:3,
      resources:{memoryPeakBytes:null,cpuUsec:null,oomKills:null,slotCpus:8},
      timings:{installMs:expect.any(Number),runMs:expect.any(Number)}});
  });

  it.each([
    ['changed byte', /snapshot digest/],
    ['extra file', /snapshot digest/],
    ['missing file', /Manifest inventory/],
    ['file symlink', /Manifest symlink/],
    ['directory symlink', /Manifest symlink/],
    ['wrong digest', /Manifest digest mismatch/],
  ])('refuses sibling %s before installation and never certifies a receipt', async (fault, error) => {
    const sibling = await siblingSnapshot();
    const plug = join(sibling,'plugs','runtime.js');
    const outside = join(root,'outside.js');
    await writeFile(outside,'export const outside = true;');
    if (fault === 'changed byte') await writeFile(plug,'export const plug = false;\n');
    if (fault === 'extra file') await writeFile(join(sibling,'plugs','extra.js'),'extra');
    if (fault === 'missing file') await rm(plug);
    if (fault === 'file symlink') {
      await rm(plug);
      await symlink(outside,plug);
    }
    if (fault === 'directory symlink') {
      await rm(join(sibling,'plugs'),{recursive:true});
      await symlink(root,join(sibling,'plugs'));
    }
    if (fault === 'wrong digest') request.manifestDigest = '0'.repeat(64);
    await expect(runner.run(request)).rejects.toThrow(error);
    await expectNoExecutionOrReceipt();
  });

  it('accepts an empty sibling root without adding a sibling digest to the receipt', async () => {
    await mkdir(siblingRoot(),{recursive:true});
    expect((await runner.run(request)).code).toBe(3);
    const receipt = await runner.finish(request);
    expect(receipt).toMatchObject({phase:'test',code:3,manifestDigest:request.manifestDigest});
    expect(receipt).not.toHaveProperty('siblingShas');
  });

  it('requires an empty sibling root when no sibling manifest was supplied', async () => {
    await siblingSnapshot();
    delete request.manifest.siblings;
    request.manifestDigest = manifestAPI.digestManifest(request.manifest);
    delete request.siblingShas;
    await expect(runner.run(request)).rejects.toThrow('Extra sibling snapshot');
    await expectNoExecutionOrReceipt({siblings:false});
  });
});

describe('gate option and scan-file allowlist (R314, R309)', () => {
  it.each([
    ['scripts/a.mjs', ['scripts/a.mjs']],
    ['scripts/a.mjs,src/b.ts', ['scripts/a.mjs', 'src/b.ts']],
    ['scripts/a.mjs\nsrc/b.ts', ['scripts/a.mjs', 'src/b.ts']],
    ['[ "scripts/a.mjs", "src/b.ts" ]', ['scripts/a.mjs', 'src/b.ts']],
    ['[]', []],
  ])('executes direct runner scan list %j as JSON consumable by scanScope', async (value, paths) => {
    request.env.VERIFY_SCAN_FILES = value;
    expect((await runner.run(request)).code).toBe(3);
    const actual = await readFile(join(work,'scan-files-seen'),'utf8');
    expect([...scanScope({VERIFY_SCAN_FILES:actual})]).toEqual(paths);
    expect(actual).toBe(JSON.stringify(paths));
    expect(request.env.VERIFY_SCAN_FILES).toBe(value);
  });
  const unit = (...args) => ['npm','run','test:unit','--','a.test.mjs',...args];
  it.each([
    ['--passWithNoTests'], ['--testTimeout=15000'], ['--hookTimeout=30000'], ['--testTimeout=1'], ['--hookTimeout=3600000'],
    ['--passWithNoTests','--testTimeout=15000','--hookTimeout=30000'],
  ])('accepts the gate options %j', (...args) => {
    expect(manifestAPI.allowedCommand(unit(...args))).toBe(true);
    expect(manifestAPI.allowedCommand(['npx','vitest','run','a.test.mjs',...args])).toBe(true);
  });
  it.each([
    '--testTimeout=abc', '--testTimeout=', '--testTimeout', '--testTimeout=0', '--testTimeout=015000', '--testTimeout=-1',
    '--testTimeout=1.5', '--testTimeout=3600001', '--testTimeout=99999999', '--hookTimeout=1e3', '--hookTimeout=abc',
    '--test-timeout=15000', '--TestTimeout=15000', '--testTimeout=15000 ', '--passWithNoTests=true', '--pass-with-no-tests',
    '--reporter=x', '--maxWorkers=1', '--teardownTimeout=1000',
  ])('rejects %s', arg => {
    expect(manifestAPI.allowedCommand(unit(arg))).toBe(false);
  });
  it('rejects a separated value after --testTimeout and a boolean after --passWithNoTests', () => {
    expect(manifestAPI.allowedCommand(unit('--testTimeout','15000'))).toBe(false);
    expect(manifestAPI.allowedCommand(['npx','vitest','run','a.test.mjs','--passWithNoTests','false'])).toBe(false);
  });
  it.each([
    '["scripts/a.mjs","scripts/b.test.mjs"]', '[]', 'scripts/a.mjs', 'scripts/a.mjs,scripts/b.mjs', 'scripts/a.mjs\nsrc/b.ts',
    '[".github/workflows/ci.yml"]', '["a/@scope/b+c-d_e.mjs"]',
  ])('accepts VERIFY_SCAN_FILES=%j', value => {
    expect(manifestAPI.allowedEnv({VERIFY_SCAN_FILES:value})).toBe(true);
  });
  it.each([
    '/etc/passwd', '["/etc/passwd"]', '../x', '["../x"]', 'a/../b', 'a..b', '..', '["a/./b"]', './a', 'a;rm', '["a;rm -rf /"]', 'a b', '$(id)',
    '`id`', 'a|b', 'a&b', 'a>b', "a'b", 'a"b', 'a\\b', '-rf', '', 'a,,b', 'a//b', 'a/', '["a",1]', '{"a":1}', '[', '["a"',
    'a\0b', 'x'.repeat(65537),
  ])('rejects VERIFY_SCAN_FILES=%j', value => {
    expect(manifestAPI.allowedEnv({VERIFY_SCAN_FILES:value})).toBe(false);
  });
  it('bounds canonical JSON size and entry count before client or runner execution', () => {
    const expanded = Array(1024).fill('a'.repeat(62)).join(',');
    expect(expanded.length).toBeLessThan(65536);
    expect(manifestAPI.allowedEnv({VERIFY_SCAN_FILES:expanded})).toBe(false);
    expect(manifestAPI.allowedEnv({VERIFY_SCAN_FILES:Array(4097).fill('a').join(',')})).toBe(false);
    const boundary = JSON.stringify([...Array(15).fill('a'.repeat(4096)), 'a'.repeat(4047)]);
    expect(boundary.length).toBe(65536);
    expect(manifestAPI.allowedEnv({VERIFY_SCAN_FILES:boundary})).toBe(true);
    expect(manifestAPI.normalizeScanFilesValue(boundary)).toBe(boundary);
  });
});

describe('fixed wrapper security boundary', () => {
  it.each(['--run','--silent','--no-color'])('rejects separated false for %s before install or execution',async flag=>{
    const command=['npx','vitest','related','a.test.mjs','--run',flag,'false'];
    await expect(runner.run({...request,argv:command,argvDigest:digestArgv(command)})).rejects.toThrow('Invalid execution parameters');
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(join(work,'task-seen'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('does not certify a rejected reply after the protected run phase started', async () => {
    await writeFile(join(root,'receipts',request.run+'.running'), JSON.stringify({v:1,nonce:request.nonce,run:request.run}));
    await rm(join(root,'receipts',request.run+'.prepared'));
    await writeFile(join(root,'receipts',request.run+'.rejected'), JSON.stringify({v:1,nonce:request.nonce,run:request.run,
      phase:'rejected',reason:'snapshot-rejected',siblings:true}));
    expect(await runner.finish(request)).toBeNull();
  });

  it('real Vitest -t --help skips execution but cannot produce a certified success', async () => {
    const queue = fileURLToPath(new URL('../heavy-admission.mjs', import.meta.url));
    const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const vitestAPI = new URL('../../../node_modules/vitest/dist/index.js', import.meta.url).href;
    await writeFile(join(root,'vitest.config.mjs'), `export default {test:{include:['probe.test.mjs'],pool:'forks',poolOptions:{forks:{singleFork:true}}}};`);
    await writeFile(join(root,'probe.test.mjs'), `
import {test, expect} from ${JSON.stringify(vitestAPI)};
import {writeFileSync} from 'node:fs';
test('executes probe', () => {writeFileSync('executed', 'yes'); expect(true).toBe(true);});
`);
    const runVitest = args => spawnSync(process.execPath, [queue,'run','--wait-ms=600000','--',process.execPath,vitest,'run',...args], {
      cwd:root, encoding:'utf8', timeout:30000, maxBuffer:1024*1024,
    });
    const unsafe = ['-t','--help'];
    const help = runVitest(unsafe);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--help');
    await expect(readFile(join(root,'executed'))).rejects.toMatchObject({code:'ENOENT'});
    const command = ['npm','run','test:unit','--',...unsafe];
    expect(manifestAPI.allowedCommand(command)).toBe(false);
    await expect(runner.run({...request,argv:command,argvDigest:digestArgv(command)})).rejects.toThrow('Invalid execution parameters');
    expect(await runner.finish(request)).toBeNull();
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
    const safe = ['-t','executes probe'];
    expect(manifestAPI.allowedCommand(['npm','run','test:unit','--',...safe])).toBe(true);
    const executed = runVitest(safe);
    expect(executed.status, executed.stdout + executed.stderr).toBe(0);
    expect(await readFile(join(root,'executed'),'utf8')).toBe('yes');
  }, 65000);

  it.each(['--help','-h','--version','-v','--passWithNoTests','--pass-with-no-tests','--changed','--shard','--bail']
    .flatMap(flag => [flag, flag+'=true', flag+'=false', flag+'=']).filter(arg => arg !== '--passWithNoTests'))
  ('rejects arguments outside the allowlist: %s before installing or executing', async arg => {
    const command = ['npm','run','test:unit','--','a.test.mjs',arg];
    expect(manifestAPI.allowedCommand(command)).toBe(false);
    await expect(runner.run({...request,argv:command,argvDigest:digestArgv(command)})).rejects.toThrow('Invalid execution parameters');
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(join(work,'task-seen'))).rejects.toMatchObject({code:'ENOENT'});
  });

  it.each(['--config','--root','--dir','--project','--workspace','--include','--exclude','--dangerouslyIgnoreUnhandledErrors','-c','-r']
    .flatMap(flag => [[flag], [flag+'=other'], ...(flag.startsWith('--') ? [] : [[flag+'other']])]))
  ('rejects discovery-changing argument %s before installing or executing', async arg => {
    const command = ['npm','run','test:unit','--','a.test.mjs',arg];
    await expect(runner.run({...request,argv:command,argvDigest:digestArgv(command)})).rejects.toThrow('Invalid execution parameters');
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(join(work,'task-seen'))).rejects.toMatchObject({code:'ENOENT'});
  });

  it.each(['--help', '--version', '--config', '--run', '--shard=1/2', '-h', '-t', '-pattern'])
  ('rejects dash-prefixed separate -t values: %s', async value => {
    const command = ['npm','run','test:unit','--','-t',value];
    expect(manifestAPI.allowedCommand(command)).toBe(false);
    await expect(runner.run({...request,argv:command,argvDigest:digestArgv(command)})).rejects.toThrow('Invalid execution parameters');
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(join(work,'task-seen'))).rejects.toMatchObject({code:'ENOENT'});
  });

  it.each([
    '--shard=1/2', '--bail=1', '--unknown', '--RUN', '--Silent', '--noColor',
    '--test-name-pattern=case', '--TestNamePattern=case', '--reporter=JSON', '--reporter=junit', '--reporter=DOT',
    '--reporter', '--run=true', '--silent=false', '--no-color=true', '-t', '-tcase',
    '--testNamePattern', '--', '--CONFIG=other', '--dangerously-ignore-unhandled-errors',
  ])('fails closed for unsupported option spelling or missing value: %s', async arg => {
    const command = ['npm','run','test:unit','--','a.test.mjs',arg];
    expect(manifestAPI.allowedCommand(command)).toBe(false);
    await expect(runner.run({...request,argv:command,argvDigest:digestArgv(command)})).rejects.toThrow('Invalid execution parameters');
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(join(work,'task-seen'))).rejects.toMatchObject({code:'ENOENT'});
  });

  it.each([
    ['--run'], ['--silent'], ['--no-color'],
    ...['default','dot','verbose','basic','tap'].map(value => ['--reporter='+value]),
    ['-t','two words'], ['--testNamePattern=two words'],
    ['scripts/a.test.mjs', 'filter*.[test]'],
  ].map(args => [args]))('executes allowed runner arguments: %j', async args => {
    const command = ['npm','run','test:unit','--',...args];
    expect(manifestAPI.allowedCommand(command)).toBe(true);
    expect((await runner.run({...request,argv:command,argvDigest:digestArgv(command)})).code).toBe(3);
    expect(JSON.parse(await readFile(join(work,'argv-seen'),'utf8'))).toEqual(command.slice(1));
  });

  it('rejects dual lockfiles before a cold install and leaves the next lock-only run cold', async () => {
    await writeFile(join(work,'npm-shrinkwrap.json'),'shrinkwrap');
    request.inputDigest = await digestInput(work);
    const first = await runner.run(request).then(value=>({value}),error=>({error:error.message}));
    const installsBefore = await readFile(join(root,'install.log'),'utf8').catch(()=> '');
    await runner.finish(request);
    const next = await runner.prepare({nonce:request.nonce});
    work = join(root,'runs',next.run,'work');
    await writeFile(join(work,'package-lock.json'),'lock');
    request = {...request,...next,...await snapshotBinding(work),inputDigest:await digestInput(work)};
    expect((await runner.run(request)).code).toBe(3);
    const installs = (await readFile(join(root,'install.log'),'utf8')).trim().split('\n');
    expect(first.error).toMatch(/shrinkwrap/i);
    expect(installsBefore).toBe('');
    expect(installs).toHaveLength(1);
    expect(installs[0]).not.toContain('--dry-run');
  });
  it.each(['dev-v3','dev-v4'])('does not reuse archives from the old package-lock-only cache profile %s', async version => {
    const old = join(root,'cache',request.lock,version);
    await mkdir(old,{recursive:true});
    await writeFile(join(old,'dependencies.tar'),'historically poisoned');
    await writeFile(join(old,'sha256'),hash('historically poisoned'));
    expect((await runner.run(request)).code).toBe(3);
    expect(await readFile(join(root,'install.log'),'utf8')).not.toContain('--dry-run');
    expect(await readFile(join(old,'dependencies.tar'),'utf8')).toBe('historically poisoned');
  });
  it('preserves split UTF-8 in captured worker output', async () => {
    await writeFile(join(root,'bin','npm'), `#!${process.execPath}
if (process.argv[2] !== 'ci') {
  const bytes = Buffer.from('é😀');
  process.stdout.write(bytes.subarray(0,1));
  process.stderr.write(bytes.subarray(0,3));
  setTimeout(() => { process.stdout.write(bytes.subarray(1)); process.stderr.write(bytes.subarray(3)); }, 100);
}
`,{mode:0o755});
    expect(await runner.run(request)).toMatchObject({code:0,stdout:'é😀',stderr:'é😀'});
  });
  it('refuses an overlapping run and rechecks its input after the first worker substitutes its assertions', async () => {
    const other = createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin'});
    const prepared = await other.prepare({nonce:'c'.repeat(32)});
    const victim = join(root,'runs',prepared.run,'work');
    await writeFile(join(victim,'package-lock.json'),'different lock');
    await writeFile(join(victim,'assertions.cjs'),'process.exit(1)');
    const second = {...request,...prepared,nonce:'c'.repeat(32),lock:hash('different lock'),...await snapshotBinding(victim),inputDigest:await digestInput(victim)};
    await writeFile(join(root,'bin','npm'), `#!/bin/bash
if [ "$1" = ci ]; then exit 0; fi
exec node '${join(root,'task.cjs')}'
`, {mode:0o755});
    await writeFile(join(root,'task.cjs'), `
const fs = require('node:fs');
if (process.cwd() === ${JSON.stringify(victim)}) require(${JSON.stringify(join(victim,'assertions.cjs'))});
else {
  fs.writeFileSync(${JSON.stringify(join(root,'ready'))}, '');
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(join(root,'release'))})) return;
    clearInterval(timer);
    fs.writeFileSync(${JSON.stringify(join(victim,'assertions.cjs'))}, 'process.exit(0)');
  }, 10);
  setTimeout(() => process.exit(2), 5000).unref();
}
`);
    const first = runner.run(request);
    try {
      // The first run must reach its worker before the overlap probe; the 1s default is too tight on a loaded host.
      await vi.waitFor(async () => expect((await stat(join(root,'ready'))).isFile()).toBe(true), {timeout:4000,interval:20});
      await expect(other.run(second)).rejects.toThrow('Worker execution busy');
    } finally {
      await writeFile(join(root,'release'),'');
      await first;
    }
    expect(await readFile(join(victim,'assertions.cjs'),'utf8')).toBe('process.exit(0)');
    await expect(other.run(second)).rejects.toThrow('Input digest mismatch');
    expect(await other.finish(second)).toBeNull();
    expect(await runner.finish(request)).toMatchObject({phase:'test',code:0});
  }, 15000);
  it('keeps an abandoned execution guard closed even after finish and pruning age', async () => {
    const active = join(root,'receipts','worker-active');
    await mkdir(active,{mode:0o700});
    const expired = new Date(Date.now()-30*24*60*60*1000);
    await utimes(active,expired,expired);
    await expect(runner.run(request)).rejects.toThrow('Worker execution busy');
    expect(await runner.finish(request)).toBeNull();
    expect((await stat(active)).isDirectory()).toBe(true);
  });
  it('retains the execution guard when a worker command rejects instead of confirming shutdown', async () => {
    await writeFile(join(root,'bin','npm'),`#!${process.execPath}
process.stdout.write('x'.repeat(4*1024*1024+1));
`,{mode:0o755});
    expect(await runner.run(request)).toMatchObject({code:97,stderr:'Output limit exceeded'});
    expect(await runner.finish(request)).toMatchObject({phase:'install',code:97});
    expect((await stat(join(root,'receipts','worker-active'))).isDirectory()).toBe(true);
    const next = await runner.prepare({nonce:request.nonce});
    await expect(runner.run({...request,...next})).rejects.toThrow('Worker execution busy');
  });
  it('rejects standards requests without hash-bound Git evidence at the server boundary', async () => {
    const command = ['npm','run','check:standards'];
    await expect(runner.run({...request,argv:command,argvDigest:digestArgv(command)})).rejects.toThrow('Missing Git evidence');
    await expect(stat(join(root,'install.log'))).rejects.toThrow();
  });
  it.each([
    ['npm','--ignore-scripts','run','test:unit'], ['npm','run','test:unit','--help'],
    ['npm','run','test:unit','extra'], ['npm','run','build'], ['sh','-c','true'],
    ['npm','run','check:standards','--workspace=other'],
  ])('rejects bypass argv %j', async (...bad) => {
    await expect(runner.run({...request,argv:bad,argvDigest:digestArgv(bad)})).rejects.toThrow();
  });
  it.each(['NODE_OPTIONS','PATH','HOME','npm_config_script_shell','GITHUB_TOKEN','ci'])('rejects env poisoning %s', async key => {
    await expect(runner.run({...request,env:{[key]:'poison'}})).rejects.toThrow();
  });
  it('isolates install environment, preserves literal argv, nulls task stdin, and ignores forged receipts', async () => {
    const result = await runner.run(request);
    expect(result.code).toBe(3);
    expect(await readFile(join(work,'stdin-seen'),'utf8')).toBe('');
    expect(JSON.parse(await readFile(join(work,'argv-seen'),'utf8'))).toEqual(argv.slice(1));
    expect(await readFile(join(work,'task-seen'),'utf8')).toContain("two words a'b $(touch marker) -t line\nbreak|production");
    await expect(stat(join(work,'marker'))).rejects.toThrow();
    const log = await readFile(join(root,'install.log'),'utf8');
    expect(log).toContain('--include=dev --ignore-scripts --no-audit --no-fund');
    expect(log).not.toContain('production');
    expect(log).not.toContain(process.env.HOME);
    expect(await runner.finish(request)).toEqual({v:1,nonce:request.nonce,run:request.run,inputDigest:request.inputDigest,
      argvDigest:request.argvDigest,lock:request.lock,manifestDigest:request.manifestDigest,phase:'test',code:3,resources:{memoryPeakBytes:null,cpuUsec:null,oomKills:null,slotCpus:8},timings:{installMs:expect.any(Number),runMs:expect.any(Number)}});
    await expect(stat(join(root,'runs',request.run))).rejects.toThrow();
    await expect(runner.finish(request)).rejects.toThrow();
    expect(await readdir(join(root,'receipts'))).toEqual(['.worker-active.writer',request.run+'.consumed',request.run+'.telemetry','telemetry.json']);
  });
  it('rejects input and lock changes before install and accepts odd filenames literally', async () => {
    for (const name of ['#file',';file',"quote'`$()",'--option','é\u2028fixture','tab\tfile','trailing ']) await writeFile(join(work,name),name);
    await expect(runner.run(request)).rejects.toThrow(/digest/);
    Object.assign(request,await snapshotBinding(work));
    request.inputDigest = await digestInput(work);
    expect((await runner.run(request)).code).toBe(3);
  });
  it('records install failure even when a task receipt is planted', async () => {
    await writeFile(join(work,'fail-install'),'');
    await writeFile(join(work,'receipt.json'),JSON.stringify({phase:'test',code:97}));
    Object.assign(request,await snapshotBinding(work));
    request.inputDigest = await digestInput(work);
    expect((await runner.run(request)).code).toBe(97);
    expect(await runner.finish(request)).toMatchObject({phase:'install',code:97});
    await expect(stat(join(work,'task-seen'))).rejects.toThrow();
  });
  it('does not reuse labels, rejects invalid run names, and consumes prepared state once', async () => {
    const other = await runner.prepare({nonce:request.nonce,label:'abcdef-1'});
    expect(other.run).not.toBe(request.run);
    await expect(runner.run({...request,run:'abcdef-1'})).rejects.toThrow();
    await runner.run(request);
    await expect(runner.run(request)).rejects.toThrow();
  });
  it('refuses to adopt a planted valid-format run directory without protected prepared state', async () => {
    const planted = 'r-'+'c'.repeat(32);
    expect(planted).toMatch(/^r-[a-f0-9]{32}$/);
    const plantedWork = join(root,'runs',planted,'work');
    await mkdir(plantedWork,{recursive:true});
    await writeFile(join(plantedWork,'package-lock.json'),'lock');
    expect(await digestInput(plantedWork)).toBe(request.inputDigest);
    const receiptsBefore = await readdir(join(root,'receipts'));
    await expect(runner.run({...request,run:planted})).rejects.toMatchObject({
      code:'ENOENT',path:join(root,'receipts',planted+'.prepared'),
    });
    expect(await readdir(plantedWork)).toEqual(['package-lock.json']);
    expect(await readFile(join(plantedWork,'package-lock.json'),'utf8')).toBe('lock');
    expect(await readdir(join(root,'receipts'))).toEqual(receiptsBefore);
    await expect(stat(join(root,'install.log'))).rejects.toThrow();
  });
  it('rejects tampered archives before extraction and reuses complete nested dependency snapshots', async () => {
    await runner.run(request);
    await runner.finish(request);
    const next = await runner.prepare({nonce:request.nonce,label:'abcdef-1'});
    work = join(root,'runs',next.run,'work');
    await writeFile(join(work,'package-lock.json'),'lock');
    request = {...request,run:next.run,...await snapshotBinding(work),inputDigest:await digestInput(work)};
    expect((await runner.run(request)).code).toBe(3);
    expect((await readFile(join(root,'install.log'),'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
    await runner.finish(request);
    const third = await runner.prepare({nonce:request.nonce});
    work = join(root,'runs',third.run,'work');
    await writeFile(join(work,'package-lock.json'),'lock');
    request = {...request,run:third.run,...await snapshotBinding(work),inputDigest:await digestInput(work)};
    await writeFile(join(root,'cache',request.lock,'dev-v5-'+request.inputDigest,'dependencies.tar'),'tampered');
    expect((await runner.run(request)).code).toBe(97);
    expect(await runner.finish(request)).toMatchObject({phase:'install',code:97});
  });
  it('quarantines execution after wrapper death until an operator stops the worker and clears the guard', async () => {
    const npm = join(root,'bin','npm');
    const original = await readFile(npm,'utf8');
    await writeFile(npm,`#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(join(root,'install-pid'))},String(process.pid));
process.kill(process.ppid,'SIGUSR2');
process.kill(process.pid,'SIGSTOP');
`,{mode:0o755});
    const source = `import {createRunner} from ${JSON.stringify(new URL('../forge-exec-run.mjs',import.meta.url).href)};
process.on('SIGUSR2',()=>{process.send('install');process.kill(process.pid,'SIGSTOP');});
const runner=createRunner({testRoot:process.argv[1],testPath:process.argv[2]});
await runner.run(JSON.parse(process.argv[3]));`;
    const holder = spawn(process.execPath,['--input-type=module','-e',source,root,join(root,'bin')+':/usr/bin:/bin',JSON.stringify(request)],{
      stdio:['ignore','ignore','ignore','ipc'],
    });
    const exited = once(holder,'exit');
    const nextRequest = async () => {
      const prepared = await runner.prepare({nonce:request.nonce});
      const nextWork = join(root,'runs',prepared.run,'work');
      await writeFile(join(nextWork,'package-lock.json'),'lock');
      return {...request,run:prepared.run,...await snapshotBinding(nextWork),inputDigest:await digestInput(nextWork)};
    };
    try {
      const [message] = await once(holder,'message',{signal:AbortSignal.timeout(10000)});
      expect(message).toBe('install');
      const blocked = await nextRequest();
      await expect(runner.run(blocked)).rejects.toThrow('Worker execution busy');
      expect(await runner.finish(blocked)).toBeNull();
      holder.kill('SIGKILL');
      expect(await exited).toEqual([null,'SIGKILL']);
      const interrupted = await nextRequest();
      await expect(runner.run(interrupted)).rejects.toThrow('Worker execution busy');
      expect(await runner.finish(interrupted)).toBeNull();
      // Simulate explicit operator recovery only after the orphan is killed.
      const pid = Number(await readFile(join(root,'install-pid'),'utf8'));
      process.kill(-pid,'SIGKILL');
      await rm(join(root,'receipts','worker-active'),{recursive:true});
      await writeFile(npm,original,{mode:0o755});
      // Persisted sentinels from older wrappers must not block recovery either.
      await mkdir(join(root,'cache',request.lock,'dev-v5-'+request.inputDigest,'.busy'));
      const recovered = await nextRequest();
      expect((await runner.run(recovered)).code).toBe(3);
      expect(await runner.finish(recovered)).toMatchObject({phase:'test',code:3});
    } finally {
      holder.kill('SIGKILL');
      await exited;
      const pid = Number(await readFile(join(root,'install-pid'),'utf8').catch(()=>0));
      if(pid) try {process.kill(-pid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH') throw error;}
    }
  }, 15000);
  it('rejects symlinked cache lock files without changing their targets', async () => {
    const profile = join(root,'cache',request.lock,'dev-v5-'+request.inputDigest);
    await mkdir(profile,{recursive:true});
    const target = join(root,'lock-target');
    await writeFile(target,'untouched');
    await symlink(target,join(profile,'.lock'));
    expect((await runner.run(request)).code).toBe(97);
    expect(await runner.finish(request)).toMatchObject({phase:'install',code:97});
    expect(await readFile(target,'utf8')).toBe('untouched');
    await expect(stat(join(root,'install.log'))).rejects.toThrow();
  });
  it('rejects symlinks at the work boundary and in the input snapshot', async () => {
    await symlink(root,join(work,'escape'));
    await expect(digestInput(work)).rejects.toThrow();
    await rm(join(work,'escape'));
    await rm(work,{recursive:true});
    await symlink(root,work);
    await expect(runner.run(request)).rejects.toThrow();
  });
  it('uses a subreaper and kills adopted setsid descendants before returning a receipt', () => {
    // Darwin cannot exercise Linux prctl; assert the production supervisor protocol here.
    expect(supervisorSource).toContain('PR_SET_CHILD_SUBREAPER');
    expect(supervisorSource).toContain('os.setsid');
    expect(supervisorSource).toContain('os.kill(pid, signal.SIGKILL)');
    expect(supervisorSource).toContain('os.waitpid(-1');
    expect(supervisorSource).toContain('stdin=subprocess.DEVNULL');
  });
  it('completes supervisor cleanup with arbitrary bytes and delimiters in proc process names', async () => {
    const status=join(root,'byte-name-status');
    // Execute the shipped supervisor on every platform; only OS/process effects
    // are mocked. Real file decoding reproduces the Linux stat failure on macOS.
    const probe=String.raw`import builtins, ctypes, json, os, signal, subprocess, sys
from unittest.mock import patch
source, root, status = sys.argv[1:]
entries = {
    '101': b'101 (\xff) S 100 0 0\n',
    '102': b'102 (a) \n\r\t\xfe)) S 101 0 0\n',
    '103': b'103 (\xe2\x80\xa8\xe2\x80\x8b) S 102 0 0\n',
    '104': b'104 (--\x60\x27../) S 999 0 0\n',
}
for pid, data in entries.items():
    with open(os.path.join(root, pid), 'wb') as f: f.write(data)
real_open = builtins.open
def proc_open(path, *args, **kwargs):
    return real_open(os.path.join(root, path.split('/')[2]), *args, **kwargs)
killed = []
def kill(pid, sig):
    assert sig == signal.SIGKILL
    killed.append(pid)
def reap(*args):
    assert set(killed) == {101, 102, 103}, killed
    raise ChildProcessError()
writer = dict(guard=os.path.join(root, 'supervisor-writer'), reservation=os.path.join(root, 'supervisor-reservation.json'), run='fixture', nonce='fixture')
fd = os.open(writer['guard'], os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
os.close(fd)
with real_open(writer['reservation'], 'w') as stream: json.dump(dict(run='fixture', nonce='fixture'), stream)
cfg = dict(uid=os.getuid(), gid=os.getgid(), argv=['unused'], cwd=root, env={}, status=status, writer=writer)
with patch.object(ctypes, 'CDLL') as libc, patch.object(subprocess, 'Popen') as worker, \
     patch.object(os, 'listdir', return_value=[*entries, 'self', '105']), \
     patch.object(os, 'getpid', return_value=100), patch.object(builtins, 'open', side_effect=proc_open), \
     patch.object(os, 'kill', side_effect=kill), patch.object(os, 'waitpid', side_effect=reap):
    libc.return_value.prctl.return_value = 0
    worker.return_value.wait.return_value = 3
    sys.argv = ['supervisor', json.dumps(cfg)]
    exec(source)
`;
    const result=spawnSync('python3',['-I','-c',probe,supervisorSource,root,status],{encoding:'utf8',timeout:10000});
    expect(result.status,result.stderr).toBe(0);
    expect(await readFile(status,'utf8')).toBe('3');
  });
});

describe('setup and pruning contract', () => {
  it('executes the installed runner with Node 22.1 module resolution outside the repository package', async () => {
    const setup=await readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
    const installer=setup.match(/<<'WRAPPER'\n([\s\S]*?)\nWRAPPER/)[1];
    const local=join(root,'usr-local');
    await mkdir(local,{mode:0o755});
    // Run the shipped installer; only the privileged host directory and ownership
    // operations are substituted. Copying, mode changes and atomic rename are real.
    const harness=String.raw`import os, sys
from types import SimpleNamespace
from unittest.mock import patch
installer, source, local = sys.argv[1:]
real_open, real_fstat = os.open, os.fstat
def local_open(path, *args, **kwargs):
    return real_open(local if path == '/usr/local' else path, *args, **kwargs)
def root_stat(fd):
    st = real_fstat(fd)
    return SimpleNamespace(st_uid=0, st_mode=st.st_mode)
with patch.object(os, 'open', side_effect=local_open), \
     patch.object(os, 'fstat', side_effect=root_stat), patch.object(os, 'fchown') as chown:
    sys.argv = ['installer', source]
    exec(installer)
    assert chown.call_count == 3
    assert chown.call_args.args[1:] == (0, 0)
`;
    const installed=spawnSync('python3',['-I','-c',harness,installer,
      new URL('../forge-exec-run.mjs',import.meta.url).pathname,local],{
      encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
    });
    expect(installed.status,installed.stderr).toBe(0);
    const names=await readdir(join(local,'libexec'));
    expect(names.sort()).toEqual(['forge-exec-limits.mjs','forge-exec-run.mjs','forge-warm-base.mjs']);
    const entry=join(local,'libexec','forge-exec-run.mjs');
    expect((await stat(entry)).mode & 0o777).toBe(0o755);
    // Disable newer Node's syntax detection to retain the Node 22.1 default.
    // Execute the actual shebang path, with no surrounding type:module package.
    const result=spawnSync(entry,[],{cwd:local,encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
      env:{PATH:join(root,'bin')+':/usr/bin:/bin',
        NODE_OPTIONS:'--no-experimental-detect-module --experimental-default-type=commonjs'},
    });
    expect(result.status,result.stderr).toBe(254);
    expect(result.stderr).toBe('forge-exec-run: Invalid subcommand\n');
    const limiter=join(local,'libexec','forge-exec-limits.mjs');
    expect((await stat(limiter)).mode & 0o777).toBe(0o755);
    const limitsResult=spawnSync(limiter,['unexpected'],{cwd:local,encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
      env:{PATH:join(root,'bin')+':/usr/bin:/bin',NODE_OPTIONS:'--no-experimental-detect-module --experimental-default-type=commonjs'}});
    expect(limitsResult.status,limitsResult.stderr).toBe(1);
    expect(limitsResult.stderr).toBe('forge-exec-limits: Expected apply\n');
    const warmer=join(local,'libexec','forge-warm-base.mjs');
    expect((await stat(warmer)).mode & 0o777).toBe(0o755);
    const warmResult=spawnSync(warmer,['unexpected'],{cwd:local,encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
      env:{PATH:join(root,'bin')+':/usr/bin:/bin',NODE_OPTIONS:'--no-experimental-detect-module --experimental-default-type=commonjs'}});
    expect(warmResult.status,warmResult.stderr).toBe(1);
    expect(warmResult.stderr).toBe('forge-warm-base: No arguments accepted\n');
    expect(setup).toContain('User=ops');
    // The worker and ops share dependency archives through ordinary 0644/0755
    // files. A service-wide 0077 mask makes a cold worker install unreadable to ops.
    const serviceMask=setup.match(/^UMask=([0-7]+)$/m)[1];
    const modes=spawnSync(process.execPath,['-e',
      "const fs=require('node:fs');process.umask(parseInt(process.argv[1],8));const dir=process.argv[2];fs.mkdirSync(dir);fs.writeFileSync(dir+'/file','public dependency');console.log(JSON.stringify({dir:fs.statSync(dir).mode&511,file:fs.statSync(dir+'/file').mode&511}));",
      serviceMask,join(root,'service-created')],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
    expect(modes.status,modes.stderr).toBe(0);
    expect(JSON.parse(modes.stdout)).toEqual({dir:0o755,file:0o644});
    expect(serviceMask).toBe('0022');
    expect(setup).toContain('/usr/bin/flock -n /srv/forge-base/.tick.lock');
    expect(setup).toContain('OnCalendar=*-*-* *:*:00,30');
    expect(setup).toContain('Persistent=true');
    const client=await readFile(new URL('../remote-exec.mjs',import.meta.url),'utf8');
    expect(client).toContain('/usr/local/libexec/forge-exec-run.mjs ${command}');
  });
  it('installs a root-owned fixed wrapper, makes the old cache inert, and prunes only expired state', async () => {
    const setup=await readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
    expect(setup).toContain('os.fchown(fd, 0, 0)');
    expect(setup).toContain('os.fchmod(fd, 0o755)');
    expect(setup).toContain('os.fchmod(cache, 0o700)');
    expect(setup).toContain('("forge-receipts", ops.pw_uid, ops.pw_gid, 0o700)');
    expect(setup).toContain('("forge-cache", 0, ops.pw_gid, 0o770)');
    const prune=setup.match(/<<'PRUNE'\n([\s\S]*?)\nPRUNE/)[1];
    expect(prune).toContain('86400');
    expect(prune).toContain('1209600');
    const expired=new Date(Date.now()-16*24*60*60*1000);
    const oldRun=join(root,'runs','r-expired'), oldReceipt=join(root,'receipts','expired.receipt');
    const oldCache=join(root,'cache','expired'), newCache=join(root,'cache','fresh');
    const active=join(root,'receipts','worker-active');
    await mkdir(active,{mode:0o700});
    await mkdir(oldRun); await writeFile(oldReceipt,'old'); await mkdir(oldCache); await mkdir(newCache);
    for(const path of [oldRun,oldReceipt,oldCache]) await utimes(path,expired,expired);
    const local=prune.replaceAll('/srv/forge-exec',join(root,'runs'))
      .replaceAll('/srv/forge-receipts',join(root,'receipts'))
      .replaceAll('/srv/forge-cache',join(root,'cache'));
    const result=spawnSync('bash',['-c',local],{encoding:'utf8'});
    expect(result.status,result.stderr).toBe(0);
    expect((await stat(oldRun)).isDirectory()).toBe(true);
    expect(await readFile(oldReceipt,'utf8')).toBe('old');
    expect((await stat(oldCache)).isDirectory()).toBe(true);
    expect((await stat(active)).isDirectory()).toBe(true);
    await rm(active,{recursive:true});
    const inactive=spawnSync('bash',['-c',local],{encoding:'utf8'});
    expect(inactive.status,inactive.stderr).toBe(0);
    for(const path of [oldRun,oldReceipt,oldCache]) await expect(stat(path)).rejects.toThrow();
    expect((await stat(newCache)).isDirectory()).toBe(true);
    expect((await stat(work)).isDirectory()).toBe(true);
    await expect(stat(active)).rejects.toThrow();
  });
  it.each(['empty historical reservation','malformed metadata','unreadable metadata','non-object metadata','missing run identity','invalid run identity'])(
    'preserves expired execution evidence and caches with %s',async fault=>{
      const setup=await readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
      const body=setup.match(/<<'PRUNE_PY'\n([\s\S]*?)\nPRUNE_PY/)[1];
      const active=join(root,'receipts/worker-active'),reservation=join(active,'reservation.json');
      await mkdir(active,{mode:0o700});
      if(fault!=='empty historical reservation'){
        const contents={'malformed metadata':'{broken','unreadable metadata':'{}','non-object metadata':'[]',
          'missing run identity':'{}','invalid run identity':JSON.stringify({run:'unknown'})};
        await writeFile(reservation,contents[fault]);
      }
      const run='r-'+ 'd'.repeat(32),expired=new Date(Date.now()-16*86400000);
      const evidence=[];
      for(const phase of ['prepared','running','receipt','telemetry']){
        const path=join(root,'receipts',run+'.'+phase),content=JSON.stringify({run,phase,lock:'e'.repeat(64)});
        await writeFile(path,content);await utimes(path,expired,expired);evidence.push([path,content]);
      }
      const cache=join(root,'cache','e'.repeat(64));await mkdir(cache);await writeFile(join(cache,'dependencies.tar'),'dependency contents');
      await utimes(cache,expired,expired);await utimes(active,expired,expired);
      const local=body.replaceAll('/srv/forge-exec',join(root,'runs')).replaceAll('/srv/forge-receipts',join(root,'receipts'))
        .replaceAll('/srv/forge-cache',join(root,'cache'));
      // Inject a real metadata-open failure without depending on the test UID's
      // permission to bypass chmod. Every other filesystem operation is real.
      const denied=`import os, errno
original_open=os.open
def metadata_open(path, *args, **kwargs):
    if path == ${JSON.stringify(reservation)}: raise PermissionError(errno.EACCES, 'fixture metadata denied', path)
    return original_open(path, *args, **kwargs)
os.open=metadata_open
`;
      const harness=(fault==='unreadable metadata'?denied:'')+local;
      const result=spawnSync('python3',['-I','-c',harness],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
      expect(result.status,result.stderr).toBe(0);
      expect(result.stderr).toContain('preserving expired receipts');expect(result.stderr).toContain('preserving expired cache entries');
      expect((await stat(active)).isDirectory()).toBe(true);
      for(const [path,content] of evidence)expect(await readFile(path,'utf8')).toBe(content);
      expect(await readFile(join(cache,'dependencies.tar'),'utf8')).toBe('dependency contents');
      // Once the operator removes the uncertain reservation, ordinary age
      // pruning must make progress on the same artifacts.
      await rm(active,{recursive:true});
      const released=spawnSync('python3',['-I','-c',harness],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
      expect(released.status,released.stderr).toBe(0);
      for(const [path] of evidence)await expect(stat(path)).rejects.toMatchObject({code:'ENOENT'});
      await expect(stat(cache)).rejects.toMatchObject({code:'ENOENT'});
    });
  it.each(['held','old with live UID','abandoned without live UID','abandoned with zombie UID','historical without writer protocol','held without cache evidence'])(
    'prunes unrelated expired telemetry, receipts and caches with reservation %s',async mode=>{
      const setup=await readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
      const body=setup.match(/<<'PRUNE_PY'\n([\s\S]*?)\nPRUNE_PY/)[1];
      const run='r-'+ 'a'.repeat(32),other='r-'+ 'b'.repeat(32),lock='c'.repeat(64);
      const slot=join(root,'runs/slot-1'),idle=join(root,'runs/slot-2'),reservation=join(root,'receipts/worker-active-1');
      const proc=join(root,'proc');await mkdir(proc);
      if(mode==='old with live UID'||mode==='abandoned with zombie UID'){
        await mkdir(join(proc,'123'));await writeFile(join(proc,'123/stat'),mode==='old with live UID'?'123 (worker) S 1':'123 (worker) Z 1');
      }
      for(const dir of [slot,idle,reservation,join(root,'cache',lock),join(root,'cache/unrelated'),join(root,'cache/recent')])await mkdir(dir);
      for(const dir of [join(slot,run),join(idle,other)])await mkdir(dir);
      await writeFile(join(reservation,'reservation.json'),JSON.stringify({run,slot:'forge-exec-1',...(mode==='historical without writer protocol'?{}:{writerGuard:1})}));
      const running=join(root,'receipts',run+'.running'),telemetry=join(root,'receipts',run+'.telemetry');
      const unrelatedReceipt=join(root,'receipts',other+'.receipt'),unrelatedTelemetry=join(root,'receipts',other+'.telemetry');
      await writeFile(running,JSON.stringify({run,...(mode==='held without cache evidence'?{}:{lock})}));await writeFile(telemetry,'active');
      await writeFile(unrelatedReceipt,'expired');await writeFile(unrelatedTelemetry,'expired');
      const recent=join(root,'receipts/recent.receipt');await writeFile(recent,'recent');
      const writer=join(root,'receipts/.worker-active-1.writer');await writeFile(writer,'',{mode:0o600});
      const writerInode=(await stat(writer)).ino;
      const expired=new Date(Date.now()-16*86400000);
      await utimes(writer,expired,expired);
      for(const path of [join(slot,run),join(idle,other),running,telemetry,unrelatedReceipt,unrelatedTelemetry,join(root,'cache',lock),join(root,'cache/unrelated')])await utimes(path,expired,expired);
      if(!['held','held without cache evidence'].includes(mode))await utimes(reservation,expired,expired);
      const local=body.replaceAll('/srv/forge-exec',join(root,'runs')).replaceAll('/srv/forge-receipts',join(root,'receipts'))
        .replaceAll('/srv/forge-cache',join(root,'cache')).replaceAll('/proc',proc);
      const harness=`import pwd, types, os\npwd.getpwnam=lambda _:types.SimpleNamespace(pw_uid=os.getuid())\n${local}`;
      const result=spawnSync('python3',['-I','-c',harness],{encoding:'utf8',timeout:10000});
      expect(result.status,result.stderr).toBe(0);
      expect((await stat(writer)).ino).toBe(writerInode);
      for(const path of [join(idle,other),unrelatedReceipt,unrelatedTelemetry])await expect(stat(path)).rejects.toMatchObject({code:'ENOENT'});
      if(mode==='held without cache evidence')expect((await stat(join(root,'cache/unrelated'))).isDirectory()).toBe(true);
      else await expect(stat(join(root,'cache/unrelated'))).rejects.toMatchObject({code:'ENOENT'});
      for(const path of [recent,join(root,'cache/recent')])expect(await stat(path)).toBeDefined();
      const protectedPaths=[reservation,join(slot,run),running,telemetry,join(root,'cache',lock)];
      if(mode.startsWith('abandoned')){
        expect(result.stderr).toContain('abandoned reservation worker-active-1; UID has no live processes');
        for(const path of protectedPaths){
          if(path===reservation&&mode==='abandoned with zombie UID')expect(await stat(path)).toBeDefined();
          else await expect(stat(path)).rejects.toMatchObject({code:'ENOENT'});
        }
      }else{
        if(mode==='held without cache evidence'){
          expect(result.stderr).toContain('preserving expired cache entries');expect(result.stderr).not.toContain('preserving expired receipts');
        }else expect(result.stderr).toBe('');
        for(const path of protectedPaths)expect(await stat(path)).toBeDefined();
      }
    });
  it('the production CLI rejects extra argv and oversized requests', () => {
    const source=new URL('../forge-exec-run.mjs',import.meta.url);
    for(const args of [['prepare','extra'],['prepare']]) {
      const result=spawnSync(process.execPath,[source.pathname,...args],{
        input:args.length===1?'x'.repeat(4*1024*1024+1):'{}',encoding:'utf8',maxBuffer:1024*1024,
        env:{PATH:process.env.PATH},timeout:10000,
      });
      expect(result.status).toBe(254);
      expect(result.stderr).toContain(args.length===1?'Request limit exceeded':'Invalid subcommand');
    }
  });
  it.each(['/root', '../', '/srv/forge-base/../root', `/srv/forge-base/${'a'.repeat(40)}.tmp/other`])
  ('warm-install rejects out-of-allowlist source %s before any copy', async source => {
    const probe=join(root,'warm-source-probe.mjs'),attempts=join(root,'warm-source-io.jsonl');
    await writeFile(probe, `
import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
// Skip host pool discovery and stop every subsequent IO operation before it
// can read or mutate a host tree, even if the source guard regresses.
fs.readdir = async () => [];
for (const method of ['open','mkdir','lstat','writeFile','copyFile','cp']) {
  fs[method] = async () => {
    appendFileSync(${JSON.stringify(attempts)},JSON.stringify(method)+'\\n');
    throw new Error('unexpected warm IO: '+method);
  };
}
syncBuiltinESMExports();
`);
    const result=spawnSync(process.execPath,['--import',probe,
      new URL('../forge-exec-run.mjs',import.meta.url).pathname,'warm-install'],{
      input:JSON.stringify({source,manifest:request.manifest}),encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
      env:{PATH:process.env.PATH},
    });
    expect(result.error).toBeUndefined();
    expect(result.status,result.stderr).toBe(254);
    expect(result.stderr).toBe('forge-exec-run: Invalid warm source\n');
    expect(result.stdout).toBe('');
    await expect(stat(attempts)).rejects.toMatchObject({code:'ENOENT'});
  });
  it.each(['base', 'temporary parent', 'tree', 'nested directory', 'leaf'])
  ('warm-install refuses a symlinked %s even when the redirected bytes match the manifest', async component => {
    const base=join(root,'warm-source'),parent=join(base,'a'.repeat(40)+'.tmp'),tree=join(parent,'tree');
    await mkdir(join(tree,'nested'),{recursive:true});
    await writeFile(join(tree,'package-lock.json'),'lock');
    await writeFile(join(tree,'nested','sentinel'),'fixture bytes');
    const {manifest}=await snapshotBinding(tree);
    const replaced={base,'temporary parent':parent,tree,'nested directory':join(tree,'nested'),leaf:join(tree,'nested','sentinel')}[component];
    await rename(replaced,replaced+'.saved');
    await symlink(replaced+'.saved',replaced);
    await expect(runner.warmInstall(tree,manifest)).rejects.toThrow(/warm source|copy/i);
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
    expect((await readdir(join(root,'runs'))).filter(name=>name.startsWith('warm-'))).toEqual([]);
    expect(await readFile(join(tree,'nested','sentinel'),'utf8')).toBe('fixture bytes');
  });
  it.each(['temporary parent', 'tree', 'nested directory'])
  ('warm copying stays on the pinned source after replacing its %s pathname', async component => {
    const parent=join(root,'a'.repeat(40)+'.tmp'),tree=join(parent,'tree'),destination=join(root,'warm-copy');
    const victim=join(root,'warm-victim'),name=Buffer.from("quote' space 雪.txt");
    await mkdir(join(tree,'nested'),{recursive:true});await mkdir(destination);
    await mkdir(join(victim,'tree','nested'),{recursive:true});
    const original=Buffer.concat([Buffer.from(join(tree,'nested')+'/'),name]);
    await writeFile(original,'public fixture');
    await writeFile(join(victim,'tree','nested','sentinel'),'private fixture');
    const replaced=component==='temporary parent'?parent:component==='tree'?tree:join(tree,'nested');
    const trigger=component==='temporary parent'?Buffer.from('tree'):component==='tree'?Buffer.from('nested'):name;
    // Replace the already-open ancestor immediately before the next openat.
    // A pathname-based copy would resolve into the victim or lose the source.
    const driver=`import os, sys, json, base64
attack=json.loads(sys.argv[2])
original=os.open
fired=False
def swapped(name, flags, *args, **kwargs):
    global fired
    if not fired and name == base64.b64decode(attack['trigger']) and 'dir_fd' in kwargs:
        fired=True
        os.rename(attack['replaced'], attack['replaced']+'.saved')
        os.symlink(attack['victim'], attack['replaced'])
    return original(name, flags, *args, **kwargs)
os.open=swapped
exec(sys.argv[1])
assert fired
`;
    const entry={path:Buffer.concat([Buffer.from('nested/'),name]).toString('base64'),sha256:hash('public fixture'),executable:false};
    const result=spawnSync('/usr/bin/python3',['-I','-c',driver,verifiedCopySource,
      JSON.stringify({trigger:trigger.toString('base64'),replaced,victim})],{
      input:JSON.stringify({source:tree,destination,entries:[entry]}),encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
    });
    expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);
    expect(await readFile(Buffer.concat([Buffer.from(join(destination,'nested')+'/'),name]),'utf8')).toBe('public fixture');
    expect(await readdir(victim)).toEqual(['tree']);
  });
  it.each(['digest mismatch', 'FIFO', 'hardlink'])
  ('warm copying refuses %s before writing any destination file', async fault => {
    const source=join(root,'source'),destination=join(root,'destination'),leaf=join(source,'sentinel');
    await mkdir(source);await mkdir(destination);
    if(fault==='FIFO') {
      const fifo=spawnSync('mkfifo',[leaf],{timeout:1000});expect(fifo.status).toBe(0);
    } else {
      await writeFile(leaf,'private fixture');
      if(fault==='hardlink')await link(leaf,join(root,'linked-sentinel'));
    }
    const result=spawnSync('/usr/bin/python3',['-I','-c',verifiedCopySource],{
      input:JSON.stringify({source,destination,entries:[{path:Buffer.from('sentinel').toString('base64'),sha256:hash(fault==='digest mismatch'?'public fixture':'private fixture'),executable:false}]}),
      encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
    });
    expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid copy source');expect(await readdir(destination)).toEqual([]);
    expect(result.stdout).toBe('');expect(result.stderr).not.toContain('private fixture');
  });
  it('warm-install accepts an ordinary source and completes dependency installation', async () => {
    const source=join(root,'ordinary-warm-source');await mkdir(source);
    await writeFile(join(source,'package-lock.json'),'lock');
    const {manifest}=await snapshotBinding(source);
    expect(await runner.warmInstall(source,manifest)).toEqual({code:0});
    expect(await readFile(join(root,'install.log'),'utf8')).toContain('ci --include=dev --ignore-scripts');
    expect((await readdir(join(root,'runs'))).filter(name=>name.startsWith('warm-'))).toEqual([]);
  });
  it.skipIf(process.platform!=='linux'||process.getuid()!==0)
  ('root warm copying refuses a redirected ancestor before copying a root-only sentinel', async () => {
    const parent=join(root,'root-source'),tree=join(parent,'tree'),destination=join(root,'root-destination');
    await mkdir(tree,{recursive:true});await mkdir(destination);
    await writeFile(join(tree,'sentinel'),'root-only fixture',{mode:0o600});
    await rename(parent,parent+'.saved');await symlink(parent+'.saved',parent);
    const result=spawnSync('/usr/bin/python3',['-I','-c',verifiedCopySource],{
      input:JSON.stringify({source:tree,destination,entries:[{path:Buffer.from('sentinel').toString('base64'),sha256:hash('root-only fixture'),executable:false}]}),
      encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
    });
    expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
    expect(await readdir(destination)).toEqual([]);expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('root-only fixture');
  });
  it('the production CLI reaches createRunner with a valid request and ignores test-root environment overrides', async () => {
    const probe=join(root,'boundary-probe.mjs');
    // Observe the real CLI's first filesystem operation after createRunner().
    // Stop before any host mutation, even if a regression enables testRoot.
    await writeFile(probe, `
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
fs.open = async path => { throw new Error('boundary-open:'+path); };
fs.mkdir = async path => { throw new Error('boundary-mkdir:'+path); };
syncBuiltinESMExports();
`);
    const result=spawnSync(process.execPath,['--import',probe,
      new URL('../forge-exec-run.mjs',import.meta.url).pathname,'prepare'],{
      input:JSON.stringify({nonce:'b'.repeat(32)}),encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
      env:{PATH:process.env.PATH,FORGE_EXEC_TEST_ROOT:root,FORGE_EXEC_TEST_PATH:join(root,'bin')},
    });
    expect(result.status,result.stderr).toBe(254);
    expect(result.stderr).toBe('forge-exec-run: boundary-open:/srv/forge-exec\n');
    expect(result.stdout).toBe('');
  });
});

it.skipIf(process.platform !== 'linux')('kills a real escaped setsid child with a non-UTF-8 process name through Linux subreaper adoption', async () => {
  const marker=join(root,'escaped-pid');
  const status=join(root,'supervised-status');
  const task=String.raw`import ctypes, os, sys, time
pid=os.fork()
if pid:
    while not os.path.exists(sys.argv[1]): time.sleep(0.01)
    sys.exit(3)
os.setsid()
assert ctypes.CDLL(None).prctl(15, ctypes.c_char_p(b'\xff)\n\xfe)'), 0, 0, 0) == 0
with open(sys.argv[1], 'w') as f: f.write(str(os.getpid()))
time.sleep(30)
`;
  const writer={guard:join(root,'supervisor-writer'),reservation:join(root,'supervisor-reservation.json'),run:request.run,nonce:request.nonce};
  await writeFile(writer.guard,'',{mode:0o600});await writeFile(writer.reservation,JSON.stringify({run:request.run,nonce:request.nonce}));
  const result=spawnSync('python3',['-I','-c',supervisorSource,JSON.stringify({
    writer,argv:['python3','-I','-c',task,marker],cwd:root,env:{PATH:process.env.PATH},
    uid:process.getuid(),gid:process.getgid(),status,
  })],{encoding:'utf8',timeout:10000});
  const pid=Number(await readFile(marker,'utf8').catch(()=>0));
  try {
    expect(result.status,result.stderr).toBe(0);
    expect(await readFile(status,'utf8')).toBe('3');
    expect(pid).toBeGreaterThan(0);
    expect(()=>process.kill(pid,0)).toThrow();
  } finally {
    if(pid) try {process.kill(pid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH') throw error;}
  }
});

describe('privileged finish cleanup', () => {
  it('delegates removal of a validated nonempty worker tree before consuming state', async () => {
    const cleanup=vi.fn(async ({file,args}) => {
      expect(file).toBe('/usr/bin/sudo');
      expect(args).toEqual(['-n','/usr/bin/rm','-rf','--',join(root,'runs',request.run)]);
      expect(await readFile(join(work,'task-seen'),'utf8')).toContain('production');
      expect(await readFile(join(root,'receipts',request.run+'.running'),'utf8')).toContain(request.nonce);
      await rm(args.at(-1),{recursive:true,force:true});
      return {code:0};
    });
    const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
    expect((await isolated.run(request)).code).toBe(3);
    expect(await isolated.finish(request)).toMatchObject({phase:'test',code:3});
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(stat(join(root,'runs',request.run))).rejects.toThrow();
    expect(await readdir(join(root,'receipts'))).toEqual(['.worker-active.writer',request.run+'.consumed',request.run+'.telemetry','telemetry.json']);
  });
  it('refuses cleanup failure without consuming state or publishing success', async () => {
    const cleanup=vi.fn(async ()=>({code:1}));
    const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
    await isolated.run(request);
    await expect(isolated.finish(request)).rejects.toThrow('Run cleanup failed');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await stat(work)).isDirectory()).toBe(true);
    expect(await readdir(join(root,'receipts'))).toEqual(['.worker-active.writer',request.run+'.receipt',request.run+'.running',request.run+'.telemetry','telemetry.json']);
  });
  it('refuses claimed cleanup success when the run directory remains', async () => {
    const cleanup=vi.fn(async ()=>({code:0}));
    const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
    await expect(isolated.finish(request)).rejects.toThrow('Run cleanup incomplete');
    expect(await readdir(join(root,'receipts'))).toEqual(['.worker-active.writer',request.run+'.prepared',request.run+'.telemetry','telemetry.json']);
    expect((await stat(work)).isDirectory()).toBe(true);
  });
  it('does not delegate invalid or symlink-swapped run containers', async () => {
    const cleanup=vi.fn(async ()=>({code:0}));
    const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
    await expect(isolated.finish({...request,run:'../outside'})).rejects.toThrow();
    await rm(join(root,'runs',request.run),{recursive:true});
    await symlink(join(root,'bin'),join(root,'runs',request.run));
    await expect(isolated.finish(request)).rejects.toThrow();
    expect(cleanup).not.toHaveBeenCalled();
    expect((await stat(join(root,'bin','npm'))).isFile()).toBe(true);
  });
});

// Required on Linux: execute this suite as a non-root ops test user with
// passwordless sudo for python3 and rm. It uses numeric worker IDs, no accounts
// are created and every mutation is confined to this test's TMPDIR fixture.
it.skipIf(process.platform !== 'linux')('cross-identity cleanup finishes a nonempty 0755 worker-owned run after prepare and execution', async () => {
  expect(process.getuid(),'Linux cross-identity fixture requires a non-root ops user with passwordless sudo').not.toBe(0);
  const workerUid=65534, workerGid=65534;
  const task=String.raw`import os
os.chown('.', 65534, 65534)
os.setgroups([])
os.setgid(65534)
os.setuid(65534)
os.mkdir('worker-data', 0o755)
with open('worker-data/result', 'w') as f: f.write('worker-owned')
os.chmod('.', 0o755)
`;
  const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
  await writeFile(join(root,'bin','npm'),`#!/bin/bash
if [ "$1" = ci ]; then mkdir -p node_modules; exit 0; fi
exec /usr/bin/sudo -n /usr/bin/python3 -I -c ${quote(task)}
`,{mode:0o755});
  const cleanup=vi.fn(async ({file,args}) => {
    const result=spawnSync(file,args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
    if(result.error) throw result.error;
    return {code:result.status,stdout:result.stdout,stderr:result.stderr};
  });
  const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
  expect((await isolated.run(request)).code).toBe(0);
  expect(await stat(work)).toMatchObject({uid:workerUid,gid:workerGid});
  expect((await stat(work)).mode & 0o777).toBe(0o755);
  expect(await stat(join(work,'worker-data','result'))).toMatchObject({uid:workerUid});
  expect(await readFile(join(work,'worker-data','result'),'utf8')).toBe('worker-owned');
  await expect(rm(join(work,'worker-data','result'))).rejects.toMatchObject({code:'EACCES'});
  expect(await isolated.finish(request)).toMatchObject({phase:'test',code:0});
  expect(cleanup).toHaveBeenCalledTimes(1);
  await expect(stat(join(root,'runs',request.run))).rejects.toThrow();
  expect(await readdir(join(root,'receipts'))).toEqual(['.worker-active.writer',request.run+'.consumed',request.run+'.telemetry','telemetry.json']);
});


// Manifest acceptance contract (Round 1): isTestFile(path:Buffer) -> boolean;
// verifyManifest(root, manifest, manifestDigest, {fs?} = {}) -> {entries, testPaths}.
// entries = [{path:Buffer, sha256:string, executable:boolean, tracked:boolean}], testPaths = Buffer[].
// fs defaults to node:fs/promises (lstat/readFile/readdir, Buffer paths/names).
// Wire manifest v2 = {v:2, paths:base64(NUL-terminated byte paths), hashes:hexSHA256[],
//   executable:boolean[], tracked:boolean[], excluded:base64(NUL-terminated excluded byte paths)};
// manifestDigest = sha256(JSON.stringify(manifest)), in that property order.
// Both path lists are strictly byte-sorted; excluded files must be absent.
// Invalid UTF-8 is allowed only for non-test byte paths; base64 is canonical.
describe('certified snapshot equals selected inventory: Forge acceptance', () => {
  const nul = paths => Buffer.concat(paths.flatMap(path => [path, Buffer.from([0])]));
  function makeManifest(entries, excluded = []) {
    const ordered = [...entries].sort((a,b) => Buffer.compare(a.path,b.path));
    const manifest = {
      v:2,
      paths:nul(ordered.map(entry => entry.path)).toString('base64'),
      hashes:ordered.map(entry => entry.sha256),
      executable:ordered.map(entry => entry.executable),
      tracked:ordered.map(entry => entry.tracked ?? false),
      excluded:nul([...excluded].sort(Buffer.compare)).toString('base64'),
    };
    return {manifest, manifestDigest:hash(JSON.stringify(manifest))};
  }
  async function snapshot(names = ['package-lock.json']) {
    const entries = await Promise.all(names.map(async name => {
      const path = Buffer.isBuffer(name) ? name : Buffer.from(name);
      const absolute = Buffer.concat([Buffer.from(work+'/'),path]);
      return {path, sha256:hash(await readFile(absolute)), executable:!!((await stat(absolute)).mode & 0o111)};
    }));
    return makeManifest(entries);
  }
  async function verify(manifest, digest, options) {
    expect(manifestAPI.verifyManifest, 'export the pre-execution exact snapshot verifier').toBeTypeOf('function');
    return manifestAPI.verifyManifest(work, manifest, digest, options);
  }

  it.each(['legacy','unknown version','missing tracked','tracked count','tracked type','tampered tracked'])
  ('refuses %s tracking evidence rather than accepting an old digest as proof',async fault=>{
    Object.assign(request,await snapshot());
    const manifest=request.manifest;
    if(fault==='legacy'){delete manifest.v;delete manifest.tracked;}
    if(fault==='unknown version')manifest.v=3;
    if(fault==='missing tracked')delete manifest.tracked;
    if(fault==='tracked count')manifest.tracked=[];
    if(fault==='tracked type')manifest.tracked=['true'];
    if(fault==='tampered tracked')manifest.tracked[0]=!manifest.tracked[0];
    else request.manifestDigest=hash(JSON.stringify(manifest));
    await expect(runner.run(request)).rejects.toThrow(/manifest|digest|tracking/i);
    await expectNoExecutionOrReceipt();
  });
  async function expectNoExecutionOrReceipt() {
    expect(await readFile(join(root,'install.log'),'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    })).toBe('');
    expect(await runner.finish(request)).toBeNull();
  }

  it.each([
    ['identity.test.mjs', true], ['credentials.test.mjs', true], ['keys/identity.spec.tsx', true],
    ['a.test.js', true], ['a.spec.cjs', true], ['a.test.mts', true], ['a.spec.jsx', true],
    ['a.test.txt', false], ['a.test.mjs.bak', false], ['a.test.mjs/source.js', false],
    ['test.mjs', false], ['a.TEST.js', false],
    ...['__tests__', '__test__', 'test', 'tests', 'spec', 'specs', 'e2e'].flatMap(dir =>
      ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'].map(ext => [`nested/${dir}/nested/credentials.${ext}`, true])),
    ['tests/notes.txt', false], ['contest/source.js', false],
  ])('uses the one shared test-file predicate for %s => %s', (path, expected) => {
    expect(manifestAPI.isTestFile).toBeTypeOf('function');
    expect(manifestAPI.isTestFile(Buffer.from(path))).toBe(expected);
  });

  it.each(['extra directory','extra file','missing file','hash mismatch','extra test file','exec bit mismatch'])
  ('rejects %s before installation even when inputDigest matches the current disk', async fault => {
    await writeFile(join(work,'identity.test.mjs'),'original assertion');
    Object.assign(request, await snapshot(['package-lock.json','identity.test.mjs']));
    if (fault === 'extra directory') await mkdir(join(work,'unexpected'));
    if (fault === 'extra file') await writeFile(join(work,'extra.json'),'extra');
    if (fault === 'extra test file') await writeFile(join(work,'credentials.test.mjs'),'hidden assertion');
    if (fault === 'missing file') await rm(join(work,'identity.test.mjs'));
    if (fault === 'hash mismatch') await writeFile(join(work,'identity.test.mjs'),'different assertion');
    if (fault === 'exec bit mismatch') request.manifest.executable[0] = !request.manifest.executable[0];
    // Re-sign malformed evidence so the exact-tree checks, not only its digest,
    // must reject it. Existing inputDigest verification cannot catch this family.
    request.manifestDigest = hash(JSON.stringify(request.manifest));
    request.inputDigest = await digestInput(work);
    await expect(runner.run(request)).rejects.toThrow(/manifest|inventory|snapshot|test set/i);
    await expectNoExecutionOrReceipt();
  });

  it.each(['invalid base64','non-canonical base64','duplicate','unsorted','newline','CR','absolute','parent','dot','empty component','missing terminator','hash count','bad hash','excluded test','excluded directory test'])
  ('rejects %s manifest before executing and never produces green evidence', async fault => {
    Object.assign(request, await snapshot());
    const manifest = request.manifest;
    if (fault === 'invalid base64') manifest.paths = '%%%';
    if (fault === 'non-canonical base64') manifest.paths += '\n';
    if (fault === 'duplicate') {
      manifest.paths = nul([Buffer.from('package-lock.json'),Buffer.from('package-lock.json')]).toString('base64');
      manifest.hashes.push(manifest.hashes[0]); manifest.executable.push(false);
      manifest.tracked.push(manifest.tracked[0]);
    }
    if (fault === 'unsorted') {
      await writeFile(join(work,'z.txt'),'z');
      manifest.paths = nul([Buffer.from('z.txt'),Buffer.from('package-lock.json')]).toString('base64');
      manifest.hashes = [hash('z'),hash('lock')]; manifest.executable = [false,false];
      manifest.tracked = [false,false];
    }
    const unsafe = {'newline':'bad\nname.test.mjs', CR:'bad\rname', absolute:'/outside', parent:'../outside', dot:'./file', 'empty component':'a//file'};
    if (fault in unsafe) manifest.paths = nul([Buffer.from(unsafe[fault])]).toString('base64');
    if (fault === 'missing terminator') manifest.paths = Buffer.from('package-lock.json').toString('base64');
    if (fault === 'hash count') manifest.hashes = [];
    if (fault === 'bad hash') manifest.hashes = ['not-sha256'];
    if (fault === 'excluded test') manifest.excluded = nul([Buffer.from('credentials.test.mjs')]).toString('base64');
    if (fault === 'excluded directory test') manifest.excluded = nul([Buffer.from('__tests__/credentials.js')]).toString('base64');
    request.manifestDigest = hash(JSON.stringify(manifest));
    request.inputDigest = await digestInput(work);
    const ordering = fault === 'duplicate' || fault === 'unsorted';
    if (ordering) {
      expect(manifest.hashes).toHaveLength(2);
      expect(manifest.executable).toEqual([false,false]);
      expect(manifest.tracked).toEqual([false,false]);
    }
    await expect(runner.run(request)).rejects.toThrow(ordering ? 'Manifest paths must be strictly increasing' : /manifest|inventory|snapshot|path|base64|hash|test/i);
    await expectNoExecutionOrReceipt();
  });

  it('refuses a manifestDigest that does not bind the supplied inventory', async () => {
    Object.assign(request, await snapshot());
    request.manifestDigest = '0'.repeat(64);
    await expect(runner.run(request)).rejects.toThrow(/manifest|digest/i);
    await expectNoExecutionOrReceipt();
  });

  it('refuses an excluded non-test file that is present on disk', async () => {
    const selected = await snapshot();
    selected.manifest.excluded = nul([Buffer.from('.env')]).toString('base64');
    Object.assign(request, selected, {manifestDigest:hash(JSON.stringify(selected.manifest))});
    await writeFile(join(work,'.env'),'must not arrive');
    request.inputDigest = await digestInput(work);
    await expect(runner.run(request)).rejects.toThrow(/manifest|excluded|extra|snapshot/i);
    await expectNoExecutionOrReceipt();
  });

  it.each(['leaf symlink','parent symlink','directory leaf','non-regular leaf'])('verifyManifest fails closed on %s', async kind => {
    // Assert availability outside rejects: a missing export is not evidence
    // that an unsafe file was inspected and refused.
    expect(manifestAPI.verifyManifest).toBeTypeOf('function');
    const path = Buffer.from(kind === 'parent symlink' ? 'linked/identity.test.mjs' : 'identity.test.mjs');
    const {manifest,manifestDigest} = makeManifest([{path,sha256:hash('assertion'),executable:false}]);
    const fs = {
      readdir:vi.fn(async () => [kind === 'parent symlink' ? Buffer.from('linked') : path]),
      lstat:vi.fn(async value => {
        const rootPath = Buffer.from(value).equals(Buffer.from(work));
        return {isSymbolicLink:()=>!rootPath && kind.includes('symlink'),
          isDirectory:()=>rootPath || kind === 'directory leaf',
          isFile:()=>!rootPath && !['directory leaf','non-regular leaf'].includes(kind), mode:0o100644};
      }),
      readFile:vi.fn(async () => Buffer.from('assertion')),
    };
    await expect(verify(manifest,manifestDigest,{fs})).rejects.toThrow(/symlink|regular|directory|manifest|inventory/i);
  });

  it('verifies non-UTF-8 byte paths using Buffer filesystem IO without a lossy decode', async () => {
    const path = Buffer.concat([Buffer.from('raw-'),Buffer.from([0xff]),Buffer.from('.txt')]);
    const {manifest,manifestDigest} = makeManifest([{path,sha256:hash('assertion'),executable:false}]);
    const fs = {
      readdir:vi.fn(async (_base, options) => {
        expect(options.encoding).toBe('buffer'); return [path];
      }),
      lstat:vi.fn(async value => ({isDirectory:()=>Buffer.from(value).equals(Buffer.from(work)),
        isSymbolicLink:()=>false, isFile:()=>!Buffer.from(value).equals(Buffer.from(work)), mode:0o100644})),
      readFile:vi.fn(async value => {
        expect(Buffer.isBuffer(value)).toBe(true);
        expect(value).toEqual(Buffer.concat([Buffer.from(work+'/'),path]));
        return Buffer.from('assertion');
      }),
    };
    const verified = await verify(manifest,manifestDigest,{fs});
    expect(verified.entries).toEqual([{path,sha256:hash('assertion'),executable:false,tracked:false}]);
    expect(verified.testPaths).toEqual([]);
    expect(fs.readFile).toHaveBeenCalled();
  });

  it.each([
    [Buffer.concat([Buffer.from('raw-'), Buffer.from([0xff]), Buffer.from('.test.mjs')]), Buffer.from('raw-�.test.mjs'), 'undecodable test name'],
    [Buffer.from('é.test.mjs'), Buffer.from('e\u0301.test.mjs'), 'test name collision'],
    [Buffer.from('A.test.mjs'), Buffer.from('a.test.mjs'), 'test name collision'],
    [Buffer.from('ß.test.mjs'), Buffer.from('SS.test.mjs'), 'test name collision'],
  ])('refuses unsafe Forge test names before installation: %s / %s', async (a, b, message) => {
    Object.assign(request, makeManifest([a,b].map(path => ({path, sha256:hash('test'), executable:false}))));
    await expect(runner.run(request)).rejects.toThrow(`Input digest mismatch: ${message}`);
    await expectNoExecutionOrReceipt();
  });

  it('the manifest test subset equals the on-disk and executed fixture set byte-for-byte', async () => {
    const tests = ['identity.test.mjs','credentials-check.spec.ts','é.test.mjs','nested/key-handler.test.cjs'];
    const support = ['notes.test.txt','nested/support.js'];
    await mkdir(join(work,'nested'));
    for (const name of [...tests,...support]) await writeFile(join(work,name),'fixture');
    Object.assign(request, await snapshot(['package-lock.json',...tests,...support]));
    const verified = await verify(request.manifest,request.manifestDigest);
    const expected = tests.map(name => Buffer.from(name)).sort(Buffer.compare);
    expect(verified.testPaths).toEqual(expected);
    expect(verified.entries.filter(entry => manifestAPI.isTestFile(entry.path)).map(entry => entry.path)).toEqual(expected);
    // This loader checks runner execution; the separate PARITY test checks the
    // real repository globs independently of this loader's suffix predicate.
    for (const name of tests) await writeFile(join(work,name),'globalThis.loaded = (globalThis.loaded || 0) + 1;');
    Object.assign(request, await snapshot(['package-lock.json',...tests,...support]));
    request.inputDigest = await digestInput(work);
    await writeFile(join(root,'bin','npm'), `#!${process.execPath}
const fs = require('node:fs');
const vm = require('node:vm');
if (process.argv[2] === 'ci') process.exit(0);
const observed = [];
function walk(base, prefix = '') {
  for (const name of fs.readdirSync(base, {encoding:'buffer'})) {
    const rel = Buffer.concat([Buffer.from(prefix),name]);
    const full = Buffer.concat([Buffer.from(process.cwd()+'/'),rel]);
    if (fs.lstatSync(full).isDirectory()) walk(full, rel.toString()+'/');
    else if (/\\.(test|spec)\\.[cm]?[jt]sx?$/.test(name.toString())) {
      vm.runInThisContext(fs.readFileSync(full,'utf8')); observed.push(rel);
    }
  }
}
walk(process.cwd());
observed.sort(Buffer.compare);
fs.writeFileSync(${JSON.stringify(join(root,'executed.json'))}, JSON.stringify(observed.map(path => path.toString('base64'))));
if (globalThis.loaded !== ${tests.length}) process.exit(9);
`, {mode:0o755});
    expect((await runner.run(request)).code).toBe(0);
    expect(JSON.parse(await readFile(join(root,'executed.json'),'utf8'))).toEqual(expected.map(path => path.toString('base64')));
    expect(await runner.finish(request)).toMatchObject({phase:'test',code:0,manifestDigest:request.manifestDigest});
  });

  it('PARITY: every repository Vitest include glob selects only manifest test files', async () => {
    // Vitest 1.6 has no list command. Read the actual unit include array and use
    // micromatch (declared in package.json), independently of isTestFile.
    const config = await readFile(new URL('../../../vitest.config.ts', import.meta.url), 'utf8');
    const section = config.match(/^    include: \[([\s\S]*?)^    \],/m);
    expect(section, 'find the real test.include array, not coverage.include').not.toBeNull();
    const globs = [...section[1].matchAll(/^\s*'([^']+)'/gm)].map(match => match[1]);
    expect(globs.length).toBeGreaterThan(0);
    const matches = name => globs.some(glob => micromatch.isMatch(name, glob));
    // Expand each real glob into concrete root/nested and extension variants.
    const positives = globs.flatMap(glob => micromatch.braces(glob, {expand: true})
      .flatMap(pattern => ['', 'nested/'].map(depth => pattern.replaceAll('**/', depth).replaceAll('*', 'identity'))));
    const names = [...new Set([...positives, 'scripts/__tests__/support.json',
      'scripts/__tests__/credentials.js', 'notes.test.txt', 'support.js'])];
    await Promise.all(names.map(async name => {
      await mkdir(join(work, name, '..'), {recursive:true});
      await writeFile(join(work, name), 'fixture');
    }));
    const binding = await snapshot(['package-lock.json', ...names]);
    const verified = await verify(binding.manifest, binding.manifestDigest);
    const selected = new Set(verified.testPaths.map(path => path.toString()));
    for (const name of positives) expect(matches(name), name).toBe(true);
    for (const name of names.filter(matches)) expect(selected.has(name), name).toBe(true);
    expect(selected.has('scripts/__tests__/credentials.js')).toBe(true);
    expect(selected.has('notes.test.txt')).toBe(false);
    expect(selected.has('support.js')).toBe(false);
  });
});


describe('sibling manifest verification', () => {
  async function withSiblings() {
    const sibling = join(root,'runs',request.run,'frontierui');
    const entries=[];
    for (const subtree of ['plugs','webtheme']) {
      await mkdir(join(sibling,subtree),{recursive:true});
      await writeFile(join(sibling,subtree,'index.js'),subtree);
      entries.push({path:Buffer.from(`${subtree}/index.js`),sha256:hash(subtree),executable:false});
    }
    request.manifest.siblings={frontierui:{sha:'a'.repeat(40),...manifestAPI.manifestWire({entries,excluded:[]})}};
    request.manifestDigest=manifestAPI.digestManifest(request.manifest);
    request.siblingShas={frontierui:'a'.repeat(40)};
    return sibling;
  }
  it('advertises sibling support and puts the sibling SHA in protected receipts', async () => {
    expect(await runner.prepare({nonce:request.nonce})).toMatchObject({capabilities:{siblings:1}});
    await withSiblings();
    expect((await runner.run(request)).code).toBe(3);
    expect(await runner.finish(request)).toMatchObject({siblingShas:request.siblingShas});
  });
  it.each(['extra','extra directory','missing','outside allowlist','wrong sha','missing sha','oversized'])
  ('rejects %s sibling evidence and writes protected rejected state before executing', async fault => {
    const sibling=await withSiblings();
    if (fault==='extra directory') await mkdir(join(sibling,'plugs/unexpected'));
    if (fault==='extra') await writeFile(join(sibling,'plugs/extra.js'),'extra');
    if (fault==='missing') await rm(join(sibling,'webtheme/index.js'));
    if (fault==='outside allowlist') request.manifest.siblings.frontierui.paths=Buffer.from('other/index.js\0').toString('base64');
    if (fault==='wrong sha') request.siblingShas.frontierui='0'.repeat(40);
    if (fault==='missing sha') delete request.siblingShas;
    if (fault==='oversized') request.manifest.siblings.frontierui.excluded='x'.repeat(4*1024*1024);
    request.manifestDigest=manifestAPI.digestManifest(request.manifest);
    await expect(runner.run(request)).rejects.toThrow();
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
    const rejected=join(root,'receipts',request.run+'.rejected');
    expect(JSON.parse(await readFile(rejected,'utf8'))).toMatchObject({nonce:request.nonce,run:request.run,phase:'rejected'});
    expect((await stat(rejected)).mode & 0o777).toBe(0o600);
    expect(await runner.finish(request)).toMatchObject({phase:'rejected',started:false});
  });
});


describe('slot resource environment and receipts',()=>{
  it.each([undefined,'3'])('defaults worker count while permitting a request override %s',async workers=>{
    const seen=[];
    runner=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testWorkerExec:async call=>{
      seen.push(call);
      return {code:0,stdout:'',stderr:''};
    }});
    request.env={CI:'true',...(workers?{WE_VITEST_MAX_WORKERS:workers}:{})};
    await runner.run(request);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for(const call of seen) expect(call.env.FORGE_SLOT_CPUS).toBe('8');
    expect(seen[0].env.WE_VITEST_MAX_WORKERS).toBe('8');
    expect(seen.at(-1).env.WE_VITEST_MAX_WORKERS).toBe(workers??'8');
    expect(JSON.parse(await readFile(join(root,'receipts',request.run+'.receipt'),'utf8')).resources)
      .toEqual({memoryPeakBytes:null,cpuUsec:null,oomKills:null,slotCpus:8});
  });
  it('refuses request overrides of the slot CPU ceiling before execution',async()=>{
    request.env.FORGE_SLOT_CPUS='100';
    await expect(runner.run(request)).rejects.toThrow('Invalid execution parameters');
    await expect(readFile(join(root,'install.log'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('accumulates per-command usage in the protected receipt',async()=>{
    let count=0;
    runner=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testWorkerExec:async()=>{
      count++;
      return {code:0,stdout:'',stderr:'',usage:{memoryPeakBytes:count===1?200:100,cpuUsec:10,oomKills:1}};
    }});
    await runner.run(request);
    expect(count).toBeGreaterThanOrEqual(2);
    const receipt=JSON.parse(await readFile(join(root,'receipts',request.run+'.receipt'),'utf8'));
    expect(receipt.resources).toEqual({memoryPeakBytes:200,cpuUsec:count*10,oomKills:count,slotCpus:8});
    expect((await runner.finish(request)).resources).toEqual(receipt.resources);
  });
  it.each(['null counters','missing counters','missing usage'].flatMap(kind=>[1,2].map(command=>[kind,command])))
  ('keeps receipt counters null with %s in command %s',async(kind,command)=>{
    let count=0;
    runner=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testWorkerExec:async()=>{
      count++;
      const usage=count!==command ? {memoryPeakBytes:200,cpuUsec:10,oomKills:1}
        : kind==='null counters' ? {memoryPeakBytes:null,cpuUsec:null,oomKills:null}
        : kind==='missing counters' ? {} : undefined;
      return {code:0,stdout:'',stderr:'',usage};
    }});
    await runner.run(request);
    expect(count).toBeGreaterThanOrEqual(2);
    const receipt=JSON.parse(await readFile(join(root,'receipts',request.run+'.receipt'),'utf8'));
    expect(receipt.resources).toEqual({memoryPeakBytes:null,cpuUsec:null,oomKills:null,slotCpus:8});
    expect((await runner.finish(request)).resources).toEqual(receipt.resources);
  });
});

it.each([false,true])('reads supervisor cgroup counters with missing counters=%s',async missing=>{
  const usage=join(root,'usage.json');
  const source=supervisorSource.slice(supervisorSource.indexOf("if 'usage' in cfg:"),supervisorSource.indexOf("fd = os.open(cfg['status']"));
  const probe=String.raw`import os, sys, json, io, builtins
from unittest.mock import patch
source, usage, missing = sys.argv[1:]
cfg = {'usage': usage}
files = {'/proc/self/cgroup': '0::/forge-exec.slice/forge-exec-3.slice/scope\n',
         '/sys/fs/cgroup/forge-exec.slice/forge-exec-3.slice/scope/memory.peak': '12345',
         '/sys/fs/cgroup/forge-exec.slice/forge-exec-3.slice/scope/cpu.stat': 'usage_usec 678\nuser_usec 600\n',
         '/sys/fs/cgroup/forge-exec.slice/forge-exec-3.slice/scope/memory.events': 'oom 2\noom_kill 1\n'}
def counter_open(path, *args, **kwargs):
    if missing == 'true' and path != '/proc/self/cgroup': raise FileNotFoundError(path)
    return io.StringIO(files[path])
with patch.object(builtins, 'open', side_effect=counter_open):
    exec(source)
# A second write must refuse to overwrite existing protected evidence.
try:
    with patch.object(builtins, 'open', side_effect=counter_open):
        exec(source)
except FileExistsError:
    pass
else:
    raise AssertionError('usage write was not exclusive')
`;
  const result=spawnSync('python3',['-I','-c',probe,source,usage,String(missing)],{encoding:'utf8',timeout:10000});
  expect(result.status,result.stderr).toBe(0);
  expect(JSON.parse(await readFile(usage,'utf8'))).toEqual(missing
    ? {memoryPeakBytes:null,cpuUsec:null,oomKills:null}
    : {memoryPeakBytes:12345,cpuUsec:678,oomKills:1});
  expect(supervisorSource.indexOf("if 'usage' in cfg:")).toBeGreaterThan(supervisorSource.indexOf('if not uid_processes(): break'));
});
