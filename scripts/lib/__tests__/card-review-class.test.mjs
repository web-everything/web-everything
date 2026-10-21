import { describe, it, expect } from 'vitest';
import { cardReviewClass, isCardCoverageFinding, CARD_REVIEW_CLASS } from '../card-review-class.mjs';
import { redTeamPanelSeatOwed, redTeamOwedOnHead } from '../review-red-team-policy.mjs';
import { CARD_CLASS_STANDARD, resolveCardClassSettings } from '../review-seat-settings.mjs';
import { cardFrontmatterField, frontmatterText } from '../../operations/review-pr-io.mjs';
import { cardClassRedTeamBinding } from '../../operations/review-job.mjs';
import { chooseSecuritySeat } from '../../operations/review-loop-cli.mjs';

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
  it('second-round audit escapes → full', () => {
    for (const front of [['type: story', '<<: {kind: "deci\\u0073ion"}'], ['kind: "deci\\u0073ion"'], ['kind: story', '<<: {codifiedIn: x}'], ['kind: story', '"r\\u0061tified": x']]) {
      expect(cls(read([A], newCard(A, front))), front.join(' / ')).toBe('full');
    }
    const p = 'backlog/raised-by/1/1-aaaaaaaaaaaaaaaaaaaaaaaa.md';
    expect(cls(read([p], [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, '@@ -1 +1 @@', '-x', '+y', ''].join('\n')))).toBe('full');
    // git says story, the diff shows an escaped decision
    expect(cls(read([A], newCard(A, ['kind: "deci\\u0073ion"']), { cardFrontmatter: { [A]: { old: null, new: 'kind: story' } } }))).toBe('full');
    // quoted header, mismatched +++, mode change, a crafted -0,0 hunk on a modified file
    expect(cls(read([A], newCard(A).replace(`diff --git a/${A} b/${A}`, `diff --git "a/${A}" "b/${A}"`)))).toBe('full');
    expect(cls(read([A], newCard(A).replace(`+++ b/${A}`, '+++ b/scripts/x.mjs')))).toBe('full');
    expect(cls(read([A], newCard(A).replace('new file mode 100644', 'old mode 100644\nnew mode 100755')))).toBe('full');
    const crafted = [`diff --git a/${A} b/${A}`, `--- a/${A}`, `+++ b/${A}`, '@@ -0,0 +1,3 @@', '+---', '+kind: story', '+---', ''].join('\n');
    expect(cls(read([A], crafted))).toBe('full');
    expect(cls(read([A], crafted, { cardFrontmatter: { [A]: { old: null, new: 'kind: story' } } }))).toBe('full');
    expect(cls(read([A], [`diff --git a/${A} b/${A}`, 'old mode 100644', 'new mode 100755', ''].join('\n'), { cardFrontmatter: { [A]: { old: 'kind: story', new: 'kind: story' } } }))).toBe('full');
    expect(isCardCoverageFinding({ category: 'COVERAGE/SECURITY' })).toBe(false);
  });
  it('third-round audit escapes → full', () => {
    const p = 'backlog/raised-by/1/1-aaaaaaaaaaaaaaaaaaaaaaaa.md';
    const note = (body) => [`diff --git a/${p} b/${p}`, 'new file mode 100644', '--- /dev/null', `+++ b/${p}`, `@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`), ''].join('\n');
    expect(cls(read([p], note(['--- ', 'kind: "deci\\u0073ion"', '--- '])))).toBe('full');
    expect(cls(read([p], note(['- Also raised by #1'])))).toBe('card');
    // settings cannot drop the standard exclusions
    const loose = { ...CARD_CLASS_STANDARD, fullKeys: [], fullMarker: '(?!)' };
    expect(cardReviewClass(read([A], newCard(A, ['kind: story', 'codifiedIn: x'])), loose).class).toBe('full');
    expect(cardReviewClass(read([A], newCard(A, ['kind: story', 'rat: 1'])), loose).class).toBe('card');
    // a partial frontmatter hunk contradicting the git reading
    const partial = [`diff --git a/${A} b/${A}`, `--- a/${A}`, `+++ b/${A}`, '@@ -1,2 +1,2 @@', ' ---', '-kind: story', '+kind: "deci\\u0073ion"', ''].join('\n');
    expect(cls(read([A], partial, { cardFrontmatter: { [A]: { old: 'kind: story\ntitle: x', new: 'kind: story\ntitle: x' } } }))).toBe('full');
    const honest = [`diff --git a/${A} b/${A}`, `--- a/${A}`, `+++ b/${A}`, '@@ -1,3 +1,3 @@', ' ---', ' kind: story', '-title: x', '+title: y', ''].join('\n');
    expect(cls(read([A], honest, { cardFrontmatter: { [A]: { old: 'kind: story\ntitle: x\nsize: 1', new: 'kind: story\ntitle: y\nsize: 1' } } }))).toBe('card');
  });
  it('fourth-round audit: a bare CR hiding a field → full (diff and git reading)', () => {
    expect(cls(read([A], newCard(A, ['type: story #\rkind: "deci\\u0073ion"'])))).toBe('full');
    expect(cls(read([A], midEdit(A), { cardFrontmatter: { [A]: { old: 'kind: story', new: 'type: story #\rkind: x' } } }))).toBe('full');
    expect(cls(read([A], newCard(A).replace(/\n/g, '\r\n')))).toBe('full');
    expect(frontmatterText('---\nkind: story\r\n---\n')).toBe('kind: story\r');
  });
  it('fifth-round audit: an appended traditional code patch after a card hunk → full', () => {
    const code = ['--- a/scripts/ci-card-only.mjs', '+++ b/scripts/ci-card-only.mjs', '@@ -17,1 +17,1 @@', '-a', '+b', ''].join('\n');
    expect(cls(read([A], newCard(A) + code))).toBe('full');
    expect(cls(read([A], newCard(A) + code, { cardFrontmatter: { [A]: { old: null, new: 'title: x\nkind: story' } } }))).toBe('full');
    expect(cls(read([A], newCard(A).replace('+body', '+body\n+extra')))).toBe('full'); // count mismatch
  });
  it('post-accept timing: the card-class red-team mode does not apply (skipCardOnly rule unchanged)', async () => {
    const { cardClassRedTeamMode } = await import('../review-red-team-policy.mjs');
    expect(cardClassRedTeamMode(read([A], newCard(A)), { WE_RED_TEAM_TIMING: 'post-accept' })).toBeNull();
    expect(cardClassRedTeamMode(read([A], newCard(A)), PANEL)).toBe('off');
  });
  it('unknown, missing or non-string kind → full (allowlist, not denylist)', () => {
    for (const front of [['kind: proposal'], ['title: x'], ['kind: [story]'], ['kind: {a: 1}']]) expect(cls(read([A], newCard(A, front)))).toBe('full');
  });
  it('git-read frontmatter decides a mid-file edit; any disagreement with the diff can only make it full', () => {
    expect(cardReviewClass(read([A], midEdit(A))).reason).toMatch(/frontmatter not proved/);
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
  it('post-accept timing is unchanged (never panel-owed)', () => {
    expect(redTeamPanelSeatOwed(payload(read([A], newCard(A))), { WE_RED_TEAM_TIMING: 'post-accept' })).toBe(false);
  });
  it('a recorded or in-flight pass on a card head is still owed its result', () => {
    const r = read([A], newCard(A));
    expect(redTeamOwedOnHead({ read: r, evidence: { recorded: true } })).toBe(true);
    expect(redTeamOwedOnHead({ read: r, evidence: { inFlight: true } })).toBe(true);
  });
  it('review-job: the card-only skip completes the panel seat only on a card-class head in mode off', () => {
    const skip = { status: 'skipped', reason: 'red team skipped: card-only' };
    expect(cardClassRedTeamBinding(skip, payload(read([A], newCard(A))), PANEL)).toBe('skip-complete');
    expect(cardClassRedTeamBinding(skip, payload(read([A], newCard(A, ['kind: decision']))), PANEL)).toBe('binding');
    expect(cardClassRedTeamBinding({ status: 'skipped', reason: 'other' }, payload(read([A], newCard(A))), PANEL)).toBe('binding');
    expect(cardClassRedTeamBinding(skip, null, PANEL)).toBe('binding');
    expect(cardClassRedTeamBinding(skip, payload(read([A], newCard(A))), { ...PANEL, WE_REVIEW_CARD_CLASS: 'off' })).toBe('binding');
    expect(cardClassRedTeamBinding({ status: 'ran' }, payload(read([A], newCard(A))), { ...PANEL, WE_REVIEW_CARD_CLASS_RED_TEAM: 'advisory' })).toBe('advisory');
    expect(cardClassRedTeamBinding({ status: 'ran' }, payload(read([A], newCard(A))), { ...PANEL, WE_REVIEW_CARD_CLASS_RED_TEAM: 'on' })).toBe('binding');
  });
  it('red-team mode on and the kill switch restore the panel seat on a card head', () => {
    const r = payload(read([A], newCard(A)));
    expect(redTeamPanelSeatOwed(r, { ...PANEL, WE_REVIEW_CARD_CLASS_RED_TEAM: 'on' })).toBe(true);
    expect(redTeamPanelSeatOwed(r, { ...PANEL, WE_REVIEW_CARD_CLASS: 'off' })).toBe(true);
    expect(redTeamPanelSeatOwed(r, { ...PANEL, WE_REVIEW_CARD_CLASS_RED_TEAM: 'advisory' })).toBe(false);
  });
});

describe('coverageToCards setting and the io frontmatter read', () => {
  it('review.cardClass: standard = the proposal, every field settable per layer, invalid values ignored', () => {
    const q = { readFile: () => '{}', platform: {}, log: () => {} };
    const std = resolveCardClassSettings({ env: {}, ...q });
    expect(std.value).toEqual({ ...CARD_CLASS_STANDARD });
    expect(Object.values(std.sources).every((l) => l === 'standard')).toBe(true);
    const tool = resolveCardClassSettings({ env: {}, readFile: () => JSON.stringify({ cardClass: { redTeam: 'advisory', kinds: ['story'] } }), platform: { coverageRoute: 'referral' }, log: () => {} });
    expect(tool.value).toMatchObject({ redTeam: 'advisory', kinds: ['story'], coverageRoute: 'referral' });
    expect(tool.sources).toMatchObject({ redTeam: 'tool', kinds: 'tool', coverageRoute: 'platform' });
    const env = resolveCardClassSettings({ env: { WE_REVIEW_CARD_CLASS: 'off', WE_REVIEW_CARD_CLASS_LENSES: 'correctness,security',
      WE_REVIEW_CARD_CLASS_KINDS: 'story,decision', WE_REVIEW_CARD_CLASS_LENSES_X: '', WE_REVIEW_CARD_CLASS_RED_TEAM: 'maybe',
      WE_REVIEW_CARD_CLASS_PATH_PATTERNS: '["^backlog/1-"]', WE_REVIEW_CARD_CLASS_FULL_MARKER: '(' }, ...q });
    expect(env.value).toMatchObject({ enabled: false, lenses: ['correctness', 'security'], kinds: CARD_CLASS_STANDARD.kinds, redTeam: 'off', cardPathPatterns: ['^backlog/1-'] });
    expect(env.invalid.join(' ')).toMatch(/kinds.*redTeam.*fullMarker|kinds/);
    expect(resolveCardClassSettings({ env: { WE_REVIEW_CARD_CLASS_LENSES: 'security' }, ...q }).value.lenses).toEqual(['correctness']);
  });
  it('settings drive the class: kill switch, narrowed paths, narrowed kinds, extra full keys and marker', () => {
    const ok = read([A], newCard(A));
    expect(cls(ok)).toBe('card');
    expect(cardReviewClass(ok, { ...CARD_CLASS_STANDARD, enabled: false }).reason).toMatch(/enabled is off/);
    expect(cardReviewClass(ok, { ...CARD_CLASS_STANDARD, cardPathPatterns: ['^backlog/9-'] }).class).toBe('full');
    expect(cardReviewClass(ok, { ...CARD_CLASS_STANDARD, cardPathPatterns: ['.*'] }).class).toBe('card');
    expect(cardReviewClass(read(['scripts/x.mjs'], codeFile('scripts/x.mjs')), { ...CARD_CLASS_STANDARD, cardPathPatterns: ['.*'] }).class).toBe('full');
    expect(cardReviewClass(ok, { ...CARD_CLASS_STANDARD, kinds: ['task'] }).class).toBe('full');
    expect(cardReviewClass(ok, { ...CARD_CLASS_STANDARD, kinds: ['story', 'decision'] }).class).toBe('card');
    expect(cardReviewClass(read([A], newCard(A, ['kind: decision'])), { ...CARD_CLASS_STANDARD, kinds: ['story', 'decision'], fullMarker: 'zzz' }).class).toBe('full');
    expect(cardReviewClass(read([A], newCard(A, ['kind: story', 'owner: x'])), { ...CARD_CLASS_STANDARD, fullKeys: ['owner'] }).class).toBe('full');
    expect(cardReviewClass(ok, { ...CARD_CLASS_STANDARD, fullMarker: 'body' }).class).toBe('full');
  });
  it('lenses: security adds the security seat on the light lane; the kill switch drops it', () => {
    const r = { readChangedFiles: () => ({ files: [A], source: 'git' }) };
    const cardOnly = { lightLane: true, claudeSeat: false };
    expect(chooseSecuritySeat(['--pr=5'], { ...r, cardOnly, cardClass: CARD_CLASS_STANDARD })).toMatchObject({ cardOnlyLight: true, securitySeat: false });
    expect(chooseSecuritySeat(['--pr=5'], { ...r, cardOnly, cardClass: { ...CARD_CLASS_STANDARD, lenses: ['correctness', 'security'] } }).securitySeat).toBe(true);
    expect(chooseSecuritySeat(['--pr=5'], { ...r, cardOnly, cardClass: { ...CARD_CLASS_STANDARD, enabled: false, lenses: ['correctness', 'security'] } }).securitySeat).toBe(false);
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
