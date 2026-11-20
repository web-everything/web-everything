import { describe, it, expect } from 'vitest';
import { scanTestTampering } from '../pr-merge-gate.mjs';

const path = (name) => `scripts/lib/__tests__/${name}.test.mjs`;
const testCase = (title, body = 'expect(actual()).toBe(1);', mode = '') =>
  `it${mode}('${title}', () => { ${body} });`;
const suite = (cases, title = 'suite') => `describe('${title}', () => {\n${cases.join('\n')}\n});`;
function patch(file, before = '', after = '', context = '') {
  const oldLines = before ? before.split('\n') : [];
  const newLines = after ? after.split('\n') : [];
  return [`diff --git a/${file} b/${file}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`),
    ...context.split('\n').filter(Boolean).map((l) => ` ${l}`)].join('\n');
}
const source = (cases) => patch(path('big'), suite(cases), suite([]));
const destination = (cases, file = path('shard')) => patch(file, '', suite(cases));
const scan = (...diffs) => scanTestTampering({ diffText: diffs.join('\n') });
const removed = (...diffs) => scan(...diffs).findings.filter((f) => f.kind === 'tests-removed');

describe('merge gate case moves', () => {
  it('moved test cases are not removals', () => {
    expect(scan(source([testCase('one'), testCase('two')]),
      destination([testCase('one')]), destination([testCase('two')], path('second'))).tampered).toBe(false);
  });

  it('replays #7140: two big files shrink by 14 and 129 cases into shards', () => {
    // Replay the reported case-count shape, not invented copies of the original test bodies.
    const diffs = [14, 129].flatMap((count, group) => {
      const cases = Array.from({ length: count }, (_, i) => testCase(`group ${group} case ${i}`));
      return [patch(path(`big-${group}`), suite(cases), suite([])),
        destination(cases.slice(0, 7), path(`shard-${group}-a`)),
        destination(cases.slice(7), path(`shard-${group}-b`))];
    });
    expect(scan(...diffs).tampered).toBe(false);
  });

  it('recognizes a rename diff carrying the same cases', () => {
    const diff = source([testCase('one')]).replace(`b/${path('big')}`, `b/${path('renamed')}`);
    expect(scan(diff, destination([testCase('one')])).tampered).toBe(false);
  });

  it('normalizes title whitespace and quote style while retaining the describe path', () => {
    expect(scan(source([testCase('one   case')]),
      destination([testCase('one case')]).replace("describe('suite'", 'describe("suite"')).tampered).toBe(false);
    expect(removed(source([testCase('one')]),
      patch(path('other'), '', suite([testCase('one')], 'different suite')))).toHaveLength(1);
  });

  it('holds truly deleted titles even when unrelated additions balance total counts', () => {
    expect(removed(source([testCase('one')]), destination([testCase('other')]))).toHaveLength(1);
  });

  it('holds mixed deletion, move and unrelated local replacement despite balanced global counts', () => {
    const findings = removed(
      patch(path('big'), suite([testCase('deleted A'), testCase('moved B')]), suite([testCase('unrelated C')])),
      destination([testCase('moved B')]),
    );
    expect(findings).toEqual([{ path: path('big'), kind: 'tests-removed', detail: 'net 1 test case(s) removed' }]);
  });

  it('pairs retained local identities separately from moved cases', () => {
    expect(scan(
      patch(path('big'), suite([testCase('retained A'), testCase('moved B')]), suite([testCase('retained A')])),
      destination([testCase('moved B')]),
    ).tampered).toBe(false);
  });

  it('holds when overall case count goes down', () => {
    expect(removed(source([testCase('one'), testCase('two')]), destination([testCase('one')]))).toHaveLength(1);
  });

  it('does not double-spend additions against moves and local churn when total count falls', () => {
    expect(removed(patch(path('big'), suite([testCase('one'), testCase('two')]), suite([testCase('other')])),
      patch(path('shard'), suite([testCase('other')]), suite([testCase('one')])))).toHaveLength(1);
  });

  it.each([
    ['literal true', 'expect(true).toBe(true);', ''],
    ['empty body', '', ''],
    ['fewer assertions', 'expect(actual()).toBe(1);', ''],
    ['skip', 'expect(actual()).toBe(1); expect(other()).toBe(2);', '.skip'],
    ['todo', 'expect(actual()).toBe(1); expect(other()).toBe(2);', '.todo'],
    ['only', 'expect(actual()).toBe(1); expect(other()).toBe(2);', '.only'],
    ['weakened matcher', 'expect(actual()).toBeDefined(); expect(other()).toBe(2);', ''],
  ])('holds a weakened moved case: %s', (_, body, mode) => {
    expect(removed(source([testCase('one', 'expect(actual()).toBe(1); expect(other()).toBe(2);')]),
      destination([testCase('one', body, mode)]))).toHaveLength(1);
  });

  it('holds a moved case after a suite return', () => {
    const cases = [testCase('unrelated live case'), 'return;', testCase('one')];
    expect(removed(source([testCase('one')]), destination(cases)))
      .toEqual([{ path: path('big'), kind: 'tests-removed', detail: 'net 1 test case(s) removed' }]);
    const fullFiles = midFileSplit((moved) => [testCase('unrelated live case'), 'return;', ...moved]);
    expect(scanTestTampering(fullFiles).findings.filter((f) => f.kind === 'tests-removed'))
      .toHaveLength(2);
  });

  it.each(['if (condition) { return; }', "throw new Error('stop');"])
    ('holds a moved case in a suite with a possible early exit: %s', (exit) => {
      expect(removed(source([testCase('one')]),
        destination([testCase('unrelated live case'), exit, testCase('one')]))).toHaveLength(1);
    });

  it('holds a moved generator callback', () => {
    const generator = testCase('one').replace('() =>', 'function* ()');
    expect(removed(source([testCase('one')]), destination([generator])))
      .toEqual([{ path: path('big'), kind: 'tests-removed', detail: 'net 1 test case(s) removed' }]);
    const fullFiles = midFileSplit((cases) => cases.map((c) => c.replace('() =>', 'function* ()')));
    expect(scanTestTampering(fullFiles).findings.filter((f) => f.kind === 'tests-removed'))
      .toHaveLength(2);
  });

  it.each(['scripts/lib/shard.mjs', 'archive/shard.test.mjs',
    'scripts/lib/__tests__/shard.txt', 'node_modules/scripts/__tests__/shard.test.mjs',
    'scripts/__tests__/stdout-flush.test.mjs'])('holds a move outside CI includes or excluded: %s', (file) => {
    expect(removed(source([testCase('one')]), destination([testCase('one')], file))).toHaveLength(1);
  });

  it.each(['removed', 'added', 'existing'])('holds ambiguous title collision: %s', (side) => {
    const cases = [testCase('one')];
    const from = source(side === 'removed' ? [...cases, ...cases] : cases);
    const to = destination(side === 'added' ? [...cases, ...cases] : cases);
    const existing = side === 'existing' ? patch(path('existing'), '', '', suite(cases)) : '';
    expect(removed(from, to, existing)).toHaveLength(1);
  });

  it('holds an incomplete or unparseable moved body', () => {
    expect(removed(source([testCase('one')]), destination(["it('one', () => {"]))).toHaveLength(1);
    expect(removed(source(["it('one', () => {"]), destination([testCase('one')]))).toHaveLength(1);
  });

  it('holds unsupported parameterized or dynamic-title evidence', () => {
    expect(removed(source([testCase('one')]), destination([testCase('one'),
      "test.each(rows)('one', () => { expect(actual()).toBe(1); });"]))).toHaveLength(1);
    expect(removed(source([testCase('one')]), destination([testCase('one')]).replace("it('one'", 'it(title')))
      .toHaveLength(1);
  });

  it('holds a body weakened by automatic semicolon insertion despite identical tokens', () => {
    expect(removed(source([testCase('one', 'return expect(actual()).toBe(1);')]),
      destination([testCase('one', 'return\nexpect(actual()).toBe(1);')]))).toHaveLength(1);
  });

  it('accepts body formatting and comment changes with the same parsed statements', () => {
    expect(scan(source([testCase('one')]),
      destination([testCase('one', '\n// relocated\nexpect( actual() ).toBe( 1 );\n')])).tampered).toBe(false);
  });

  it('does not join disconnected hunks to invent a complete case', () => {
    const diff = source([testCase('one')]);
    const to = destination(["it('one', () => {"]) + '\n@@ -90,0 +90,2 @@\n+expect(actual()).toBe(1);\n+});';
    expect(removed(diff, to)).toHaveLength(1);
  });

  it('holds unknown suite ancestry in a mid-file hunk', () => {
    expect(removed(source([testCase('one')]).replace('@@ -1,', '@@ -40,'),
      destination([testCase('one')]))).toHaveLength(1);
  });

  it('holds a moved case hidden in a conditional or disabled suite', () => {
    expect(removed(source([testCase('one')]),
      destination([`if (false) { ${testCase('one')} }`]))).toHaveLength(1);
    expect(removed(source([testCase('one')]),
      destination([testCase('one')]).replace('describe(', 'describe.skip('))).toHaveLength(1);
  });

  it('holds oversized move evidence with an explicit human-review fallback', () => {
    const result = removed(source([testCase('one')]), destination([testCase('one')]),
      patch('notes.txt', '', 'x'.repeat(1024 * 1024)));
    expect(result).toHaveLength(1);
    expect(result[0].detail).toContain('human review of full diff required');
  });

  it('holds moves when the same diff changes the test configuration', () => {
    expect(removed(source([testCase('one')]), destination([testCase('one')]),
      patch('vitest.config.ts', 'old config', 'new config'))).toHaveLength(1);
  });

  it('keeps test-file-removed and test-skipped findings', () => {
    expect(scan(source([testCase('one')]).replace('@@', 'deleted file mode 100644\n@@'),
      destination([testCase('one')])).findings.some((f) => f.kind === 'test-file-removed')).toBe(true);
    expect(scan(source([testCase('one')]), destination([testCase('one', '', '.skip')]))
      .findings.some((f) => f.kind === 'test-skipped')).toBe(true);
  });
});

// Real-shaped #7140 split: original suites start before each changed hunk.
function midFileSplit(transform = (cases) => cases, destinationPath = path('split')) {
  const files = new Map();
  const diffs = [14, 129].flatMap((count, group) => {
    const file = `scripts/__tests__/${group ? 'progress-board' : 'merge-ai-prs-prestage'}.test.mjs`;
    const shard = destinationPath.replace('.test.mjs', `-${group}.test.mjs`);
    const cases = Array.from({ length: count }, (_, i) => testCase(`group ${group} case ${i}`));
    const prefix = `import { describe, it, expect } from 'vitest';\n\n`;
    files.set(`base:${file}`, prefix + suite([testCase(`retained ${group}`), ...cases]));
    files.set(`head:${file}`, prefix + suite([testCase(`retained ${group}`)]));
    files.set(`head:${shard}`, prefix + suite(transform(cases)));
    return [
      [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`,
        `@@ -5,${count} +4,0 @@`, ...cases.map((c) => `-${c}`)].join('\n'),
      `diff --git a/${shard} b/${shard}\nnew file mode 100644\n--- /dev/null\n+++ b/${shard}\n@@ -0,0 +1,${count + 4} @@\n` +
        files.get(`head:${shard}`).split('\n').map((l) => `+${l}`).join('\n'),
    ];
  });
  return { diffText: diffs.join('\n'), readFile: (file, side) => files.get(`${side}:${file}`) };
}

describe('full-file move evidence', () => {
  it('clears the #7140 mid-file split of net 14 and 129 cases using exact suite ancestry', () => {
    const input = midFileSplit();
    expect(scanTestTampering({ diffText: input.diffText }).findings.map((f) => f.detail))
      .toEqual(['net 14 test case(s) removed', 'net 129 test case(s) removed']);
    expect(scanTestTampering(input).findings).toEqual([]);
  });

  it.each([
    ['weakened move', (cases) => cases.map((c) => c.replace('toBe(1)', 'toBeDefined()'))],
    ['deleted case', (cases) => cases.slice(1)],
    ['ambiguous title', (cases) => [...cases, cases[0]]],
  ])('holds a full-file %s', (_, transform) => {
    expect(scanTestTampering(midFileSplit(transform)).tampered).toBe(true);
  });

  it('holds a full-file move excluded from CI', () => {
    expect(scanTestTampering(midFileSplit(undefined, 'archive/split.test.mjs')).tampered).toBe(true);
  });

  it.each(['throw', 'undefined', 'malformed'])('holds when full-file evidence is %s', (mode) => {
    const input = midFileSplit();
    const read = input.readFile;
    input.readFile = (file, side) => {
      if (file.includes('progress-board') && side === 'head') {
        if (mode === 'throw') throw new Error('missing object');
        return mode === 'undefined' ? undefined : 'describe(';
      }
      return read(file, side);
    };
    expect(scanTestTampering(input).findings.filter((f) => f.kind === 'tests-removed')).toHaveLength(2);
  });

  it('holds oversized full-file evidence with a human-review fallback', () => {
    const input = midFileSplit();
    input.readFile = () => '// ' + 'x'.repeat(1024 * 1024);
    expect(scanTestTampering(input).reasons.join(' ')).toContain('human review of full diff required');
  });
});


describe('full-file declaration shapes from #7140', () => {
  function input(before, after, moved) {
    return {
      diffText: patch(path('big'), suite([before]), suite([after])) + '\n' + destination(moved),
      readFile: (file, side) => file === path('big') ? suite(side === 'base' ? [before] : [after])
        : side === 'base' ? '' : suite(moved),
    };
  }

  it('keeps parameterized declarations in collision evidence without crediting them', () => {
    const parameterized = "it.each(rows)('parameter %s', () => { expect(actual()).toBe(1); });";
    const moved = testCase('one');
    expect(scanTestTampering(input(parameterized + '\n' + moved, parameterized, [moved])).findings).toEqual([]);
    expect(scanTestTampering(input(moved, '', [moved, parameterized.replace('parameter %s', 'one')])).tampered).toBe(true);
  });

  it('compares constant concatenated titles by their complete string value', () => {
    const moved = testCase('one case').replace("'one case'", "'one ' + 'case'");
    expect(scanTestTampering(input(moved, '', [testCase('one case')])).findings).toEqual([]);
  });

  it('holds unknown titles anywhere in a full file', () => {
    const moved = testCase('one');
    const unknown = "it(title, () => { expect(actual()).toBe(1); });";
    expect(scanTestTampering(input(unknown + '\n' + moved, unknown, [moved])).tampered).toBe(true);
  });
});
