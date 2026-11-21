/**
 * @file critical-work.test.mjs — unit tests for scripts/lib/critical-work.mjs (#4034).
 *
 * Verifies:
 *   - `criticalWorkVerdict` separates the gate/approval boundary from broad full-review proxies.
 *     Explicit high risk, human-required and unknown scope still fail closed.
 *   - `isMissRecord`/`isCriticalMiss` read only the explicit `outcome` (never inferred from `findings`), and
 *     fail closed on missing scope evidence.
 *   - `criticalMissesFor` filters by taskType, accepts both the bare-array and `{records}` store shapes, and
 *     fails closed on legacy rows with no `filesTouched`.
 *   - Real-card fixtures (#4124, #4108, #4131, #4081, #4071) prove the `we:` prefix normalisation and pin the
 *     module's real-world verdicts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  criticalWorkVerdict,
  isMissRecord,
  isCriticalMiss,
  criticalMissesFor,
  MISS_OUTCOMES,
} from '../critical-work.mjs';
import { deriveRisk, deriveComplexity } from '../dispatch-contracts.mjs';
import { NEVER_SPOT_CHECK_PATH_PREFIXES } from '../dispatch-thresholds.mjs';

describe('critical-work.mjs is pure (#4034)', () => {
  it('imports only the shared proxy/data sources and uses no impure primitive', () => {
    const source = readFileSync('scripts/lib/critical-work.mjs', 'utf8');
    for (const forbidden of ['node:fs', 'Date.now', 'new Date', 'process.env', 'Math.random']) expect(source).not.toContain(forbidden);
    // #4200 — `constellation-repos.mjs` added: the plain, IO-free repo-key/dirs table (no fs/os/process import
    // of its own — see that file's own header), read here so the irreversible-group fix (below) has ONE source
    // for sibling-repo path aliases rather than a second, driftable copy of the list.
    expect([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual([
      './dispatch-thresholds.mjs', './gate-config.mjs', './constellation-repos.mjs',
    ]);
  });
});

describe('criticalWorkVerdict + isCriticalMiss — the dispatch-risk proxy (#4034)', () => {
  it('ordinary implementation plus tests is not critical merely because deriveRisk scores it high', () => {
    const taskType = 'bugfix';
    const filesTouched = ['scripts/lib/example.mjs', 'scripts/lib/__tests__/example.test.mjs'];
    const complexity = deriveComplexity(taskType, 0, filesTouched.length);
    // Prove the shared source itself scores this high BEFORE trusting the composition over it.
    expect(deriveRisk(taskType, filesTouched, complexity, true)).toBe('high');

    const record = { outcome: 'reworked', taskType, filesTouched };
    expect(isMissRecord(record)).toBe(true);
    expect(isCriticalMiss(record)).toBe(false);
    expect(isCriticalMiss({ ...record, risk: 'high' })).toBe(true);
  });
});

describe('criticalWorkVerdict + isCriticalMiss — the never-spot-check proxy, every group (#4034)', () => {
  it('is a critical miss for a path in each NEVER_SPOT_CHECK_PATH_PREFIXES group, naming the group', () => {
    for (const [group, prefixes] of Object.entries(NEVER_SPOT_CHECK_PATH_PREFIXES)) {
      const prefix = prefixes[0];
      const path = prefix.endsWith('/') ? `${prefix}x.mjs` : `${prefix}${prefix.includes('.') ? '' : '-x.mjs'}`;

      const record = { outcome: 'reworked', taskType: 'bugfix', filesTouched: [path] };
      expect(isCriticalMiss(record), `group ${group}, path ${path}`).toBe(true);

      const verdict = criticalWorkVerdict({ taskType: 'bugfix', filesTouched: [path] });
      const neverSpotCheck = verdict.reasons.find((r) => r.proxy === 'never-spot-check');
      expect(neverSpotCheck, `group ${group}, path ${path}`).toBeTruthy();
      expect(neverSpotCheck.detail.split(',')).toContain(group);
    }
  });
});

describe('criticalWorkVerdict + isCriticalMiss — the human-required proxy (#4034)', () => {
  it('is a critical miss for humanRequired: true even on an otherwise non-critical scope', () => {
    const taskType = 'build-new-feature';
    const filesTouched = ['blocks/foo/bar.ts'];
    // The bare scope, with no humanRequired, is NOT critical — proves the flag is what does the work.
    expect(criticalWorkVerdict({ taskType, filesTouched }).critical).toBe(false);

    const record = { outcome: 'reworked', taskType, filesTouched, humanRequired: true };
    expect(isCriticalMiss(record)).toBe(true);
  });
});

describe('criticalWorkVerdict + isCriticalMiss — no proxy fires (real card #4081 scope, #4034)', () => {
  it('is NOT a critical miss for a reworked record matching none of the proxies', () => {
    const record = {
      outcome: 'reworked',
      taskType: 'build-new-feature',
      filesTouched: ['scripts/operations/operator-queue.mjs'],
    };
    expect(isCriticalMiss(record)).toBe(false);
  });
});

describe('isCriticalMiss — only an explicit reworked/rejected outcome counts (#4034)', () => {
  it('is NOT a critical miss for a landed (clean) record even on a critical scope, nor for outcome null', () => {
    const criticalScope = ['docs/agent/platform-decisions.md'];
    expect(isCriticalMiss({ outcome: 'landed', taskType: 'doc-fix', filesTouched: criticalScope })).toBe(false);
    expect(isCriticalMiss({ outcome: null, taskType: 'doc-fix', filesTouched: criticalScope })).toBe(false);
    expect(isMissRecord({ outcome: 'landed' })).toBe(false);
    expect(MISS_OUTCOMES).toEqual(['reworked', 'rejected']);
  });
});

describe('isCriticalMiss — fails closed on missing scope evidence (#4034)', () => {
  it('a reworked record with no filesTouched and no evidence is a critical miss; matching evidence clears it', () => {
    const record = { outcome: 'reworked', taskType: 'build-new-feature' };
    expect(isCriticalMiss(record)).toBe(true);
    expect(isCriticalMiss(record, { filesTouched: ['scripts/operations/operator-queue.mjs'] })).toBe(false);
  });
});

describe('criticalWorkVerdict — real-card fixtures prove the we: prefix normalisation (#4034)', () => {
  it('#4124 scope remains critical because it includes the lander', () => {
    const verdict = criticalWorkVerdict({
      taskType: 'bugfix',
      filesTouched: ['we:scripts/merge-ai-prs.mjs', 'we:scripts/lane-drain.mjs', 'we:scripts/readiness/drain-lock.mjs'],
    });
    expect(verdict.critical).toBe(true);
    const proxies = verdict.reasons.map((r) => r.proxy);
    expect(proxies).toEqual(expect.arrayContaining(['never-spot-check']));
  });

  it('#4108 lander scope remains critical via irreversible', () => {
    const verdict = criticalWorkVerdict({ taskType: 'bugfix', filesTouched: ['we:scripts/merge-ai-prs.mjs'] });
    expect(verdict.critical).toBe(true);
    const proxies = verdict.reasons.map((r) => r.proxy);
    expect(proxies).toEqual(expect.arrayContaining(['never-spot-check']));
    const neverSpotCheck = verdict.reasons.find((r) => r.proxy === 'never-spot-check');
    expect(neverSpotCheck.detail).toContain('irreversible');
  });

  it('#4131 ordinary health-watch scope is non-critical', () => {
    const verdict = criticalWorkVerdict({
      taskType: 'bugfix',
      filesTouched: ['we:scripts/conveyor/health-watch-core.mjs', 'we:scripts/conveyor/health-watch.mjs'],
    });
    expect(verdict).toEqual({ critical: false, reasons: [] });
  });

  it('#4081 scope is NOT critical', () => {
    const verdict = criticalWorkVerdict({ taskType: 'build-new-feature', filesTouched: ['we:scripts/operations/operator-queue.mjs'] });
    expect(verdict).toEqual({ critical: false, reasons: [] });
  });

  it('#4071 scope is NOT critical', () => {
    const verdict = criticalWorkVerdict({
      taskType: 'build-new-feature',
      filesTouched: ['we:scripts/lib/telemetry.mjs', 'we:scripts/operations/telemetry-summary-io.mjs'],
    });
    expect(verdict).toEqual({ critical: false, reasons: [] });
  });

  it('a docs/agent path is critical', () => {
    expect(criticalWorkVerdict({ taskType: 'doc-fix', filesTouched: ['docs/agent/some-rule.md'] }).critical).toBe(true);
  });

  it('an empty scope is critical with proxy unknown-scope (fail closed)', () => {
    const verdict = criticalWorkVerdict({ taskType: 'build-new-feature', filesTouched: [] });
    expect(verdict.critical).toBe(true);
    expect(verdict.reasons).toEqual([{ proxy: 'unknown-scope', detail: expect.any(String) }]);
  });
});

// #4200 (epic #3383) — LIVE-CONFIRMED gap: the `irreversible` never-spot-check group (`.github/workflows/`, the
// deploy/land mechanisms) only ever fired for a `we:`-scoped path. A `plateau:`/`plateau-app:`/`frontierui:`/
// `fui:`-scoped file at the SAME relative path (e.g. that repo's own `.github/workflows/deploy.yml`) normalized
// to `plateau/.github/workflows/deploy.yml` etc. — which does not start with `.github/workflows/` — so it read
// as non-critical, opening it to a non-Claude worker with no human-required floor. This closes it for every
// constellation repo locus, while leaving `statute`/`gateSelf` (WE's own governance/gate files, no sibling-repo
// equivalent) deliberately unchanged.
describe('criticalWorkVerdict — the irreversible group applies to every repo locus, not only we: (#4200)', () => {
  it('a plateau-app-scoped .github/workflows/ file is critical via never-spot-check (irreversible)', () => {
    const verdict = criticalWorkVerdict({
      taskType: 'bugfix',
      filesTouched: ['plateau-app:.github/workflows/deploy.yml'],
    });
    expect(verdict.critical).toBe(true);
    const neverSpotCheck = verdict.reasons.find((r) => r.proxy === 'never-spot-check');
    expect(neverSpotCheck).toBeTruthy();
    expect(neverSpotCheck.detail).toContain('irreversible');
  });

  it('the same file under the short "plateau:" scope prefix is critical the same way', () => {
    const verdict = criticalWorkVerdict({ taskType: 'bugfix', filesTouched: ['plateau:.github/workflows/deploy.yml'] });
    expect(verdict.critical).toBe(true);
    expect(verdict.reasons.find((r) => r.proxy === 'never-spot-check').detail).toContain('irreversible');
  });

  it('a frontierui-scoped .github/workflows/ file is critical the same way, including the short "fui:" alias', () => {
    for (const scope of ['frontierui:.github/workflows/ci.yml', 'fui:.github/workflows/ci.yml']) {
      const verdict = criticalWorkVerdict({ taskType: 'bugfix', filesTouched: [scope] });
      expect(verdict.critical, scope).toBe(true);
      expect(verdict.reasons.find((r) => r.proxy === 'never-spot-check').detail, scope).toContain('irreversible');
    }
  });

  it('does NOT widen the WE-only statute/gateSelf groups to sibling repos (docs/agent/ has no plateau equivalent)', () => {
    const verdict = criticalWorkVerdict({ taskType: 'doc-fix', filesTouched: ['plateau-app:docs/agent/some-rule.md'] });
    expect(verdict).toEqual({ critical: false, reasons: [] });
  });

  it('a sibling-repo file that is NOT under an irreversible pattern stays non-critical', () => {
    const verdict = criticalWorkVerdict({
      taskType: 'build-new-feature',
      filesTouched: ['plateau-app:src/feature-tracker/feature-tracking.mount-conformance.test.ts'],
    });
    expect(verdict).toEqual({ critical: false, reasons: [] });
  });
});

describe('criticalMissesFor (#4034)', () => {
  const legacyRow = (extra = {}) => ({
    provider: 'codex',
    model: 'gpt-6-astra',
    taskType: 'bugfix',
    outcome: 'reworked',
    pr: null,
    dispatchKind: 'session-delegation',
    taskDescription: 'Harden codex-direct-task.mjs / gemini-direct-task.mjs — round 1 of 3',
    ...extra,
  });

  it('returns only the critical misses of the requested taskType, over a mixed array', () => {
    const scorecards = [
      legacyRow({ scoredAt: '2026-09-01T00:00:00Z' }),
      { provider: 'codex', model: 'gpt-6-astra', taskType: 'doc-fix', outcome: 'reworked', scoredAt: '2026-09-02T00:00:00Z' },
      { provider: 'gemini', model: 'gemini-3.1-pro', taskType: 'bugfix', outcome: 'landed', scoredAt: '2026-09-03T00:00:00Z' },
    ];
    const misses = criticalMissesFor(scorecards, 'bugfix');
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix' });
  });

  it('accepts the {records} store shape', () => {
    const scorecards = { records: [legacyRow({ scoredAt: '2026-09-01T00:00:00Z' })] };
    expect(criticalMissesFor(scorecards, 'bugfix')).toHaveLength(1);
  });

  it('keeps legacy launcher misses critical after scope is supplied; clears ordinary documentation misses', () => {
    const rows = [
      legacyRow({ scoredAt: '2026-09-01T00:00:00Z' }),
      legacyRow({ scoredAt: '2026-09-05T00:00:00Z' }),
    ];
    expect(criticalMissesFor(rows, 'bugfix')).toHaveLength(2);

    const rowsWithScope = rows.map((r) => ({ ...r, filesTouched: ['scripts/codex-direct-task.mjs', 'scripts/gemini-direct-task.mjs'] }));
    expect(criticalMissesFor(rowsWithScope, 'bugfix')).toHaveLength(2);
    const ordinaryRows = rows.map(r => ({ ...r, filesTouched: ['docs/guide.md'] }));
    expect(criticalMissesFor(ordinaryRows, 'bugfix')).toHaveLength(0);
  });
});

describe('module load order (#4034)', () => {
  it('critical-work.mjs and provider-routing.mjs both load with no TDZ error', async () => {
    const providerRouting = await import('../provider-routing.mjs');
    expect(typeof providerRouting.selectProvider).toBe('function');
    expect(typeof criticalWorkVerdict).toBe('function');
  });
});

describe('criticalWorkVerdict — gate roster parity (PR #3124 review)', () => {
  it('every policy-tier TRUST_CHAIN home is critical', async () => {
    const { TRUST_CHAIN } = await import('../gate-config.mjs');
    const homes = TRUST_CHAIN.filter((m) => m.tier === 'policy').flatMap((m) => m.homes);
    expect(homes.length).toBeGreaterThan(0);
    for (const home of homes) {
      expect(criticalWorkVerdict({ taskType: 'bugfix', filesTouched: [`we:${home}`] }).critical, home).toBe(true);
    }
  });

  it('the gate-self group, `we:`-prefixed, reports never-spot-check', () => {
    for (const path of ['we:scripts/review-runner.mjs', 'we:scripts/lib/dispatch-contracts.mjs', 'we:.claude/settings.json']) {
      const verdict = criticalWorkVerdict({ taskType: 'bugfix', filesTouched: [path] });
      expect(verdict.critical, path).toBe(true);
      expect(verdict.reasons.find((r) => r.proxy === 'never-spot-check')?.detail, path).toContain('gateSelf');
    }
  });

  it('every NEVER_SPOT_CHECK gateSelf entry is critical unless deliberately demoted with a reason', () => {
    // Deliberate demotions (operator decision 2026-09-30): the dispatch loop's launcher is ordinary machinery.
    const demoted = new Map([['scripts/lib/dispatch-', 'wildcard; only dispatch-contracts/-thresholds are gate (asserted above)'], ['scripts/operations/dispatch-lane', 'dispatch operation is conveyor machinery'], ['scripts/lane-pool', 'lane pool is conveyor machinery']]);
    const entries = [...NEVER_SPOT_CHECK_PATH_PREFIXES.gateSelf, ...NEVER_SPOT_CHECK_PATH_PREFIXES.irreversible].filter((p) => !demoted.has(p));
    for (const prefix of entries) {
      const path = prefix.endsWith('/') ? `${prefix}x.yml` : /\.\w+$/.test(prefix) ? prefix : `${prefix}${prefix.endsWith('-') ? 'x' : ''}.mjs`;
      expect(criticalWorkVerdict({ taskType: 'bugfix', filesTouched: [`we:${path}`] }).critical, path).toBe(true);
    }
  });
});

describe('criticalWorkVerdict — independent must-be-critical fixture (PR #3124 round 2)', () => {
  // Not derived from any roster: the land step, required checks, credentials, approval stores and hooks that the
  // operator's boundary names, so a file missing from every roster still reddens here.
  const MUST_BE_CRITICAL = [
    'scripts/lib/pr-merge-gate.mjs', 'scripts/lib/required-status-checks.mjs', 'scripts/lib/verify-lane-gate.mjs',
    'scripts/lib/github-app-token.mjs', 'scripts/lib/github-app-auth-env.mjs', 'scripts/lib/forge-land-provider.mjs',
    'scripts/operations/land-advance.mjs', 'scripts/operations/land-advance-gate.mjs', 'scripts/operations/pr-land-reasons.mjs',
    'scripts/lib/ai-pr-authorship.mjs', 'scripts/lib/marker-authorship.mjs', 'scripts/lib/verdict-totality.mjs',
    'scripts/lib/trust-chain-tier.mjs', 'scripts/conveyor/hiccup-approve.mjs', '.githooks/pre-push',
  ];
  it.each(MUST_BE_CRITICAL)('%s is critical (bare and we:-prefixed)', (path) => {
    expect(criticalWorkVerdict({ taskType: 'bugfix', filesTouched: [path] }).critical, path).toBe(true);
    expect(criticalWorkVerdict({ taskType: 'bugfix', filesTouched: [`we:${path}`] }).critical, path).toBe(true);
  });

  it('constellation-prefixed drain-daemon paths are critical', () => {
    for (const p of ['plateau-app:tools/drain-daemon/cli.mjs', 'plateau-app:tools/drain-daemon/lib.mjs']) {
      expect(criticalWorkVerdict({ taskType: 'bugfix', filesTouched: [p] }).critical, p).toBe(true);
    }
  });

  it('ordinary conveyor machinery stays non-critical', () => {
    expect(criticalWorkVerdict({ taskType: 'bugfix', filesTouched: ['we:scripts/conveyor/tick-core.mjs'] }).critical).toBe(false);
  });
});

describe('criticalWorkVerdict + isCriticalMiss — every security-proxy arm (PR #3124 round 2)', () => {
  const ordinary = ['scripts/conveyor/tick-core.mjs'];
  const proxyOf = (work) => criticalWorkVerdict({ taskType: 'bugfix', filesTouched: ordinary, ...work }).reasons.map((r) => r.proxy);

  it('taskType security-fix is critical', () => {
    expect(proxyOf({ taskType: 'security-fix' })).toContain('security');
  });
  it('the security tag is critical', () => {
    expect(proxyOf({ tags: ['security'] })).toContain('security');
    expect(proxyOf({ tags: ['docs'] })).not.toContain('security');
  });
  it.each(['we:config/.env.production', 'we:.env', 'we:scripts/lib/secrets.mjs', 'we:app/credentials.json', 'we:x/required-checks.json', 'we:x/branch-protection.json'])(
    'path %s trips the security regex', (path) => {
      expect(criticalWorkVerdict({ taskType: 'bugfix', filesTouched: [path] }).reasons.map((r) => r.proxy), path).toContain('security');
    });
  it('isCriticalMiss passes tags through', () => {
    const row = { outcome: 'reworked', taskType: 'bugfix', filesTouched: ordinary };
    expect(isCriticalMiss(row)).toBe(false);
    expect(isCriticalMiss({ ...row, tags: ['security'] })).toBe(true);
    expect(isCriticalMiss(row, { tags: ['security'] })).toBe(true);
  });
});

describe('admission/application fixture trust boundary', () => {
  it.each([
    'scripts/lib/__tests__/fixtures/agy-target-path-cases.mjs',
    'scripts/lib/__tests__/fixtures/future/nested-case.json',
  ])('marks fixture %s critical, including repo-prefixed scope', path => {
    expect(criticalWorkVerdict({ filesTouched: [path] }).critical).toBe(true);
    expect(criticalWorkVerdict({ filesTouched: [`we:${path}`] }).critical).toBe(true);
  });
  it('does not match a similarly named fixture directory', () => {
    expect(criticalWorkVerdict({ filesTouched: ['scripts/lib/__tests__/fixtures-other/case.mjs'] }).critical).toBe(false);
  });
});
