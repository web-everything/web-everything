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

import { planRevert, newTestTitles, revertRedVerdict, revertRedGate, formatRevertRed, parseFailureLine } from '../revert-red-rule.mjs';

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
      .toMatchObject({ status: 'unproven', reason: 'new-source-kept', nonDiscriminating: [] });
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
