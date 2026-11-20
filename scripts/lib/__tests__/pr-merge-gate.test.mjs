import { describe, it, expect } from 'vitest';
import { scanTestTampering as rawScan } from '../pr-merge-gate.mjs';

const config = `export default { test: {
    include: ['scripts/**/__tests__/**/*.test.mjs'],
    exclude: [...configDefaults.exclude, 'scripts/__tests__/stdout-flush.test.mjs'],
    setupFiles: ['./test/setup.mjs'],
} };`;
// Reviewed-tree config is an explicit fixture, never the worker checkout's config.
const scanTestTampering = (input) => rawScan({ ...input, readFile: input.readFile && ((file, side) =>
  file === 'vitest.config.ts' ? config : input.readFile(file, side)) });
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
const scan = (...diffs) => {
  const diffText = diffs.join('\n');
  const files = new Map();
  let file, oldFile, before = [], after = [];
  const save = () => { if (file) { files.set(`base:${oldFile}`, before.join('\n')); files.set(`head:${file}`, after.join('\n')); } };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) { save(); file = line.match(/ b\/(.+)$/)?.[1]; oldFile = line.match(/^diff --git a\/(.+) b\//)?.[1]; before = []; after = []; }
    else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    else if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith('+')) after.push(line.slice(1));
    else if (line.startsWith(' ')) { before.push(line.slice(1)); after.push(line.slice(1)); }
  }
  save();
  return scanTestTampering({ diffText, readFile: (p, side) => files.get(`${side}:${p}`) });
};
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
      .toEqual([14, 129].map((n) => `net ${n} test case(s) removed; incomplete or non-static move evidence: human review of full diff required`));
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

  it('holds non-static parameterized registrations even alongside an otherwise valid move', () => {
    const parameterized = "it.each(rows)('parameter %s', () => { expect(actual()).toBe(1); });";
    const moved = testCase('one');
    expect(scanTestTampering(input(parameterized + '\n' + moved, parameterized, [moved])).tampered).toBe(true);
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


describe('round two move-credit trust boundaries', () => {
  const one = testCase('one');
  it('counts declarations rather than opener lines when spending credits', () => {
    expect(removed(source([one + testCase('two'), testCase('deleted')]),
      destination([one, testCase('two'), testCase('unrelated')]))).toHaveLength(1);
  });
  it.each(['({ skip = true }) =>', '(ctx = disabled) =>', '(ctx) =>'])
    ('holds changed callback parameters and defaults: %s', (params) => {
      expect(removed(source([one]), destination([one.replace('() =>', params)]))).toHaveLength(1);
    });
  it.each(['{ skip: true }', '{ timeout: 10 }', '1000'])
    ('holds extra case and ancestor suite arguments: %s', (options) => {
      expect(removed(source([one]), destination([one.replace('});', `}, ${options});`)]))).toHaveLength(1);
      expect(removed(source([one]), destination([one]).replace(/\n\+\}\);$/, `\n+}, ${options});`))).toHaveLength(1);
      // Identical options are deliberately outside the admitted two-argument subset.
      const extra = one.replace('});', `}, ${options});`);
      expect(removed(source([extra]), destination([extra]))).toHaveLength(1);
    });
  it.each([
    "const it = fake;", "function expect() {}", "import { test } from 'other';",
    "import { vi as expect } from 'vitest';", "const { describe } = fake;",
    "expect = fake;", "({ expect } = fake);", "globalThis.it = fake;",
    "globalThis['test'] = fake;", "Object.assign(globalThis, { it: fake });",
    "function helper(vi) {}", "const x = beforeEach(helper);",
    "beforeEach(() => ctx.skip());", "afterEach(cleanup);", "beforeAll(setup);",
    "afterAll(cleanup);", "onTestFinished(cleanup);", "context.skip();",
    "vi.mock('target');", "vi.hoisted(() => {});", "activateSkipping();",
  ])('holds added binding/hook/effect in source or destination: %s', (effect) => {
    for (const side of ['source', 'destination']) {
      const from = side === 'source' ? patch(path('big'), effect + '\n' + suite([one]), suite([])) : source([one]);
      const to = side === 'destination' ? patch(path('shard'), '', effect + '\n' + suite([one])) : destination([one]);
      expect(removed(from, to)).toHaveLength(1);
    }
  });
  it('holds identical skip hooks and protected bindings on both sides', () => {
    for (const effect of ['beforeEach(() => ctx.skip());', 'const it = fake;', "vi.hoisted(() => {});"]) {
      expect(removed(patch(path('big'), effect + '\n' + suite([one]), effect + '\n' + suite([])),
        patch(path('shard'), '', effect + '\n' + suite([one])))).toHaveLength(1);
    }
  });
  it('preserves identical setup and cleanup effects without permitting a changed hook', () => {
    const effect = 'beforeEach(() => reset());';
    expect(scan(patch(path('big'), effect + '\n' + suite([one]), effect + '\n' + suite([])),
      patch(path('shard'), '', effect + '\n' + suite([one]))).findings).toEqual([]);
  });
  it.each(['node_modules', 'dist', 'cypress', '.idea', '.git', '.cache', '.output', '.temp'])
    ('honours Vitest default excluded directory %s', (dir) => {
      expect(removed(source([one]), destination([one], `scripts/${dir}/__tests__/shard.test.mjs`))).toHaveLength(1);
    });
  it.each(['vitest.config.mts', 'vitest.setup.ts', 'vitest.shared.ts', 'scripts/hermetic-tests.settings.json',
    'package.json', '.github/workflows/unit.yml', 'test/setup.mjs'])
    ('holds moves beside changed test execution settings: %s', (file) => {
      expect(removed(source([one]), destination([one]), patch(file, 'old', 'new'))).toHaveLength(1);
    });
  it.each(['base', 'head'])('holds when diff text and %s tree disagree', (side) => {
    const input = midFileSplit();
    const read = input.readFile;
    input.readFile = (p, s) => {
      const text = read(p, s);
      return s === side && typeof text === 'string' ? text.replaceAll('toBe(1)', 'toBe(2)') : text;
    };
    expect(scanTestTampering(input).tampered).toBe(true);
  });
  it.each(['unreadable', 'excluded', 'dynamic', 'setup', 'spread', 'root'])('holds on reviewed config %s', (mode) => {
    const input = midFileSplit();
    const read = input.readFile;
    input.readFile = (p, side) => p === 'vitest.config.ts'
      ? mode === 'unreadable' ? undefined : mode === 'root' ? config.replace('export default', 'const unused =') + '\nexport default unknown;' : mode === 'setup' ? config.replace("['./test/setup.mjs']", 'unknownSetup')
        : mode === 'spread' ? config.replace('test: {', 'test: { ...unknown,') : mode === 'dynamic' ? config.replace("['scripts/**/__tests__/**/*.test.mjs']", '[...unknown]')
        : config.replace('...configDefaults.exclude', "...configDefaults.exclude, '**/*'") : read(p, side);
    expect(rawScan(input).tampered).toBe(true);
  });
  it('holds without a reviewed-tree resolver', () => {
    expect(rawScan({ diffText: source([one]) + '\n' + destination([one]) }).tampered).toBe(true);
  });
});


describe('move-credit helper bounds and preservation', () => {
  const one = testCase('one');
  it('holds a changed ancestor callback default', () => {
    expect(removed(source([one]), destination([one]).replace("describe('suite', () =>", "describe('suite', (ctx = disabled) =>"))).toHaveLength(1);
  });
  it('does not retain a local case with newly added skip options beside a credited move', () => {
    expect(removed(patch(path('big'), suite([one, testCase('two')]),
      suite([one.replace('});', '}, { skip: true });')])), destination([testCase('two')]))).toHaveLength(1);
  });
  it('holds an extracted helper import without reading the oversized helper', () => {
    const helper = 'scripts/lib/__tests__/helpers/world.mjs';
    const result = removed(source([one]), patch(path('shard'), '',
      "import { data } from './helpers/world.mjs';\n" + suite([one])),
    patch(helper, '', "export const data = '" + 'x'.repeat(128 * 1024) + "';"));
    expect(result).toHaveLength(1);
    expect(result[0].detail).toBe('net 1 test case(s) removed');
  });
  it('holds a new helper import without traversing its dependency chain', () => {
    const helpers = Array.from({ length: 10 }, (_, i) => patch(`scripts/lib/__tests__/helpers/h${i}.mjs`, '',
      (i < 9 ? `import './h${i + 1}.mjs';\n` : '') + 'export const data = 1;'));
    const result = removed(source([one]), patch(path('shard'), '', "import './helpers/h0.mjs';\n" + suite([one])), ...helpers);
    expect(result[0].detail).toBe('net 1 test case(s) removed');
  });
  it('holds a new extracted helper containing a hidden registration hook', () => {
    expect(removed(source([one]), patch(path('shard'), '', "import './helpers/world.mjs';\n" + suite([one])),
      patch('scripts/lib/__tests__/helpers/world.mjs', '', "import { beforeEach } from 'vitest';\nconst hook = beforeEach(disable);"))).toHaveLength(1);
  });
});


describe('strict registration context compatibility', () => {
  const one = testCase('one');
  it('holds identical hooks that change registration order', () => {
    const hooks = ['beforeEach(first);', 'beforeEach(second);'];
    expect(removed(patch(path('big'), hooks.join('\n') + '\n' + suite([one]), suite([])),
      patch(path('shard'), '', [...hooks].reverse().join('\n') + '\n' + suite([one])))).toHaveLength(1);
  });
  it('holds test-setting files renamed out of their sensitive path', () => {
    const workflow = patch('.github/workflows/tests.yml', 'old', 'new')
      .replace('b/.github/workflows/tests.yml', 'b/notes.yml');
    expect(removed(source([one]), destination([one]), workflow)).toHaveLength(1);
  });
  it('accepts an unchanged test-local data const it and refuses calling it', () => {
    const data = testCase('one', 'const it = lookup(); expect(it.status).toBe(1);');
    expect(scan(source([data]), destination([data])).findings).toEqual([]);
    const invoked = testCase('one', 'const it = lookup(); it(); expect(actual()).toBe(1);');
    expect(removed(source([invoked]), destination([invoked]))).toHaveLength(1);
  });
});


describe('unchanged mutable setup declarations', () => {
  it('holds changed mutable setup beside a moved case', () => {
    const one = testCase('one');
    expect(removed(patch(path('big'), 'let enabled = true;\n' + suite([one]), suite([])),
      patch(path('shard'), '', 'let enabled = false;\n' + suite([one])))).toHaveLength(1);
  });
});


it('keeps extracted helper effects before importer effects in registration order', () => {
  const one = testCase('one');
  expect(removed(patch(path('big'), 'beforeEach(first);\nbeforeEach(second);\n' + suite([one]), suite([])),
    patch(path('shard'), '', "import './helpers/world.mjs';\nbeforeEach(first);\n" + suite([one])),
    patch('scripts/lib/__tests__/helpers/world.mjs', '', "import { beforeEach } from 'vitest';\nbeforeEach(second);"))).toHaveLength(1);
});


describe('final conservative move rule', () => {
  const one = testCase('one');
  it.each([
    ['helper', 'function actual() { return 1; }', 'function actual() { return 2; }'],
    ['import binding', "import { actual } from './world.mjs';", "import { fake as actual } from './world.mjs';"],
    ['import module', "import { actual } from './world.mjs';", "import { actual } from './fake.mjs';"],
    ['const initializer', 'const actual = () => 1;', 'const actual = () => 2;'],
    ['hook', 'beforeEach(() => reset());', 'beforeEach(() => disable());'],
    ['directive', '', '// @vitest-' + 'environment jsdom'],
  ])('holds a new or changed destination %s', (_, before, after) => {
    expect(removed(patch(path('big'), before + '\n' + suite([one]), suite([])),
      patch(path('shard'), '', after + '\n' + suite([one])))).toHaveLength(1);
  });
  it('credits identical top-level helpers, imports, initializers and directives', () => {
    const preamble = "// @vitest-environment node\nimport { data } from './world.mjs';\n" +
      'function actual() { return data; }\nconst enabled = true;\nbeforeEach(() => reset());';
    expect(scan(patch(path('big'), preamble + '\n' + suite([one]), preamble + '\n' + suite([])),
      patch(path('shard'), '', preamble + '\n' + suite([one]))).tampered).toBe(false);
  });
  it('strips comments and normalizes whitespace without changing import literal bytes', () => {
    expect(scan(patch(path('big'), 'const actual = () => 1;\n' + suite([one]), suite([])),
      patch(path('shard'), '', 'const /* unchanged */ actual=()=>1;\n' + suite([one]))).tampered).toBe(false);
  });
  it('cannot hide an independent deletion in another file beside a valid move', () => {
    expect(removed(source([one]), destination([one]),
      patch(path('independent'), suite([testCase('deleted')]), suite([testCase('replacement')]))))
      .toEqual([{ path: path('independent'), kind: 'tests-removed', detail: 'net 1 test case(s) removed' }]);
  });
  it('cannot hide an independent template deletion beside a valid move', () => {
    expect(removed(source([one]), destination([one]),
      patch(path('independent'), "const fixture = `\n" + testCase('deleted') + "\n`;", 'const fixture = ``;'))
      .some((f) => f.path === path('independent'))).toBe(true);
  });
  it('holds an independent non-static registration deletion beside a valid move', () => {
    const dynamic = "test.each(rows)('value %s', () => { expect(actual()).toBe(1); });";
    expect(removed(source([one]), destination([one]),
      patch(path('independent'), suite([dynamic]), suite([testCase('replacement')]))))
      .toHaveLength(2);
  });
  it.each(['unreadable', 'oversized'])('never balances removal lines with %s evidence', (mode) => {
    const before = suite([one]), after = suite([testCase('replacement')]);
    const result = scanTestTampering({ diffText: patch(path('big'), before, after),
      readFile: () => mode === 'unreadable' ? undefined : 'x'.repeat(1024 * 1024 + 1) });
    expect(result.tampered).toBe(true);
    expect(result.reasons.join(' ')).toContain('human review of full diff required');
  });
  it.each(['', '   ', 'not a diff'])('holds empty or unresolved diff text: %j', (diffText) => {
    expect(rawScan({ diffText }).findings[0].kind).toBe('test-evidence-unavailable');
  });
  it('holds unscored evidence even when the text looks like a legitimate non-test diff', () => {
    expect(rawScan({ diffText: patch('notes.md', 'old', 'new'), scored: false }).tampered).toBe(true);
  });
  it('passes a genuinely scored diff touching no test files', () => {
    expect(rawScan({ diffText: patch('notes.md', 'old', 'new'), scored: true }).tampered).toBe(false);
  });
});


it('cannot balance a rejected move with an unrelated local addition', () => {
  const one = testCase('one');
  expect(removed(patch(path('big'), suite([one]), suite([testCase('unrelated')])),
    patch(path('shard'), '', 'const actual = () => 2;\n' + suite([one])))).toHaveLength(1);
});

it.each(['[...rows]', '[buildRow()]', '[{ value: dynamic }]'])
  ('refuses a non-static table nested inside an array: %s', (table) => {
    const one = testCase('one');
    const dynamic = `test.each(${table})('value %s', () => { expect(actual()).toBe(1); });`;
    expect(removed(source([one, dynamic]), destination([one]))).toHaveLength(1);
  });


it.each(['const', 'let', 'var'])('holds reordered %s initializers that change a moved test dependency', (kind) => {
  const declarations = [
    `${kind} state = { enabled: true };`,
    `${kind} actual = state.enabled ? real : fake;`,
    `${kind} disable = (state.enabled = false);`,
  ];
  const one = testCase('preserved dependency');
  const before = declarations.join('\n');
  const from = patch(path('big'), before + '\n' + suite([one]), before + '\n' + suite([]));
  expect(scan(from, patch(path('shard'), '', before + '\n' + suite([one]))).tampered).toBe(false);
  const reordered = [declarations[0], declarations[2], declarations[1]].join('\n');
  expect(removed(from, patch(path('shard'), '', reordered + '\n' + suite([one]))))
    .toEqual([{ path: path('big'), kind: 'tests-removed', detail: 'net 1 test case(s) removed' }]);
});


it.each(['file', 'suite'])('holds identical filename-dependent registration effects at %s scope', (scope) => {
  const effect = "globalThis.actual = import.meta.url.endsWith('/big.test.mjs') ? real : fake;";
  const one = testCase('preserved body', 'expect(globalThis.actual()).toBe(1);');
  const content = (cases) => scope === 'file'
    ? effect + '\n' + suite(cases) : suite([effect, ...cases]);
  expect(removed(patch(path('big'), content([one]), content([])),
    patch(path('shard'), '', content([one]))))
    .toEqual([{ path: path('big'), kind: 'tests-removed', detail: 'net 1 test case(s) removed' }]);
});

it('holds identical unsupported executable registration effects even without filename reads', () => {
  const effect = 'activateSkipping();';
  const one = testCase('preserved body');
  expect(removed(patch(path('big'), effect + '\n' + suite([one]), effect + '\n' + suite([])),
    patch(path('shard'), '', effect + '\n' + suite([one])))).toHaveLength(1);
});
