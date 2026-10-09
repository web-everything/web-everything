/**
 * @file scaffold.test.mjs — proof of the backlog id allocator (#2292): a NEW item takes a RANDOM free number
 *   within the existing range (a gap below the max) rather than deterministic max+1, so two lanes branching
 *   off the same main rarely pick the same NNN (the race that double-landed #2316) — with a max+1 fallback
 *   when the range is gap-free. `rng` is injected so the choice is deterministic under test.
 */
import { describe, it, expect } from 'vitest';
import { nextNum, pad3, slugify, normalizeScope, renderItem, GUARD_RELAXATION_HINT } from '../scaffold.mjs';
import { readTaskAgreement } from '../task-agreement.mjs';

describe('nextNum — random free-in-range allocation (#2292)', () => {
  it('picks a GAP below max, not max+1 (cuts the two-lanes-same-NNN collision)', () => {
    // used 1,2,5 → gaps below max(5) are [3,4]; rng=0 → first, rng→1 → last.
    expect(nextNum(['001', '002', '005'], () => 0)).toBe('003');
    expect(nextNum(['001', '002', '005'], () => 0.99)).toBe('004');
  });
  it('NEVER returns an already-used number, for any rng draw', () => {
    const used = ['001', '002', '003', '005', '008'];
    for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) expect(used).not.toContain(nextNum(used, () => r));
  });
  it('falls back to max+1 when the range is gap-free (dense)', () => {
    expect(nextNum(['001', '002', '003'], () => 0.5)).toBe('004');
  });
  it('empty backlog → 001', () => {
    expect(nextNum([], () => 0.5)).toBe('001');
  });
  it('always a zero-padded 3-digit NNN', () => {
    expect(pad3(7)).toBe('007');
    expect(nextNum(['001', '002', '005'], () => 0)).toMatch(/^\d{3}$/);
  });
});

describe('slugify', () => {
  it('kebab-cases and trims to 60 chars', () => {
    expect(slugify('Hello, World! Foo')).toBe('hello-world-foo');
    expect(slugify('  --Edge__case--  ').replace(/^-+|-+$/g, '')).toBe('edge-case');
  });
});

describe('normalizeScope — coarse, prefix-shaped touch-set the readiness flow authors (#2619)', () => {
  it('trims each entry and drops empties/whitespace', () => {
    expect(normalizeScope([' we:scripts/backlog/scaffold.mjs ', '', '   '])).toEqual([
      'we:scripts/backlog/scaffold.mjs',
    ]);
  });
  it('dedupes while preserving first-seen order (a set, not a sort)', () => {
    expect(normalizeScope(['we:b', 'we:a', 'we:b', 'we:a'])).toEqual(['we:b', 'we:a']);
  });
  it('collapses entries that differ only by surrounding whitespace', () => {
    expect(normalizeScope(['we:a', ' we:a '])).toEqual(['we:a']);
  });
  it('non-array / nullish → []', () => {
    expect(normalizeScope(undefined)).toEqual([]);
    expect(normalizeScope(null)).toEqual([]);
    expect(normalizeScope('we:a')).toEqual([]);
  });
});

describe('renderItem — predicted scope: frontmatter (#2619)', () => {
  const base = { kind: 'story', size: 3, slug: 'x', title: 'X', today: '2026-07-27' };
  it('emits an inline scope: array, normalized (deduped/trimmed) in author order', () => {
    const out = renderItem({ ...base, scope: [' we:scripts/backlog/scaffold.mjs ', 'we:skills-src/split-backlog-item/', 'we:scripts/backlog/scaffold.mjs'] });
    expect(out).toContain('scope: ["we:scripts/backlog/scaffold.mjs", "we:skills-src/split-backlog-item/"]');
  });
  it('omits scope: entirely when no touch-set is given (unscoped item)', () => {
    expect(renderItem(base)).not.toContain('scope:');
    expect(renderItem({ ...base, scope: [] })).not.toContain('scope:');
    expect(renderItem({ ...base, scope: ['  '] })).not.toContain('scope:');
  });
});

describe('renderItem — task-agreement skeleton (#2949, #5399 S7)', () => {
  const base = { kind: 'story', size: 3, slug: 'x', title: 'X', today: '2026-07-27' };
  it('appends `## Acceptance` with an `[A1]` **Executable** TODO line, then `## Non-goals` with an `[N1]` TODO line', () => {
    const out = renderItem(base);
    expect(out).toMatch(/^## Acceptance\n\n- \[A1\] \*\*Executable\*\* — TODO: a command that fails before this item lands and passes after\.$/m);
    expect(out).toMatch(/^## Non-goals\n\n- \[N1\] TODO: /m);
    expect(out).not.toMatch(/Done when/);
    // digest paragraph comes before the heading, not after; Acceptance before Non-goals before Edge cases
    expect(out.indexOf('TODO digest')).toBeLessThan(out.indexOf('## Acceptance'));
    expect(out.indexOf('## Acceptance')).toBeLessThan(out.indexOf('## Non-goals'));
    expect(out.indexOf('## Non-goals')).toBeLessThan(out.indexOf('## Edge cases'));
  });
  it('the shared reader reads the skeleton: A1 and N1 are both TODO, so both sections report empty', () => {
    const a = readTaskAgreement(renderItem(base));
    expect(a.legacy).toBe(false);
    expect(a.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['acceptance-todo', 'non-goals-todo']));
  });
});

describe('renderItem — guard-relaxation hint (#4409)', () => {
  it('#4409 scaffold skeleton carries the pinned hint verbatim', () => {
    const out = renderItem({ kind: 'story', size: 3, slug: 'x', title: 'X', today: '2026-07-27' });
    expect(out).toContain(GUARD_RELAXATION_HINT);
    expect(out.indexOf('## Acceptance')).toBeLessThan(out.indexOf(GUARD_RELAXATION_HINT));
    expect(out.indexOf(GUARD_RELAXATION_HINT)).toBeLessThan(out.indexOf('## Non-goals'));
  });
});

describe('renderItem — conditional endpoint-security guidance (#4704)', () => {
  it.each([
    ['story', 3, undefined],
    ['epic', 5, undefined],
    ['task', undefined, undefined],
    ['decision', undefined, 'author-session'],
  ])('preserves %s metadata and acceptance guidance', (kind, size, scaffoldedBy) => {
    const out = renderItem({
      kind, size, scaffoldedBy, title: 'Example', today: '2026-10-06',
      parent: '4075', blockedBy: ['2774'], digest: 'Example digest.',
      scope: [' we:example ', 'we:example'],
    });
    const metadata = [
      '---', `kind: ${kind}`,
      ...(size === undefined ? [] : [`size: ${size}`]),
      'parent: "4075"',
      ...(scaffoldedBy
        ? ['status: active', 'scaffoldedBy: "author-session"', 'dateScaffolded: "2026-10-06"']
        : ['status: open']),
      'blockedBy: ["2774"]', 'scope: ["we:example"]',
      'dateOpened: "2026-10-06"', 'tags: []', '---',
    ].join('\n');
    expect(out.split('\n\n# ')[0]).toBe(metadata);
    expect(out).toContain('# Example\n\nExample digest.\n\n## Acceptance\n\n');
    expect(out).toContain('- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.');
    const guardHint = 'Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.';
    expect(out).toContain(guardHint);

    const securityHint = out.split('\n').find((line) => line.startsWith('Hint: For any receive or write endpoint,'));
    expect(securityHint).toBeDefined();
    for (const obligation of [
      'specify the body-size cap', 'rate limit', 'CSRF/origin check',
      'protection against abuse of state-resetting triggers',
      'mirror each in the port test plan, or explain why it does not apply',
    ]) expect(securityHint).toContain(obligation);
    expect(out.indexOf('## Acceptance')).toBeLessThan(out.indexOf(securityHint));
    expect(out.indexOf(securityHint)).toBeLessThan(out.indexOf('## Non-goals'));
    expect(out).toContain(`${guardHint}\n\n${securityHint}\n`);
  });
});
