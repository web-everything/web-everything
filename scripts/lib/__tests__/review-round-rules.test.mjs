import { describe, it, expect } from 'vitest';
import {
  enclosingSymbol, findingDefectClass, findingIdentity, lastReviewedHead, reviewRoundOf,
  reviewScope, bindingRoundDecision, shadowRound, foldFindingStatuses, acceptanceIds,
  projectAvoidedRounds,
} from '../review-round-rules.mjs';
import { resolveReviewSettings } from '../review-settings.mjs';

const context = { repo: 'example/repo', pr: 42, symbol: 'check' };
const finding = (overrides = {}) => ({
  summary: 'A check is missing', file: 'src/a.mjs', line: 10,
  category: 'security/fail-open', ...overrides,
});
const deltaScope = (files = { 'src/a.mjs': [100, 101] }) => reviewScope({
  priorHead: 'p', head: 'h', delta: { priorHead: 'p', head: 'h', files },
});
const round = (overrides = {}) => shadowRound({
  ...context, head: 'h', round: 2, scope: deltaScope(), liveVerdict: 'changes',
  findings: [{ finding: finding(), symbol: 'check', heldVerdict: true }], ...overrides,
});

describe('enclosingSymbol', () => {
  it.each([
    ['function first() {}', 'first'],
    ['async function second() {}', 'second'],
    ['export const third = () => {};', 'third'],
    ['class Fourth {}', 'Fourth'],
    ["describe('rules', () => {", 'describe:rules'],
  ])('finds the nearest column-0 declaration: %s', (declaration, expected) => {
    const text = ['function earlier() {}', declaration, '  const inner = 1;', '  // citation'].join('\n');
    expect(enclosingSymbol(text, 4)).toBe(expected);
    expect(enclosingSymbol(text, 2)).toBe(expected);
  });

  it.each([[0], [3], [1.5]])('rejects invalid line %s', (line) => {
    expect(enclosingSymbol('function f() {}\n// end', line)).toBe('');
  });
  it.each([null, undefined, 42, {}])('rejects non-string source %s', (text) => {
    expect(enclosingSymbol(text, 1)).toBe('');
  });
  it('returns empty when no declaration precedes the citation', () => {
    expect(enclosingSymbol('// start\nfunction later() {}', 1)).toBe('');
  });
  it('uses the nearest Markdown heading', () => {
    const text = '# Card\nIntro\n## Acceptance\n- [A1] Works\n## Notes';
    expect(enclosingSymbol(text, 4, 'x.md')).toBe('## Acceptance');
  });
});

describe('findingDefectClass', () => {
  it.each([
    [{ category: 'security/fail-open' }, 'fail-open'],
    [{ category: 'correctness' }, 'correctness'],
    [{}, 'unknown'],
  ])('classifies %j', (value, expected) => {
    expect(findingDefectClass(value)).toBe(expected);
  });
});

describe('findingIdentity', () => {
  it('keeps identity stable when prose and citation coordinates change', () => {
    const original = findingIdentity(finding({ quote: 'old quote' }), context);
    expect(original).toEqual({
      findingId: expect.stringMatching(/^fi-[0-9a-f]{12}$/),
      path: 'src/a.mjs', symbol: 'check', defectClass: 'fail-open',
    });
    expect(findingIdentity(finding({ summary: 'Different words', line: 80, quote: 'new quote' }), context))
      .toEqual(original);
  });
  it.each([
    ['symbol', {}, { symbol: 'other' }],
    ['class', { category: 'security/injection' }, {}],
    ['path', { file: 'src/b.mjs' }, {}],
    ['PR', {}, { pr: 43 }],
    ['repo', {}, { repo: 'example/other' }],
  ])('distinguishes a different %s', (_name, fields, options) => {
    expect(findingIdentity(finding(fields), { ...context, ...options }).findingId)
      .not.toBe(findingIdentity(finding(), context).findingId);
  });
  it('ignores the symbol when the finding has no file', () => {
    const original = findingIdentity(finding({ file: undefined }), context);
    expect(original).toMatchObject({ path: '', symbol: '' });
    expect(findingIdentity(finding({ file: undefined }), { ...context, symbol: 'other' })).toEqual(original);
  });
  it.each([null, 'prose', {}, { summary: ' ' }])('rejects non-finding %j', (value) => {
    expect(findingIdentity(value, context)).toBeNull();
  });
});

describe('review history', () => {
  const rows = [{ headSha: 'a' }, { headSha: 'b' }, { headSha: 'b' }];
  it.each([['b', 'a', 2], ['c', 'b', 3]])('scopes head %s against %s', (head, prior, number) => {
    expect(lastReviewedHead(rows, head)).toBe(prior);
    expect(reviewRoundOf(rows, head)).toBe(number);
  });
  it('starts at round one without history', () => {
    expect(lastReviewedHead([], 'h')).toBeNull();
    expect(reviewRoundOf([], 'h')).toBe(1);
  });
});

describe('reviewScope', () => {
  it.each([
    [{ head: 'h' }, 'round-1'],
    [{ priorHead: 'p', head: 'h', delta: null }, 'delta-unknown'],
    [{ priorHead: 'p', head: 'h', delta: { error: 'missing commit' } }, 'delta-unreadable: missing commit'],
    [{ priorHead: 'p', head: 'h', delta: { priorHead: 'other', head: 'h', files: {} } }, 'delta-unknown'],
  ])('falls back to full review: %s', (facts, reason) => {
    expect(reviewScope(facts)).toMatchObject({ kind: 'full', reason });
  });
  it('keeps the known delta and deduplicates carried findings and acceptance ids', () => {
    const files = { 'a.mjs': [10] };
    expect(reviewScope({
      priorHead: 'p', head: 'h', delta: { priorHead: 'p', head: 'h', files },
      sentBack: ['fi-one', 'fi-one', 'fi-two'], acceptance: ['A1', 'A2', 'A1'],
    })).toEqual({
      kind: 'delta', reason: 'delta', priorHead: 'p', head: 'h', files,
      carried: ['fi-one', 'fi-two'], acceptance: ['A1', 'A2'],
    });
  });
});

describe('bindingRoundDecision', () => {
  it.each([
    ['tolerated prior', {}, { status: 'tolerated' }, 'card', 'tolerated-on-unchanged-code'],
    ['confirmed broken', { verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }, { status: 'tolerated' }, 'block', 'confirmed-broken'],
    ['confirmed unrecoverable', { verdict: 'CONFIRMED', impactIfUnfixed: 'unrecoverable' }, { status: 'tolerated' }, 'block', 'confirmed-broken'],
    ['changed code', { line: 101 }, { status: 'tolerated' }, 'block', 'changed-code'],
    ['fixed prior', {}, { status: 'fixed' }, 'card', 'reraise-of-fixed'],
    ['unaddressed raised prior', {}, { status: 'raised', path: 'src/a.mjs', lines: [10] }, 'block', 'sent-back-carry'],
    ['addressed raised prior', {}, { status: 'raised', path: 'src/a.mjs', lines: [100] }, 'card', 'reraise-of-fixed'],
    ['new untouched file', { file: 'src/b.mjs' }, null, 'card', 'late-on-unchanged-code'],
    ['missing citation', { file: undefined }, null, 'block', 'no-citation'],
  ])('%s', (_name, fields, prior, decision, reason) => {
    const f = finding(fields);
    expect(bindingRoundDecision({ finding: f, identity: findingIdentity(f, context), prior, scope: deltaScope() }))
      .toMatchObject({ decision, reason });
  });
  it.each([
    [deltaScope({ 'src/a.mjs': null }), 'change-unplaceable'],
    [reviewScope({ head: 'h' }), 'full-review'],
  ])('blocks when scope cannot place a change: %j', (scope, reason) => {
    expect(bindingRoundDecision({ finding: finding(), identity: findingIdentity(finding(), context), scope }))
      .toMatchObject({ decision: 'block', reason });
  });
});

describe('shadowRound', () => {
  it('does not avoid round one or issue shadow decisions for it', () => {
    const result = round({ round: 1, scope: reviewScope({ head: 'h' }) });
    expect(result.entries).toEqual([]);
    expect(result.summary.roundAvoided).toBe(false);
  });
  it('avoids another round when the only held finding becomes a card', () => {
    const result = round();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ decision: 'card', reason: 'late-on-unchanged-code' });
    expect(result.summary).toMatchObject({
      liveBlocked: true, shadowBlocked: false, carded: 1, blocked: 0, roundAvoided: true,
    });
  });
  it('keeps a human requirement blocking', () => {
    expect(round({ humanRequired: true }).summary).toMatchObject({ shadowBlocked: true, roundAvoided: false });
  });
  it('keeps an unattributed live block blocking', () => {
    expect(round({ findings: [] }).summary).toMatchObject({ shadowBlocked: true, roundAvoided: false });
  });
  it.each([false, true])('deduplicates rows, collects lines, and keeps the strongest status (reverse=%s)', (reverse) => {
    const item = (symbol, line, heldVerdict, deferred = false) => ({
      finding: finding({ line }), symbol, heldVerdict, deferred,
    });
    const findings = [
      item('raised', 10, false), item('raised', 11, true, true), item('raised', 12, true),
      item('raised', 12, false), item('carded', 20, false), item('carded', 21, true, true),
      item('tolerated', 30, false),
    ];
    const result = round({ findings: reverse ? [...findings].reverse() : findings });
    expect(result.rows).toHaveLength(3);
    expect(new Set(result.rows.map((r) => r.findingId)).size).toBe(3);
    for (const [symbol, lines] of [['raised', [10, 11, 12]], ['carded', [20, 21]], ['tolerated', [30]]]) {
      const row = result.rows.find((r) => r.symbol === symbol);
      expect(row).toMatchObject({ status: symbol, round: 2 });
      expect([...row.lines].sort((a, b) => a - b)).toEqual(lines);
    }
  });
  it('marks an absent raised identity fixed only when its prior citation was touched', () => {
    const prior = new Map([
      ['fi-touched', { status: 'raised', path: 'src/a.mjs', lines: [100] }],
      ['fi-far', { status: 'raised', path: 'src/a.mjs', lines: [10] }],
      ['fi-tolerated', { status: 'tolerated', path: 'src/a.mjs', lines: [100] }],
    ]);
    expect(round({ findings: [], prior }).rows).toEqual([
      { findingId: 'fi-touched', path: 'src/a.mjs', symbol: '', defectClass: 'unknown', status: 'fixed', round: 2, lines: [100] },
    ]);
  });
});

describe('foldFindingStatuses', () => {
  it('keeps the latest prior finding row per identity for the requested PR', () => {
    const row = (overrides = {}) => ({
      type: 'finding', pr: 42, headSha: 'p', findingId: 'fi-one', status: 'raised',
      round: 1, path: 'src/a.mjs', symbol: 'check', defectClass: 'fail-open', lines: [10], ...overrides,
    });
    const rows = [row(), row({ status: 'tolerated' }), row({ findingId: 'fi-two' }),
      row({ headSha: 'h', status: 'fixed' }), row({ pr: 99, status: 'carded' }),
      row({ type: 'review-run', status: 'fixed' })];
    expect(foldFindingStatuses(rows, { pr: 42, head: 'h' })).toEqual(new Map([
      ['fi-one', { status: 'tolerated', headSha: 'p', round: 1, path: 'src/a.mjs', symbol: 'check', defectClass: 'fail-open', lines: [10] }],
      ['fi-two', { status: 'raised', headSha: 'p', round: 1, path: 'src/a.mjs', symbol: 'check', defectClass: 'fail-open', lines: [10] }],
    ]));
  });
});

describe('acceptanceIds', () => {
  it('reads only acceptance bullets, deduplicating and stopping at the next level-two heading', () => {
    expect(acceptanceIds([
      '- [A0] Outside', '## Acceptance', '- [A1] First', '- [A1] Repeated',
      'Prose [A9]', '- [x] Checkbox', '- [B1] Other id', '### Details', '- [A2] Second',
      '## Notes', '- [A3] Outside',
    ].join('\n'))).toEqual(['A1', 'A2']);
    expect(acceptanceIds('- [A1] No acceptance section')).toEqual([]);
  });
});

describe('projectAvoidedRounds', () => {
  it('counts rounds after the first avoided continuation', () => {
    expect(projectAvoidedRounds([{ round: 1 }, { round: 2, roundAvoided: true }, { round: 3 }, { round: 4 }]))
      .toEqual({ rounds: 4, avoided: 2, stopAt: 2, laterRounds: 3 });
  });
});

describe('resolveReviewSettings', () => {
  it('preserves the built-in defaults and allows file shadow mode', () => {
    expect(resolveReviewSettings({ fileConfig: null, env: {} }))
      .toEqual({ scopedRereview: 'off', referralDefault: 'operator', roundBudget: 'off', takeoverReviewAttempts: 1 });
    expect(resolveReviewSettings({ fileConfig: { scopedRereview: 'shadow' }, env: {} }).scopedRereview).toBe('shadow');
  });
  it('lets an explicit off environment override the file', () => {
    expect(resolveReviewSettings({ fileConfig: { scopedRereview: 'shadow' }, env: { WE_REVIEW_SCOPED_REREVIEW: 'off' } })
      .scopedRereview).toBe('off');
  });
  // `on` is valid since card 5470 (we:scripts/lib/__tests__/review-settings.test.mjs).
  it.each(['ON', 'yes'])('rejects invalid scoped mode %s in file and environment', (invalid) => {
    const env = { WE_REVIEW_SCOPED_REREVIEW: invalid };
    expect(resolveReviewSettings({ fileConfig: { scopedRereview: 'shadow' }, env }).scopedRereview).toBe('shadow');
    expect(resolveReviewSettings({ fileConfig: null, env }).scopedRereview).toBe('off');
    expect(resolveReviewSettings({ fileConfig: { scopedRereview: invalid }, env: {} }).scopedRereview).toBe('off');
  });
  it('preserves referralDefault file, override, and invalid-value fallback behavior', () => {
    const fileConfig = { scopedRereview: 'shadow', referralDefault: 'auto-block' };
    expect(resolveReviewSettings({ fileConfig, env: {} }).referralDefault).toBe('auto-block');
    expect(resolveReviewSettings({ fileConfig, env: { WE_REVIEW_REFERRAL_DEFAULT: 'operator' } }).referralDefault).toBe('operator');
    expect(resolveReviewSettings({ fileConfig, env: { WE_REVIEW_REFERRAL_DEFAULT: 'invalid' } }).referralDefault).toBe('auto-block');
    expect(resolveReviewSettings({ fileConfig: { referralDefault: 'invalid' }, env: {} }).referralDefault).toBe('operator');
  });
});
