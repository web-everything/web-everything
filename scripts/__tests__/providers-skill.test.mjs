/**
 * @file scripts/__tests__/providers-skill.test.mjs
 * @description Proof that the routing-only `providers` skill exists, is triggerable (name + description
 *   mention agy and Codex), and that every repo path it references resolves.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = join(ROOT, 'skills-src', 'providers', 'SKILL.md');

describe('providers skill', () => {
  it('exists with name and trigger description', () => {
    expect(existsSync(SKILL)).toBe(true);
    const text = readFileSync(SKILL, 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    expect(fm).not.toBeNull();
    expect(fm[1]).toMatch(/^name: providers$/m);
    const desc = /^description: (.*)$/m.exec(fm[1]);
    expect(desc).not.toBeNull();
    expect(desc[1]).toMatch(/agy/);
    expect(desc[1]).toMatch(/Codex/);
  });

  it('keeps the safety routing: audits use --review, agy is not a read-only seat, no skip flags', () => {
    const text = readFileSync(SKILL, 'utf8');
    expect(text).toMatch(/audits must pass `--review`/);
    expect(text).toMatch(/not a read-only research seat/);
    expect(text).toMatch(/Never use skip-permission flags/);
  });

  it('every we: path it links to resolves', () => {
    const text = readFileSync(SKILL, 'utf8');
    const paths = [...text.matchAll(/`we:([^`\s]+)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
  });
});
