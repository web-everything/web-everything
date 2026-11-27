import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { selectTargetedBreaks, runTargetedBreaks, targetedBreaksCli, soakCacheOk } from '../targeted-breaks.mjs';

const dirs = [];
const prefix = 'scripts/conveyor/soak/breaks/';
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const selectorUrl = pathToFileURL(join(sourceRoot, 'scripts/conveyor/soak/targeted-breaks.mjs')).href;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'targeted-breaks-'));
  dirs.push(root);
  mkdirSync(join(root, prefix), { recursive: true });
  writeFileSync(join(root, 'vitest.soak.config.ts'), 'export default { test: {} };');
  function add(name, source = "export default { fixedBy: { paths: ['scripts/changed.mjs'] } }", sibling = true) {
    writeFileSync(join(root, prefix, `${name}.mjs`), source);
    if (sibling) writeFileSync(join(root, prefix, `${name}.soak.test.mjs`), '');
    return `${prefix}${name}.soak.test.mjs`;
  }
  function plan(options = {}) {
    // Native Node imports the actual temporary ESM registry, outside Vite's loader.
    const input = { root, changed: ['scripts/changed.mjs'], timings: { soak: { [`${prefix}timed.soak.test.mjs`]: 1 } }, ...options };
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import {selectTargetedBreaks} from ${JSON.stringify(selectorUrl)}; console.log(JSON.stringify(await selectTargetedBreaks({...${JSON.stringify(input)}, now:()=>0})));`],
      { cwd: root, env: { HOME: root, TMPDIR: root }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    expect(r.error, r.stderr).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }
  return { root, add, plan };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('targeted soak selector (temporary registries only)', () => {
  it.each(['scenario-only', 'test-only'])('%s selects the sibling', async kind => {
    const f = fixture(), file = f.add('a');
    expect(await f.plan({ changed: [kind === 'scenario-only' ? `${prefix}a.mjs` : file] })).toMatchObject({ status: 'run', files: [file] });
  });
  it('resolves constant fixedBy paths by import, without calling fixPresent or run', async () => {
    const f = fixture();
    const file = f.add('constant', "const DISPATCH='scripts/changed.mjs'; export default {fixedBy:{paths:[DISPATCH]}, fixPresent(){throw Error('called fixPresent')}, run(){throw Error('called run')}}");
    expect(await f.plan()).toMatchObject({ status: 'run', files: [file] });
  });
  it('missing-sibling and absent-paths do not match a dependency; absent-paths matches itself', async () => {
    const f = fixture(); f.add('missing', undefined, false);
    const a = f.add('absent', 'export default {}');
    expect(await f.plan()).toMatchObject({ status: 'none', files: [], estSeconds: 0 });
    expect(await f.plan({ changed: [`${prefix}absent.mjs`] })).toMatchObject({ status: 'run', files: [a] });
  });
  it.each(['backlog/x.md', 'scripts/conveyor/soak/define-break-test.mjs'])('unrelated %s gives none without reading timings', async path => {
    const f = fixture(); f.add('a');
    expect(await f.plan({ changed: [path], timings: null })).toMatchObject({ status: 'none' });
  });
  it('sorts and deduplicates canonical realpath identities', async () => {
    const f = fixture(), z = f.add('z'), a = f.add('a');
    f.add('alias', 'export default {}', false);
    symlinkSync(join(f.root, z), join(f.root, prefix, 'alias.soak.test.mjs'));
    expect((await f.plan({ changed: ['scripts/changed.mjs', `${prefix}alias.mjs`] })).files).toEqual([a, z]);
  });
  it('unknown-changed-set takes precedence over selector-error', async () => {
    const f = fixture(); f.add('bad', "throw Error('broken import')");
    expect(await f.plan({ changed: null })).toMatchObject({ status: 'deferred', reason: 'changed-set-unknown' });
  });
  it('selector-error-detail takes precedence over unusable timings', async () => {
    const f = fixture(); f.add('bad', "throw Error('broken import')");
    expect(await f.plan({ timings: null })).toMatchObject({ status: 'deferred', reason: 'selector-error', detail: expect.stringMatching(/bad.mjs.*broken import/) });
  });
  it.each(['config', 'registry'])('missing %s defers instead of returning none', async kind => {
    const f = fixture(); rmSync(join(f.root, kind === 'config' ? 'vitest.soak.config.ts' : prefix), { recursive: true });
    expect(await f.plan()).toMatchObject({ status: 'deferred', reason: 'selector-error' });
  });
  it.each([null, {}, { soak: {} }, { soak: { a: 1, [`${prefix}a.soak.test.mjs`]: 0, [`${prefix}b.soak.test.mjs`]: -1, [`${prefix}c.soak.test.mjs`]: NaN, [`${prefix}d.soak.test.mjs`]: '2' } }])('unreadable, empty or invalid timings fail closed: %j', async timings => {
    const f = fixture(); f.add('a');
    expect(await f.plan({ timings })).toMatchObject({ status: 'deferred', reason: 'timings-unavailable' });
  });
  it('median-fallback uses the lower middle valid break timing', async () => {
    const f = fixture(); f.add('untimed');
    const soak = Object.fromEntries([1, 2, 3, 4].map((v, i) => [`${prefix}${i}.soak.test.mjs`, v]));
    expect(await f.plan({ timings: { soak } })).toMatchObject({ status: 'run', estSeconds: 2 });
  });
  it('budget-boundaries: 64 and 900 run, 65 and 900.01 defer', async () => {
    const f = fixture(); for (let i = 0; i < 65; i++) f.add(`a${i}`);
    expect(await f.plan()).toMatchObject({ status: 'deferred', reason: 'over-budget', estSeconds: 65 });
    rmSync(join(f.root, prefix, 'a64.soak.test.mjs'));
    expect(await f.plan()).toMatchObject({ status: 'run', files: expect.any(Array) });
    expect(await f.plan({ timings: { soak: { [`${prefix}t.soak.test.mjs`]: 900 / 64 } } })).toMatchObject({ status: 'run', estSeconds: 900 });
    expect(await f.plan({ timings: { soak: { [`${prefix}t.soak.test.mjs`]: 900.01 / 64 } } })).toMatchObject({ status: 'deferred', reason: 'over-budget' });
  });
  it('outside symlink fails closed', async () => {
    const f = fixture(); f.add('a', undefined, false);
    writeFileSync(join(f.root, 'outside.soak.test.mjs'), '');
    symlinkSync(join(f.root, 'outside.soak.test.mjs'), join(f.root, prefix, 'a.soak.test.mjs'));
    expect(await f.plan()).toMatchObject({ status: 'deferred', reason: 'selector-error' });
  });
  it('timed-out import defers with a named operator fallback', async () => {
    const f = fixture(); f.add('hang');
    expect(await selectTargetedBreaks({ root: f.root, changed: ['scripts/changed.mjs'], importModule: () => new Promise(() => {}), now: () => 0, importTimeoutMs: 1 })).toMatchObject({ status: 'deferred', reason: 'selector-error', detail: expect.stringMatching(/hang.mjs.*timed out.*rerun verify/) });
  });
  it.each(['allowed-path-lookup', 'unexpected-process', 'write', 'append'])('cold import-effect probe detects %s without touching the host', kind => {
    const f = fixture();
    const existing = join(f.root, 'existing.txt'); writeFileSync(existing, 'before');
    const effect = kind === 'allowed-path-lookup' ? "import {execFileSync} from 'node:child_process';execFileSync('sh',['-c','command -v git']);"
      : kind === 'unexpected-process' ? "import {execFileSync} from 'node:child_process';execFileSync('true');"
        : `import {${kind === 'write' ? 'writeFileSync' : 'appendFileSync'} as effect} from 'node:fs';effect(${JSON.stringify(existing)},'after');`;
    f.add('effect', `${effect} export default {fixedBy:{paths:['scripts/changed.mjs']}};`);
    const probe = join(f.root, 'probe.mjs');
    writeFileSync(probe, `import cp from 'node:child_process';import fs from 'node:fs';import promises from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const emit=call=>process.stdout.write(JSON.stringify({probe:call})+'\\n');
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=(...args)=>{emit({kind:'process',name,command:args[0],args:args[1]});return '/fixture/git\\n';};
const names=['writeFile','writeFileSync','appendFile','appendFileSync','open','openSync','mkdir','mkdirSync','rm','rmSync','unlink','unlinkSync','rename','renameSync','copyFile','copyFileSync','createWriteStream'];
for(const api of [fs,promises])for(const name of names){if(typeof api[name]!=='function')continue;const original=api[name];api[name]=(...args)=>{if(name.startsWith('open')&&!(typeof args[1]==='string'?/[wa+]/.test(args[1]):Boolean(args[1]&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))))return original(...args);emit({kind:'write',name});throw Error('probe blocked import write');};}
syncBuiltinESMExports();`);
    const r = spawnSync(process.execPath, ['--import', probe, '--input-type=module', '-e', `import {selectTargetedBreaks} from ${JSON.stringify(selectorUrl)};console.log(JSON.stringify({selection:await selectTargetedBreaks({root:${JSON.stringify(f.root)},changed:['scripts/changed.mjs'],timings:{soak:{'${prefix}effect.soak.test.mjs':1}},now:()=>0})}));`],
      { cwd: f.root, env: { HOME: f.root, TMPDIR: f.root }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    expect(r.error, r.stderr).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
    const rows = r.stdout.trim().split('\n').map(JSON.parse), calls = rows.filter(row => row.probe).map(row => row.probe);
    const assertAllowed = () => {
      expect(calls.filter(call => call.kind === 'write')).toEqual([]);
      expect(calls.filter(call => call.kind === 'process').every(call => call.name === 'execFileSync' && call.command === 'sh' && JSON.stringify(call.args) === JSON.stringify(['-c', 'command -v git']))).toBe(true);
    };
    if (kind === 'allowed-path-lookup') {
      assertAllowed(); expect(calls).toHaveLength(1);
      expect(rows.at(-1).selection.status).toBe('run');
    } else expect(assertAllowed).toThrow();
    expect(readFileSync(existing, 'utf8')).toBe('before');
  });
});

describe('exact-file runner (injected spawn)', () => {
  function fakeSpawn(inspect = () => {}, { code = 0, signal = null, error } = {}) {
    return vi.fn((command, args, options) => {
      inspect(command, args, options);
      const child = new EventEmitter();
      queueMicrotask(() => error ? child.emit('error', error) : child.emit('close', code, signal));
      return child;
    });
  }
  it.each([[], ['run'], ['run', '--'], ['run', '--', '../x.mjs'], ['run', '--', 'scripts/foo.test.mjs'], ['run', '--', `${prefix}missing.soak.test.mjs`]].map(argv => [argv]))('refuses invalid input without spawning: %j', async argv => {
    const f = fixture(), spawnFn = fakeSpawn();
    expect(await targetedBreaksCli(argv, { cwd: f.root, spawnFn, stderr: () => {} })).toBe(2);
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it.each(['a b', "it's", 'x;touch PWNED$(id)|&>', 'a`id`', 'a,b', 'a[1]*', 'a{b}(c)?!+@'])('argv remains one literal entry: %s', async name => {
    const f = fixture(), file = f.add(name);
    let configPath;
    const spawnFn = fakeSpawn((command, args, options) => {
      expect(command).toBe('npx');
      expect(args.slice(0, 3)).toEqual(['vitest', 'run', '--config']);
      expect(args).toHaveLength(4);
      configPath = args[3];
      const source = readFileSync(configPath, 'utf8');
      const includes = JSON.parse(source.match(/include: (\[[^\n]+\])/)[1]);
      expect(includes).toEqual([realpathSync(join(f.root, file)).replace(/[\[\]{}()*?!+@\\]/g, '\\$&')]);
      expect(options).toMatchObject({ cwd: realpathSync(f.root), stdio: 'inherit' });
      expect(options.shell).toBeFalsy();
    });
    expect(await runTargetedBreaks({ root: f.root, files: [file], spawnFn, tempRoot: f.root })).toBe(0);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(f.root, 'PWNED'))).toBe(false);
  });
  it('report-argv and canonical duplicate elimination', async () => {
    const f = fixture(), file = f.add('a'), report = join(f.root, 'report.json');
    symlinkSync(join(f.root, file), join(f.root, prefix, 'alias.soak.test.mjs'));
    const spawnFn = fakeSpawn((_command, args) => {
      expect(args.slice(4)).toEqual(['--reporter=default', '--reporter=json', `--outputFile.json=${report}`]);
      expect(JSON.parse(readFileSync(args[3], 'utf8').match(/include: (\[[^\n]+\])/)[1])).toEqual([realpathSync(join(f.root, file))]);
    });
    expect(await runTargetedBreaks({ root: f.root, files: [file, `${prefix}alias.soak.test.mjs`], report, spawnFn, tempRoot: f.root })).toBe(0);
  });
  it('refuses absolute and escaping symlink paths before spawning', async () => {
    const f = fixture(), file = f.add('a'), spawnFn = fakeSpawn();
    symlinkSync(join(f.root, 'vitest.soak.config.ts'), join(f.root, prefix, 'outside.soak.test.mjs'));
    for (const entry of [join(f.root, file), `${prefix}outside.soak.test.mjs`]) {
      expect(await runTargetedBreaks({ root: f.root, files: [entry], spawnFn, stderr: () => {} })).toBe(2);
    }
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it.each([{ code: 0, expected: 0 }, { code: 1, expected: 1 }, { code: null, signal: 'SIGTERM', expected: 1 }, { error: new Error('spawn broke'), expected: 1 }])('propagates child outcome %j and cleans config', async outcome => {
    const f = fixture(), file = f.add('a'), stderr = vi.fn();
    expect(await runTargetedBreaks({ root: f.root, files: [file], spawnFn: fakeSpawn(undefined, outcome), tempRoot: f.root, stderr })).toBe(outcome.expected);
    if (outcome.error) expect(stderr).toHaveBeenCalledWith(expect.stringContaining('spawn broke'));
  });
  it.each(['a[1]*', 'a'])('real Vitest executes only the exact literal include: %s', async name => {
    const f = fixture(), file = f.add(name), report = join(f.root, 'report.json');
    const vitest = pathToFileURL(join(sourceRoot, 'node_modules/vitest/dist/index.js')).href;
    const body = pass => `import {it,expect} from ${JSON.stringify(vitest)}; it('literal fixture',()=>expect(${pass}).toBe(true));`;
    writeFileSync(join(f.root, file), body(true));
    for (const other of name === 'a' ? ['xa', 'a.soak.test.mjs.extra'] : ['a1', 'a1x', 'a[1]x']) {
      writeFileSync(join(f.root, prefix, `${other}.soak.test.mjs`), body(false));
    }
    mkdirSync(join(f.root, prefix, 'sub'));
    writeFileSync(join(f.root, prefix, 'sub', `${name}.soak.test.mjs`), body(false));
    const spawnFn = (_command, args, options) => spawn(process.execPath,
      [join(sourceRoot, 'node_modules/vitest/vitest.mjs'), ...args.slice(1), '--root', f.root, '--maxWorkers=1', '--minWorkers=1'],
      { ...options, stdio: 'pipe', env: { HOME: f.root, TMPDIR: f.root, PATH: process.env.PATH } });
    expect(await runTargetedBreaks({ root: f.root, files: [file], report, spawnFn, tempRoot: f.root })).toBe(0);
    const executed = JSON.parse(readFileSync(report, 'utf8')).testResults.filter(row => row.assertionResults.some(a => a.status === 'passed' || a.status === 'failed')).map(row => row.name);
    expect(executed).toEqual([realpathSync(join(f.root, file))]);
  }, 20000);
});

describe('soak cache evidence', () => {
  const run = { status: 'run', files: ['a'] };
  const record = soak => ({ phases: { soak } });
  it('none accepts legacy and transient evidence', () => {
    expect(soakCacheOk({}, { status: 'none', files: [] }, false)).toBe(true);
    expect(soakCacheOk(record({ status: 'deferred', reason: 'selector-error' }), { status: 'none', files: [] }, false)).toBe(true);
  });
  it('run requires passed evidence for exactly the same files', () => {
    expect(soakCacheOk(record({ status: 'passed', files: ['a'] }), run, false)).toBe(true);
    for (const soak of [undefined, { status: 'failed', files: ['a'] }, { status: 'skipped', reason: 'explicit-gate', files: ['a'] }, { status: 'passed', files: ['b'] }, { status: 'deferred', reason: 'over-budget', files: ['a'] }]) {
      expect(soakCacheOk(record(soak), run, false)).toBe(false);
    }
  });
  it('over-budget accepts same-file passed or over-budget evidence only', () => {
    const selection = { ...run, status: 'deferred', reason: 'over-budget' };
    expect(soakCacheOk(record({ ...selection }), selection, false)).toBe(true);
    expect(soakCacheOk(record({ status: 'passed', files: ['a'] }), selection, false)).toBe(true);
    expect(soakCacheOk(record({ ...selection, files: ['b'] }), selection, false)).toBe(false);
  });
  it('a genuine repeated operator override can reuse its matching explicit skip, while a default cannot', () => {
    const old = record({ status: 'skipped', reason: 'explicit-gate', files: ['a'] });
    expect(soakCacheOk(old, run, true)).toBe(true);
    expect(soakCacheOk(old, run, false)).toBe(false);
    expect(soakCacheOk(old, { ...run, files: ['b'] }, true)).toBe(false);
    expect(soakCacheOk(record({ status: 'skipped', reason: 'explicit-gate', files: [] }), { status: 'deferred', reason: 'changed-set-unknown', files: [] }, true)).toBe(true);
  });
  it.each(['selector-error', 'timings-unavailable', 'changed-set-unknown'])('transient %s always misses', reason => {
    expect(soakCacheOk(record({ status: 'deferred', reason, files: ['a'] }), run, false)).toBe(false);
    expect(soakCacheOk(record({ status: 'passed', files: ['a'] }), { ...run, status: 'deferred', reason }, false)).toBe(false);
  });
});
