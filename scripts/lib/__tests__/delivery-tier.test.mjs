import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyTier, fileTier, HIGH_MUST_STAY, TIER_RULES } from '../delivery-tier.mjs';
import { GUARD_FLOOR, REVIEW_AUTH_FLOOR, AUDITOR_FLOOR } from '../protected-path-floor.mjs';
import { TRUST_CHAIN } from '../gate-config.mjs';


// Concrete witnesses, including directory-marker entries from the protected floors.
const sample = (glob) => (glob.endsWith('/') ? `${glob}sample.mjs` : glob).replace(/\*\*\//g, 'nested/')
  .replace(/\*\*/g, 'sample.mjs').replace(/\*/g, 'sample').replace(/\?/g, 'x');
const matchedHigh = (path) => {
  const r = classifyTier([path], builtins).perFile[0];
  return r.tier === 'HIGH' && !['unmatched', 'invalid-path', 'settings-unavailable'].includes(r.rule);
};
const builtins = { settings: { extraHigh: [] } };
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
  it.each(highExamples)('must stay HIGH: %s', (path) => {
    expect(fileTier(path)).toBe('HIGH');
    expect(classifyTier([path], builtins).perFile[0].rule).not.toBe('unmatched');
  });
  it.each([
    ['docs/x.md', 'LOW'], ['README.md', 'LOW'], ['src/__tests__/x.test.mjs', 'LOW'],
    ['__tests__/x.test.mjs', 'LOW'], ['scripts/conveyor/x.mjs', 'MEDIUM'],
  ])('%s is %s', (path, tier) => expect(fileTier(path)).toBe(tier));

  it('highest matching rule wins, including HIGH tests and conveyor files', () => {
    expect(fileTier('scripts/hooks/__tests__/x.test.mjs')).toBe('HIGH');
    expect(fileTier('scripts/conveyor/__tests__/x.test.mjs')).toBe('MEDIUM');
    const result = classifyTier(['docs/x.md', 'scripts/conveyor/x.mjs', 'scripts/merge-ai-prs.mjs']);
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
      expect(classifyTier([path], { settings }).tier).toBe('LOW');
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
    expect(classifyTier(['docs/x.md'], { readSettings }).tier).toBe('LOW');
    expect(readSettings).toHaveBeenCalledWith(expect.stringMatching(/scripts\/settings\/delivery-tiers\.json$/), 'utf8');
  });
  it.each(['../docs/x.md', '/docs/x.md', 'docs/../scripts/merge.mjs', 'docs/./x.md', 'docs//x.md', '', null])(
    'invalid path stays HIGH: %j', (path) => expect(classifyTier([path], builtins).tier).toBe('HIGH'),
  );
});
