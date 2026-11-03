import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from './fixtures/lane-pool-freshness-loader.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const loaderUrl = () => pathToFileURL(resolve(process.cwd(), 'scripts/__tests__/fixtures/lane-pool-freshness-loader.mjs'));
const run = args => spawnSync(process.execPath, args, {
  env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
});

describe('lane-pool fixture freshness injection', () => {
  it('preloads a file URL in native Node children', () => {
    const option = process.env.NODE_OPTIONS.split(/\s+/).find(value => value.includes('lane-pool-freshness-loader.mjs'));
    expect(option).toMatch(/^--import=file:/);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', "console.log('fixture started')"], {
      env: process.env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('fixture started\n');
  });

  it('injects only the canonical tool and preserves copied guard fixtures', async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const tool = pathToFileURL(resolve(directory, '../lane-pool.mjs')).href;
    const source = 'await guardToolEntry();';
    const nextLoad = async () => ({ format: 'module', source: Buffer.from(source) });
    const result = await load(tool, {}, nextLoad);
    expect(String(result.source)).toContain('guardToolEntry({ check: async () => undefined })');
    const copiedTool = pathToFileURL(resolve(directory, 'copied/lane-pool.mjs')).href;
    expect(String((await load(copiedTool, {}, nextLoad)).source)).toBe(source);
    expect(fileURLToPath(tool)).toMatch(/scripts\/lane-pool\.mjs$/);
  });

  it('does not register loader hooks in unrelated children', () => {
    const child = run(['--input-type=module', '-e', `
      import Module, { syncBuiltinESMExports } from 'node:module';
      Module.register = () => { throw new Error('unexpected loader thread'); };
      syncBuiltinESMExports();
      await import(${JSON.stringify(loaderUrl().href)});
      console.log('native loading');
    `]);
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('native loading\n');
  });

  it('recognizes a symlink to the canonical tool before registering hooks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freshness-loader-'));
    dirs.push(dir);
    const alias = join(dir, 'tool alias.mjs');
    symlinkSync(resolve(process.cwd(), 'scripts/lane-pool.mjs'), alias);
    // Observe registration without running the real pool CLI or making Git writes.
    const child = run(['--input-type=module', '-e', `
      import Module, { syncBuiltinESMExports } from 'node:module';
      Module.register = () => console.log('registered');
      syncBuiltinESMExports();
      process.argv[1] = ${JSON.stringify(alias)};
      await import(${JSON.stringify(loaderUrl().href)});
    `]);
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('registered\n');
  });

  it.each([false, true])('injects a selected tool reached through a symlink (selected alias=%s)', selectedAlias => {
    const dir = mkdtempSync(join(tmpdir(), 'freshness-loader-'));
    dirs.push(dir);
    const tool = join(dir, 'tool entry é.mjs');
    const alias = join(dir, 'tool alias.mjs');
    writeFileSync(tool, `
      async function guardToolEntry({ check = async () => { throw new Error('fixture guard ran'); } } = {}) {
        await check();
      }
      await guardToolEntry();
      console.log('injected');
    `);
    symlinkSync(tool, alias);
    const selected = loaderUrl();
    selected.searchParams.set('tool', pathToFileURL(selectedAlias ? alias : tool).href);
    const child = run(['--import', selected.href, alias]);
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('injected\n');
  });

  it('injects an explicitly selected simulator copy, preserving its output and refusing other copies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freshness-loader-'));
    dirs.push(dir);
    const tool = join(dir, 'tool entry é.mjs');
    const other = join(dir, 'other.mjs');
    const source = `
      async function guardToolEntry({ check = async () => { throw new Error('fixture guard ran'); } } = {}) {
        await check();
      }
      await guardToolEntry();
      process.stdout.write('x'.repeat(32768));
    `;
    writeFileSync(tool, source);
    writeFileSync(other, source);
    // The default preload must leave copied guard fixtures real.
    const refused = run(['--import', loaderUrl().href, tool]);
    expect(refused.error).toBeUndefined();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('fixture guard ran');
    expect(refused.stdout).toBe('');

    const selected = loaderUrl();
    selected.searchParams.set('tool', pathToFileURL(tool).href);
    const admitted = run(['--import', selected.href, tool]);
    expect(admitted.error).toBeUndefined();
    expect(admitted.stderr).toBe('');
    expect(admitted.status).toBe(0);
    expect(admitted.stdout).toBe('x'.repeat(32768));

    const unrelated = run(['--import', selected.href, other]);
    expect(unrelated.error).toBeUndefined();
    expect(unrelated.status).toBe(1);
    expect(unrelated.stderr).toContain('fixture guard ran');
    expect(unrelated.stdout).toBe('');
  });

  it('injects disposable rebuild candidate entries only with an explicit candidate directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freshness-loader-'));
    dirs.push(dir);
    const state = join(dir, 'state');
    const selected = loaderUrl();
    selected.searchParams.set('candidates', pathToFileURL(state).href);
    // Rebuild fallback and last-good probes reuse the path with new contents.
    for (const label of ['candidate', 'plain main', 'last good']) {
      const tool = join(state, 'control.candidate-token/scripts/lane-pool.mjs');
      mkdirSync(dirname(tool), { recursive: true });
      writeFileSync(tool, `
        async function guardToolEntry({ check = async () => { throw new Error('fixture guard ran'); } } = {}) {
          await check();
        }
        await guardToolEntry();
        console.log(${JSON.stringify(label)});
      `);
      const refused = run(['--import', loaderUrl().href, tool]);
      expect(refused.error).toBeUndefined();
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('fixture guard ran');
      expect(refused.stdout).toBe('');
      const admitted = run(['--import', selected.href, tool]);
      expect(admitted.error).toBeUndefined();
      expect(admitted.stderr).toBe('');
      expect(admitted.status).toBe(0);
      expect(admitted.stdout).toBe(`${label}\n`);
    }
  });

  it.each([
    'state/control.candidate-token/scripts/worker.mjs',
    'state/control/scripts/lane-pool.mjs',
    'state-sibling/control.candidate-token/scripts/lane-pool.mjs',
  ])('keeps native loading outside candidate pool entries: %s', path => {
    const dir = mkdtempSync(join(tmpdir(), 'freshness-loader-'));
    dirs.push(dir);
    const tool = join(dir, path);
    mkdirSync(dirname(tool), { recursive: true });
    writeFileSync(tool, '');
    const selected = loaderUrl();
    selected.searchParams.set('candidates', pathToFileURL(join(dir, 'state')).href);
    const child = run(['--input-type=module', '-e', `
      import Module, { syncBuiltinESMExports } from 'node:module';
      Module.register = () => { throw new Error('unexpected loader thread'); };
      syncBuiltinESMExports();
      process.argv[1] = ${JSON.stringify(tool)};
      await import(${JSON.stringify(selected.href)});
      console.log('native loading');
    `]);
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('native loading\n');
  });

  it.each(['no injection site', 'await guardToolEntry(); await guardToolEntry();'])(
    'refuses a changed injection site: %s', async source => {
      const tool = pathToFileURL(resolve(process.cwd(), 'scripts/lane-pool.mjs')).href;
      await expect(load(tool, {}, async () => ({ format: 'module', source: Buffer.from(source) })))
        .rejects.toThrow('Lane-pool fixture guard injection site changed');
    },
  );
});
