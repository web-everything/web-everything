import { describe, it, expect } from 'vitest';
import { cardReviewClass, isCardCoverageFinding, CARD_REVIEW_CLASS } from '../card-review-class.mjs';
import { redTeamPanelSeatOwed, redTeamOwedOnHead } from '../review-red-team-policy.mjs';
import { resolveCardOnlyReviewSettings } from '../review-seat-settings.mjs';
import { cardFrontmatterField, frontmatterLines } from '../../operations/review-pr-io.mjs';

const REV = 'a'.repeat(40);
const newCard = (path, front = ['title: x', 'kind: story']) => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
  `@@ -0,0 +1,${front.length + 4} @@`, '+---', ...front.map((l) => `+${l}`), '+---', '+', '+body', '',
].join('\n');
const codeFile = (path) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -10,1 +10,1 @@', '-a', '+b', ''].join('\n');
const read = (files, diffText, extra = {}) => ({ netChangedFiles: files, netRenameSources: [], diffText, netBasis: { rev: REV }, ...extra });
const payload = (r) => ({ findings: { read: r } });
const PANEL = { WE_RED_TEAM_TIMING: 'panel-seat' };

describe('card review class', () => {
  it('card-only story card → card (light routing)', () => {
    expect(cardReviewClass(read(['backlog/1-a.md'], newCard('backlog/1-a.md'))).class).toBe(CARD_REVIEW_CLASS.CARD);
  });
  it('card + code → full', () => {
    const r = read(['backlog/1-a.md', 'scripts/x.mjs'], newCard('backlog/1-a.md') + codeFile('scripts/x.mjs'));
    expect(cardReviewClass(r)).toMatchObject({ class: 'full', reason: 'touches a non-card path' });
  });
  it('card + docs/agent/platform-decisions.md → full', () => {
    const r = read(['backlog/1-a.md', 'docs/agent/platform-decisions.md'], newCard('backlog/1-a.md') + codeFile('docs/agent/platform-decisions.md'));
    expect(cardReviewClass(r).class).toBe('full');
  });
  it('decision card or ratified card → full (human gate and today routing kept)', () => {
    for (const front of [['kind: decision'], ['kind: "decision"'], ['type: decision'], ['kind: story', 'codifiedIn: docs/agent/platform-decisions.md'], ['ratified: 2026-10-01']]) {
      expect(cardReviewClass(read(['backlog/1-a.md'], newCard('backlog/1-a.md', front))).class).toBe('full');
    }
  });
  it('a story turned from a decision (old side decision) → full, via git-read frontmatter', () => {
    const diff = ['diff --git a/backlog/1-a.md b/backlog/1-a.md', '--- a/backlog/1-a.md', '+++ b/backlog/1-a.md', '@@ -30,1 +30,1 @@', '-old', '+new', ''].join('\n');
    expect(cardReviewClass(read(['backlog/1-a.md'], diff)).reason).toMatch(/frontmatter not fully shown/);
    const git = { 'backlog/1-a.md': { old: ['kind: decision'], new: ['kind: story'] } };
    expect(cardReviewClass(read(['backlog/1-a.md'], diff, { cardFrontmatter: git })).class).toBe('full');
    const plain = { 'backlog/1-a.md': { old: ['type: story'], new: ['type: story'] } };
    expect(cardReviewClass(read(['backlog/1-a.md'], diff, { cardFrontmatter: plain })).class).toBe('card');
  });
  it('fails closed: degraded, unpinned, empty diff, rename, missing block, no frontmatter', () => {
    const ok = read(['backlog/1-a.md'], newCard('backlog/1-a.md'));
    expect(cardReviewClass({ ...ok, degraded: true }).class).toBe('full');
    expect(cardReviewClass({ ...ok, netBasis: { rev: 'abc' } }).class).toBe('full');
    expect(cardReviewClass({ ...ok, diffText: '' }).class).toBe('full');
    expect(cardReviewClass({ ...ok, netRenameSources: ['scripts/x.mjs'] }).class).toBe('full');
    expect(cardReviewClass(read(['backlog/1-a.md', 'backlog/2-b.md'], newCard('backlog/1-a.md'))).class).toBe('full');
    const bare = newCard('backlog/1-a.md').replace('+---\n+title', '+title');
    expect(cardReviewClass(read(['backlog/1-a.md'], bare)).class).toBe('full');
    expect(cardReviewClass(null).class).toBe('full');
  });
  it('raised-by pointer notes need no frontmatter', () => {
    const p = 'backlog/raised-by/5473/5619-a56d6de393ea8aa2f9b77445.md';
    const diff = [`diff --git a/${p} b/${p}`, 'new file mode 100644', '--- /dev/null', `+++ b/${p}`, '@@ -0,0 +1 @@', '+- Also raised by', ''].join('\n');
    expect(cardReviewClass(read([p], diff)).class).toBe('card');
  });
  it('only COVERAGE is a card coverage finding', () => {
    expect(isCardCoverageFinding({ category: 'COVERAGE' })).toBe(true);
    expect(isCardCoverageFinding({ category: 'coverage — test plan' })).toBe(true);
    expect(isCardCoverageFinding({ category: 'CORRECTNESS' })).toBe(false);
    expect(isCardCoverageFinding({})).toBe(false);
  });
});

describe('panel-seat red team on the card class', () => {
  it('card-only story → not owed; card+code, platform-decisions, decision card → still owed', () => {
    expect(redTeamPanelSeatOwed(payload(read(['backlog/1-a.md'], newCard('backlog/1-a.md'))), PANEL)).toBe(false);
    expect(redTeamPanelSeatOwed(payload(read(['backlog/1-a.md', 'scripts/x.mjs'], newCard('backlog/1-a.md') + codeFile('scripts/x.mjs'))), PANEL)).toBe(true);
    expect(redTeamPanelSeatOwed(payload(read(['docs/agent/platform-decisions.md'], codeFile('docs/agent/platform-decisions.md'))), PANEL)).toBe(true);
    expect(redTeamPanelSeatOwed(payload(read(['backlog/1-a.md'], newCard('backlog/1-a.md', ['kind: decision']))), PANEL)).toBe(true);
  });
  it('skipCardOnly off keeps the seat owed; post-accept timing is unchanged (never panel-owed)', () => {
    const r = payload(read(['backlog/1-a.md'], newCard('backlog/1-a.md')));
    expect(redTeamPanelSeatOwed(r, { ...PANEL, WE_RED_TEAM_SKIP_CARD_ONLY: 'off' })).toBe(true);
    expect(redTeamPanelSeatOwed(r, { WE_RED_TEAM_TIMING: 'post-accept' })).toBe(false);
  });
  it('a recorded or in-flight pass on a card head is still owed its result', () => {
    const r = read(['backlog/1-a.md'], newCard('backlog/1-a.md'));
    expect(redTeamOwedOnHead({ read: r, evidence: { recorded: true } })).toBe(true);
    expect(redTeamOwedOnHead({ read: r, evidence: { inFlight: true } })).toBe(true);
  });
});

describe('coverageToCards setting and the io frontmatter read', () => {
  it('defaults on and the env can turn it off', () => {
    const quiet = { readFile: () => '{}', log: () => {}, platform: {} };
    expect(resolveCardOnlyReviewSettings({ env: {}, ...quiet }).value.coverageToCards).toBe(true);
    expect(resolveCardOnlyReviewSettings({ env: { WE_REVIEW_CARD_ONLY_COVERAGE_TO_CARDS: 'off' }, ...quiet }).value.coverageToCards).toBe(false);
  });
  it('reads both sides at the pinned commits, only for a card-only diff', () => {
    const B = 'b'.repeat(40);
    const blobs = { [`${B}:backlog/1-a.md`]: '---\ntype: decision\n---\nx', [`${REV}:backlog/1-a.md`]: '---\ntype: story\n---\nx' };
    const exec = (_c, args) => (args[0] === 'ls-tree' ? (blobs[`${args[2]}:${args[4]}`] ? args[4] : '') : blobs[args[2]]);
    expect(cardFrontmatterField({ exec, paths: ['backlog/1-a.md'], base: B, rev: REV }))
      .toEqual({ cardFrontmatter: { 'backlog/1-a.md': { old: ['type: decision'], new: ['type: story'] } } });
    expect(cardFrontmatterField({ exec, paths: ['backlog/1-a.md', 'scripts/x.mjs'], base: B, rev: REV })).toEqual({});
    expect(cardFrontmatterField({ exec: () => { throw new Error('git'); }, paths: ['backlog/1-a.md'], base: B, rev: REV })).toEqual({ cardFrontmatter: {} });
    expect(frontmatterLines('no front')).toEqual([]);
  });
});
