/**
 * @file trust-chain-tier.test.mjs — pins the trust-chain tier predicate (scripts/lib/trust-chain-tier.mjs, #2875)
 * and proves the tier is actually INSTRUMENTED: the real `vitest.config.ts` coverage allowlist carries every tier
 * file, so the per-diff coverage floor (#2876) has something to attribute.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRUST_CHAIN_TIER_FILES,
  TIER_ADDITIONS,
  isTrustChainTier,
  normalizeTierPath,
} from '../trust-chain-tier.mjs';
import { TRUST_CHAIN, isTrustChainPath } from '../gate-config.mjs';
import vitestConfig from '../../../vitest.config.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('TRUST_CHAIN_TIER_FILES — the in-scope set (#2875)', () => {
  it('pins the current tier membership (a change to the set must be a visible diff here)', () => {
    expect([...TRUST_CHAIN_TIER_FILES]).toEqual([
      'scripts/lib/auto-land-seam.mjs',
      'scripts/lib/disposition-judge.mjs',
      'scripts/lib/disposition-land-seam.mjs',
      'scripts/lib/drain-workflow-edit-hold.mjs',
      'scripts/lib/gate-config.mjs',
      'scripts/lib/review-core.mjs',
      'scripts/lib/review-escalation.mjs',
      'scripts/lib/review-independence.mjs',
      'scripts/lib/review-policy.mjs',
      'scripts/lib/review-runner-core.mjs',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(TRUST_CHAIN_TIER_FILES)).toBe(true);
    expect(Object.isFrozen(TIER_ADDITIONS)).toBe(true);
  });

  it('every tier file exists on disk (a moved/renamed member cannot leave a dead coverage entry)', () => {
    for (const f of TRUST_CHAIN_TIER_FILES) expect(existsSync(resolve(REPO_ROOT, f)), f).toBe(true);
  });

  it('is derived from the roster: every roster home that is scripts/lib/ JS source is in the tier', () => {
    const rosterLibSources = TRUST_CHAIN.flatMap((m) => m.homes)
      .filter((h) => h.startsWith('scripts/lib/') && h.endsWith('.mjs') && !h.includes('/__tests__/'));
    expect(rosterLibSources.length).toBeGreaterThan(0);
    for (const h of rosterLibSources) expect(isTrustChainTier(h), h).toBe(true);
  });

  it('excludes roster homes that are not instrumentable tier source (JSON contract, test suites, outside scripts/lib/)', () => {
    expect(isTrustChainTier('scripts/lib/review-policy.contract.json')).toBe(false);
    expect(isTrustChainTier('scripts/lib/__tests__/gate-invariants.test.mjs')).toBe(false);
    expect(isTrustChainTier('scripts/lib/__tests__/review-policy.conformance.test.mjs')).toBe(false);
    expect(isTrustChainTier('scripts/merge-ai-prs.mjs')).toBe(false);
    expect(isTrustChainTier('scripts/conveyor/tick-core.mjs')).toBe(false);
    expect(isTrustChainTier('plateau-app/tools/drain-daemon/daemon.mjs')).toBe(false);
  });

  it('includes the epic-named disposition judge even though the escalation roster does not register it', () => {
    expect(isTrustChainPath('scripts/lib/disposition-judge.mjs')).toBe(false);
    expect(isTrustChainTier('scripts/lib/disposition-judge.mjs')).toBe(true);
  });
});

describe('isTrustChainTier — exact normalized-path match, never basename', () => {
  it('matches a plain repo-relative member path', () => {
    expect(isTrustChainTier('scripts/lib/review-core.mjs')).toBe(true);
  });

  it('accepts the we: locus prefix, a leading ./, Windows separators, and interior dot segments', () => {
    expect(isTrustChainTier('we:scripts/lib/review-core.mjs')).toBe(true);
    expect(isTrustChainTier('./scripts/lib/review-core.mjs')).toBe(true);
    expect(isTrustChainTier('scripts\\lib\\review-core.mjs')).toBe(true);
    expect(isTrustChainTier('scripts/lib/__tests__/../review-core.mjs')).toBe(true);
    expect(isTrustChainTier('  scripts/lib/review-core.mjs  ')).toBe(true);
  });

  it('rejects a same-basename file elsewhere (unlike the basename-matched escalation roster)', () => {
    expect(isTrustChainPath('scripts/review-core.mjs')).toBe(true);
    expect(isTrustChainTier('scripts/review-core.mjs')).toBe(false);
    expect(isTrustChainTier('review-core.mjs')).toBe(false);
    expect(isTrustChainTier('frontierui/scripts/lib/review-core.mjs')).toBe(false);
  });

  it("rejects a member's own test file and other scripts/lib/ files", () => {
    expect(isTrustChainTier('scripts/lib/__tests__/review-core.test.mjs')).toBe(false);
    expect(isTrustChainTier('scripts/lib/judge-panel.mjs')).toBe(false);
    expect(isTrustChainTier('scripts/lib/trust-chain-tier.mjs')).toBe(false);
  });

  it('rejects a foreign locus prefix, absolute paths, and paths escaping the repo root', () => {
    expect(isTrustChainTier('fui:scripts/lib/review-core.mjs')).toBe(false);
    expect(isTrustChainTier('plateau-app:scripts/lib/review-core.mjs')).toBe(false);
    expect(isTrustChainTier('/scripts/lib/review-core.mjs')).toBe(false);
    expect(isTrustChainTier(resolve(REPO_ROOT, 'scripts/lib/review-core.mjs'))).toBe(false);
    expect(isTrustChainTier('../scripts/lib/review-core.mjs')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isTrustChainTier('scripts/lib/Review-Core.mjs')).toBe(false);
  });

  it('rejects non-string and empty input without throwing', () => {
    for (const bad of [undefined, null, 42, {}, [], '', '   ', '.', '..', 'we:']) {
      expect(isTrustChainTier(bad)).toBe(false);
    }
  });
});

describe('normalizeTierPath', () => {
  it('returns the repo-relative WE form or null', () => {
    expect(normalizeTierPath('we:./scripts//lib/x.mjs')).toBe('scripts/lib/x.mjs');
    expect(normalizeTierPath('fui:blocks/x.ts')).toBeNull();
    expect(normalizeTierPath('C:\\repo\\x.mjs')).toBeNull();
    expect(normalizeTierPath('a/../../x')).toBeNull();
  });
});

describe('coverage instrumentation — the real vitest.config.ts allowlist carries the tier (#2875)', () => {
  const include = vitestConfig.test.coverage.include;

  it('lists every tier file in coverage.include', () => {
    for (const f of TRUST_CHAIN_TIER_FILES) expect(include, f).toContain(f);
  });

  it('adds only the tier from scripts/ — the rest of scripts/ stays outside the #2082 allowlist', () => {
    const scriptsEntries = include.filter((g) => g.startsWith('scripts/'));
    expect([...scriptsEntries].sort()).toEqual([...TRUST_CHAIN_TIER_FILES]);
  });

  it('keeps the tier files out of coverage.exclude', () => {
    const exclude = vitestConfig.test.coverage.exclude;
    for (const f of TRUST_CHAIN_TIER_FILES) expect(exclude).not.toContain(f);
  });
});
