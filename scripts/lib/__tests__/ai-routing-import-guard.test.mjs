import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const allowlist = new Set(); // PR0 has no production consumers.
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (entry.isSymbolicLink() || ['.git', 'node_modules', '_site', 'dist', '.lanes', '.cache'].includes(entry.name)) return [];
  const path = join(dir, entry.name);
  return entry.isDirectory() ? files(path) : /\.(?:[cm]?[jt]sx?|njk|html)$/.test(entry.name) ? [path] : [];
});

describe('PR0 launch resolver import boundary', () => {
  it('has no consumers outside ai-routing and tests (empty production allowlist)', () => {
    const consumers = files(root).filter(path => {
      const name = relative(root, path).replaceAll('\\', '/');
      if (name === 'scripts/lib/ai-routing.mjs' || /(?:__tests__\/|\.(?:test|spec)\.)/.test(name) || allowlist.has(name)) return false;
      return /\bresolveLaunchSpec\b/.test(readFileSync(path, 'utf8'));
    }).map(path => relative(root, path));
    expect(consumers).toEqual([]);
    expect([...allowlist]).toEqual([]);
  });

  it('has no process.env read in resolveLaunchSpec', () => {
    const source = readFileSync(join(root, 'scripts/lib/ai-routing.mjs'), 'utf8');
    const body = source.slice(source.indexOf('export function resolveLaunchSpec('));
    expect(body).toContain('ctx.env');
    expect(body).not.toMatch(/\bprocess\s*(?:\.\s*env|\[\s*['"]env['"]\s*\])/);
  });
});
