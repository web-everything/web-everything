import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';
import { normalizeRepo } from '../action-record.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const sweptRepos = JSON.parse(readFileSync(resolve(testDir, '../../lib/swept-repos.json'), 'utf8'));

describe('normalizeRepo pre-transfer owner alias', () => {
  it('aliases chalbert only when the resulting slug is in sweptRepos', () => {
    expect(sweptRepos).toContain('web-everything/web-everything');
    expect(normalizeRepo('chalbert/web-everything')).toBe('web-everything/web-everything');
    expect(normalizeRepo('  chalbert/web-everything  ')).toBe('web-everything/web-everything');
    for (const name of ['not-a-swept-repo', 'frontierui', 'plateau-app']) {
      expect(sweptRepos).not.toContain(`web-everything/${name}`);
      // Preserve the original slug in the error: an unswept alias must not be applied.
      expect(() => normalizeRepo(`chalbert/${name}`)).toThrow(`Unknown coordination repo: chalbert/${name}`);
    }
  });

  it('still throws Unknown coordination repo for unknown inputs', () => {
    for (const repo of ['unknown', 'unknown/web-everything', 'web-everything/unknown', 'chalbert/web-everything/extra', '', null, undefined]) {
      expect(() => normalizeRepo(repo)).toThrow(TypeError);
      expect(() => normalizeRepo(repo)).toThrow(`Unknown coordination repo: ${String(repo ?? '').trim()}`);
    }
  });

  it('preserves canonical slugs, constellation keys and every constellation directory', () => {
    for (const slug of sweptRepos) {
      expect(normalizeRepo(slug)).toBe(slug);
      expect(normalizeRepo(`  ${slug}  `)).toBe(slug);
    }
    for (const [key, { slug, dirs }] of Object.entries(CONSTELLATION_REPOS)) {
      expect(normalizeRepo(key)).toBe(slug);
      for (const dir of dirs) {
        expect(normalizeRepo(dir)).toBe(slug);
        expect(normalizeRepo(`  ${dir}  `)).toBe(slug);
      }
    }
  });

  it('keeps the owner alias table in one module-level constant', () => {
    const source = readFileSync(resolve(testDir, '../action-record.mjs'), 'utf8');
    expect(source.match(/const RENAMED_OWNERS\s*=\s*\{\s*chalbert:\s*'web-everything'\s*\};/g)).toHaveLength(1);
    expect(source.match(/\bchalbert\b/g)).toHaveLength(1);
    expect(source.indexOf('const RENAMED_OWNERS')).toBeLessThan(source.indexOf('export function normalizeRepo'));
    expect(source).toContain('RENAMED_OWNERS[renamed[1]]');
  });
});
