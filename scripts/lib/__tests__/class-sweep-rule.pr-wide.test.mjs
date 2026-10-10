/**
 * Card 5536 — the class sweep covers the same class ANYWHERE IN THE PR, not only the four paths around the fixed site.
 *
 * Replay: PR 4624's real fix round 1 (head 459ea6f4f). Its class-sweep block was `complete` under the four-path rule,
 * yet round 3 raised the same class ("a manual freeze is silently not honoured") in `scripts/lib/red-main-hold.mjs`, a
 * file of the same PR that no sweep row named. With the PR's changed files as a fact, the rule flags that file in the
 * same pass.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classSweepVerdict, unsweptPrFiles, MAX_PR_FILES, MAX_EVIDENCE_BYTES } from '../class-sweep-rule.mjs';

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/class-sweep-replay-4624.json'), 'utf8'));
const LATER = FX.laterFindings[0].file;

describe('class sweep — same class anywhere in the PR (replay PR 4624)', () => {
  it('before: without the PR files the real round-1 sweep reads complete (the gap)', () => {
    const v = classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence: FX.evidence });
    expect(v.status).toBe('complete');
  });

  it('after: the same sweep with the PR files flags the file round 3 found the same class in', () => {
    const v = classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence: FX.evidence, changedFiles: FX.changedFiles });
    expect(v.status).toBe('incomplete');
    expect(v.blocking).toBe(false);
    expect(v.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^F-migration: pr-unswept-\d+$/)]));
    expect(v.unswept['F-migration']).toContain(LATER);
    // Files the round-1 rows did name are not flagged.
    expect(v.unswept['F-migration']).not.toContain('scripts/merge-ai-prs.mjs');
    expect(v.unswept['F-migration']).not.toContain('scripts/readiness/red-main-remediation.mjs');
    // Backlog cards are exempt.
    expect(v.unswept['F-migration'].some((f) => f.startsWith('backlog/'))).toBe(false);
  });

  it('enforce blocks that same round', () => {
    expect(classSweepVerdict({ mode: 'enforce', changeKind: 'fix', evidence: FX.evidence, changedFiles: FX.changedFiles }).blocking).toBe(true);
  });

  it('a sweep that adds `pr` rows for every other file reads complete', () => {
    const block = FX.evidence.match(/```class-sweep\n([\s\S]*?)\n```/)[1];
    const sweep = JSON.parse(block);
    for (const f of sweep.findings) {
      const miss = unsweptPrFiles({ siblings: f.siblings }, FX.changedFiles);
      f.siblings.push({ path: 'pr', site: 'scripts/lib/__tests__/ scripts/__tests__/', status: 'checked', note: 'test files: no freeze read' });
      for (const file of miss.filter((m) => !m.includes('__tests__/'))) f.siblings.push({ path: 'pr', site: file, status: 'checked', note: 'no marker read here' });
    }
    const evidence = `\`\`\`class-sweep\n${JSON.stringify(sweep)}\n\`\`\``;
    const v = classSweepVerdict({ mode: 'enforce', changeKind: 'fix', evidence, changedFiles: FX.changedFiles });
    expect(v.problems).toEqual([]);
    expect(v.status).toBe('complete');
  });
});

describe('class sweep — PR file list edge cases', () => {
  const evidence = '```class-sweep\n' + JSON.stringify({ v: 1, findings: [{ finding: 'F1', class: 'truncated read', siblings: [
    { path: 'family', site: 'a.mjs#f', status: 'fixed', note: '' },
    { path: 'callers', site: 'b.mjs#main', status: 'checked', note: 'ok' },
    { path: 'branches', site: '', status: 'n/a', note: 'none' },
    { path: 'recovery', site: 'a.mjs#retry', status: 'checked', note: 'ok' }] }] }) + '\n```';

  it('an unreadable file list fails closed (pr-files-unknown), never complete', () => {
    const v = classSweepVerdict({ mode: 'enforce', changeKind: 'fix', evidence, changedFiles: null });
    expect(v).toMatchObject({ status: 'incomplete', reason: 'pr-files-unknown', blocking: true });
  });

  it('a list past the bound is never checked partially', () => {
    const v = classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence, changedFiles: Array.from({ length: MAX_PR_FILES + 1 }, (_, i) => `f${i}.mjs`) });
    expect(v).toMatchObject({ status: 'incomplete', reason: 'pr-files-truncated' });
  });

  it('a directory prefix row covers the files under it; the printed codes carry counts, not paths', () => {
    expect(unsweptPrFiles({ siblings: [{ site: 'a.mjs#f' }, { site: 'lib/' }] }, ['a.mjs', 'lib/x.mjs', 'lib2/y.mjs', 'backlog/1.md'])).toEqual(['lib2/y.mjs']);
    const v = classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence, changedFiles: ['a.mjs', 'b.mjs', 'c/secret-name.mjs'] });
    expect(v.problems).toEqual(['F1: pr-unswept-1']);
  });

  it('an unknown path is still refused; `pr` is the one extra path', () => {
    const bad = evidence.replace('"family"', '"elsewhere"');
    expect(classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence: bad }).problems[0]).toMatch(/unknown-path/);
  });
});

describe('class sweep — review round 2 (PR 4687): file identity is a whole path token, an empty list is unknown', () => {
  const swept = (site, files) => unsweptPrFiles({ siblings: [{ site }] }, files);

  it('file coverage requires a complete path token (a different file sharing a suffix is never swept)', () => {
    expect(swept('test/a.mjs#f', ['a.mjs'])).toEqual(['a.mjs']);
    expect(swept('docs/README.md#x', ['README.md'])).toEqual(['README.md']);
    expect(swept('packages/x/package.json#deps', ['package.json'])).toEqual(['package.json']);
    expect(swept('scripts/lib/a.mjs.orig', ['scripts/lib/a.mjs'])).toEqual(['scripts/lib/a.mjs']);
    expect(swept('src/index.mjs', ['index.mjs'])).toEqual(['index.mjs']);
    expect(swept('Makefile.bak', ['Makefile'])).toEqual(['Makefile']);
    expect(swept('xa.mjs#f', ['a.mjs'])).toEqual(['a.mjs']);
    // A file merely mentioned inside a longer free-text token is not named either.
    expect(swept('see-a.mjs-note', ['a.mjs'])).toEqual(['a.mjs']);
  });

  it('a site still names its file in every honest spelling', () => {
    expect(swept('a.mjs#f/g', ['a.mjs'])).toEqual([]);
    expect(swept('./a.mjs', ['a.mjs'])).toEqual([]);
    expect(swept('a.mjs:12', ['a.mjs'])).toEqual([]);
    expect(swept('a.mjs:12-30', ['a.mjs'])).toEqual([]);
    expect(swept('lib/a.mjs#f + lib/b.mjs#g, lib/c.mjs; (lib/d.mjs)', ['lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs', 'lib/d.mjs'])).toEqual([]);
    expect(swept('`lib/a.mjs`#f', ['lib/a.mjs'])).toEqual([]);
    expect(swept('./lib/', ['lib/x.mjs'])).toEqual([]);
  });

  it('a `#` or `:` tail never turns a file spelling into a directory prefix', () => {
    const files = ['scripts/a.mjs', 'scripts/b.mjs'];
    for (const site of ['scripts/#x/', 'scripts/:1', 'scripts/#/', 'x/ scripts/#', 'scripts/#x']) expect(swept(site, files)).toEqual(files);
    expect(swept('scripts/', files)).toEqual([]);
  });

  it('honest spellings (we: tag, trailing punctuation, markdown, :line:col, ::fn) name the file; both sides are normalized alike', () => {
    for (const site of ['we:scripts/a.mjs', 'scripts/a.mjs.', 'scripts/a.mjs,', '*scripts/a.mjs*', '“scripts/a.mjs”', 'scripts/a.mjs:12:5', 'scripts/a.mjs:L12', 'scripts/a.mjs::fn', 'scripts/a.mjs:fn()']) {
      expect(swept(site, ['scripts/a.mjs'])).toEqual([]);
    }
    expect(swept('scripts/a.mjs', ['./scripts/a.mjs', 'we:scripts/a.mjs'])).toEqual([]);
    // Different case or a different directory stays a different file.
    expect(swept('Scripts/a.mjs', ['scripts/a.mjs'])).toEqual(['scripts/a.mjs']);
  });

  it('truncated evidence is never complete, even when one block survives (padding hides a second block)', () => {
    const block = '```class-sweep\n' + JSON.stringify({ v: 1, findings: [{ finding: 'F1', class: 'c', siblings: ['family', 'callers', 'branches', 'recovery'].map((path) => ({ path, site: 'a.mjs#f', status: 'checked', note: 'ok' })) }] }) + '\n```\n';
    const padded = `${block}${'z'.repeat(MAX_EVIDENCE_BYTES)}\n${block}`;
    expect(classSweepVerdict({ mode: 'enforce', changeKind: 'fix', evidence: padded })).toMatchObject({ status: 'incomplete', reason: 'evidence-truncated', blocking: true });
    // Multibyte: fewer characters than the bound, more bytes than it.
    const wide = `${block}${'é'.repeat(MAX_EVIDENCE_BYTES / 2)}x`;
    expect(classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence: wide }).reason).toBe('evidence-truncated');
    expect(classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence: block }).status).toBe('complete');
  });

  it('an empty changed-file list is unknown, never complete (even for enforce)', () => {
    const evidence = '```class-sweep\n' + JSON.stringify({ v: 1, findings: [{ finding: 'F1', class: 'c', siblings: [
      { path: 'family', site: 'a.mjs#f', status: 'fixed', note: '' },
      { path: 'callers', site: 'a.mjs#g', status: 'checked', note: 'ok' },
      { path: 'branches', site: '', status: 'n/a', note: 'none' },
      { path: 'recovery', site: '', status: 'n/a', note: 'none' }] }] }) + '\n```';
    expect(classSweepVerdict({ mode: 'enforce', changeKind: 'fix', evidence, changedFiles: [] })).toMatchObject({ status: 'incomplete', reason: 'pr-files-unknown', blocking: true });
    // Only blank / non-string entries are as good as empty.
    expect(classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence, changedFiles: ['', '  ', 7] }).reason).toBe('pr-files-unknown');
    // Only backlog cards changed: the list is known and nothing needs a row.
    expect(classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence, changedFiles: ['backlog/1-x.md'] }).status).toBe('complete');
  });
});
