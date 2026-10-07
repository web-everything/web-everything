/** @file pr-comment-read-guard.test.mjs — truncated PR comment read baseline ratchet (item 88). */
/** @repo-scanning-test scope=files — see scripts/lib/repo-scan-tests.mjs. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readGit } from '../proc-read.mjs';
import { scanRoot, scanScope } from '../repo-scan-tests.mjs';
import { findTruncatedCommentReads, checkBaseline, isCommentReadSource } from '../pr-comment-read-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts/pr-comment-read-baseline.json'), 'utf8'));

function trackedSourceFiles() {
  const scope = scanScope();
  if (scope) return [...scope].filter(isCommentReadSource).filter((f) => existsSync(join(scanRoot(ROOT), f)));
  return readGit(['ls-files', '-z', 'scripts', 'skills-src'], { cwd: ROOT }).split('\0').filter(isCommentReadSource);
}

describe('truncated PR comment read detector', () => {
  it.each([
    ["gh(['pr', 'view', '1', '--json', 'comments'])", 'json-comments'],
    ["['pr', 'list', '--json', 'number,labels,comments']", 'json-comments'],
    ['gh pr view ${pr} --json comments --jq x', 'json-comments'],
    ["run('gh pr list --json=number,comments')", 'json-comments'],
    ['query { pullRequest { comments(first: 100) { nodes { body } } } }', 'graphql-comments'],
    ["gh(`repos/${slug}/issues/${pr}/comments`)", 'rest-unpaginated'],
  ])('flags %s', (src, kind) => {
    expect(findTruncatedCommentReads(`// intro\n${src}`)).toMatchObject([{ line: 2, kind }]);
  });

  it.each([
    "gh(['pr', 'view', '1', '--json', 'number,body'])",
    "// gh pr view --json comments\n/* comments(first: 100) */\n/**\n * --json comments\n */",
    "gh(['api', '--paginate', `repos/${s}/issues/${n}/comments`])",
    "ghJson(`repos/o/n/issues/${n}/comments`, { paginate: true })",
    "readCompletePrComments(7, { repo })",
  ])('ignores %s', (src) => {
    expect(findTruncatedCommentReads(src)).toEqual([]);
  });

  it('is red on a fixture adding a bare --json comments read to a clean file', () => {
    const clean = { 'scripts/new.mjs': 0 };
    const count = findTruncatedCommentReads("const v = gh(['pr', 'view', n, '--json', 'comments']);").length;
    expect(checkBaseline({ 'scripts/new.mjs': count }, clean).regressions).toEqual([{ file: 'scripts/new.mjs', count: 1, allowed: 0 }]);
  });

  it('scans production sources only and exempts the helper modules', () => {
    expect(isCommentReadSource('scripts/conveyor/x.mjs')).toBe(true);
    for (const f of ['scripts/a.test.mjs', 'scripts/__tests__/a.mjs', 'scripts/conveyor/pr-comments-complete.mjs', 'scripts/lib/pr-comment-read-guard.mjs', 'src/a.js']) {
      expect(isCommentReadSource(f), f).toBe(false);
    }
  });
});

describe('tracked-source comment-read ratchet', () => {
  it('has no per-file regressions and the baseline equals a fresh scan', () => {
    const counts = {};
    for (const file of trackedSourceFiles()) {
      const n = findTruncatedCommentReads(readFileSync(join(scanRoot(ROOT), file), 'utf8')).length;
      if (n) counts[file] = n;
    }
    expect(checkBaseline(counts, baseline).regressions).toEqual([]);
    if (!scanScope()) {
      expect(counts, 'Regenerate with node scripts/lib/pr-comment-read-guard.mjs --write-baseline after improvements').toEqual(baseline);
    }
  });
});
