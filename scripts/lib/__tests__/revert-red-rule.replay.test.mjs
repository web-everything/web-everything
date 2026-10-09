/**
 * #5466 — replay fixtures for the revert-red rule (protocol card 5468's shape: facts + settings in, exact verdict out).
 *
 * The `replay-*` fixtures are derived from two REAL fix commits, PRs 4441 and 4481 (the 2026-10-08 fixer audit's
 * non-discriminating tests), replayed through the real revert transaction and recorded as facts; 4441 is also replayed
 * under `off` and `enforce`. The rest are synthetic, one per edge class.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planRevert, newTestTitles, revertRedVerdict, revertRedGate, formatRevertRed, parseFailureLine, changedOutsideNewTests, isStructuralUnproven, scanTestDeclarations, newTestEntries } from '../revert-red-rule.mjs';

const FIXTURES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/revert-red-replay.json'), 'utf8'));

function replay(rule, { changes, maxFiles = 40, ...facts }) {
  return rule({ ...facts, plan: planRevert({ changes, maxFiles }) });
}

describe('revert-red rule — replay fixtures', () => {
  it.each(FIXTURES.map((f) => [f.name, f]))('%s', (_name, fixture) => {
    const verdict = replay(revertRedVerdict, fixture.facts);
    expect({ status: verdict.status, reason: verdict.reason, blocking: verdict.blocking, nonDiscriminating: verdict.nonDiscriminating })
      .toEqual(fixture.expect);
  });

  it('the real replays flag the tests the 2026-10-08 audit named', () => {
    const named = (name) => replay(revertRedVerdict, FIXTURES.find((f) => f.name === name).facts).nonDiscriminating.map((t) => t.test);
    // 4481: "a new test that always passes" — the scratch-store pin.
    expect(named('replay-4481-warn')).toContain('pins OPERATION_COMPLETIONS_DIR to a fresh scratch dir in the child env AND in the prompt\'s own report command, and leaves a real store untouched');
    // 4441: "its new test cannot catch removal of the guard" — the demotion guard's new edge test.
    expect(named('replay-4441-warn')).toContain('demotes an advisory seat when a source file changed within LATER_ROUND_CHANGE_WINDOW of the cited line (edges included)');
  });

  it('the fixtures discriminate: a broken rule that trusts any red run fails them', () => {
    const broken = (facts) => {
      const v = revertRedVerdict(facts);
      return v.status === 'flagged' ? { ...v, status: 'clean', reason: 'all-new-tests-red-with-fix-reverted', blocking: false, nonDiscriminating: [] } : v;
    };
    const failing = FIXTURES.filter((f) => {
      const v = replay(broken, f.facts);
      return JSON.stringify({ status: v.status, reason: v.reason, blocking: v.blocking, nonDiscriminating: v.nonDiscriminating }) !== JSON.stringify(f.expect);
    });
    expect(failing.map((f) => f.name)).toEqual(expect.arrayContaining(['replay-4441-warn', 'replay-4481-warn']));
  });

  it('warn never blocks; only enforce does', () => {
    for (const fixture of FIXTURES) {
      const v = replay(revertRedVerdict, fixture.facts);
      if (fixture.facts.mode !== 'enforce') expect(v.blocking, fixture.name).toBe(false);
    }
  });
});

describe('revert-red rule — parts', () => {
  it('plans: modified source is reverted, tests run, new source / helpers / cards are kept', () => {
    expect(planRevert({ changes: [
      { status: 'M', path: 'scripts/a.mjs' }, { status: 'A', path: 'scripts/new.mjs' }, { status: 'D', path: 'scripts/old.mjs' },
      { status: 'M', path: 'scripts/__tests__/a.test.mjs' }, { status: 'A', path: 'scripts/__tests__/b.test.mjs' },
      { status: 'M', path: 'scripts/__tests__/helpers/h.mjs' }, { status: 'M', path: 'backlog/1-x.md' }, { status: 'D', path: 'scripts/__tests__/c.test.mjs' },
      { status: 'M', path: 'src/__snapshots__/a.test.ts.snap' },
    ] })).toEqual({
      tests: ['scripts/__tests__/a.test.mjs', 'scripts/__tests__/b.test.mjs'], revert: ['scripts/a.mjs'], keptNew: ['scripts/new.mjs'],
      keptOther: ['backlog/1-x.md', 'scripts/__tests__/c.test.mjs', 'scripts/__tests__/helpers/h.mjs', 'scripts/old.mjs', 'src/__snapshots__/a.test.ts.snap'], tooLarge: false,
    });
  });

  it('reads only literal titles of it/test calls on added lines', () => {
    expect(newTestTitles([
      "  it('plain title', () => {",
      '  test("double \\"quoted\\"", async () => {',
      '  it.concurrent(`template ok`, () => {})',
      '  it(`dynamic ${name}`, () => {})',
      '  describe(\'not a test\', () => {',
      '  // it(\'commented\') still counts as text; the runner decides',
      '  expect(fit).toBe(1)',
      "  if (/x/.test('not a title')) return;",
      "  fit('focused is not it', () => {})",
    ])).toEqual(['plain title', 'double "quoted"', 'template ok', 'commented']);
  });

  it('splits runner failure lines; a bare file is a load error; a bracketed title is kept whole', () => {
    expect(parseFailureLine('a.test.mjs > grp > t')).toMatchObject({ file: 'a.test.mjs', path: ['grp', 't'], loadError: false });
    expect(parseFailureLine('a.test.mjs [ a.test.mjs ]')).toMatchObject({ file: 'a.test.mjs', loadError: true });
    expect(parseFailureLine('a.test.mjs > handles arrays [1]')).toMatchObject({ raw: 'a.test.mjs > handles arrays [1]', path: ['handles arrays [1]'] });
  });

  it('a fix that added a source file never flags: the green test may test the new code', () => {
    const T = 's/__tests__/n.test.mjs';
    const plan = planRevert({ changes: [{ status: 'M', path: 's/a.mjs' }, { status: 'A', path: 's/new.mjs' }, { status: 'A', path: T }] });
    const probe = { applied: true, occurrences: 1, baselineRan: true, baselineGreen: true, mutantRan: true, mutantGreen: true, killedBy: [], restored: true };
    expect(revertRedVerdict({ mode: 'enforce', changeKind: 'fix', recordMatchesHead: true, plan, titles: { [T]: ['new helper works'] }, probe }))
      .toMatchObject({ status: 'unproven', reason: 'new-source-kept', nonDiscriminating: [], blocking: false });
  });

  it('a partial revert never flags: a green test may guard the file that stayed fixed', () => {
    const fixture = FIXTURES.find((f) => f.name === 'replay-4441-warn').facts;
    const plan = { ...planRevert({ changes: fixture.changes }), unrevertable: ['assets/logo.bin'] };
    const v = revertRedVerdict({ ...fixture, plan });
    expect(v).toMatchObject({ status: 'unproven', reason: 'partial-revert', nonDiscriminating: [] });
    expect(v.unproven).toHaveLength(2);
  });

  it('the gate is asked before anything else and off costs nothing', () => {
    expect(revertRedGate({ mode: 'off', changeKind: 'fix', recordMatchesHead: true })).toBe('mode-off');
    expect(revertRedGate({ mode: 'warn', changeKind: 'ci-heal', recordMatchesHead: true })).toBe(null);
    expect(formatRevertRed(revertRedVerdict({ mode: 'off' }))).toBe('revert-red (off): skipped — mode-off');
  });
});

// Card A5 / review of PR 4535: an `unproven` the fixer CANNOT clear (a structural fact about the diff) is recorded, never
// blocking; an `unproven` from a run that failed to execute still blocks in enforce (fail closed).
describe('revert-red rule — structural versus execution unproven', () => {
  const T = 's/__tests__/n.test.mjs';
  const probe = (over = {}) => ({ applied: true, occurrences: 1, baselineRan: true, baselineGreen: true, mutantRan: true, mutantGreen: false, killedBy: [], restored: true, ...over });
  const verdict = (planChanges, over = {}) => revertRedVerdict({ mode: 'enforce', changeKind: 'fix', recordMatchesHead: true, plan: planRevert({ changes: planChanges }), titles: { [T]: ['new works'] }, probe: probe(), ...over });
  const MODIFY = [{ status: 'M', path: 's/a.mjs' }, { status: 'A', path: T }];

  it('names which unproven reasons are structural', () => {
    expect(['new-source-kept', 'partial-revert', 'load-error-with-fix-reverted'].map(isStructuralUnproven)).toEqual([true, true, true]);
    expect(['baseline-unrun', 'baseline-timeout', 'reverted-run-unrun', 'reverted-run-timeout', 'not-restored', 'failure-list-truncated', 'no-probe-result'].map(isStructuralUnproven)).toEqual(Array(7).fill(false));
  });

  it('a fix that adds a source file and its test is recorded unproven but does not block in enforce', () => {
    const v = verdict([...MODIFY, { status: 'A', path: 's/b.mjs' }], { probe: probe({ mutantGreen: true }) });
    expect(v).toMatchObject({ status: 'unproven', reason: 'new-source-kept', blocking: false });
  });

  it('a partial revert and a test that cannot load without the fix are recorded, not blocking', () => {
    const partial = revertRedVerdict({ mode: 'enforce', changeKind: 'fix', recordMatchesHead: true, plan: { ...planRevert({ changes: MODIFY }), unrevertable: ['x.bin'] }, titles: { [T]: ['new works'] }, probe: probe({ mutantGreen: true }) });
    expect(partial).toMatchObject({ status: 'unproven', reason: 'partial-revert', blocking: false });
    const load = verdict(MODIFY, { probe: probe({ killedBy: [`${T} [ ${T} ]`] }) });
    expect(load).toMatchObject({ status: 'unproven', reason: 'load-error-with-fix-reverted', blocking: false });
  });

  it('an unproven list that mixes a structural reason with an execution one still blocks, and names the execution one', () => {
    const T2 = 's/__tests__/z.test.mjs'; // sorts AFTER T, so the structural entry comes first in the list
    const v = revertRedVerdict({ mode: 'enforce', changeKind: 'fix', recordMatchesHead: true,
      plan: planRevert({ changes: [{ status: 'M', path: 's/a.mjs' }, { status: 'A', path: T }, { status: 'A', path: T2 }] }),
      titles: { [T]: ['new works'], [T2]: ['other works'] }, probe: probe({ failuresTruncated: true, killedBy: [`${T} [ ${T} ]`] }) });
    expect(v.unproven.map((u) => u.why).sort()).toEqual(['failure-list-truncated', 'load-error-with-fix-reverted']);
    expect(v).toMatchObject({ status: 'unproven', reason: 'failure-list-truncated', blocking: true });
  });

  it('a run that timed out is its own reason and blocks in enforce, ahead of the generic unrun reason', () => {
    expect(verdict(MODIFY, { probe: probe({ applied: false, baselineRan: false, baselineGreen: false, baselineTimedOut: true }) })).toMatchObject({ reason: 'baseline-timeout', blocking: true });
    expect(verdict(MODIFY, { probe: probe({ mutantRan: false, mutantTimedOut: true }) })).toMatchObject({ reason: 'reverted-run-timeout', blocking: true });
    expect(verdict(MODIFY, { probe: probe({ applied: false, baselineRan: false, baselineGreen: false, detail: 'target-changed-during-baseline', driftedDuringBaseline: true }) })).toMatchObject({ reason: 'target-changed-during-baseline', blocking: true });
  });
});

describe('revert-red rule — a changed existing test next to a new one is still assessed', () => {
  const T = 's/__tests__/n.test.mjs';
  const plan = planRevert({ changes: [{ status: 'M', path: 's/a.mjs' }, { status: 'M', path: T }] });
  const probe = (killedBy) => ({ applied: true, occurrences: 1, baselineRan: true, baselineGreen: true, mutantRan: true, mutantGreen: false, killedBy, restored: true });
  const ask = (killedBy, changedExisting = { [T]: true }) => revertRedVerdict({ mode: 'warn', changeKind: 'fix', recordMatchesHead: true, plan, titles: { [T]: ['brand new'] }, changedExisting, probe: probe(killedBy) });

  it('assesses changed existing tests alongside newly added tests: only the new one going red is not clean', () => {
    const v = ask([`${T} > brand new`]);
    expect(v).toMatchObject({ status: 'flagged', reason: 'tests-pass-with-fix-reverted' });
    expect(v.discriminating).toEqual([{ file: T, test: 'brand new' }]);
    expect(v.nonDiscriminating).toEqual([{ file: T, test: null }]);
  });

  it('is clean when some OTHER test in the file also goes red, or when no existing test changed', () => {
    expect(ask([`${T} > brand new`, `${T} > an existing test that was tightened`]).status).toBe('clean');
    expect(ask([`${T} > brand new`], {}).status).toBe('clean');
    expect(ask([`${T} > brand new`], null).status).toBe('clean');
  });

  it('a truncated failure list cannot prove the changed existing test green: unproven', () => {
    const v = revertRedVerdict({ mode: 'warn', changeKind: 'fix', recordMatchesHead: true, plan, titles: { [T]: ['brand new'] }, changedExisting: { [T]: true },
      probe: { ...probe([`${T} > brand new`]), failuresTruncated: true } });
    expect(v.status).toBe('unproven');
    expect(v.unproven).toEqual([{ file: T, test: null, why: 'failure-list-truncated' }]);
  });
});

describe('revert-red rule — changedOutsideNewTests reads the -U0 diff of one test file', () => {
  const hunk = (head, ...lines) => [head, ...lines].join('\n');
  const NEW = hunk('@@ -10,0 +11,3 @@', "+it('brand new', () => {", '+  expect(guard(".x")).toBe(false);', '+});');

  it('a hunk that only adds a new test is attributed; nothing else changed', () => {
    expect(changedOutsideNewTests(NEW)).toBe(false);
    expect(changedOutsideNewTests('')).toBe(false);
  });

  it('a tightened assertion in an existing test is a change outside the new tests', () => {
    expect(changedOutsideNewTests(`${NEW}\n${hunk('@@ -4 +4 @@', '-  expect(a).toBeTruthy();', '+  expect(a).toBe(true);')}`)).toBe(true);
  });

  it('assertion lines ADDED to an existing test (all + lines) count too', () => {
    expect(changedOutsideNewTests(`${NEW}\n${hunk('@@ -7,0 +8 @@', '+  expect(b).toBe(2);')}`)).toBe(true);
  });

  it('import lines, blank lines and comments do not count as a changed test', () => {
    expect(changedOutsideNewTests(`${hunk('@@ -1 +1,2 @@', "-import { a } from './a.mjs';", "+import { a, b } from './a.mjs';", '+')}\n${NEW}`)).toBe(false);
    expect(changedOutsideNewTests(hunk('@@ -3,0 +4 @@', '+// explains the case below'))).toBe(false);
  });

  it('a deleted test, or a comment edited to mention an assertion word, is not a changed test the fixer must prove', () => {
    expect(changedOutsideNewTests(`${NEW}\n${hunk('@@ -20,3 +0,0 @@', "-it('obsolete', () => {", '-  expect(a).toBe(1);', '-});')}`)).toBe(false);
    expect(changedOutsideNewTests(hunk('@@ -3 +3 @@', '-  // returns 1', '+  // should return 1'))).toBe(false);
  });

  it('a renamed test is ONE test: its new title carries it, so no second failure is demanded (red-team break 2)', () => {
    expect(changedOutsideNewTests(hunk('@@ -2 +2 @@', "-it('old name', () => {", "+it('new name', () => {"))).toBe(false);
  });

  it('a rewritten existing test whose declaration line is untouched is a changed existing test', () => {
    expect(changedOutsideNewTests(hunk('@@ -3 +3 @@', '-  expect(a).toBe(1);', '+  expect(a).toBe(2);'))).toBe(true);
  });
});

// Post-accept red team of PR 4535: the same-titled-test and single-replacement shapes at the rule's own seam.
describe('revert-red rule — suite-qualified test identity', () => {
  const T = 's/__tests__/n.test.mjs';
  const plan = planRevert({ changes: [{ status: 'M', path: 's/a.mjs' }, { status: 'M', path: T }] });
  const probe = (killedBy) => ({ applied: true, occurrences: 1, baselineRan: true, baselineGreen: true, mutantRan: true, mutantGreen: false, killedBy, restored: true });
  const ask = (titles, killedBy, mode = 'enforce') => revertRedVerdict({ mode, changeKind: 'fix', recordMatchesHead: true, plan, titles: { [T]: titles }, probe: probe(killedBy) });

  it('reads the suite chain of each declaration, braces inside strings and comments notwithstanding', () => {
    const src = [
      "import { x } from './x.mjs';",
      "describe('A', () => {",
      "  // } not a brace",
      "  it('has a } in its title', () => {});",
      "  describe('inner', () => {",
      "    it(`tpl`, () => { const s = '}'; });",
      '  });',
      '});',
      "it('top', () => {});",
    ].join('\n');
    const { decls, complete } = scanTestDeclarations(src);
    expect(complete).toBe(true);
    expect(decls.map((d) => [...d.suites, d.title].join(' > '))).toEqual(['A > has a } in its title', 'A > inner > tpl', 'top']);
  });

  it('a dynamic describe, or an unbalanced file, is incomplete: ids are then not trusted', () => {
    expect(scanTestDeclarations("describe.each([1])('g %s', () => { it('t', () => {}); });").complete).toBe(false);
    expect(scanTestDeclarations("describe(name, () => { it('t', () => {}); });").complete).toBe(false);
    expect(scanTestDeclarations("describe('A', () => { it('t', () => {});").complete).toBe(false);
  });

  it('suite forms the scanner cannot model are incomplete; a plain import list is not one', () => {
    const complete = (src) => scanTestDeclarations(src).complete;
    expect(complete("import { describe, it } from 'vitest';\ndescribe('A', () => { it('x', () => {}); });")).toBe(true);
    expect(complete('describe.each`\n a | b\n`(\'A %s\', () => { it(\'x\', () => {}); });')).toBe(false);
    expect(complete("describe<Foo>('A', () => { it('x', () => {}); });")).toBe(false);
    expect(complete("const d = describe;\nd('A', () => { it('x', () => {}); });")).toBe(false);
    expect(complete("test.describe('A', () => { test('x', () => {}); });")).toBe(false);
    expect(scanTestDeclarations("suite('S', () => { it('x', () => {}); });").decls[0]).toMatchObject({ title: 'x', suites: ['S'] });
  });

  it('a regex literal after => or return does not throw the scan out of step', () => {
    const src = "describe('A', () => {\n  const f = (s) => /\\{/.test(s);\n  const g = (s) => { return /'/.test(s); };\n  it('x', () => {});\n});\ndescribe('B', () => { it('x', () => {}); });";
    const r = scanTestDeclarations(src);
    expect(r.complete).toBe(true);
    expect(r.decls.map((d) => [...d.suites, d.title].join(' > '))).toEqual(['A > x', 'B > x']);
  });

  it('title escapes are decoded as the runtime does, so the id equals what the runner prints', () => {
    expect(scanTestDeclarations("it('caf\\u00e9 \\x41 \\n ok', () => {});").decls[0].title).toBe('café A \n ok');
    expect(newTestTitles(["it('caf\\u00e9', () => {})"])).toEqual(['café']);
  });

  it('entries carry the qualified id of what the diff ADDED; an existing same-titled test only makes it shared when the id repeats', () => {
    const headSource = "describe('A', () => {\n  it('works', () => {});\n});\ndescribe('B', () => {\n  it('works', () => {});\n});\n";
    const diffText = '@@ -0,0 +1,3 @@\n+describe(\'A\', () => {\n+  it(\'works\', () => {});\n+});';
    expect(newTestEntries({ headSource, diffText })).toEqual([{ title: 'works', id: 'A > works', shared: false, leafShared: true }]);
  });

  it('entries fall back to the leaf and say when it is declared more than once', () => {
    const headSource = "describe.each([1])('g %s', () => {\n  it('works', () => {});\n});\nit('works', () => {});\n";
    const diffText = "@@ -0,0 +4 @@\n+it('works', () => {});";
    expect(newTestEntries({ headSource, diffText })).toEqual([{ title: 'works', id: null, shared: true, leafShared: true }]);
  });

  it('a failure in ANOTHER suite is not credited to a new test with a qualified id', () => {
    const v = ask([{ title: 'works', id: 'A > works', shared: false }], [`${T} > B > works`]);
    expect(v).toMatchObject({ status: 'flagged', blocking: true });
    expect(v.nonDiscriminating).toEqual([{ file: T, test: 'A > works' }]);
  });

  it('the qualified id is matched whole, so the right suite going red is discriminating', () => {
    const v = ask([{ title: 'works', id: 'A > works', shared: false }], [`${T} > A > works`]);
    expect(v).toMatchObject({ status: 'clean' });
    expect(v.discriminating).toEqual([{ file: T, test: 'A > works' }]);
  });

  it('a shared title with an unknown suite is unproven when anything matches, flagged when nothing does', () => {
    const entry = [{ title: 'works', id: null, shared: true }];
    expect(ask(entry, [`${T} > grp 1 > works`])).toMatchObject({ status: 'unproven', reason: 'ambiguous-test-title', blocking: true });
    expect(ask(entry, [`${T} > something else`]).status).toBe('flagged');
  });

  it('one test declared once but run under several suites (describe.each, a helper) is one test, not an ambiguity', () => {
    const v = ask([{ title: 'works', id: null, shared: false, leafShared: false }], [`${T} > A > case 1 > works`, `${T} > A > case 2 > works`]);
    expect(v).toMatchObject({ status: 'clean' });
  });

  it('a suite the scanner could not see does not hide the failure, but a DIFFERENT suite still never matches', () => {
    // helper-declared test: id has no suite, the runner prints the one it ran under
    expect(ask([{ title: 'h works', id: 'h works', shared: false, leafShared: false }], [`${T} > A > h works`]).status).toBe('clean');
    // a suite in the middle that the scanner missed
    expect(ask([{ title: 'x', id: 'Outer > x', shared: false, leafShared: false }], [`${T} > Outer > Inner > x`]).status).toBe('clean');
    expect(ask([{ title: 'x', id: 'Outer > x', shared: false, leafShared: false }], [`${T} > Other > Inner > x`]).status).toBe('flagged');
    // an unseen suite plus a same-leaf test elsewhere: two paths hit a leaf the file declares twice => unproven
    const v = ask([{ title: 'works', id: 'works', shared: false, leafShared: true }], [`${T} > A > works`, `${T} > B > works`]);
    expect(v).toMatchObject({ status: 'unproven', reason: 'ambiguous-test-title' });
  });

  it('plain string titles keep their old leaf meaning', () => {
    expect(ask(['works'], [`${T} > A > works`]).status).toBe('clean');
  });
});

describe('revert-red rule — replacing one test needs one failure', () => {
  const hunk = (head, ...lines) => [head, ...lines].join('\n');

  it('a hunk that swaps a test declaration for a new titled one is attributed to the new test', () => {
    expect(changedOutsideNewTests(hunk('@@ -2 +2 @@', "-it('old name', () => {", "+it('new name', () => {"))).toBe(false);
    expect(changedOutsideNewTests(hunk('@@ -2,3 +2,3 @@', "-it('old', () => {", '-  expect(a).toBe(1);', '-});', "+it('new', () => {", '+  expect(a).toBe(2);', '+});'))).toBe(false);
  });

  it('a rewritten assertion with no new title, or next to a kept declaration, is still a changed existing test', () => {
    expect(changedOutsideNewTests(hunk('@@ -4 +4 @@', '-  expect(a).toBeTruthy();', '+  expect(a).toBe(true);'))).toBe(true);
    expect(changedOutsideNewTests(hunk('@@ -4 +4,2 @@', '-  expect(a).toBeTruthy();', '+  expect(a).toBe(true);', "+it('new', () => {}); "))).toBe(true);
  });
});
