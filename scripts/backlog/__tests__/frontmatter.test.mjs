/**
 * @file scripts/backlog/__tests__/frontmatter.test.mjs
 * Tests the surgical frontmatter splice + status transitions against in-memory fixtures — the body is
 * never touched, illegal transitions are refused, and stamps land next to their anchors.
 */
import { describe, it, expect } from 'vitest';
import { setFrontmatterField, removeFrontmatterField, readField, applyTransition, quoteScalar, validateCodifiedIn } from '../frontmatter.mjs';
import { nextNum, slugify, renderItem } from '../scaffold.mjs';
import matter from 'gray-matter';

const ITEM = [
  '---',
  'kind: story',
  'size: 3',
  'status: open',
  'blockedBy: ["035", "136"]',
  'dateOpened: "2026-06-06"',
  'tags: [droplist, filter]',
  '---',
  '',
  '# Build the filter surface',
  '',
  'A digest that mentions status: and dateStarted: and must never change.',
  '',
  '## Progress',
  '- **Status:** open',
  '',
].join('\n');

describe('setFrontmatterField — surgical, body never touched', () => {
  it('replaces an existing field in place', () => {
    const out = setFrontmatterField(ITEM, 'status', 'active');
    expect(readField(out, 'status')).toBe('active');
    expect(out).toContain('## Progress\n- **Status:** open'); // body status line untouched
    expect(out).toContain('must never change');
  });

  it('inserts a new field after its anchor, not at the bottom', () => {
    const out = setFrontmatterField(ITEM, 'dateStarted', '"2026-06-10"', { after: ['dateOpened', 'status'] });
    const fm = out.slice(0, out.indexOf('\n---', 4));
    expect(fm).toMatch(/dateOpened: "2026-06-06"\ndateStarted: "2026-06-10"/);
    expect(readField(out, 'dateStarted')).toBe('2026-06-10');
  });

  it('returns null when there is no frontmatter', () => {
    expect(setFrontmatterField('# just a body\n', 'status', 'active')).toBeNull();
  });

  it('only edits the frontmatter block — a body line that looks like a field is left alone', () => {
    const out = setFrontmatterField(ITEM, 'status', 'resolved');
    expect((out.match(/^status:/gm) || []).length).toBe(1); // still only one top-level status:
    expect(out).toContain('- **Status:** open');
  });
});

describe('applyTransition — legal from-status enforced', () => {
  it('claim: open → active + dateStarted', () => {
    const r = applyTransition(ITEM, 'claim', { today: '2026-06-10' });
    expect(readField(r.content, 'status')).toBe('active');
    expect(readField(r.content, 'dateStarted')).toBe('2026-06-10');
  });

  it('claim refuses a non-open item (lost the race)', () => {
    const active = setFrontmatterField(ITEM, 'status', 'active');
    const r = applyTransition(active, 'claim', { today: '2026-06-10' });
    expect(r.error).toMatch(/expected "open"/);
    expect(r.content).toBeUndefined();
  });

  it('claim --as=preparing: open → preparing + dateStarted (#375)', () => {
    const r = applyTransition(ITEM, 'claim', { today: '2026-06-10', as: 'preparing' });
    expect(readField(r.content, 'status')).toBe('preparing');
    expect(readField(r.content, 'dateStarted')).toBe('2026-06-10');
  });

  it('release: preparing → open, stamps untouched (#375)', () => {
    const preparing = applyTransition(ITEM, 'claim', { today: '2026-06-10', as: 'preparing' }).content;
    const r = applyTransition(preparing, 'release', {});
    expect(readField(r.content, 'status')).toBe('open');
    expect(readField(r.content, 'dateStarted')).toBe('2026-06-10'); // not removed
  });

  it('resolve: active → resolved + dateResolved + graduatedTo', () => {
    const active = setFrontmatterField(ITEM, 'status', 'active');
    const r = applyTransition(active, 'resolve', { today: '2026-06-10', graduatedTo: 'intent:filter' });
    expect(readField(r.content, 'status')).toBe('resolved');
    expect(readField(r.content, 'dateResolved')).toBe('2026-06-10');
    expect(readField(r.content, 'graduatedTo')).toBe('intent:filter');
  });

  it('resolve: a graduatedTo with YAML-significant chars is quoted so the loader re-parses it (#603)', () => {
    const active = setFrontmatterField(ITEM, 'status', 'active');
    const value = 'the gap-sweep-rerun skill + /gap-sweep + #366 ruling';
    const r = applyTransition(active, 'resolve', { today: '2026-06-10', graduatedTo: value });
    expect(r.content).toContain(`graduatedTo: "${value}"`); // wrapped, not bare
    expect(readField(r.content, 'graduatedTo')).toBe(value); // and round-trips back to the raw value
  });

  it('release: active → open, stamps untouched', () => {
    const active = applyTransition(ITEM, 'claim', { today: '2026-06-10' }).content;
    const r = applyTransition(active, 'release', {});
    expect(readField(r.content, 'status')).toBe('open');
    expect(readField(r.content, 'dateStarted')).toBe('2026-06-10'); // not removed
  });

  it('release refuses an item that is not active', () => {
    expect(applyTransition(ITEM, 'release', {}).error).toMatch(/expected "active"/);
  });

  it('is deterministic — same input, identical output', () => {
    const a = applyTransition(ITEM, 'claim', { today: '2026-06-10' }).content;
    const b = applyTransition(ITEM, 'claim', { today: '2026-06-10' }).content;
    expect(a).toBe(b);
  });
});

// #2779-incident (2026-09-26 03:14Z) — PR #2785's branch (`lane/2779-session-token-fresh`) wrongly resolved
// backlog card #2779 on `main`, and no product path existed to undo a `resolved` status short of hand-editing
// `main`. `unresolve` is that path. RED (before this fix): no `unresolve` verb existed at all — `release` only
// accepts `active`/`preparing`, so `applyTransition(resolvedCard, 'release', {})` on a wrongly-resolved card
// like #2779 (which was plain `open`, never even claimed, before the false resolve) errors `expected "active"
// or "preparing"` and cannot get it back to `open`. GREEN (this fix): `unresolve` accepts exactly `resolved`,
// requires a `reason` (never a silent correction), and drops the fields a real resolve would have earned but
// this one never did.
describe('applyTransition — unresolve (#2779-incident correction path: resolved → open)', () => {
  const RESOLVED_2779 = [
    '---',
    'kind: story',
    'size: 3',
    'status: resolved',
    'dateOpened: "2026-08-01"',
    'dateResolved: "2026-09-26"',
    '---',
    '',
    '# reliable per-build cost metering attribution model tier policy',
    '',
  ].join('\n');

  it('RED (pre-fix shape): release refuses a resolved card — there was no way back to open', () => {
    expect(applyTransition(RESOLVED_2779, 'release', {}).error).toMatch(/expected "active" or "preparing"/);
  });

  it('GREEN: unresolve flips resolved → open, drops dateResolved, and requires + records a reason', () => {
    const r = applyTransition(RESOLVED_2779, 'unresolve', { today: '2026-09-26', reason: '#2779-incident — resolved on a branch-name coincidence, nothing built' });
    expect(r.error).toBeUndefined();
    expect(readField(r.content, 'status')).toBe('open');
    expect(readField(r.content, 'dateResolved')).toBeUndefined();
    expect(readField(r.content, 'unresolvedReason')).toBe('#2779-incident — resolved on a branch-name coincidence, nothing built');
    expect(readField(r.content, 'dateUnresolved')).toBe('2026-09-26');
    // dateOpened (legitimately earned, long before the false resolve) is left untouched.
    expect(readField(r.content, 'dateOpened')).toBe('2026-08-01');
  });

  it('unresolve without --reason is refused — never a silent correction', () => {
    expect(applyTransition(RESOLVED_2779, 'unresolve', { today: '2026-09-26' }).error).toMatch(/reason.*required/);
  });

  it('unresolve refuses anything that is not resolved (never reopens a card that is already open/active)', () => {
    expect(applyTransition(ITEM, 'unresolve', { today: '2026-09-26', reason: 'x' }).error).toMatch(/expected "resolved"/);
  });

  it('also drops graduatedTo/codifiedIn — neither was legitimately earned by a resolve that should never have happened', () => {
    const withGrad = [
      '---', 'kind: story', 'status: resolved', 'dateResolved: "2026-09-26"',
      'graduatedTo: "intent:something"', 'codifiedIn: "docs/x#anchor"', '---', '', '# X', '',
    ].join('\n');
    const r = applyTransition(withGrad, 'unresolve', { today: '2026-09-26', reason: 'incident correction' });
    expect(readField(r.content, 'graduatedTo')).toBeUndefined();
    expect(readField(r.content, 'codifiedIn')).toBeUndefined();
  });
});

describe('applyTransition — codification gate on kind:decision (#911)', () => {
  const DECISION = [
    '---', 'kind: decision', 'status: active',
    'dateOpened: "2026-06-18"', '---', '', '# A cross-cutting ruling', '',
  ].join('\n');

  it('refuses to resolve a decision with no codifiedIn (existing or flag)', () => {
    const r = applyTransition(DECISION, 'resolve', { today: '2026-06-18' });
    expect(r.error).toMatch(/no codifiedIn/);
    expect(r.content).toBeUndefined(); // never a half-written file
  });

  it('refuses a codifiedIn that is not a statute pointer', () => {
    const r = applyTransition(DECISION, 'resolve', { today: '2026-06-18', codifiedTo: 'see the docs' });
    expect(r.error).toMatch(/not a valid statute pointer/);
  });

  it('resolves with --codified-to a doc#anchor and stamps the field', () => {
    const ptr = 'docs/agent/platform-decisions.md#constellation-placement';
    const r = applyTransition(DECISION, 'resolve', { today: '2026-06-18', codifiedTo: ptr });
    expect(r.error).toBeUndefined();
    expect(readField(r.content, 'status')).toBe('resolved');
    expect(readField(r.content, 'codifiedIn')).toBe(ptr);
  });

  it('resolves with the one-off sentinel (a narrow call, no reusable rule)', () => {
    const r = applyTransition(DECISION, 'resolve', { today: '2026-06-18', codifiedTo: 'one-off' });
    expect(r.error).toBeUndefined();
    expect(readField(r.content, 'codifiedIn')).toBe('one-off');
  });

  it('resolves when codifiedIn already lives in frontmatter, no flag needed', () => {
    const withField = setFrontmatterField(DECISION, 'codifiedIn', '"docs/agent/platform-decisions.md#naming"');
    const r = applyTransition(withField, 'resolve', { today: '2026-06-18' });
    expect(r.error).toBeUndefined();
    expect(readField(r.content, 'status')).toBe('resolved');
  });

  it('does NOT gate non-decision items', () => {
    const idea = setFrontmatterField(ITEM, 'status', 'active');
    const r = applyTransition(idea, 'resolve', { today: '2026-06-18' });
    expect(r.error).toBeUndefined();
  });
});

describe('validateCodifiedIn', () => {
  it('accepts one-off and doc paths with/without anchor; rejects empty/bare/anchor-only', () => {
    expect(validateCodifiedIn('one-off')).toBeNull();
    expect(validateCodifiedIn('docs/agent/platform-decisions.md#constellation-placement')).toBeNull();
    expect(validateCodifiedIn('docs/agent/backlog-workflow.md')).toBeNull();
    expect(validateCodifiedIn(undefined)).toMatch(/no codifiedIn/);
    expect(validateCodifiedIn('')).toMatch(/no codifiedIn/);
    expect(validateCodifiedIn('#anchor-only')).toMatch(/not a valid/);
    expect(validateCodifiedIn('platform-decisions')).toMatch(/not a valid/);
  });
});

describe('quoteScalar — quotes iff a YAML-significant char is present (#603)', () => {
  it('leaves a plain slug untouched (diff-quiet)', () => {
    expect(quoteScalar('intent-filter')).toBe('intent-filter');
    expect(quoteScalar('/research/source-awareness-substrate/')).toBe('/research/source-awareness-substrate/');
    expect(quoteScalar('the gap-sweep-rerun skill and skill')).toBe('the gap-sweep-rerun skill and skill');
  });

  it('quotes a colon (the key/value separator) and a hash (comment intro)', () => {
    expect(quoteScalar('foo: bar')).toBe('"foo: bar"');
    expect(quoteScalar('see #492')).toBe('"see #492"');
  });

  it('quotes a leading YAML indicator char (@, *, !, [, {, -)', () => {
    expect(quoteScalar('@frontierui/plugs')).toBe('"@frontierui/plugs"');
    expect(quoteScalar('[a, b]')).toBe('"[a, b]"');
    expect(quoteScalar('- leading dash')).toBe('"- leading dash"');
  });

  it('escapes embedded double-quotes and passes an already-quoted value through', () => {
    expect(quoteScalar('a "quoted" word: x')).toBe('"a \\"quoted\\" word: x"');
    expect(quoteScalar('"already"')).toBe('"already"');
  });

  it('renders the empty string as explicit empty quotes', () => {
    expect(quoteScalar('')).toBe('""');
  });
});

describe('scaffold helpers', () => {
  it('nextNum picks a random free gap below max (#2292), max+1 only when gap-free', () => {
    expect(nextNum(['001', '002', '254'], () => 0)).toBe('003');  // first free gap below 254 (not max+1=255)
    expect(nextNum(['001', '002', '003'], () => 0.5)).toBe('004'); // gap-free range → deterministic max+1
    expect(nextNum([])).toBe('001');
  });

  it('slugify kebab-cases a title', () => {
    expect(slugify('Build the `filter` + clearable surface!')).toBe('build-the-filter-clearable-surface');
  });

  it('renderItem emits a check:standards-shaped skeleton (story carries size, digest present)', () => {
    const out = renderItem({ kind: 'story', size: 3, slug: 'x', title: 'Do the thing', today: '2026-06-10', blockedBy: ['254'] });
    expect(out).toContain('kind: story');
    expect(out).toContain('size: 3');
    expect(out).toContain('status: open');
    expect(out).toContain('blockedBy: ["254"]');
    expect(out).toContain('# Do the thing');
    expect(out).toContain('## Acceptance'); // #2949 / #5399 S7 skeleton, appended after the digest
    expect(out).toMatch(/\n[^\n#-].*\n$/); // non-empty trailing content (the agreement skeleton, not the digest — #2949)
  });

  it('a task carries no size', () => {
    const out = renderItem({ kind: 'task', slug: 'x', title: 'Fix it', today: '2026-06-10' });
    expect(out).not.toContain('size:');
  });
});

describe('#2530 buildQueued splice — set writes a real boolean, remove is CRLF-safe', () => {
  const base = ['---', 'kind: story', 'tier: pinned', 'status: open', '---', '', '# Title', 'body'].join('\n');

  it('set writes an UNQUOTED boolean the YAML loader reads back as `true` (not the string "true")', () => {
    const withFlag = setFrontmatterField(base, 'buildQueued', 'true', { after: ['tier', 'priority', 'size', 'kind'] });
    expect(withFlag).toContain('buildQueued: true');
    expect(matter(withFlag).data.buildQueued).toBe(true); // the round-trip the whole gate depends on
  });

  it('remove deletes the line, leaves no blank line, and is a no-op when the field is absent', () => {
    const withFlag = setFrontmatterField(base, 'buildQueued', 'true', { after: ['tier'] });
    const cleared = removeFrontmatterField(withFlag, 'buildQueued');
    expect(cleared).not.toContain('buildQueued');
    expect(matter(cleared).data.buildQueued).toBeUndefined();
    expect(cleared).not.toMatch(/\n\n---/); // no blank line left before the closing fence
    expect(removeFrontmatterField(base, 'buildQueued')).toBe(base); // absent → exact no-op
  });

  it('remove is CRLF-safe (a hand-rolled `---\\n` regex would silently no-op and leave the flag set)', () => {
    const crlf = ['---', 'status: open', 'buildQueued: true', 'tier: pinned', '---', '', '# T'].join('\r\n');
    const cleared = removeFrontmatterField(crlf, 'buildQueued');
    expect(cleared).not.toContain('buildQueued');
    expect(cleared).toContain('tier: pinned'); // the adjacent CRLF line survives
  });

  it('remove never touches a `buildQueued:` line in the BODY (frontmatter-scoped)', () => {
    const bodyKeyword = ['---', 'status: open', '---', '', '# T', 'buildQueued: not-frontmatter'].join('\n');
    expect(removeFrontmatterField(bodyKeyword, 'buildQueued')).toBe(bodyKeyword);
  });
});
