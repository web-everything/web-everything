// @repo-scanning-test scope=full — verifies the numbered guide against its pinned source.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { joinTestingNotes, readTestingNotes } from '../lib/testing-notes-join.mjs';

const root = resolve(import.meta.dirname, '../..');
const baseline = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/testing-notes-split-baseline.json'), 'utf8'));
const fragment = (name, text) => ({ name, text });

describe('testing notes join', () => {
  it('sorts by code units across locales with exactly one blank line', () => {
    const files = ['a.md', 'Z.md', '10-a.md', '010-b.md'].map((name) => fragment(name, `## ${name}\n\n`));
    const before = process.env.LANG;
    try {
      for (const locale of ['en_US.UTF-8', 'tr_TR.UTF-8']) {
        process.env.LANG = locale;
        expect(joinTestingNotes(files).text).toBe('## 010-b.md\n\n## 10-a.md\n\n## Z.md\n\n## a.md\n');
      }
    } finally { if (before === undefined) delete process.env.LANG; else process.env.LANG = before; }
  });

  it('rejects fragments without a leading level-two heading', () => {
    expect(() => joinTestingNotes([fragment('bad.md', '# Wrong\n')])).toThrow(/bad.md.*leading ##/);
  });

  it('reports duplicate heading anchors across fragments', () => {
    const result = joinTestingNotes([fragment('a.md', '## One\n### Same\n'), fragment('b.md', '## Two\n### Same\n')]);
    expect(result.warnings).toEqual([expect.stringMatching(/duplicate.*same.*a.md.*b.md/i)]);
    expect(result.text).toContain('## Two');
  });

  it('accepts a new fragment at a stable position and ignores README, non-md and nested files', () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'testing-notes-'));
    const directory = resolve(temporary, 'docs/agent/testing.d');
    mkdirSync(resolve(directory, 'nested'), { recursive: true });
    try {
      for (const [name, text] of [['001-old.md', '## Old\n'], ['README.md', 'invalid'], ['ignore.txt', 'ignored'], ['nested/child.md', 'ignored']]) writeFileSync(resolve(directory, name), text);
      expect(readTestingNotes(temporary).text).toBe('## Old\n');
      writeFileSync(resolve(directory, 'new-topic.md'), '## New topic\n');
      expect(readTestingNotes(temporary).text).toBe('## Old\n\n## New topic\n');
      writeFileSync(resolve(directory, 'bad.md'), 'invalid');
      expect(() => readTestingNotes(temporary)).toThrow(/bad.md/);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it('fails closed for missing, empty or unreadable evidence', () => {
    expect(() => readTestingNotes(resolve(root, 'nonexistent-testing-notes-root'))).toThrow();
    expect(() => joinTestingNotes([fragment('bad.md', null)])).toThrow();
    expect(() => joinTestingNotes([])).toThrow(/no.*fragments/i);
  });

  it('CLI prints the complete joined text and reports duplicate anchors on stderr', () => {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/testing-notes.mjs')], {
      cwd: tmpdir(), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 5000,
    });
    const joined = readTestingNotes(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(joined.text);
    expect(joined.warnings).toHaveLength(3);
    for (const warning of joined.warnings) expect(result.stderr).toContain(warning);
  });

  it('losslessly preserves every original section against the pinned commit', (context) => {
    try { execFileSync('git', ['cat-file', '-e', baseline.sha + '^{commit}'], { cwd: root, stdio: 'pipe' }); }
    catch (error) {
      const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim() === 'true';
      if (!shallow || !/Not a valid object name|Not a valid object|bad object/i.test(String(error.stderr))) throw error;
      context.skip(`Pinned commit ${baseline.sha} is unreachable (shallow clone); fetch history to verify losslessness.`);
      return;
    }
    const original = execFileSync('git', ['show', baseline.sha + ':docs/agent/testing.md'], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    expect(createHash('sha256').update(original).digest('hex')).toBe(baseline.sha256);
    expect(original.split('\n').length - Number(original.endsWith('\n'))).toBe(baseline.lineCount);
    const body = original.replace(/^# [^\n]*\n+/, '').replace(/^> Authors:[^\n]*\n\n/gm, '');
    const sections = body.split(/(?=^## )/m).filter(Boolean);
    const directory = resolve(root, 'docs/agent/testing.d');
    const files = readdirSync(resolve(root, 'docs/agent/testing.d')).filter((name) => /^\d{3}-/.test(name)).sort();
    expect(files).toHaveLength(sections.length);
    files.forEach((name, i) => expect(readFileSync(resolve(directory, name), 'utf8')).toBe(sections[i]));
    expect(joinTestingNotes(files.map((name) => fragment(name, readFileSync(resolve(directory, name), 'utf8')))).text)
      .toBe(sections.map((text) => text.replace(/\n+$/g, '')).join('\n\n') + '\n');
    expect(readTestingNotes(root).text).toContain('## Red-main timeout policy');
  });
});
