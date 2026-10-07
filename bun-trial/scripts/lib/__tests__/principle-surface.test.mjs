/**
 * #2892 — `isPrincipleSurface` (#2840, `#human-is-principle-surface-not-path`): the three triggers, their fail
 * directions, and — the part a unit test of the isolated predicate cannot give — the WIRING: real `git diff`
 * text, through `scoreEscalation`, deciding `humanRequired`.
 */
import { describe, it, test, expect, afterAll } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/lib/__tests__/principle-surface.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isPrincipleSurface, principleSurfaceTriggers, isStatuteAnchorEdit, statuteAnchorEditKind, isMarkedInvariantEdit,
  isDeclarativeLeashPath, parseFileHunks, MARKED_BLOCK_MAX_LINES, POLICY_SPEC_BASENAMES,
} from '../../../../scripts/lib/gate-config.mjs';
import { scoreEscalation, indexDiffSections, fileHunksResolver } from '../../../../scripts/lib/review-escalation.mjs';

const ROOT = join(dirname(fileURLToPath(__ORIG_URL)), '..', '..', '..');
const STATUTE = 'docs/agent/platform-decisions.md';
const tmpDirs = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

/** A REAL unified diff (git's own output, default -U3) between two file-tree states — the same shape
 *  `computeNetDiffText` feeds `scoreEscalation`, never a hand-typed approximation of it. */
function realDiff(before, after, { noprefix = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'we-2892-'));
  tmpDirs.push(dir);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', `diff.noprefix=${noprefix}`, '-c', 'diff.renames=true', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (tree) => {
    for (const [rel, body] of Object.entries(tree)) {
      if (body === null) { rmSync(join(dir, rel), { force: true }); continue; }
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
  };
  git('init', '-q');
  write(before);
  git('add', '-A'); git('commit', '-q', '-m', 'base', '--no-gpg-sign');
  write(after);
  git('add', '-A'); git('commit', '-q', '-m', 'head', '--no-gpg-sign');
  return git('diff', '--no-ext-diff', 'HEAD~1', 'HEAD');
}

const lines = (...xs) => xs.join('\n') + '\n';
const indexDiffSectionText = (diff, path) => fileHunksResolver(diff)(path);
const HUMAN = (changedFiles, diffHunks) => scoreEscalation({ changedFiles, diffHunks });

// ── trigger 1: statute-anchor edit ──────────────────────────────────────────────────────────────────────
describe('trigger 1 — statute-anchor edit: rule text, not the whole document', () => {
  const doc = lines(
    '# Platform decisions', '', '### First rule {#first-rule}', '', '**Ratified** the operator ruled that agents may not do X.', 'A second line of the ruling body.', '',
    '**Lineage:** ratified by #1.', '', '---', '', '### Second rule {#second-rule}', '', 'Body two.');

  it('a REFLOW / whitespace-only touch no longer fires (the one intended narrowing)', () => {
    const reflowed = doc.replace('**Ratified** the operator ruled that agents may not do X.\nA second line', '**Ratified**  the operator ruled\nthat agents may not do X. A second line');
    const diff = realDiff({ [STATUTE]: doc }, { [STATUTE]: reflowed });
    expect(diff).toContain('@@');
    expect(isStatuteAnchorEdit(STATUTE, diff)).toBe(false);
    const s = HUMAN([STATUTE], diff);
    expect(s.humanRequired).toBe(false);
    // …but it is still statute-layer work: it ESCALATES to the committee (blast-radius), it just no longer needs a person.
    expect(s.escalate).toBe(true);
    expect(s.signals.blastRadius).toContain(STATUTE);
  });

  it('a rule-BODY edit fires, and reports `rule-body`', () => {
    const edited = doc.replace('may not do X', 'may do X');
    const diff = realDiff({ [STATUTE]: doc }, { [STATUTE]: edited });
    expect(statuteAnchorEditKind(STATUTE, diff)).toBe('rule-body');
    const s = HUMAN([STATUTE], diff);
    expect(s.humanRequired).toBe(true);
    expect(s.signals.statute).toEqual([STATUTE]);
  });

  it('adding, removing or altering an anchored rule HEADING fires, and reports `anchor-heading`', () => {
    for (const edited of [
      doc.replace('{#second-rule}', '{#renamed-rule}'),                       // alter the anchor
      doc.replace('### Second rule {#second-rule}\n\nBody two.\n', ''),         // remove a whole rule
      doc + '\n### A new rule {#new-rule}\n\nNew body.\n',                      // add a rule
    ]) {
      const diff = realDiff({ [STATUTE]: doc }, { [STATUTE]: edited });
      expect(statuteAnchorEditKind(STATUTE, diff)).toBe('anchor-heading');
      expect(HUMAN([STATUTE], diff).humanRequired).toBe(true);
    }
  });

  it('a reflow that ALSO changes one word still fires (the collapsed text differs)', () => {
    const edited = doc.replace('**Ratified** the operator ruled that agents may not do X.\nA second line', '**Ratified** the operator\nruled that agents may do X. A second line');
    expect(HUMAN([STATUTE], realDiff({ [STATUTE]: doc }, { [STATUTE]: edited })).humanRequired).toBe(true);
  });

  it('FAIL-CLOSED — hunks NOT COMPUTED, or no section for the file, fires exactly as the old whole-file gate did', () => {
    expect(HUMAN([STATUTE], null).humanRequired).toBe(true);                    // no diff text at all
    expect(HUMAN([STATUTE], '').humanRequired).toBe(true);                      // computed-empty diff, yet the file is in the basis
    const other = realDiff({ 'src/a.md': 'a\n' }, { 'src/a.md': 'b\n' });
    expect(HUMAN([STATUTE], other).humanRequired).toBe(true);                   // hunks cover a DIFFERENT file only
    expect(statuteAnchorEditKind(STATUTE, null)).toBe('unevaluable');
  });

  it('FAIL-CLOSED — a deleted or binary statute doc fires (there is no rule text to compare)', () => {
    const deleted = realDiff({ [STATUTE]: doc }, { [STATUTE]: null });
    expect(deleted).toContain('deleted file mode');
    expect(HUMAN([STATUTE], deleted).humanRequired).toBe(true);
    const binary = realDiff({ [STATUTE]: 'a\0b\n' }, { [STATUTE]: 'a\0c\n' });
    expect(binary).toContain('Binary files');
    expect(HUMAN([STATUTE], binary).humanRequired).toBe(true);
  });

  it('a mode-only touch of the statute doc changes no rule text and does not fire', () => {
    const diff = `diff --git a/${STATUTE} b/${STATUTE}\nold mode 100644\nnew mode 100755\n`;
    expect(HUMAN([STATUTE], diff).humanRequired).toBe(false);
  });

  it('a line MOVED across an anchored heading inside ONE hunk fires (its `-` and `+` blocks are each unbalanced, so they do not cancel)', () => {
    const before = lines('### Rule A {#a}', '', 'Agents may not do X.', '', '### Rule B {#b}', '', 'Body B.');
    const after = lines('### Rule A {#a}', '', '', '### Rule B {#b}', '', 'Agents may not do X.', 'Body B.');
    const diff = realDiff({ [STATUTE]: before }, { [STATUTE]: after });
    expect((diff.match(/^@@/gm) || []).length).toBe(1);                            // really one hunk
    expect(statuteAnchorEditKind(STATUTE, diff)).not.toBeNull();
    expect(HUMAN([STATUTE], diff).humanRequired).toBe(true);
  });

  it('two SEPARATE whitespace-only touches in one hunk still do not fire (each change block balances on its own)', () => {
    const before = lines('### R {#r}', 'one two', 'ctx', 'ctx2', 'three four', 'end');
    const after = lines('### R {#r}', 'one  two', 'ctx', 'ctx2', 'three   four', 'end');
    const diff = realDiff({ [STATUTE]: before }, { [STATUTE]: after });
    expect(HUMAN([STATUTE], diff).humanRequired).toBe(false);
  });

  it('a RENAME INTO the statute layer (no hunks, but rule text arrives at that path) fires; a pure mode change does not', () => {
    const other = 'docs/agent/other-statute-notes.md';
    const body = lines('### Rule {#r}', ...Array.from({ length: 12 }, (_, i) => `line ${i}`));
    const diff = realDiff({ 'notes/draft.md': body }, { 'notes/draft.md': null, [other]: body });
    expect(diff).toContain('rename to docs/agent/other-statute-notes.md');
    expect(parseFileHunks(indexDiffSectionText(diff, other)).hunks).toHaveLength(0);
    expect(HUMAN([other], diff).humanRequired).toBe(true);
    const modeOnly = `diff --git a/${STATUTE} b/${STATUTE}\nold mode 100644\nnew mode 100755\n`;
    expect(HUMAN([STATUTE], modeOnly).humanRequired).toBe(false);
  });

  it('a rename INTO the statute layer fires even when it carries only a whitespace tweak (the hunks balance, the structure does not)', () => {
    const body = lines('### Rule {#r}', ...Array.from({ length: 12 }, (_, i) => `line ${i}`));
    const tweaked = body.replace('line 3', 'line 3 ');
    const diff = realDiff({ 'notes/draft.md': body }, { 'notes/draft.md': null, 'docs/agent/other-statute-notes.md': tweaked });
    expect(diff).toContain('rename to docs/agent/other-statute-notes.md');
    expect(diff).toContain('@@');
    expect(HUMAN(['docs/agent/other-statute-notes.md'], diff).humanRequired).toBe(true);
  });

  it('merging a heading into the line below it is NOT a whitespace touch — same words, different heading', () => {
    const before = lines('### Rule {#a}', '', 'body text', '', 'more');
    const after = lines('### Rule {#a} body text', '', 'more');
    const diff = realDiff({ [STATUTE]: before }, { [STATUTE]: after });
    expect(HUMAN([STATUTE], diff).humanRequired).toBe(true);
    // …whereas re-wrapping the body (no heading line involved) and dropping a blank line still does not fire.
    const rewrapped = realDiff({ [STATUTE]: lines('### Rule {#a}', '', 'body text', 'more', '', 'tail') }, { [STATUTE]: lines('### Rule {#a}', '', 'body', 'text more', 'tail') });
    expect(HUMAN([STATUTE], rewrapped).humanRequired).toBe(false);
  });

  it('setext headings and indented-code blocks are structure too — a reflow may not create or destroy them', () => {
    const setext = realDiff({ [STATUTE]: lines('Rule', '---', 'body') }, { [STATUTE]: lines('Rule ---', 'body') });
    expect(HUMAN([STATUTE], setext).humanRequired).toBe(true);
    const indented = realDiff({ [STATUTE]: lines('### R {#r}', '', 'a paragraph line', 'more') }, { [STATUTE]: lines('### R {#r}', '', '    a paragraph line', 'more') });
    expect(HUMAN([STATUTE], indented).humanRequired).toBe(true);
  });

  it('merging list items, or nesting one, is structure too — same words, different list', () => {
    const merged = realDiff({ [STATUTE]: lines('### R {#r}', '', '- Agents may not do X.', '- Agents may not do Y.') }, { [STATUTE]: lines('### R {#r}', '', '- Agents may not do X. Agents may not do Y.') });
    expect(HUMAN([STATUTE], merged).humanRequired).toBe(true);
    const rewrapped = realDiff({ [STATUTE]: lines('### R {#r}', '', '- Agents may not do X and', '  may not do Y.', '- Next.') }, { [STATUTE]: lines('### R {#r}', '', '- Agents may not do X', '  and may not do Y.', '- Next.') });
    expect(HUMAN([STATUTE], rewrapped).humanRequired).toBe(false);
  });

  it('a non-statute path never fires this trigger, whatever its hunks say', () => {
    const diff = realDiff({ 'docs/other.md': 'a\n' }, { 'docs/other.md': 'b\n' });
    expect(isStatuteAnchorEdit('docs/other.md', diff)).toBe(false);
  });
});

// ── trigger 2: marked @principle / @invariant edit ─────────────────────────────────────────────────────────
describe('trigger 2 — an edit to a @principle/@invariant block that ALREADY EXISTS in base', () => {
  const F = 'src/guard.mjs';
  const base = lines(
    'export function unrelated() { return 1; }', '',
    '// @invariant never-self-clear (#some-anchor) — a reviewer never clears its own PR',
    'export function mayClear(reviewer, author) {',
    '  return reviewer !== author;',
    '}', '',
    'export function tail1() {}', 'export function tail2() {}', 'export function tail3() {}', 'export function tail4() {}', 'export function tail5() {}');
  const fire = (after) => isMarkedInvariantEdit(F, realDiff({ [F]: base }, { [F]: after }));

  it('editing the assertion under the marker fires', () => {
    expect(fire(base.replace('reviewer !== author', 'true'))).toBe(true);
  });
  it('REMOVING the marker, or the whole marked block, fires', () => {
    expect(fire(base.replace(/\/\/ @invariant[^\n]*\n/, ''))).toBe(true);
    expect(fire(base.replace(/\/\/ @invariant[\s\S]*?\n}\n/, ''))).toBe(true);
  });
  it('EDITING the marker line itself fires', () => {
    expect(fire(base.replace('never-self-clear', 'sometimes-self-clear'))).toBe(true);
  });
  it('inserting a line directly inside / under the block fires', () => {
    expect(fire(base.replace('  return reviewer !== author;', '  if (!reviewer) return true;\n  return reviewer !== author;'))).toBe(true);
    expect(fire(base.replace('return reviewer !== author;\n', 'return reviewer !== author;\n  // trailing\n'))).toBe(true);
  });
  it('a whitespace-only touch INSIDE the block still fires (a blank line can detach the tail from its marker)', () => {
    expect(fire(base.replace('export function mayClear(reviewer, author) {', 'export function mayClear(reviewer, author) {\n'))).toBe(true);
  });
  it('an edit OUTSIDE the block does not fire — above it, or below its blank-line terminator', () => {
    expect(fire(base.replace('return 1;', 'return 2;'))).toBe(false);
    expect(fire(base.replace('tail5', 'tail5b'))).toBe(false);
    expect(fire(base.replace('export function tail1() {}', 'export function tail1() { return 0; }'))).toBe(false);
  });
  it('ADDING a brand-new marked invariant is implementation, not a principle edit — no base marker, no fire', () => {
    const added = base.replace('export function tail5() {}', '// @invariant a-new-one (#some-anchor)\nexport function tail5() {}');
    expect(fire(added)).toBe(false);
    // …and a new marker+assertion sitting NEXT TO an untouched old one does not drag the old one in.
    const two = base + '\n// @principle brand-new (#other)\nexport const NEW = 1;\n';
    expect(fire(two)).toBe(false);
  });
  it('the block is capped at MARKED_BLOCK_MAX_LINES — a line beyond it is outside the guarantee (and the cap fits default hunk context)', () => {
    const tall = lines('// @invariant tall', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8');
    const at = (n) => isMarkedInvariantEdit('x.mjs', realDiff({ 'x.mjs': tall }, { 'x.mjs': tall.replace(`a${n}`, `a${n}!`) }));
    expect(MARKED_BLOCK_MAX_LINES).toBe(3);
    for (const n of [1, 2, 3]) expect(at(n)).toBe(true);     // distance 1..3 from the marker
    for (const n of [4, 5, 8]) expect(at(n)).toBe(false);    // distance 4+ — outside the grammar
  });
  it('recognizes each comment leader, and ignores prose that merely MENTIONS the tokens', () => {
    const mk = (line) => realDiff({ 'y.txt': `${line}\nguarded\n` }, { 'y.txt': `${line}\nguarded!\n` });
    for (const line of ['// @invariant x', '/* @principle x */', ' * @invariant x', '# @principle x', '  <!-- @invariant x -->', '///  @principle x']) {
      expect(isMarkedInvariantEdit('y.txt', mk(line)), line).toBe(true);
    }
    for (const line of ['the @principle marker is documented', 'const s = "// @invariant x";', '// see `@invariant` in the docs', '// @invariantly true', '// @principle-ish', 'email@principle.io']) {
      expect(isMarkedInvariantEdit('y.txt', mk(line)), line).toBe(false);
    }
  });
  it('two changes in DIFFERENT hunks are judged independently', () => {
    const big = lines('// @invariant i1', 'guard1', ...Array.from({ length: 30 }, (_, i) => `filler${i}`), 'plain', 'plain2');
    const diff = realDiff({ 'z.mjs': big }, { 'z.mjs': big.replace('plain2', 'plain2!') });
    expect(isMarkedInvariantEdit('z.mjs', diff)).toBe(false);          // only the far, unmarked hunk changed
    expect(isMarkedInvariantEdit('z.mjs', realDiff({ 'z.mjs': big }, { 'z.mjs': big.replace('plain2', 'plain2!').replace('guard1', 'guard1!') }))).toBe(true);
  });
  it('is ADDITIVE — hunks NOT COMPUTED contribute nothing (it must not human-gate every PR scored without a clone)', () => {
    expect(isMarkedInvariantEdit(F, null)).toBe(false);
    expect(isMarkedInvariantEdit(F, undefined)).toBe(false);
    expect(isMarkedInvariantEdit(F, realDiff({ 'b.bin': 'a\0b\n' }, { 'b.bin': 'a\0c\n' }))).toBe(false);
  });
  it('a deleted file that carried a marker fires (every base line is removed)', () => {
    expect(isMarkedInvariantEdit(F, realDiff({ [F]: base }, { [F]: null }))).toBe(true);
  });
});

// ── trigger 3 + the composition ──────────────────────────────────────────────────────────────────────────
describe('trigger 3 + composition — the declarative-leash path floor is unconditional', () => {
  it('every POLICY_SPEC file is a principle surface whatever its hunks are — empty, absent, or a pure-whitespace touch', () => {
    for (const name of POLICY_SPEC_BASENAMES) {
      const path = `some/relocated/dir/${name}`;
      expect(isDeclarativeLeashPath(path)).toBe(true);
      for (const hunks of [null, undefined, '', 'garbage', realDiff({ [name]: 'a\n' }, { [name]: 'a \n' })]) {
        expect(isPrincipleSurface(path, hunks), `${name} / ${JSON.stringify(hunks)?.slice(0, 20)}`).toBe(true);
        expect(principleSurfaceTriggers(path, hunks)).toContain('leash-path');
      }
    }
  });
  it('an ordinary file with no principle content is not a principle surface', () => {
    const diff = realDiff({ 'src/x.mjs': 'a\n' }, { 'src/x.mjs': 'b\n' });
    expect(isPrincipleSurface('src/x.mjs', diff)).toBe(false);
    expect(principleSurfaceTriggers('src/x.mjs', diff)).toEqual([]);
  });
  it('the triggers are a UNION — a statute doc carrying an edited marker reports both', () => {
    const before = { [STATUTE]: '### R {#r}\n\n<!-- @invariant m -->\nguard\n' };
    const diff = realDiff(before, { [STATUTE]: '### R {#r}\n\n<!-- @invariant m -->\nguard!\n' });
    expect(principleSurfaceTriggers(STATUTE, diff)).toEqual(['statute-anchor', 'marked-invariant']);
  });
});

// ── isPrincipleSurface IS the union principleSurfaceTriggers reports ─────────────────────────────────────
describe('isPrincipleSurface and principleSurfaceTriggers cannot diverge', () => {
  it('agree over the whole trigger matrix — leash / statute / marker, each with and without hunks', () => {
    const mk = (a, b, path) => realDiff({ [path]: a }, { [path]: b });
    const marked = lines('// @invariant m', 'guard');
    const cases = [
      ['scripts/lib/review-policy.contract.json', null], ['scripts/lib/gate-config.mjs', ''],
      [STATUTE, null], [STATUTE, ''], [STATUTE, mk('### R {#r}\n\na b\n', '### R {#r}\n\na  b\n', STATUTE)], [STATUTE, mk('### R {#r}\n\na\n', '### R {#r}\n\nb\n', STATUTE)],
      ['src/m.mjs', mk(marked, marked.replace('guard', 'guard!'), 'src/m.mjs')], ['src/m.mjs', mk('a\n', 'b\n', 'src/m.mjs')], ['src/m.mjs', null], ['src/x.mjs', undefined],
    ];
    for (const [path, hunks] of cases) {
      expect(isPrincipleSurface(path, hunks), `${path}`).toBe(principleSurfaceTriggers(path, hunks).length > 0);
    }
  });
});

// ── the wiring: real diff → per-file section → scoreEscalation ────────────────────────────────────────────
describe('scoreEscalation reads each file\'s OWN hunks (integration through the real call path)', () => {
  it('a multi-file diff: only the file whose section is a principle surface makes it human', () => {
    const marked = lines('// @invariant m', 'guard');
    const diff = realDiff(
      { 'a/plain.mjs': 'x\n', 'b/marked.mjs': marked, [STATUTE]: '### R {#r}\n\nbody one\n' },
      { 'a/plain.mjs': 'y\n', 'b/marked.mjs': marked.replace('guard', 'guard!'), [STATUTE]: '### R {#r}\n\nbody  one\n' });
    const s = HUMAN(['a/plain.mjs', 'b/marked.mjs', STATUTE], diff);
    expect(s.humanRequired).toBe(true);
    expect(s.signals.markedInvariant).toEqual(['b/marked.mjs']);
    expect(s.signals.statute).toBeUndefined();                       // its statute hunk was whitespace-only
    expect(s.reasons.some((r) => /principle-surface \(b\/marked\.mjs\)/.test(r))).toBe(true);
    // Take the marked file out of the basis and the same diff no longer needs a person.
    expect(HUMAN(['a/plain.mjs', STATUTE], diff).humanRequired).toBe(false);
  });

  it('a policy DERIVATION file whose diff is not a principle surface still ESCALATES, to the committee — not a human', () => {
    const diff = realDiff({ 'scripts/lib/review-core.mjs': 'a\n' }, { 'scripts/lib/review-core.mjs': 'b\n' });
    const s = HUMAN(['scripts/lib/review-core.mjs'], diff);
    expect(s.escalate).toBe(true);
    expect(s.humanRequired).toBe(false);
    expect(s.signals.gateDerivation).toEqual(['scripts/lib/review-core.mjs']);
  });

  it('a leash file is human even when its own hunks are empty or the diff was not computed', () => {
    expect(HUMAN(['scripts/lib/review-policy.contract.json'], null).humanRequired).toBe(true);
    expect(HUMAN(['scripts/lib/review-policy.contract.json'], '').humanRequired).toBe(true);
  });

  it('a path that git C-quotes in its headers still resolves to its own section (non-ASCII basename)', () => {
    const diff = realDiff({ 'src/café.mjs': lines('// @invariant m', 'g') }, { 'src/café.mjs': lines('// @invariant m', 'g!') });
    expect(diff).toContain('"b/src/caf\\303\\251.mjs"');
    expect(fileHunksResolver(diff)('src/café.mjs')).toContain('@@');
    expect(HUMAN(['src/café.mjs'], diff).signals.markedInvariant).toEqual(['src/café.mjs']);
  });

  it('resolves under a `diff.noprefix` producer too (the code supports it, so a test must pin it)', () => {
    const marked = lines('// @invariant m', 'guard');
    const diff = realDiff({ 'src/m.mjs': marked, [STATUTE]: '### R {#r}\n\nbody\n' }, { 'src/m.mjs': marked.replace('guard', 'guard!'), [STATUTE]: '### R {#r}\n\nbody!\n' }, { noprefix: true });
    expect(diff).toContain('diff --git src/m.mjs src/m.mjs');
    const s = HUMAN(['src/m.mjs', STATUTE], diff);
    expect(s.signals.markedInvariant).toEqual(['src/m.mjs']);
    expect(s.signals.statute).toEqual([STATUTE]);
  });

  it('a DECOY file at `a/<statute path>` cannot claim the statute doc\'s section — under either producer', () => {
    const decoy = `a/${STATUTE}`;
    for (const noprefix of [false, true]) {
      const diff = realDiff(
        { [decoy]: 'x\n', [STATUTE]: '### R {#r}\n\nbody\n' },
        { [decoy]: 'x \n', [STATUTE]: '### R {#r}\n\nbody CHANGED\n' },   // decoy: whitespace only; real doc: a real edit
        { noprefix });
      const s = HUMAN([STATUTE], diff);
      expect(s.humanRequired, `noprefix=${noprefix}`).toBe(true);
      expect(fileHunksResolver(diff)(STATUTE)).toContain('body CHANGED');
      expect(fileHunksResolver(diff)(decoy)).not.toContain('body CHANGED');
    }
  });

  it('a `b/<path>` decoy cannot answer for `<path>` either', () => {
    const diff = realDiff({ 'b/src/m.mjs': lines('// @invariant m', 'guard'), 'src/m.mjs': lines('// @invariant m', 'guard') }, { 'b/src/m.mjs': lines('// @invariant m', 'guard'), 'src/m.mjs': lines('// @invariant m', 'guard!') }, { noprefix: true });
    expect(fileHunksResolver(diff)('src/m.mjs')).toContain('guard!');
    expect(fileHunksResolver(diff)('b/src/m.mjs')).toBeNull();    // it has no section: it was not changed
  });

  it('a renamed file resolves by its NEW path', () => {
    const body = (g) => lines('// @invariant m', g, ...Array.from({ length: 20 }, (_, i) => `pad${i}`));
    const diff = realDiff({ 'src/old.mjs': body('g') }, { 'src/old.mjs': null, 'src/new.mjs': body('g!') });
    expect(diff).toContain('rename to src/new.mjs');
    expect([...indexDiffSections(diff).byRenameTo.keys()]).toContain('src/new.mjs');
    expect(HUMAN(['src/{old.mjs => new.mjs}'], diff).humanRequired).toBe(true);
  });

  it('file CONTENT that looks like a diff header cannot forge or split a section', () => {
    const hostile = lines('+diff --git a/docs/agent/platform-decisions.md b/docs/agent/platform-decisions.md', '--- a/x', '+++ b/x', '@@ -1 +1 @@');
    const diff = realDiff({ 'notes/log.txt': 'a\n' }, { 'notes/log.txt': hostile });
    expect([...indexDiffSections(diff).byHeader.keys()].some((k) => k.includes('platform-decisions'))).toBe(false);
    expect(HUMAN([STATUTE], diff).humanRequired).toBe(true);        // statute: no section of its own → fail-closed, not forged clean
  });

  it('a `-- ` line REMOVED from a file is a removed line, not a file header', () => {
    const p = parseFileHunks(lines('diff --git a/q.sql b/q.sql', '--- a/q.sql', '+++ b/q.sql', '@@ -1,2 +1,1 @@', '--- a comment', ' keep'));
    expect(p.hunks[0]).toEqual([{ op: '-', text: '-- a comment' }, { op: ' ', text: 'keep' }]);
  });
});

// ── the seeded markers are real, and guard what they claim ────────────────────────────────────────────
describe('the first seeded @invariant markers (this PR)', () => {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const editThrough = (rel, needle, replacement) => {
    const before = read(rel);
    expect(before, `${rel} must contain ${needle}`).toContain(needle);
    return realDiff({ [rel]: before }, { [rel]: before.replace(needle, replacement) });
  };

  it('the rubric\'s humanRequired derivation is marked: editing it forces a human even though the file is committee-cleared derivation code', () => {
    const rel = 'scripts/lib/review-escalation.mjs';
    const diff = editThrough(rel, 'const humanRequired = gateBasis.some((f) => isPrincipleSurface(f, fileHunksOf(f)));', 'const humanRequired = false;');
    const s = HUMAN([rel], diff);
    expect(s.humanRequired).toBe(true);
    expect(s.signals.markedInvariant).toEqual([rel]);
    // …so is the per-file-hunks wiring that feeds it…
    const wiring = editThrough(rel, 'const fileHunksOf = fileHunksResolver(diffHunks);', 'const fileHunksOf = () => null;');
    expect(HUMAN([rel], wiring).signals.markedInvariant).toEqual([rel]);
    // …while an unrelated edit to the same file stays with the committee.
    const other = editThrough(rel, "reasons.push('cross-repo impl+WE couple')", "reasons.push('cross-repo couple')");
    const o = HUMAN([rel], other);
    expect(o.humanRequired).toBe(false);
    expect(o.signals.gateDerivation).toEqual([rel]);
  });

  it('the composition\'s union is marked', () => {
    const rel = 'scripts/lib/gate-config.mjs';
    const diff = editThrough(rel, 'return isDeclarativeLeashPath(changedFile) || isStatuteAnchorEdit(changedFile, fileHunks) || isMarkedInvariantEdit(changedFile, fileHunks);', 'return false;');
    expect(isMarkedInvariantEdit(rel, diff)).toBe(true);
  });
});

// ── the assumptions the marker grammar and the lazy loader rest on, pinned ─────────────────────────────
describe('the assumptions the content triggers rest on — what is pinned (producer argv, lazy loader, the unavailable signal); a runner-level diff.context is a filed residual (x93vxdr)', () => {
  it('the real PR-time producer runs `git diff` with DEFAULT context — the -U3 assumption behind MARKED_BLOCK_MAX_LINES', async () => {
    const { computeNetDiffText } = await import('../../../../scripts/merge-ai-prs.mjs');
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args);
      if (args[0] === 'diff' && !args.includes('--numstat')) return 'diff --git a/x b/x\n';
      if (args[0] === 'diff') return '1\t0\tx\n';
      if (args[0] === 'log') return '';
      return '';
    };
    const r = computeNetDiffText({ exec, rev: 'deadbeef' });
    expect(r.scored).toBe(true);
    const textDiff = calls.find((a) => a[0] === 'diff' && !a.includes('--numstat'));
    expect(textDiff).toBeTruthy();
    // No context override in ANY spelling — narrower context hides the marker from a hunk (see MARKED_BLOCK_MAX_LINES).
    expect(textDiff.some((a) => /^(-U|--unified|--inter-hunk-context|-W|--function-context)/.test(a))).toBe(false);
  });

  it('rules-loader.cjs does NOT load the markdown renderer just to be imported (gate-config.mjs imports it on the hook / drain path)', () => {
    const out = execFileSync(process.execPath, ['-e', "require('./scripts/lib/rules-loader.cjs'); process.stdout.write(String(Object.keys(require.cache).some((k) => k.includes('markdown-it'))))"], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(out.trim()).toBe('false');
  });

  it('scoreEscalation SAYS when it scored files without any diff text (the additive marker term could not look)', () => {
    expect(HUMAN(['src/x.mjs'], null).signals.hunksUnavailable).toEqual(['src/x.mjs']);
    expect(HUMAN([], null).signals.hunksUnavailable).toBeUndefined();               // nothing was scored
    // A COMPUTED diff that does not cover a scored path (an own-delta-only file on a stacked basis) is named too —
    // and only that path: the file the diff DOES cover is readable.
    const covered = realDiff({ 'src/a.mjs': 'a\n' }, { 'src/a.mjs': 'b\n' });
    expect(HUMAN(['src/a.mjs', 'src/own-only.mjs'], covered).signals.hunksUnavailable).toEqual(['src/own-only.mjs']);
    expect(HUMAN(['src/a.mjs'], covered).signals.hunksUnavailable).toBeUndefined();
  });
});
