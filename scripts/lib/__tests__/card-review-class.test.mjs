import { describe, it, expect } from 'vitest';
import { cardReviewClass, isCardCoverageFinding, CARD_REVIEW_CLASS } from '../card-review-class.mjs';
import { redTeamPanelSeatOwed, redTeamOwedOnHead } from '../review-red-team-policy.mjs';
import { resolveCardOnlyReviewSettings } from '../review-seat-settings.mjs';
import { cardFrontmatterField, frontmatterText } from '../../operations/review-pr-io.mjs';
import { cardClassSkip } from '../../operations/review-job.mjs';

const REV = 'a'.repeat(40);
const newCard = (path, front = ['title: x', 'kind: story'], body = ['body']) => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
  `@@ -0,0 +1,${front.length + 2 + body.length} @@`, '+---', ...front.map((l) => `+${l}`), '+---', ...body.map((l) => `+${l}`), '',
].join('\n');
const codeFile = (path) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -10,1 +10,1 @@', '-a', '+b', ''].join('\n');
const midEdit = (path) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -30,1 +30,1 @@', '-old', '+new', ''].join('\n');
const read = (files, diffText, extra = {}) => ({ netChangedFiles: files, netRenameSources: [], diffText, netBasis: { rev: REV }, ...extra });
const payload = (r) => ({ findings: { read: r } });
const PANEL = { WE_RED_TEAM_TIMING: 'panel-seat' };
const A = 'backlog/1-a.md';
const cls = (r) => cardReviewClass(r).class;

describe('card review class', () => {
  it('card-only story card → card (light routing)', () => {
    expect(cls(read([A], newCard(A)))).toBe(CARD_REVIEW_CLASS.CARD);
  });
  it('card + code → full', () => {
    expect(cardReviewClass(read([A, 'scripts/x.mjs'], newCard(A) + codeFile('scripts/x.mjs')))).toMatchObject({ class: 'full', reason: 'touches a non-card path' });
  });
  it('card + docs/agent/platform-decisions.md → full', () => {
    expect(cls(read([A, 'docs/agent/platform-decisions.md'], newCard(A) + codeFile('docs/agent/platform-decisions.md')))).toBe('full');
  });
  it('decision or ratified card → full, in every YAML spelling', () => {
    for (const front of [['kind: decision'], ['kind: "decision"'], ["kind:  'decision'"], ['type: decision'], ['"kind": decision'],
      ['kind: !!str decision'], ['kind: >-', '  decision'], ['kind: story', 'codifiedIn: docs/agent/platform-decisions.md'],
      ['kind: story', '"codifiedIn": x'], ['kind: story', 'ratified : 2026-10-01'], ['kind: story', 'kind: decision'], ['title: |', '  ---', 'kind: decision']]) {
      expect(cls(read([A], newCard(A, front))), front.join(' / ')).toBe('full');
    }
  });
  it('unknown, missing or non-string kind → full (allowlist, not denylist)', () => {
    for (const front of [['kind: proposal'], ['title: x'], ['kind: [story]'], ['kind: {a: 1}']]) expect(cls(read([A], newCard(A, front)))).toBe('full');
  });
  it('git-read frontmatter decides a mid-file edit; any disagreement with the diff can only make it full', () => {
    expect(cardReviewClass(read([A], midEdit(A))).reason).toMatch(/frontmatter not read/);
    expect(cls(read([A], midEdit(A), { cardFrontmatter: { [A]: { old: 'kind: decision', new: 'kind: story' } } }))).toBe('full');
    expect(cls(read([A], midEdit(A), { cardFrontmatter: { [A]: { old: 'kind: story', new: 'kind: story' } } }))).toBe('card');
    expect(cls(read([A], midEdit(A), { cardFrontmatter: { [A]: { old: '', new: 'kind: story' } } }))).toBe('full');
    // git read says story, but the diff itself shows a decision → full
    expect(cls(read([A], newCard(A, ['kind: decision']), { cardFrontmatter: { [A]: { old: null, new: 'kind: story' } } }))).toBe('full');
  });
  it('the diff body mentioning a decision or ratification marker → full (fail-closed over-match)', () => {
    expect(cls(read([A], newCard(A, undefined, ['see the ratified rule'])))).toBe('full');
    expect(cls(read([A], newCard(A, undefined, ['type: decision'])))).toBe('full');
  });
  it('a diff header naming a path outside the card list → full', () => {
    expect(cls(read([A], newCard(A) + codeFile('scripts/x.mjs')))).toBe('full');
    expect(cls(read([A], newCard(A).replace(`diff --git a/${A} b/${A}`, `diff --git a/scripts/x.mjs b/${A}`)))).toBe('full');
    expect(cls(read([A], `${newCard(A)}rename from scripts/x.mjs\n`))).toBe('full');
  });
  it('fails closed: degraded, unpinned, empty diff, rename, missing block', () => {
    const ok = read([A], newCard(A));
    expect(cls({ ...ok, degraded: true })).toBe('full');
    expect(cls({ ...ok, netBasis: { rev: 'abc' } })).toBe('full');
    expect(cls({ ...ok, diffText: '' })).toBe('full');
    expect(cls({ ...ok, netRenameSources: ['scripts/x.mjs'] })).toBe('full');
    expect(cls(read([A, 'backlog/2-b.md'], newCard(A)))).toBe('full');
    expect(cls(read([A], newCard(A).replace('+---\n+title', '+title')))).toBe('full');
    expect(cls(null)).toBe('full');
  });
  it('raised-by pointer notes need no frontmatter', () => {
    const p = 'backlog/raised-by/5473/5619-a56d6de393ea8aa2f9b77445.md';
    const diff = [`diff --git a/${p} b/${p}`, 'new file mode 100644', '--- /dev/null', `+++ b/${p}`, '@@ -0,0 +1 @@', '+- Also raised by', ''].join('\n');
    expect(cls(read([p], diff))).toBe('card');
  });
  it('only COVERAGE is a card coverage finding', () => {
    expect(isCardCoverageFinding({ category: 'COVERAGE' })).toBe(true);
    expect(isCardCoverageFinding({ category: 'CORRECTNESS' })).toBe(false);
    expect(isCardCoverageFinding({ category: 'SECURITY' })).toBe(false);
    expect(isCardCoverageFinding({})).toBe(false);
  });
});

describe('panel-seat red team on the card class', () => {
  it('card-only story → not owed; card+code, platform-decisions, decision card → still owed', () => {
    expect(redTeamPanelSeatOwed(payload(read([A], newCard(A))), PANEL)).toBe(false);
    expect(redTeamPanelSeatOwed(payload(read([A, 'scripts/x.mjs'], newCard(A) + codeFile('scripts/x.mjs'))), PANEL)).toBe(true);
    expect(redTeamPanelSeatOwed(payload(read(['docs/agent/platform-decisions.md'], codeFile('docs/agent/platform-decisions.md'))), PANEL)).toBe(true);
    expect(redTeamPanelSeatOwed(payload(read([A], newCard(A, ['kind: decision']))), PANEL)).toBe(true);
  });
  it('skipCardOnly off keeps the seat owed; post-accept timing is unchanged (never panel-owed)', () => {
    const r = payload(read([A], newCard(A)));
    expect(redTeamPanelSeatOwed(r, { ...PANEL, WE_RED_TEAM_SKIP_CARD_ONLY: 'off' })).toBe(true);
    expect(redTeamPanelSeatOwed(r, { WE_RED_TEAM_TIMING: 'post-accept' })).toBe(false);
  });
  it('a recorded or in-flight pass on a card head is still owed its result', () => {
    const r = read([A], newCard(A));
    expect(redTeamOwedOnHead({ read: r, evidence: { recorded: true } })).toBe(true);
    expect(redTeamOwedOnHead({ read: r, evidence: { inFlight: true } })).toBe(true);
  });
  it('review-job: the card-only skip completes the panel seat only on a card-class head', () => {
    const skip = { status: 'skipped', reason: 'red team skipped: card-only' };
    expect(cardClassSkip(skip, payload(read([A], newCard(A))), PANEL)).toBe(true);
    expect(cardClassSkip(skip, payload(read([A], newCard(A, ['kind: decision']))), PANEL)).toBe(false);
    expect(cardClassSkip({ status: 'skipped', reason: 'other' }, payload(read([A], newCard(A))), PANEL)).toBe(false);
    expect(cardClassSkip({ status: 'error' }, payload(read([A], newCard(A))), PANEL)).toBe(false);
  });
});

describe('coverageToCards setting and the io frontmatter read', () => {
  it('defaults on and the env can turn it off', () => {
    const quiet = { readFile: () => '{}', log: () => {}, platform: {} };
    expect(resolveCardOnlyReviewSettings({ env: {}, ...quiet }).value.coverageToCards).toBe(true);
    expect(resolveCardOnlyReviewSettings({ env: { WE_REVIEW_CARD_ONLY_COVERAGE_TO_CARDS: 'off' }, ...quiet }).value.coverageToCards).toBe(false);
  });
  it('reads both sides at the pinned commits, only for a card-only diff; exact delimiters', () => {
    const B = 'b'.repeat(40);
    const blobs = { [`${B}:${A}`]: '---\nkind: decision\n---\nx', [`${REV}:${A}`]: '---\nkind: story\n---\nx' };
    const exec = (_c, args) => (args[0] === 'ls-tree' ? (blobs[`${args[2]}:${args[4]}`] ? `${args[4]}\n` : '') : blobs[args[2]]);
    expect(cardFrontmatterField({ exec, paths: [A], base: B, rev: REV })).toEqual({ cardFrontmatter: { [A]: { old: 'kind: decision', new: 'kind: story' } } });
    expect(cardFrontmatterField({ exec, paths: [A, 'scripts/x.mjs'], base: B, rev: REV })).toEqual({});
    expect(cardFrontmatterField({ exec: () => { throw new Error('git'); }, paths: [A], base: B, rev: REV })).toEqual({ cardFrontmatter: {} });
    expect(frontmatterText('no front')).toBe('');
    expect(frontmatterText('---\ntitle: |\n  ---\nkind: decision\n---\nbody')).toBe('title: |\n  ---\nkind: decision');
  });
});
