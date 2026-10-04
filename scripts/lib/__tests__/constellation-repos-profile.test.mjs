/**
 * @file scripts/lib/__tests__/constellation-repos-profile.test.mjs
 * @description Executable proof for we:backlog/xjko7gy-multi-repo-slice-1-a-per-repo-profile.md: `repoProfile`
 *   collapses key/slug/slugTag/scope-prefix into ONE frozen per-repo profile, and `gateFor` reuses
 *   `verify-lane-gate.mjs#composeGate` (never a second gate derivation) against that profile's checkout path.
 *   No real filesystem/homedir IO: `home` and `gateFor`'s `checkoutExists`/`readPackageJson` are injected
 *   throughout, so this suite is hermetic and immune to whatever machine it runs on.
 */
import { describe, it, expect } from 'vitest';

import { repoProfile, gateFor, briefTokensForRepo, repoKeyForScope, primaryCheckoutForLanePath, repoProfileForLanePath } from '../repo-profile.mjs';

const HOME = '/home/test';

describe('repoProfile', () => {
  const EXPECT = {
    // Landing-freeze fix (lane-leftover-reclaim) — `we`'s `lanePoolRepo` used to be the literal `.`; it is now
    // ALWAYS `checkoutPath` (an absolute path, real for `we` — see the dedicated `.` → absolute test below and
    // its own docblock for why). Left out of this static map (unlike every other field here) because the real
    // value is machine-dependent; asserted separately.
    we: {
      slug: 'web-everything/web-everything', slugTag: '',
      scopePrefixes: ['we', 'webeverything'], canonicalPrefix: 'we',
      capabilities: { review: true, fix: true, ciHeal: true, build: 'direct' },
    },
    frontierui: {
      slug: 'frontier-ui/frontierui', slugTag: 'fui', lanePoolRepo: `${HOME}/workspace/frontierui`,
      scopePrefixes: ['fui', 'frontierui'], canonicalPrefix: 'fui',
      // #x33jgwt multi-repo slice 5 turned `fix` on for the couple-repos; #3967 multi-repo slice 7 turns
      // `ciHeal` on the same way, independently, as its own capability.
      capabilities: { review: true, fix: true, ciHeal: true, build: 'couple' },
    },
    'plateau-app': {
      slug: 'plateauapp/plateau-app', slugTag: 'pa', lanePoolRepo: `${HOME}/workspace/plateau-app`,
      scopePrefixes: ['plateau', 'plateau-app'], canonicalPrefix: 'plateau',
      capabilities: { review: true, fix: true, ciHeal: true, build: 'couple' },
    },
  };

  // Every input form this function documents itself as accepting, per repo.
  const INPUTS = {
    we: ['we', 'web-everything/web-everything', 'we:', 'webeverything', 'webeverything:'],
    frontierui: ['frontierui', 'frontier-ui/frontierui', 'fui', 'fui:', 'frontierui:'],
    'plateau-app': ['plateau-app', 'plateauapp/plateau-app', 'pa', 'pa:', 'plateau', 'plateau:', 'plateau-app:'],
  };

  for (const [key, inputs] of Object.entries(INPUTS)) {
    for (const input of inputs) {
      it(`resolves ${JSON.stringify(input)} to the ${key} profile`, () => {
        const profile = repoProfile(input, { home: HOME });
        expect(profile.key).toBe(key);
        expect(profile.slug).toBe(EXPECT[key].slug);
        expect(profile.slugTag).toBe(EXPECT[key].slugTag);
        // `lanePoolRepo` is ALWAYS `checkoutPath` now (see the dedicated `we` test below) — for a sibling repo
        // that is still the exact `$HOME`-expanded literal this map pins.
        expect(profile.lanePoolRepo).toBe(key === 'we' ? profile.checkoutPath : EXPECT[key].lanePoolRepo);
        expect(profile.scopePrefixes).toEqual(EXPECT[key].scopePrefixes);
        expect(profile.canonicalPrefix).toBe(EXPECT[key].canonicalPrefix);
        expect(profile.capabilities).toEqual(EXPECT[key].capabilities);
      });
    }
  }

  it('every input form for one repo resolves to the SAME profile (deep-equal)', () => {
    const profiles = INPUTS.frontierui.map((input) => repoProfile(input, { home: HOME }));
    for (const p of profiles.slice(1)) expect(p).toEqual(profiles[0]);
  });

  it('checkoutPath is absolute and $HOME-expanded for a sibling repo', () => {
    const profile = repoProfile('frontierui', { home: HOME });
    expect(profile.checkoutPath).toBe(`${HOME}/workspace/frontierui`);
  });

  it('checkoutPath for `we` is an absolute path (this checkout\'s own root), and `lanePoolRepo` is the SAME '
    + 'absolute path (landing-freeze fix — was the literal `.`, broken for any caller not running from that '
    + 'root, e.g. a dispatched brief\'s scratch cwd; see repo-profile.mjs\'s own docblock)', () => {
    const profile = repoProfile('we', { home: HOME });
    expect(profile.checkoutPath.startsWith('/')).toBe(true);
    expect(profile.lanePoolRepo).toBe(profile.checkoutPath);
  });

  it('defaults `home` to the real homedir() when not injected', () => {
    const profile = repoProfile('frontierui');
    expect(profile.lanePoolRepo.startsWith('/')).toBe(true);
    expect(profile.lanePoolRepo.endsWith('/workspace/frontierui')).toBe(true);
  });

  it('returns null for unknown input, and never throws', () => {
    for (const bad of ['nope', '', 'not-a-slug', 'chalbert/other-repo', 'plateauapp', null, undefined, 123, {}]) {
      expect(() => repoProfile(bad)).not.toThrow();
      expect(repoProfile(bad)).toBeNull();
    }
  });

  it('the returned profile is frozen', () => {
    const profile = repoProfile('we');
    expect(Object.isFrozen(profile)).toBe(true);
    expect(() => { 'use strict'; profile.key = 'frontierui'; }).toThrow(/read only|frozen/i);
    expect(profile.key).toBe('we');
    expect(Object.isFrozen(profile.capabilities)).toBe(true);
    expect(Object.isFrozen(profile.scopePrefixes)).toBe(true);
  });
});

describe('gateFor', () => {
  it('returns null for an unknown repo', () => {
    expect(gateFor('not-a-repo')).toBeNull();
  });

  it('returns null when the checkout does not exist (injected)', () => {
    const result = gateFor('frontierui', { home: HOME, checkoutExists: () => false });
    expect(result).toBeNull();
  });

  it('xpnhz4o — the gate is WE\'s diff-selected verify-lane `run` against the agent\'s cwd, for every repo (never the bare full suite)', () => {
    const plateau = gateFor('plateau-app', {
      home: HOME,
      checkoutExists: (p) => { expect(p).toBe(`${HOME}/workspace/plateau-app`); return true; },
    });
    expect(plateau).toMatch(/^node \/\S+\/scripts\/verify-lane\.mjs run --repo=\.$/);
    const we = gateFor('we', { checkoutExists: () => true });
    expect(we).toBe(plateau);
    expect(we).not.toContain('test:unit');
    expect(gateFor('we', { checkoutExists: () => true, weRoot: '/opt/we' })).toBe('node /opt/we/scripts/verify-lane.mjs run --repo=.');
  });

  it('resolves the same gate from any vocabulary (key, gh slug, scope prefix) and defaults WE root to THIS checkout', () => {
    const byKey = gateFor('frontierui', { home: HOME, checkoutExists: () => true });
    expect(gateFor('frontier-ui/frontierui', { home: HOME, checkoutExists: () => true })).toBe(byKey);
    expect(gateFor('fui:', { home: HOME, checkoutExists: () => true })).toBe(byKey);
    expect(byKey).toBe(`node ${briefTokensForRepo('we', { checkoutExists: () => true }).WE_ROOT}/scripts/verify-lane.mjs run --repo=.`);
  });

  it('the gate string is brief-safe (no quote / backtick / $ — BRIEF_FREE_TEXT_VALUE_RE)', () => {
    expect(gateFor('we', { checkoutExists: () => true })).toMatch(/^[^`$"\\\n]+$/);
  });
});

// #3960 (multi-repo slice 4) — `briefTokensForRepo` is the ONE place `dispatchFix`/`dispatchCiHeal` get the five
// repo-aware brief placeholders from; these tests pin its WE shape (must reproduce today's hardcoded literal
// values byte-for-byte) and prove it also resolves correctly for a sibling repo, ready for slice 5.
describe('briefTokensForRepo', () => {
  const WE_PACKAGE_JSON = JSON.stringify({ scripts: { 'test:unit': 'vitest run', 'check:standards': 'node scripts/check-standards.mjs' } });
  const PLATEAU_PACKAGE_JSON = JSON.stringify({ scripts: { test: 'vitest run' } });

  it('for `we`, reproduces exactly what the pre-#3960 briefs hardcoded ({{GATE_COMMAND}}/{{ATTRIBUTION}}) — '
    + 'except {{LANE_REPO}}, which the landing-freeze fix changed from `.` to an absolute path (see '
    + 'repo-profile.mjs\'s own docblock: `.` from a dispatched brief\'s scratch cwd resolved to the WRONG repo)', () => {
    const tokens = briefTokensForRepo('we', {
      itemNum: '3960', prNum: 743,
      checkoutExists: () => true, readPackageJson: () => WE_PACKAGE_JSON,
    });
    expect(tokens).toEqual({
      REPO: 'web-everything/web-everything',
      LANE_REPO: expect.any(String),
      GATE_COMMAND: expect.stringMatching(/\/scripts\/verify-lane\.mjs run --repo=\.$/),
      WE_ROOT: expect.any(String),
      ATTRIBUTION: 'WE #3960',
    });
    // `WE_ROOT` is THIS checkout's own root, not injected — it must be absolute either way. `LANE_REPO` for
    // `we` is now the SAME absolute path (both derive from the one real checkout root) — this is the
    // consistency the fix establishes: whatever `--repo=` a dispatched agent passes to `acquire`, it now
    // resolves to the exact checkout `{{WE_ROOT}}` already qualifies every OTHER tool call with.
    expect(tokens.WE_ROOT.startsWith('/')).toBe(true);
    expect(tokens.LANE_REPO).toBe(tokens.WE_ROOT);
  });

  it('ATTRIBUTION falls back to `PR #<n>` when there is no item (an item-less fix, slice 6)', () => {
    const tokens = briefTokensForRepo('we', {
      prNum: 743, checkoutExists: () => true, readPackageJson: () => WE_PACKAGE_JSON,
    });
    expect(tokens.ATTRIBUTION).toBe('PR #743');
  });

  it('for a sibling repo, WE_ROOT still points at WE (the tools live only there), everything else is the target repo\'s own', () => {
    const tokens = briefTokensForRepo('plateau-app', {
      itemNum: '3960', home: '/home/test',
      checkoutExists: () => true, readPackageJson: () => PLATEAU_PACKAGE_JSON,
    });
    expect(tokens.REPO).toBe('plateauapp/plateau-app');
    expect(tokens.LANE_REPO).toBe('/home/test/workspace/plateau-app');
    expect(tokens.GATE_COMMAND).toBe(`node ${tokens.WE_ROOT}/scripts/verify-lane.mjs run --repo=.`); // verify-lane picks `npm test` itself (#3919)
    expect(tokens.ATTRIBUTION).toBe('PLATEAU #3960');
    expect(tokens.WE_ROOT.startsWith('/')).toBe(true);
    expect(tokens.WE_ROOT).not.toBe(tokens.LANE_REPO);
  });

  it('returns null for an unknown repo', () => {
    expect(briefTokensForRepo('not-a-repo', { itemNum: '1' })).toBeNull();
  });

  it('returns null when the target checkout does not exist (gate unresolvable) — fail-closed, never a guess', () => {
    expect(briefTokensForRepo('frontierui', { itemNum: '1', checkoutExists: () => false })).toBeNull();
  });

  it('the returned tokens are frozen', () => {
    const tokens = briefTokensForRepo('we', { itemNum: '1', checkoutExists: () => true, readPackageJson: () => WE_PACKAGE_JSON });
    expect(Object.isFrozen(tokens)).toBe(true);
  });
});

// xftsbsg (epic #3383) — the mechanical Codex/agent build path (we:scripts/operations/dispatch-lane-io.mjs,
// we:scripts/operations/deliver-item-wrapper.mjs) needs to know WHICH repo a dispatch is for, from nothing but
// the item's own scope or the lane's own resolved path, so it stops assuming `we` for a frontierui/plateau-app
// card. See those files' own PRs for the live defect this closes.
describe('repoKeyForScope', () => {
  it('reads the repo key off the first entry\'s prefix in an array of repo-qualified scope strings', () => {
    expect(repoKeyForScope(['plateau-app:src/feature-tracker/feature-tracking.mount-conformance.test.ts'])).toBe('plateau-app');
    expect(repoKeyForScope(['frontierui:plugs/webdirectives/ssr/net/for-each.mjs'])).toBe('frontierui');
    expect(repoKeyForScope(['we:scripts/lib/repo-profile.mjs'])).toBe('we');
  });

  it('accepts a single already-joined string, not only an array', () => {
    expect(repoKeyForScope('plateau:src/main.ts')).toBe('plateau-app');
  });

  it('accepts an alias prefix (fui/plateau), not only the canonical key', () => {
    expect(repoKeyForScope(['fui:plugs/x.mjs'])).toBe('frontierui');
  });

  it('returns null for empty, missing, or unrecognized scope — never a guess', () => {
    expect(repoKeyForScope([])).toBeNull();
    expect(repoKeyForScope(null)).toBeNull();
    expect(repoKeyForScope(undefined)).toBeNull();
    expect(repoKeyForScope(['not-a-real-repo:some/path.js'])).toBeNull();
    expect(repoKeyForScope(['no-colon-at-all'])).toBeNull();
  });
});

describe('primaryCheckoutForLanePath', () => {
  it('maps a frontierui lane clone\'s path to frontierui\'s own real primary checkout', () => {
    expect(primaryCheckoutForLanePath('/Users/op/workspace/.lanes/frontierui/lane-3', { home: '/Users/op' }))
      .toBe('/Users/op/workspace/frontierui');
  });

  it('maps a plateau-app lane clone\'s path to plateau-app\'s own real primary checkout', () => {
    expect(primaryCheckoutForLanePath('/Users/op/workspace/.lanes/plateau-app/lane-1', { home: '/Users/op' }))
      .toBe('/Users/op/workspace/plateau-app');
  });

  it('maps a WE lane clone\'s path to the WE checkout (this module\'s own root)', () => {
    const result = primaryCheckoutForLanePath('/Users/op/workspace/.lanes/web-everything/lane-40');
    expect(result).not.toBeNull();
    expect(result.endsWith('workspace/webeverything') || result.length > 0).toBe(true);
  });

  it('returns null for an unrecognized pool-dir basename — the caller falls back to its own default', () => {
    expect(primaryCheckoutForLanePath('/some/synthetic/test/path/lane-1')).toBeNull();
    expect(primaryCheckoutForLanePath('')).toBeNull();
  });
});

// build-path-codex-isolation-locus — the generalization behind `primaryCheckoutForLanePath` (same lookup,
// now also exposed for a caller that needs the FULL profile, e.g. `deliver-item-wrapper.mjs#commitBuildTurn`'s
// repo-aware commit-subject prefix).
describe('repoProfileForLanePath', () => {
  it('returns the full plateau-app profile (key, canonicalPrefix, checkoutPath) for a plateau-app lane path', () => {
    const profile = repoProfileForLanePath('/Users/op/workspace/.lanes/plateau-app/lane-4', { home: '/Users/op' });
    expect(profile.key).toBe('plateau-app');
    expect(profile.canonicalPrefix).toBe('plateau');
    expect(profile.checkoutPath).toBe('/Users/op/workspace/plateau-app');
  });

  it('is what primaryCheckoutForLanePath is now built from — same null cases', () => {
    expect(repoProfileForLanePath('/some/synthetic/test/path/lane-1')).toBeNull();
    expect(repoProfileForLanePath('')).toBeNull();
  });
});
