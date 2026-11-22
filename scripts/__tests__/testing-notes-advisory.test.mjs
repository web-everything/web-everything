import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { testingNotesAdvisory, scanTestingNotesAdvisory, TESTING_GUIDE } from '../lib/testing-notes-advisory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { extractAnchors } = createRequire(import.meta.url)('../lib/rules-loader.cjs');
const base = 'a'.repeat(40);
const added = '@@ -1,0 +2 @@\n+new note\n';

describe('testing notes advisory', () => {
  it('warns for added lines in the legacy guide, with the per-topic destination', () => {
    expect(testingNotesAdvisory([TESTING_GUIDE])).toEqual([
      expect.stringContaining('docs/agent/testing/ as separate topic files'),
    ]);
  });

  it('is silent for a new per-topic file and unrelated additions', () => {
    expect(testingNotesAdvisory(['docs/agent/testing/new-topic.md', 'AGENTS.md'])).toEqual([]);
    expect(testingNotesAdvisory([])).toEqual([]);
  });

  it('reads additions against the origin/main merge base, including the working tree', () => {
    const calls = [];
    const warnings = scanTestingNotesAdvisory(root, { git: (...args) => {
      calls.push(args);
      return calls.length === 1 ? base : added;
    } });
    expect(warnings).toEqual(testingNotesAdvisory([TESTING_GUIDE]));
    expect(calls[0][1]).toEqual(['merge-base', 'origin/main', 'HEAD']);
    expect(calls[1][1]).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--text', '--unified=0', base, '--', TESTING_GUIDE]);
    expect(calls[1][2]).toMatchObject({ timeout: 5000, maxBuffer: 1024 * 1024 });
  });

  it.each(['', '@@ -1 +0,0 @@\n-old note\n'])('is silent for no additions: %s', (patch) => {
    expect(scanTestingNotesAdvisory(root, { git: (_, args) => args[0] === 'merge-base' ? base : patch })).toEqual([]);
  });

  it.each(['missing-base', 'read-failed', 'oversized'])('warns visibly with a manual fallback for %s evidence', (failure) => {
    const warnings = scanTestingNotesAdvisory(root, { git: (_, args) => {
      if (failure === 'missing-base') return '';
      if (args[0] === 'merge-base') return base;
      throw Object.assign(new Error('unreadable'), { code: failure === 'oversized' ? 'ENOBUFS' : 'EIO' });
    } });
    expect(warnings).toEqual([expect.stringContaining('Review the diff manually.')]);
  });

  it('registers the producer as warnings only in check:standards', () => {
    const checker = readFileSync(resolve(root, 'scripts/check-standards.mjs'), 'utf8');
    expect(checker).toContain('for (const message of scanTestingNotesAdvisory(ROOT)) warn(message);');
  });
});

describe('testing documentation links', () => {
  it('preserves relative testing.md anchors referenced by AGENTS and top-level agent docs on main and in the working tree', () => {
    // Pinned origin/main callers keep the check hermetic and preserve old incoming links.
    const baseline = JSON.parse(readFileSync(resolve(root, 'scripts/__tests__/fixtures/testing-notes-main-links.json'), 'utf8'));
    expect(baseline.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(baseline.references.length).toBeGreaterThan(0);
    const currentAnchors = extractAnchors(readFileSync(resolve(root, TESTING_GUIDE), 'utf8')).anchors;
    const files = ['AGENTS.md', ...readdirSync(resolve(root, 'docs/agent'))
      .filter((name) => name.endsWith('.md')).map((name) => `docs/agent/${name}`)];
    const sources = files.map((file) => [file, readFileSync(resolve(root, file), 'utf8')]);
    sources.push(...baseline.references);
    let checked = 0;
    for (const [file, text] of sources) {
      for (const match of text.matchAll(/\]\(([^\s)]*testing\.md)#([^\s)]+)\)/g)) {
        if (resolve(root, dirname(file), match[1]) !== resolve(root, TESTING_GUIDE)) continue;
        const anchor = decodeURIComponent(match[2]);
        expect(currentAnchors.has(anchor), `${file}: ${match[0]}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('keeps the static directory link valid and each topic headed and named consistently', () => {
    expect(readFileSync(resolve(root, TESTING_GUIDE), 'utf8')).toContain('(testing/README.md)');
    const directory = resolve(root, 'docs/agent/testing');
    expect(readFileSync(resolve(directory, 'README.md'), 'utf8')).toContain('not appended');
    const topics = readdirSync(directory).filter((name) => name !== 'README.md');
    expect(topics.length).toBeGreaterThanOrEqual(4);
    for (const topic of topics) {
      expect(topic).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
      expect(readFileSync(resolve(directory, topic), 'utf8')).toMatch(/^## .+\n/);
    }
  });
});
