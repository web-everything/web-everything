// @repo-scanning-test scope=full — verifies the numbered guide against its pinned source.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import MarkdownIt from 'markdown-it';
import { extractAnchors } from '../lib/rules-loader.cjs';
import { dirname, relative, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { joinTestingNotes, readTestingNotes } from '../lib/testing-notes-join.mjs';

const root = resolve(import.meta.dirname, '../..');
const baseline = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/testing-notes-split-baseline.json'), 'utf8'));
const fragment = (name, text) => ({ name, text });

const markdown = new MarkdownIt();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Parse the entire body, including reference links, images and nested inline tokens.
function brokenLinks(file, text, repo = root) {
  const failures = [];
  function visit(tokens) {
    for (const token of tokens) {
      const href = token.attrGet('href') ?? token.attrGet('src');
      if (href && !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) {
        const [path, anchor] = href.split('#');
        const target = resolve(repo, dirname(file), decodeURIComponent(path));
        if (relative(repo, target).startsWith('..') || !existsSync(target)) failures.push(`${file}: missing ${href}`);
        else if (anchor && path.endsWith('.md') && (!statSync(target).isFile()
          || !extractAnchors(readFileSync(target, 'utf8')).anchors.has(decodeURIComponent(anchor)))) {
          failures.push(`${file}: missing anchor ${href}`);
        }
      }
      if (token.children) visit(token.children);
    }
  }
  visit(markdown.parse(text, {}));
  return failures;
}

function requireBaseline(git, skip = process.env.TESTING_SPLIT_BASELINE_SKIP) {
  try { git(); return true; }
  catch (error) {
    if (skip === '1') return false;
    throw new Error(`Pinned commit ${baseline.sha} is unreachable; restore local history or set TESTING_SPLIT_BASELINE_SKIP=1.`, { cause: error });
  }
}

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

  it('reports repeated subheadings within one fragment', () => {
    expect(joinTestingNotes([fragment('a.md', '## One\n### Same\n### Same\n')]).warnings)
      .toEqual([expect.stringMatching(/duplicate.*same.*a.md.*a.md/i)]);
  });

  it('checks relative links and markdown anchors throughout every fragment body', () => {
    const directory = 'docs/agent/testing.d';
    const failures = readdirSync(resolve(root, directory)).filter((name) => name.endsWith('.md'))
      .flatMap((name) => brokenLinks(`${directory}/${name}`, readFileSync(resolve(root, directory, name), 'utf8')));
    expect(failures).toEqual([]);
  });

  it('reports a synthetic broken body link, reference link and missing anchor', () => {
    const text = '## Synthetic\n\n[broken](missing.md)\n\n[reference][bad]\n\n[bad]: absent.md\n\n[anchor](../testing.md#absent-anchor)';
    expect(brokenLinks('docs/agent/testing.d/synthetic.md', text)).toEqual([
      expect.stringContaining('missing.md'), expect.stringContaining('absent.md'), expect.stringContaining('absent-anchor'),
    ]);
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

  it('fails closed for an unreachable baseline unless the explicit override is 1', () => {
    const missing = () => { throw new Error('missing commit'); };
    expect(() => requireBaseline(missing, '')).toThrow(/TESTING_SPLIT_BASELINE_SKIP=1/);
    expect(() => requireBaseline(missing, 'true')).toThrow(/unreachable/);
    expect(requireBaseline(missing, '1')).toBe(false);
    expect(requireBaseline(() => {}, '')).toBe(true);
  });

  it('losslessly preserves every original section from fragment bytes without git', () => {
    const directory = resolve(root, 'docs/agent/testing.d');
    const files = readdirSync(directory).filter((name) => /^\d{3}-/.test(name)).sort();
    expect(files).toEqual(baseline.sections.map(({ file }) => file));
    const restored = baseline.sections.map(({ file, sha256: expected, links }) => {
      let text = readFileSync(resolve(directory, file), 'utf8');
      // Only URL relocation is allowed; all other original bytes remain pinned.
      for (const { original, relocated } of links) text = text.replaceAll(`](${relocated})`, `](${original})`);
      expect(sha256(text), file).toBe(expected);
      return fragment(file, text);
    });
    expect(sha256(joinTestingNotes(restored).text)).toBe(baseline.bodySha256);
    expect(readTestingNotes(root).text).toContain('## Red-main timeout policy');
  });

  it('requires the pinned commit unless the explicit baseline override is set', () => {
    requireBaseline(() => execFileSync('git', ['cat-file', '-e', baseline.sha + '^{commit}'], { cwd: root, stdio: 'pipe' }));
  });
});
