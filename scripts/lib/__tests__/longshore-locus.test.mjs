/**
 * @file longshore-locus.test.mjs — backlog-split S1: the `longshore` repo/locus is registered, its slug comes only from
 *   the repo-names setting, it declares NO daemon capabilities, and the widened prefix regexes accept `longshore:` only.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { CONSTELLATION_REPOS, repoKeyForDir, repoKeyForSlug } from '../constellation-repos.mjs';
import { repoProfile, deliveryLocusForScope } from '../repo-profile.mjs';
import { CROSS_REPO_LOCI, findDanglingLoci } from '../citation-check.mjs';
import { CARD_REF_RE, referralCardReadable } from '../referral-card-readable.mjs';
import { LOCI, LOCUS_NAMES, LOCUS_MARKER_RE } from '../../check-standards-rules.mjs';

const require = createRequire(import.meta.url);
const settings = JSON.parse(readFileSync('scripts/settings/repo-names.json', 'utf8'));
const SLUG = `${settings.repos.longshore.owner}/${settings.repos.longshore.name}`;

describe('longshore registry entry', () => {
  it('resolves its slug from the repo-names setting (default longshoreai/longshore)', () => {
    expect(SLUG).toBe('longshoreai/longshore');
    expect(CONSTELLATION_REPOS.longshore.slug).toBe(SLUG);
    expect(repoKeyForSlug(SLUG)).toBe('longshore');
    expect(repoKeyForDir('longshore')).toBe('longshore');
  });
  it('never hard-codes the slug in the registry source', () => {
    const src = readFileSync('scripts/lib/constellation-repos.mjs', 'utf8');
    expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/longshoreai/);
  });
  it('profile: home-relative path, prefixes, and NO daemon capabilities', () => {
    const p = repoProfile('longshore', { home: '/h' });
    expect(p.slug).toBe(SLUG);
    expect(p.checkoutPath).toBe('/h/workspace/longshore');
    expect(p.scopePrefixes).toEqual(['longshore']);
    expect(p.canonicalPrefix).toBe('longshore');
    expect(p.capabilities).toEqual({ review: false, fix: false, ciHeal: false, build: 'none' });
    expect(repoProfile('longshore:', { home: '/h' }).key).toBe('longshore');
  });
  it('does not resolve junk prefixes', () => {
    for (const j of ['longshor', 'longshoreai', 'longshore2', 'xlongshore', 'long']) expect(repoProfile(j)).toBeNull();
  });
  it('scope routing and locus table', () => {
    expect(deliveryLocusForScope('longshore:backlog/x.md')).toEqual({ multiRepo: false, keys: ['longshore'] });
    expect(LOCI.longshore.commitTarget).toBe('longshore');
    expect(LOCUS_NAMES.has('longshore')).toBe(true);
  });
  it('backlog loader maps longshore: scope to the longshore locus only', () => {
    const b = require('../../../src/_data/backlog.js');
    expect(b.inferLocusFromScope('longshore:backlog/a.md')).toBe('longshore');
    expect(b.inferLocusFromScope('longshoreai:backlog/a.md')).toBeNull();
  });
});

describe('longshore cites and card refs', () => {
  it('LOCUS_MARKER_RE accepts longshore: and rejects junk', () => {
    expect(LOCUS_MARKER_RE.test('see longshore:')).toBe(true);
    expect(LOCUS_MARKER_RE.test('see xlongshore2:')).toBe(false);
    expect(LOCUS_MARKER_RE.test('see ops:')).toBe(false);
  });
  it('longshore: is a cross-repo locus, never errored as dangling', () => {
    expect(CROSS_REPO_LOCI.has('longshore:')).toBe(true);
    const deps = { fileExists: () => false, lineCount: () => 0 };
    expect(findDanglingLoci('cite longshore:scripts/a/b.mjs:12', deps)).toEqual([]);
    expect(findDanglingLoci('cite we:scripts/a/b.mjs:12', deps).length).toBe(1);
  });
  it('CARD_REF_RE parses longshore card refs, still rejects junk', () => {
    expect(CARD_REF_RE.test('longshore:backlog/1234-a.md@pr77')).toBe(true);
    expect(CARD_REF_RE.test('longshore:backlog/1234-a.md')).toBe(true);
    expect(CARD_REF_RE.test('we:backlog/1234-a.md@pr77')).toBe(true);
    for (const bad of ['ops:backlog/1.md', 'longshoreai:backlog/1.md', 'longshore:backlog/../x.md', 'longshore:backlog/a.md@pr0', 'longshore:docs/a.md']) {
      expect(CARD_REF_RE.test(bad)).toBe(false);
    }
  });
  it('a longshore PR card ref reads from the longshore slug, not WE', () => {
    const seen = [];
    const ok = referralCardReadable('longshore:backlog/1234-a.md@pr77', '/nowhere', {
      readOnPr: (file, pr, o) => { seen.push([file, pr, o]); return '---\nstatus: open\n---\n'; },
      readMainByBornAs: () => null,
    });
    expect(ok).toBe(true);
    expect(seen[0].slice(0, 2)).toEqual(['1234-a.md', '77']);
    expect(seen[0][2]?.repo).toBe(SLUG);
  });
});
