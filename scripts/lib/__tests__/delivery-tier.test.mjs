import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyTier, fileTier, HIGH_MUST_STAY, TIER_RULES, NARROWED_NAME_GLOBS, readPrereleasePreset, activatePrereleasePreset } from '../delivery-tier.mjs';
import { GUARD_FLOOR, REVIEW_AUTH_FLOOR, AUDITOR_FLOOR } from '../protected-path-floor.mjs';
import { TRUST_CHAIN } from '../gate-config.mjs';
import * as policyCascade from '../policy-cascade.mjs';


// Concrete witnesses, including directory-marker entries from the protected floors.
const sample = (glob) => (glob.endsWith('/') ? `${glob}sample.mjs`
  : glob).replace(/\*\*\//g, 'nested/')
  .replace(/\*\*/g, 'sample.mjs').replace(/\*/g, 'sample').replace(/\?/g, 'x');
const matchedHigh = (path) => {
  const r = classifyTier([path], builtins).perFile[0];
  return r.tier === 'HIGH' && !['unmatched', 'invalid-path', 'settings-unavailable'].includes(r.rule);
};
const builtins = { redMainFix: false, quarantinedTests: [], settings: { extraHigh: [] } };
const highExamples = [
  'scripts/merge-ai-prs.mjs', 'scripts/lib/review-core.mjs', 'scripts/drain-queue.mjs',
  'scripts/conveyor/force-land.mjs', 'scripts/conveyor/red-main-fix.mjs',
  'scripts/lib/delivery-tier.mjs', 'scripts/settings/delivery-tiers.json',
  'scripts/settings/schema.json', 'scripts/lib/example-settings.mjs', 'scripts/settings/presets/x.json',
  '.github/workflows/test.yml', 'vitest.config.ts', 'packages/x/vitest.unit.config.mjs',
  'scripts/ci/run.mjs', 'scripts/lib/main-staleness.mjs', 'scripts/lib/daemon-load-overlay.mjs',
  'scripts/operations/prototype-load.mjs', 'scripts/operations/prototype-load-io.mjs',
  'scripts/conveyor/credential-inventory.mjs', 'scripts/operations/worker-wrapper-launch.mjs',
  'scripts/conveyor/agent-launch.mjs', 'scripts/hooks/x.mjs', '.githooks/pre-push',
  '.claude/agents/x.md', 'custom/guard-x.mjs',
  'scripts/lib/__tests__/review-policy.conformance.test.mjs',
];

describe('delivery tiers (observe-only)', () => {
  it('a red-main fix that only touches tests is not LOW', () => {
    expect(classifyTier(['src/__tests__/x.test.mjs'], { ...builtins, redMainFix: true }).perFile[0])
      .toMatchObject({ tier: 'MEDIUM', rule: 'red-main-or-unknown-context' });
    expect(fileTier('README.md', { ...builtins, redMainFix: true })).toBe('MEDIUM');
  });
  it('unknown red-main context is not LOW', () => {
    for (const redMainFix of [undefined, null, 0, '', 'false', {}, []]) {
      const opts = { ...builtins, redMainFix };
      expect(classifyTier(['README.md'], opts).perFile[0])
        .toMatchObject({ tier: 'MEDIUM', rule: 'red-main-or-unknown-context' });
      expect(fileTier('README.md', opts)).toBe('MEDIUM');
    }
    expect(classifyTier(['README.md']).tier).toBe('MEDIUM');
  });
  it('a quarantined test is HIGH', () => {
    const path = 'src/__tests__/x.test.mjs';
    const opts = { ...builtins, quarantinedTests: [path] };
    expect(classifyTier([path], opts).perFile[0]).toEqual({ path, tier: 'HIGH', rule: 'quarantined-test' });
    expect(fileTier(path, opts)).toBe('HIGH');
    expect(fileTier('other/' + path, opts)).toBe('LOW');
    expect(fileTier('README.md', { ...builtins, quarantinedTests: [] })).toBe('LOW');
    expect(classifyTier([{ path: 'README.md', oldPath: path }], opts).tier).toBe('HIGH');
  });
  it('missing or undefined quarantine roster cannot license LOW', () => {
    const missing = { ...builtins };
    delete missing.quarantinedTests;
    for (const opts of [missing, { ...builtins, quarantinedTests: undefined }]) {
      for (const path of ['README.md', 'src/__tests__/x.test.mjs']) {
        expect(classifyTier([path], opts).perFile[0])
          .toEqual({ path, tier: 'MEDIUM', rule: 'red-main-or-unknown-context' });
        expect(fileTier(path, opts)).toBe('MEDIUM');
      }
      expect(fileTier('scripts/conveyor/x.mjs', opts)).toBe('MEDIUM');
      expect(classifyTier(['scripts/merge-ai-prs.mjs'], opts).perFile[0])
        .toMatchObject({ tier: 'HIGH', rule: expect.not.stringMatching(/unmatched|context-invalid/) });
    }
  });
  it.each([null, 'x', {}, [null], [1], Array(1), [''], ['./src/__tests__/x.test.mjs'],
    ['src/__tests__/x.test.mjs::case'],
    ['src/../x'], ['src//x'], ['/src/x'], ['src/x/'], ['src\\x'], ['src/\nx'], ['src/\x7fx'],
  ])('invalid quarantine context refuses: %j', (quarantinedTests) => {
    const opts = { ...builtins, quarantinedTests };
    const paths = ['README.md', 'scripts/conveyor/x.mjs', 'src/unknown.js', 'src/__tests__/x.test.mjs'];
    expect(classifyTier(paths, opts).perFile.map(f => [f.tier, f.rule]))
      .toEqual(paths.map(() => ['HIGH', 'context-invalid']));
    for (const path of paths) expect(fileTier(path, opts)).toBe('HIGH');
  });
  it.each([
    'src/__tests__/safety-check.mjs', 'src/__tests__/x-safety.mjs', 'src/x-safety.test.ts',
    'docs/governance/policy.txt', 'docs/governance.md', 'docs/nested/governance-policy.md',
    'AGENTS.md', 'CLAUDE.md', 'docs/agent/testing.md', 'scripts/conveyor/advisory-label-sweep.mjs',
    'scripts/conveyor/__tests__/advisory-label-sweep.test.mjs',
    'scripts/lib/__tests__/delivery-tier.test.mjs',
  ])('sensitive path has a HIGH rule: %s', path => expect(matchedHigh(path)).toBe(true));
  it('skills-src is HIGH', () => {
    for (const path of ['skills-src/x/SKILL.md', 'nested/skills-src/x/SKILL.md']) {
      expect(matchedHigh(path)).toBe(true);
    }
  });
  it.each(['scripts', 'prompts', 'skills-src', '.claude', '.github'])(
    '%s merge/review/drain names stay explicitly HIGH at root and nested, regardless of extension', tree => {
      for (const name of ['merge', 'review', 'drain']) {
        expect(HIGH_MUST_STAY).toContain(`${tree}/**/*${name}*`);
        for (const dir of ['', 'nested/']) {
          for (const ext of ['', '.md', '.py', '.mjs', '.cjs', '.js', '.ts', '.json', '.sh']) {
            expect(matchedHigh(`${tree}/${dir}${name}-notes${ext}`)).toBe(true);
          }
        }
      }
    },
  );
  it.each([
    'scripts/review-instructions.md', 'scripts/__tests__/review-policy.test.py',
    'scripts/conveyor/review-worker.py', 'prompts/review-notes.md',
    '.github/review-x.md', 'skills-src/merge-x.md',
  ])('sensitive name cannot fall to LOW with redMainFix:false: %s', path => {
    expect(fileTier(path, builtins)).toBe('HIGH');
    expect(matchedHigh(path)).toBe(true);
  });
  it('exports no narrowed name globs and retains the original root variants', () => {
    expect(NARROWED_NAME_GLOBS).toEqual([]);
    for (const glob of ['scripts/*merge*', 'scripts/*drain*']) {
      expect(HIGH_MUST_STAY).toContain(glob);
    }
    expect(TIER_RULES.HIGH).toBe(HIGH_MUST_STAY);
  });
  it('names outside sensitive trees can be LOW unless extraHigh protects them', () => {
    for (const name of ['merge', 'review', 'drain']) {
      const path = `docs/${name}-notes.md`;
      expect(fileTier(path, builtins)).toBe('LOW');
      const opts = { ...builtins, settings: { extraHigh: [`docs/**/*${name}*`] } };
      expect(classifyTier([path], opts).perFile[0])
        .toMatchObject({ tier: 'HIGH', rule: `docs/**/*${name}*` });
    }
  });
  it('duplicate settings keys refuse', () => {
    for (const text of [
      '{"extraHigh":["docs/**"],"extraHigh":[]}',
      '{"extraHigh":[],"nested":{"x":1,"x":2}}',
      '{"extraHigh":[],"nested":[{"x":1,"\\u0078":2}]}',
    ]) {
      const opts = { ...builtins, readSettings: () => text };
      delete opts.settings;
      expect(classifyTier(['README.md'], opts).perFile[0])
        .toMatchObject({ tier: 'HIGH', rule: 'settings-unavailable' });
      expect(fileTier('README.md', opts)).toBe('HIGH');
    }
  });
  it('settings tokenizer accepts distinct objects and punctuation in strings', () => {
    const readSettings = () => '{"extraHigh":[],"a":{"x":"{\\\"x\\\":}"},"b":[{"x":2}]}';
    expect(fileTier('README.md', { readSettings, redMainFix: false, quarantinedTests: [] })).toBe('LOW');
  });
  it.each([{}, { extraHigh: [''] }, ...['/docs/**', 'docs\\x', 'docs/\nx', 'docs/\x7fx',
    'docs//x', 'docs/./x', 'docs/../x', 'docs/***', 'docs/'].map(g => ({ extraHigh: [g] }))])(
    'missing extraHigh or invalid globs refuse: %j', settings => {
      for (const opts of [{ settings }, { readSettings: () => JSON.stringify(settings) }]) {
        expect(classifyTier(['README.md'], opts).perFile[0])
          .toMatchObject({ tier: 'HIGH', rule: 'settings-unavailable' });
        expect(fileTier('README.md', opts)).toBe('HIGH');
      }
    },
  );
  it('malformed settings text refuses', () => {
    expect(classifyTier(['README.md'], { readSettings: () => '{' }).perFile[0])
      .toMatchObject({ tier: 'HIGH', rule: 'settings-unavailable' });
  });

  it.each(highExamples)('must stay HIGH: %s', (path) => {
    expect(fileTier(path)).toBe('HIGH');
    expect(classifyTier([path], builtins).perFile[0].rule).not.toBe('unmatched');
  });
  it.each([
    ['docs/x.md', 'LOW'], ['README.md', 'LOW'], ['src/__tests__/x.test.mjs', 'LOW'],
    ['__tests__/x.test.mjs', 'LOW'], ['scripts/conveyor/x.mjs', 'MEDIUM'],
  ])('%s is %s', (path, tier) => expect(fileTier(path, { redMainFix: false, quarantinedTests: [] })).toBe(tier));

  it('highest matching rule wins, including HIGH tests and conveyor files', () => {
    expect(fileTier('scripts/hooks/__tests__/x.test.mjs')).toBe('HIGH');
    expect(fileTier('scripts/conveyor/__tests__/x.test.mjs')).toBe('MEDIUM');
    const result = classifyTier(['docs/x.md', 'scripts/conveyor/x.mjs', 'scripts/merge-ai-prs.mjs'], builtins);
    expect(result.tier).toBe('HIGH');
    expect(result.perFile.map(f => f.tier)).toEqual(['LOW', 'MEDIUM', 'HIGH']);
    expect(result.perFile[0]).toEqual({ path: 'docs/x.md', tier: 'LOW', rule: 'docs/**' });
  });
  it('unknown and empty changes fail closed', () => {
    expect(classifyTier(['src/unknown.js'], builtins)).toEqual({
      tier: 'HIGH', perFile: [{ path: 'src/unknown.js', tier: 'HIGH', rule: 'unmatched' }],
    });
    expect(classifyTier([], builtins)).toEqual({ tier: 'HIGH', perFile: [] });
  });
  it('settings only add HIGH and ignore removal and lower-tier keys', () => {
    const settings = { extraHigh: ['docs/private/**'], remove: HIGH_MUST_STAY,
      HIGH: [], LOW: ['scripts/**'], MEDIUM: ['scripts/hooks/**'] };
    expect(classifyTier(['docs/private/x.md'], { settings }).tier).toBe('HIGH');
    expect(classifyTier(['docs/private/x.md'], builtins).tier).toBe('LOW');
    for (const path of highExamples) expect(classifyTier([path], { settings }).tier).toBe('HIGH');
  });
  it('matches **/x at root and nested locations, anchored at repo root', () => {
    const settings = { extraHigh: ['**/x.md', 'private/**', 'docs/a?.md', 'docs/a+b.md'] };
    for (const path of ['x.md', 'docs/x.md', 'private/a/b.md', 'docs/ab.md', 'docs/a+b.md']) {
      expect(classifyTier([path], { settings }).tier).toBe('HIGH');
    }
    for (const path of ['docs/private/a.md', 'docs/abc.md', 'docs/aaab.md']) {
      expect(classifyTier([path], { settings, redMainFix: false, quarantinedTests: [] }).tier).toBe('LOW');
    }
  });
  it.each([
    ['scripts/merge-ai-prs.mjs', 'docs/x.md'], ['docs/x.md', 'scripts/merge-ai-prs.mjs'],
  ])('renames classify both old %s and new %s', (oldPath, path) => {
    const result = classifyTier([{ path, oldPath }], builtins);
    expect(result.tier).toBe('HIGH');
    expect(result.perFile.map(f => f.path).sort()).toEqual([oldPath, path].sort());
  });
  it.each(HIGH_MUST_STAY)('every must-stay glob has a HIGH witness: %s', (glob) => {
    expect(matchedHigh(sample(glob))).toBe(true);
    expect(HIGH_MUST_STAY).toContain(glob);
    expect(TIER_RULES.HIGH).toContain(glob);
  });
  for (const [name, floor] of Object.entries({ GUARD_FLOOR, REVIEW_AUTH_FLOOR, AUDITOR_FLOOR })) {
    it.each(floor)(`${name} parity: %s`, (glob) => {
      expect(HIGH_MUST_STAY).toContain(glob);
      expect(matchedHigh(sample(glob))).toBe(true);
    });
  }
  it.each(TRUST_CHAIN.flatMap(member => member.homes))('TRUST_CHAIN home is explicitly HIGH: %s', (path) => {
    expect(classifyTier([path], builtins).perFile[0].rule).not.toBe('unmatched');
    expect(fileTier(path)).toBe('HIGH');
  });
  it('freezes the built-in rules', () => {
    expect(Object.isFrozen(HIGH_MUST_STAY)).toBe(true);
    expect(Object.isFrozen(TIER_RULES)).toBe(true);
    for (const rules of Object.values(TIER_RULES)) expect(Object.isFrozen(rules)).toBe(true);
  });
  it.each([null, { extraHigh: null }, { extraHigh: 'docs/**' }, { extraHigh: [null] }])('invalid settings fail closed: %j', (settings) => {
    expect(classifyTier(['docs/x.md'], { settings }).tier).toBe('HIGH');
    expect(classifyTier(['docs/x.md'], { readSettings: () => JSON.stringify(settings) }).tier).toBe('HIGH');
  });
  it.each([
    ['all holes', Array(1)],
    ['leading hole', [, 'private/**']],
    ['interior hole', ['private/**', , 'other/**']],
    ['trailing hole', ['private/**', ,]],
    ['explicit undefined', [undefined]],
  ])('invalid extraHigh fails closed for both APIs: %s', (_name, extraHigh) => {
    const opts = { settings: { extraHigh } };
    expect(classifyTier(['docs/x.md', 'scripts/conveyor/x.mjs'], opts)).toEqual({
      tier: 'HIGH',
      perFile: [
        { path: 'docs/x.md', tier: 'HIGH', rule: 'settings-unavailable' },
        { path: 'scripts/conveyor/x.mjs', tier: 'HIGH', rule: 'settings-unavailable' },
      ],
    });
    expect(fileTier('docs/x.md', opts)).toBe('HIGH');
    expect(fileTier('scripts/conveyor/x.mjs', opts)).toBe('HIGH');
  });
  it('sparse arrays never classify LOW', () => {
    expect(classifyTier(Array(1), builtins).tier).toBe('HIGH');
    expect(classifyTier(Array(1), { readSettings: () => { throw new Error('x'); } }).tier).toBe('HIGH');
  });
  it('unreadable settings fail closed', () => {
    const readSettings = () => { throw new Error('unreadable'); };
    expect(classifyTier(['docs/x.md'], { readSettings }).tier).toBe('HIGH');
  });
  it('loads the shipped settings through the default reader', () => {
    const readSettings = vi.fn(() => '{"extraHigh":[]}');
    expect(classifyTier(['docs/x.md'], { readSettings, redMainFix: false, quarantinedTests: [] }).tier).toBe('LOW');
    expect(readSettings).toHaveBeenCalledWith(expect.stringMatching(/scripts\/settings\/delivery-tiers\.json$/), 'utf8');
  });
  it.each(['../docs/x.md', '/docs/x.md', 'docs/../scripts/merge.mjs', 'docs/./x.md', 'docs//x.md', '', null])(
    'invalid path stays HIGH: %j', (path) => expect(classifyTier([path], builtins).tier).toBe('HIGH'),
  );
});


describe('prerelease preset settings (observe-only)', () => {
  const now = Date.parse('2026-10-30T16:00:00.000Z');
  const read = (settings, at = now) => readPrereleasePreset({ settings, now: at, platform: {}, env: {} });
  const off = { active: false, expiresAt: null };
  it('prerelease preset reads active off with no expiry until activated', () => {
    expect(readPrereleasePreset({ platform: {}, env: {} })).toEqual(off);
  });
  it('activation stamps seven elapsed days in UTC across a DST edge without mutating settings', () => {
    const settings = { extraHigh: [], prereleasePresetActive: false, prereleasePresetExpiresAt: null };
    const activated = activatePrereleasePreset(settings, now);
    expect(activated).toEqual({ ...settings, prereleasePresetActive: true,
      prereleasePresetExpiresAt: '2026-11-06T16:00:00.000Z' });
    expect(settings.prereleasePresetActive).toBe(false);
    expect(settings.prereleasePresetExpiresAt).toBeNull();
    expect(read(activated)).toEqual({ active: true, expiresAt: '2026-11-06T16:00:00.000Z' });
  });
  it('past expiry and the exact expiry boundary read inactive', () => {
    const settings = activatePrereleasePreset({}, now);
    const expiry = Date.parse(settings.prereleasePresetExpiresAt);
    expect(read(settings, expiry - 1).active).toBe(true);
    expect(read(settings, expiry).active).toBe(false);
    expect(read(settings, expiry + 1).active).toBe(false);
  });
  it.each([undefined, null, [], {}, { prereleasePresetActive: 'true' },
    { prereleasePresetActive: true }, { prereleasePresetActive: true, prereleasePresetExpiresAt: null },
    ...['garbage', '2026-11-31T00:00:00.000Z', '2026-11-06', '2026-11-06T16:00:00-05:00', 42]
      .map(prereleasePresetExpiresAt => ({ prereleasePresetActive: true, prereleasePresetExpiresAt })),
  ])('malformed preset reads inactive: %j', settings => expect(read(settings)).toEqual(off));
  it('unreadable and duplicate-key settings read inactive', () => {
    for (const readSettings of [() => { throw Error('unreadable'); }, () => '{',
      () => '{"prereleasePresetActive":false,"prereleasePresetActive":true,"prereleasePresetExpiresAt":"2026-11-06T16:00:00.000Z"}']) {
      expect(readPrereleasePreset({ readSettings, now, platform: {}, env: {} })).toEqual(off);
    }
  });
  it('invalid clocks refuse activation and read inactive', () => {
    for (const invalid of [NaN, Infinity, '2026-10-30', null, 8.64e15]) {
      expect(() => activatePrereleasePreset({}, invalid)).toThrow();
      expect(read(activatePrereleasePreset({}, now), invalid)).toEqual(off);
    }
  });
  it('preset settings never change classification and their files stay explicitly HIGH', () => {
    const settings = activatePrereleasePreset({ extraHigh: [] }, now);
    const paths = ['README.md', 'scripts/conveyor/x.mjs', 'scripts/settings/delivery-tiers.json'];
    expect(classifyTier(paths, { ...builtins, settings })).toEqual(classifyTier(paths, builtins));
    for (const path of ['scripts/settings/delivery-tiers.json',
      'scripts/lib/settings-registry-metadata.d/settings/prereleasePresetActive.json',
      'scripts/lib/settings-registry-metadata.d/settings/prereleasePresetExpiresAt.json']) {
      expect(matchedHigh(path)).toBe(true);
    }
  });
  it('logs effective settings with tool provenance through the shared cascade', () => {
    const log = vi.fn();
    readPrereleasePreset({ now, platform: {}, env: { WE_POLICY_CASCADE_LOG: '1' }, log });
    expect(log.mock.calls.flat().join(' ')).toContain('tool');
    expect(log.mock.calls.flat().join(' ')).toContain('prereleasePresetActive');
  });
  it('rejects an object resolved from platform active leaves despite explicit tool opt-out, with a warning', () => {
    const log = vi.fn();
    expect(readPrereleasePreset({ now, env: {}, log,
      platform: { prereleasePresetActive: { unexpected: true } },
      settings: { prereleasePresetActive: false, prereleasePresetExpiresAt: '2026-11-06T16:00:00.000Z' },
    })).toEqual(off);
    expect(log.mock.calls.flat().join(' ')).toMatch(/prereleasePresetActive.*boolean/);
  });
  it.each([{ unexpected: true }, 'true', null])('rejects non-boolean tool active %j with a validation warning', active => {
    const log = vi.fn();
    expect(readPrereleasePreset({ now, env: {}, log,
      platform: activatePrereleasePreset({}, now),
      settings: { prereleasePresetActive: active, prereleasePresetExpiresAt: '2026-11-06T16:00:00.000Z' },
    })).toEqual(off);
    expect(log.mock.calls.flat().join(' ')).toMatch(/prereleasePresetActive.*boolean/);
  });
  it('preserves explicit tool null expiry instead of borrowing a platform expiry for a tool active bit', () => {
    expect(readPrereleasePreset({ now, env: {},
      platform: { prereleasePresetExpiresAt: '2026-11-06T16:00:00.000Z' },
      settings: { prereleasePresetActive: true, prereleasePresetExpiresAt: null },
    })).toEqual(off);
  });
  it('uses the future expiry from the tool activation layer even when platform expiry differs', () => {
    expect(readPrereleasePreset({ now, env: {},
      platform: { prereleasePresetActive: false, prereleasePresetExpiresAt: '2026-10-29T16:00:00.000Z' },
      settings: activatePrereleasePreset({}, now),
    })).toEqual({ active: true, expiresAt: '2026-11-06T16:00:00.000Z' });
  });
  it('rejects activation resolved from platform with a valid future expiry resolved from tool', () => {
    const settings = activatePrereleasePreset({}, now);
    const active = policyCascade.resolveCascade({ standard: false, platform: true });
    const expiry = policyCascade.resolveCascade({ tool: { expiresAt: settings.prereleasePresetExpiresAt } });
    expect(active.value).toBe(true);
    expect(active.sources['']).toBe('platform');
    expect(Date.parse(expiry.value.expiresAt)).toBeGreaterThan(now);
    expect(expiry.sources.expiresAt).toBe('tool');
    // Isolate the reader's source check from its input validation using real cascade results.
    const cascade = vi.spyOn(policyCascade, 'cascadePolicy')
      .mockReturnValueOnce(active).mockReturnValueOnce(expiry);
    try {
      expect(readPrereleasePreset({ settings, now, platform: {}, env: {} })).toEqual(off);
      expect(cascade).toHaveBeenCalledTimes(2);
    } finally {
      cascade.mockRestore();
    }
  });
});
