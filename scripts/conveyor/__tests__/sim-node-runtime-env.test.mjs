import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { nodeRuntimeEnv } from './sim/node-runtime-env.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const worldRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-node-runtime-'));
  roots.push(root);
  return root;
};

it('isolates the child compile cache from ambient state and other worlds', () => {
  const first = worldRoot(), second = worldRoot();
  const env = { NODE_COMPILE_CACHE: '/ambient-cache', ...nodeRuntimeEnv(first) };
  expect(resolve(env.NODE_COMPILE_CACHE)).toBe(join(first, 'node-compile-cache'));
  expect(env.NODE_COMPILE_CACHE).not.toBe(nodeRuntimeEnv(second).NODE_COMPILE_CACHE);
});

it('fresh children see main moves at the same module path and keep process state separate', () => {
  const root = worldRoot();
  const module = join(root, 'daemon.mjs');
  const runtime = nodeRuntimeEnv(root);
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(module).href)}); console.log(m.tick());`], {
    env: { ...process.env, ...runtime }, encoding: 'utf8', timeout: 10_000,
  }).trim();
  writeFileSync(module, 'let count = 0; export const tick = () => `old:${++count}`;\n');
  expect(run()).toBe('old:1');
  expect(run()).toBe('old:1');
  writeFileSync(module, 'let count = 0; export const tick = () => `new:${++count}`;\n');
  expect(run()).toBe('new:1');
  expect(readFileSync(module, 'utf8')).toContain('new:');
  // The CI runtime supports compile caching (Node >=22.8); older local runtimes ignore the setting.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if ((major > 22 || (major === 22 && minor >= 8)) && !process.env.NODE_DISABLE_COMPILE_CACHE) {
    expect(existsSync(runtime.NODE_COMPILE_CACHE)).toBe(true);
    expect(readdirSync(runtime.NODE_COMPILE_CACHE).length).toBeGreaterThan(0);
  }
  rmSync(root, { recursive: true, force: true });
  expect(existsSync(runtime.NODE_COMPILE_CACHE)).toBe(false);
});
