/**
 * @file longshore-locus.test.mjs — backlog-split S1: the `longshore` repo/locus is registered, its slug comes only from
 *   the repo-names setting, it declares NO daemon capabilities, and citations remain refused by the prefix gate.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { CONSTELLATION_REPOS, PENDING_REPOS, repoKeyForDir, repoKeyForSlug, siblingKeys, repoSlugTag, repoKeyForSlugTag, canonicalizeSlug } from '../constellation-repos.mjs';
import { repoProfile, deliveryLocusForScope, repoProfileForLanePath, primaryCheckoutForLanePath } from '../repo-profile.mjs';
import { planReviewDispatch } from '../../operations/review-dispatch.mjs';
import { CROSS_REPO_LOCI, findDanglingLoci } from '../citation-check.mjs';
import { CARD_REF_RE, referralCardReadable } from '../referral-card-readable.mjs';
import { LOCI, LOCUS_NAMES, scanRepoLocusPrefixes } from '../../check-standards-rules.mjs';

const require = createRequire(import.meta.url);
const settings = JSON.parse(readFileSync('scripts/settings/repo-names.json', 'utf8'));
const SLUG = `${settings.repos.longshore.owner}/${settings.repos.longshore.name}`;

describe('longshore registry entry', () => {
  it('resolves its slug from the repo-names setting (default longshoreai/longshore)', () => {
    expect(SLUG).toBe('longshoreai/longshore');
    expect(PENDING_REPOS.longshore.slug).toBe(SLUG);
    expect(Object.isFrozen(PENDING_REPOS)).toBe(true);
    expect(repoKeyForSlug(SLUG)).toBeNull();
    expect(repoKeyForDir('longshore')).toBeNull();
  });
  it('excludes longshore from every sweep registry lookup and list while retaining its profile', () => {
    const sweepKeys = ['we', 'frontierui', 'plateau-app'];
    expect(Object.keys(CONSTELLATION_REPOS)).toEqual(sweepKeys);
    for (const selfKey of [null, 'unknown', 'longshore', ...sweepKeys]) {
      expect(siblingKeys(selfKey)).toEqual(sweepKeys.filter((key) => key !== selfKey));
    }
    expect(repoKeyForSlug(SLUG)).toBeNull();
    expect(repoKeyForSlug('longshore')).toBeNull();
    expect(repoKeyForDir('longshore')).toBeNull();
    expect(repoSlugTag('longshore')).toBeNull();
    expect(repoKeyForSlugTag('ls')).toBeNull();
    expect(canonicalizeSlug('chalbert/longshore')).toBe('chalbert/longshore');
    expect(repoProfile('longshore').key).toBe('longshore');
    for (const repo of ['longshore', SLUG]) {
      expect(() => planReviewDispatch({ pr: 1, repo, checkoutExists: () => true }))
        .toThrow(/not a constellation repo/);
    }
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
  it.each(['longshore', SLUG, 'ls', 'longshore:', `${SLUG}:`, 'ls:'])('resolves pending profile spelling %s', (input) => {
    expect(repoProfile(input, { home: '/h' })).toEqual(repoProfile('longshore', { home: '/h' }));
  });
  it('resolves pending lane profiles and primary checkout without sweep registration', () => {
    expect(repoProfileForLanePath('/lanes/longshore/lane-1', { home: '/h' }))
      .toEqual(repoProfile('longshore', { home: '/h' }));
    expect(primaryCheckoutForLanePath('/lanes/longshore/lane-1', { home: '/h' }))
      .toBe('/h/workspace/longshore');
    expect(repoProfileForLanePath('/lanes/unknown/lane-1')).toBeNull();
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
    expect(b.inferLocusFromScope(['longshore:backlog/a.md'])).toBe('longshore');
    expect(b.inferLocusFromScope(['longshoreai:backlog/a.md'])).toBeNull();
  });
});

describe('longshore cites and card refs', () => {
  it.each(['longshore', 'xlongshore2', 'ops'])('prefix gate rejects %s citations rather than silently ignoring them', (prefix) => {
    expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `cite ${prefix}:scripts/a/b.mjs:12` }]))
      .toEqual([{ file: 'backlog/x.md', count: 1, sample: 'scripts/a/b.mjs:12' }]);
  });
  it.each(['we', 'fui', 'plateau', 'webeverything', 'frontierui', 'plateau-app'])('prefix gate still accepts %s citations', (prefix) => {
    expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `cite ${prefix}:scripts/a/b.mjs:12` }])).toEqual([]);
  });
  it('longshore is NOT a cross-repo citation locus yet (no exemption added)', () => {
    expect(CROSS_REPO_LOCI.has('longshore:')).toBe(false);
    const deps = { fileExists: () => false, lineCount: () => 0 };
    expect(findDanglingLoci('cite we:scripts/a/b.mjs:12', deps).length).toBe(1);
  });
  it('longshore card refs are NOT accepted for hold release yet (fail closed)', () => {
    expect(CARD_REF_RE.test('longshore:backlog/1234-a.md@pr77')).toBe(false);
    expect(CARD_REF_RE.test('longshore:backlog/1234-a.md')).toBe(false);
    expect(CARD_REF_RE.test('we:backlog/1234-a.md@pr77')).toBe(true);
    expect(referralCardReadable('longshore:backlog/1234-a.md@pr77', '/nowhere', {
      readOnPr: () => '---\nstatus: resolved\n---\n', readMainByBornAs: () => null,
    })).toBe(false);
  });
});
