import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from './fixtures/lane-pool-freshness-loader.mjs';

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
});
