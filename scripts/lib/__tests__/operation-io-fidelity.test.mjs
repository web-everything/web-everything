/**
 * @file operation-io-fidelity.test.mjs — the #2949 fidelity qualifier for `we:scripts/operations/*-io.mjs`.
 *
 * WHAT THIS FILE IS AN ANSWER TO. The rule under test exists because #3264 shipped a tier-1 acceptance
 * criterion that passed against a stub and a production bug that did not survive contact with a narrow clone.
 * A test suite for THAT rule which only proved the happy path — "a module with no test errors" — would be the
 * same vacuity one level up: green, deterministic, and silent about whether the thing it guards actually
 * ratchets. So the three ratchet properties are proven INDEPENDENTLY below, each with the counter-case that
 * would otherwise let a trivially-wrong implementation pass:
 *
 *   1. on the list + HAS a test  → error ("remove it from the list")   — this is what makes the list SHRINK
 *   2. off the list + NO test    → error                                — the ordinary rule
 *   3. on the list + NOT in the baseline → error                        — the list cannot GROW
 *
 * Each property is paired with its negative (the case that must produce NOTHING), because `() => []` and
 * `() => [everything]` are both single-property-passing implementations and neither may survive this file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findIoModulesWithoutFidelityTest,
  scanOperationIoFidelity,
  importsRealRepoHelper,
  unjudgeableHelperImport,
  testCoversIoModule,
  REAL_REPO_HELPER,
  RATCHET_BASELINE,
  UNCONVERTED_IO_MODULES,
} from '../operation-io-fidelity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A test source that imports the harness AND the module pair — i.e. real proof of fidelity. */
const fidelityTest = (name, file = `${name}-io.real.test.mjs`) => ({
  file: `scripts/operations/__tests__/${file}`,
  content:
    "import { withNarrowClone } from './helpers/real-repo.mjs';\nit('real', () => withNarrowClone(() => {}));\n"
    + `import { createSinks } from '../${name}-io.mjs';\n`,
});

/** A test source that reaches the module but drives an injected double — the #3264 shape. */
const stubTest = (name) => ({
  file: `scripts/operations/__tests__/${name}.test.mjs`,
  content: `import { createSinks } from '../${name}-io.mjs';\nconst run = () => '';\n`,
});

const kinds = (r) => r.errors.map((e) => e.descriptor.kind);

describe('property 2 — a module with no real-mechanism test is an ERROR (the ordinary rule)', () => {
  it('errors when the module is neither allowlisted nor covered', () => {
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict'], tests: [], allowlist: [], baseline: [],
    });
    expect(kinds(r)).toEqual(['io-fidelity-missing']);
    expect(r.errors[0].descriptor.file).toBe('scripts/operations/record-verdict-io.mjs');
  });

  it('a STUB test does not satisfy it — reaching the module is not exercising the mechanism', () => {
    // The whole motivating case, in one assertion. `record-verdict.test.mjs` imports the io module and is a
    // thorough suite; it is also the suite that was green while `git worktree add origin/<branch>` died live.
    // If this ever stops erroring, the gate has been reduced to "is the module imported anywhere", which every
    // module already satisfied on the day the bug shipped.
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict'], tests: [stubTest('record-verdict')], allowlist: [], baseline: [],
    });
    expect(kinds(r)).toEqual(['io-fidelity-missing']);
  });

  it('the NEGATIVE — a real-mechanism test silences it', () => {
    // Without this, "always error" passes both assertions above.
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict'], tests: [fidelityTest('record-verdict')], allowlist: [], baseline: [],
    });
    expect(r.errors).toEqual([]);
  });

  it('the helper import alone is not enough — it must be in a test that reaches THIS module', () => {
    // A converted `claim` test must not launder fidelity onto `verify`. Both halves of the conjunction are
    // load-bearing and each is pinned by dropping the other.
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['verify'], tests: [fidelityTest('claim')], allowlist: [], baseline: [],
    });
    expect(kinds(r)).toEqual(['io-fidelity-missing']);
  });
});

describe('property 1 — an allowlisted module that HAS a test is an ERROR (the list must shrink)', () => {
  it('errors with "remove it from the list" when the debt is paid but the entry remains', () => {
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict'],
      tests: [fidelityTest('record-verdict')],
      allowlist: ['record-verdict'],
      baseline: ['record-verdict'],
    });
    expect(kinds(r)).toEqual(['io-fidelity-allowlist-stale']);
    expect(r.errors[0].descriptor.test).toBe('scripts/operations/__tests__/record-verdict-io.real.test.mjs');
    expect(r.errors[0].message).toMatch(/remove it from/i);
  });

  it('the NEGATIVE — an allowlisted module with no test is TOLERATED (this is what makes the rule landable)', () => {
    // The half that lets the ratchet ship at all. If this ever errors, the gate cannot be merged with 15
    // unconverted modules on the tree, and a rule nobody can land protects nothing.
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict'],
      tests: [stubTest('record-verdict')],
      allowlist: ['record-verdict'],
      baseline: ['record-verdict'],
    });
    expect(r.errors).toEqual([]);
  });

  it('property 1 and property 2 are DIFFERENT findings on the same tree', () => {
    // Independence, asserted rather than assumed: an implementation that collapsed the two into one condition
    // would report the same kind twice here.
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict', 'verify'],
      tests: [fidelityTest('record-verdict')],
      allowlist: ['record-verdict'],
      baseline: ['record-verdict', 'verify'],
    });
    expect(kinds(r).sort()).toEqual(['io-fidelity-allowlist-stale', 'io-fidelity-missing']);
  });
});

describe('property 3 — the allowlist cannot GROW (new code is held to the rule immediately)', () => {
  it('errors when an entry is outside the frozen day-one baseline', () => {
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['brand-new'],
      tests: [],
      allowlist: ['brand-new'],
      baseline: ['record-verdict'],
    });
    // Note the SHAPE, not just the count: the module is silenced as far as property 2 goes (it IS listed),
    // so without property 3 a new module would buy a permanent exemption by editing one line. The only
    // finding must be the growth one.
    expect(kinds(r)).toEqual(['io-fidelity-allowlist-grew']);
    expect(r.errors[0].message).toMatch(/only ever SHRINKS/);
  });

  it('the NEGATIVE — a baseline entry is fine, so the rule is not just "any allowlist entry errors"', () => {
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict'], tests: [], allowlist: ['record-verdict'], baseline: ['record-verdict'],
    });
    expect(r.errors).toEqual([]);
  });

  it('a dead entry — baselined but the module is gone — is a separate finding', () => {
    const r = findIoModulesWithoutFidelityTest({
      ioModules: [], tests: [], allowlist: ['retired'], baseline: ['retired'],
    });
    expect(kinds(r)).toEqual(['io-fidelity-allowlist-dead']);
  });

  it('growth takes precedence over deadness — one entry never yields two findings', () => {
    const r = findIoModulesWithoutFidelityTest({
      ioModules: [], tests: [], allowlist: ['brand-new'], baseline: [],
    });
    expect(kinds(r)).toEqual(['io-fidelity-allowlist-grew']);
  });
});

describe('importsRealRepoHelper — the import, not the mention', () => {
  it('matches static and dynamic imports at any relative depth', () => {
    // Each case carries a CALL SITE, because an import alone no longer satisfies the rule — see the
    // "importing is not using" block below for why. The axis under test here is still the import form
    // (static / dynamic) and the relative depth, not the usage.
    expect(importsRealRepoHelper(
      "import { withRealRepo } from './helpers/real-repo.mjs';\nit('x', () => withRealRepo(() => {}));",
    )).toBe(true);
    expect(importsRealRepoHelper(
      "import { withBareOrigin } from '../helpers/real-repo.mjs';\nit('x', () => withBareOrigin(() => {}));",
    )).toBe(true);
    expect(importsRealRepoHelper(
      `const h = await import('../../${REAL_REPO_HELPER}');\nit('x', () => h.withNarrowClone(() => {}));`,
    )).toBe(false); // dynamic: not judged here, refused by the scan instead
  });

  it('a COMMENT naming the helper proves nothing', () => {
    // A gate satisfied by a promise is not a gate. This is the cheapest possible way to fake the rule and it
    // is the one somebody reaches for first.
    expect(importsRealRepoHelper('// TODO: port this to helpers/real-repo.mjs once the harness lands')).toBe(false);
    expect(importsRealRepoHelper('describe("real-repo", () => {});')).toBe(false);
  });
});

describe('importsRealRepoHelper — importing is not using (PR #1549 juror)', () => {
  const IMPORT_LINE = "import { withRealRepo } from '../helpers/real-repo.mjs';\n";

  it('REFUSES a decorative import with no call site — the #3264 vacuity, one level up', () => {
    // THE FINDING. A presence check is satisfied by an import nobody calls, so a suite could import the
    // harness, stay entirely stubbed, and satisfy the gate built to stop exactly that. The gate would then be
    // vacuous in the same way the criterion it enforces exists to forbid.
    const decorative = `${IMPORT_LINE}\nit('stubbed', () => { const run = () => ''; expect(run()).toBe(''); });\n`;
    expect(importsRealRepoHelper(decorative)).toBe(false);
  });

  it('accepts an import that is actually used', () => {
    const real = `${IMPORT_LINE}\nit('real', async () => { await withRealRepo((root) => { expect(root).toBeTruthy(); }); });\n`;
    expect(importsRealRepoHelper(real)).toBe(true);
  });

  it('accepts the repository and filesystem harness entry points', () => {
    for (const name of ['withRealRepo', 'withBareOrigin', 'withNarrowClone', 'withRealDirectory']) {
      const src = `import { ${name} } from '../helpers/real-repo.mjs';\nit('x', () => ${name}(() => {}));\n`;
      expect(importsRealRepoHelper(src)).toBe(true);
    }
  });

  it('refuses a decorative filesystem fixture import without a call', () => {
    expect(importsRealRepoHelper("import { withRealDirectory } from '../helpers/real-repo.mjs';\nit('stubbed', () => {});")).toBe(false);
  });

  it('still refuses a file that uses the names but never imports the helper', () => {
    // The other direction: a local function called `withRealRepo` is not the harness.
    const impostor = "const withRealRepo = (f) => f('/tmp');\nit('x', () => withRealRepo(() => {}));\n";
    expect(importsRealRepoHelper(impostor)).toBe(false);
  });
});

describe('testCoversIoModule — derived from the import graph, not from the filename', () => {
  it('either half of the operation pair counts', () => {
    expect(testCoversIoModule("import x from '../record-verdict-io.mjs';", 'record-verdict')).toBe(true);
    expect(testCoversIoModule("import x from '../record-verdict.mjs';", 'record-verdict')).toBe(true);
  });

  it('a name that is only a SUFFIX of another module does not match it', () => {
    // The leading `/` in the pattern. Without it `verdict` is credited with `record-verdict`'s test.
    expect(testCoversIoModule("import x from '../record-verdict-io.mjs';", 'verdict')).toBe(false);
  });

  it('a filename match without an import does not count', () => {
    expect(testCoversIoModule('// covers record-verdict-io.mjs', 'record-verdict')).toBe(false);
  });
});

describe('the shipped constants against the real tree (#2949 ratchet, day-one state)', () => {
  const opsDir = join(ROOT, 'scripts', 'operations');
  const modules = existsSync(opsDir)
    ? readdirSync(opsDir).filter((n) => n.endsWith('-io.mjs')).map((n) => n.replace(/-io\.mjs$/, '')).sort()
    : [];

  it('RATCHET_BASELINE is the census of `-io.mjs` modules as they were when the ratchet landed', () => {
    // Not "equals the current tree" — the baseline is FROZEN and the tree moves. What is pinned is that every
    // baselined name was real, so the frozen list can never be a place to park a name that never existed.
    for (const name of RATCHET_BASELINE) expect(modules, `baseline entry \`${name}\``).toContain(name);
  });

  it('the shipped allowlist never exceeds the frozen baseline', () => {
    // The ratchet's direction, asserted against the SHIPPED constants rather than fixtures — this is the
    // assertion that reddens if a future author appends a new module to the debt register.
    expect([...UNCONVERTED_IO_MODULES].filter((n) => !RATCHET_BASELINE.includes(n))).toEqual([]);
  });

  it('the gate is GREEN on the tree as it stands — the ratchet is landable today', () => {
    // The whole reason the allowlist exists, asserted through the SAME entry point check-standards calls. If
    // this reddens, either a module was added without a fidelity test (fix the module, not this test) or the
    // harness track converted one without deleting its entry.
    expect(scanOperationIoFidelity(ROOT).errors.map((e) => e.message)).toEqual([]);
  });
});

describe('the fs shell, against a REAL directory tree (this rule obeying its own rule)', () => {
  // A stubbed `readdirSync` has no nested directories, no absent `__tests__/`, and no non-test siblings —
  // exactly the shape of absence that made #3264 vacuous. So the walk is driven over a real tmpdir.
  let root;
  const EMPTY = { allowlist: [], baseline: [] };
  const write = (rel, content) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'io-fidelity-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds the io modules and their tests, and reports the unconverted ones', () => {
    write('scripts/operations/alpha-io.mjs', 'export const a = 1;\n');
    write('scripts/operations/__tests__/alpha.test.mjs', "import { a } from '../alpha-io.mjs';\n");
    const r = scanOperationIoFidelity(root, EMPTY);
    expect(r.errors.map((e) => e.descriptor.kind)).toEqual(['io-fidelity-missing']);
    expect(r.errors[0].descriptor.file).toBe('scripts/operations/alpha-io.mjs');
  });

  it('a real-repo test found by the walk clears the module', () => {
    write('scripts/operations/alpha-io.mjs', 'export const a = 1;\n');
    write('scripts/operations/__tests__/alpha.test.mjs',
      "import { withRealRepo } from './helpers/real-repo.mjs';\nimport { a } from '../alpha-io.mjs';\nit('real', () => withRealRepo(() => a()));\n");
    expect(scanOperationIoFidelity(root, EMPTY).errors).toEqual([]);
  });

  it('requires repo proof when module source is unavailable', () => {
    const result = findIoModulesWithoutFidelityTest({ ioModules: ['alpha'],
      tests: [{ file: 'alpha.test.mjs', content:
        "import { withRealDirectory } from './helpers/real-repo.mjs';\n"
        + "import { a } from '../alpha-io.mjs';\nwithRealDirectory(() => {});" }],
      ...EMPTY });
    expect(result.errors.map(e => e.descriptor.kind)).toEqual(['io-fidelity-missing']);
  });

  it.each([
    ["export const a = () => run('git status');", true],
    ["export const a = () => spawnSync('git', ['status']);", true],
    ["export const a = () => readFileSync('record.json');", false],
  ])('directory-only proof is rejected for Git IO: %s', (source, needsRepo) => {
    write('scripts/operations/alpha-io.mjs', source);
    write('scripts/operations/__tests__/alpha.test.mjs',
      "import { withRealDirectory } from './helpers/real-repo.mjs';\n"
      + "import { a } from '../alpha-io.mjs';\n"
      + "it('empty directory', () => withRealDirectory(() => {}));\n"
      + "it('mocked Git', () => a());\n");
    expect(scanOperationIoFidelity(root, EMPTY).errors.map(e => e.descriptor.kind))
      .toEqual(needsRepo ? ['io-fidelity-missing'] : []);
  });

  it('descends into SUBDIRECTORIES and credits non-`.test.mjs` fixture modules', () => {
    // Both halves of the collector's contract in one tree: the proof lives in a nested helper module whose
    // name is not `*.test.mjs`. A shallow walk, or a `.test.mjs`-only filter, reports this module untested.
    write('scripts/operations/alpha-io.mjs', 'export const a = 1;\n');
    write('scripts/operations/__tests__/fixtures/alpha-real.mjs',
      "import { withBareOrigin } from '../helpers/real-repo.mjs';\nimport { a } from '../../alpha-io.mjs';\nit('real', () => withBareOrigin(() => a()));\n");
    expect(scanOperationIoFidelity(root, EMPTY).errors).toEqual([]);
  });

  it('an ABSENT __tests__/ directory is an empty list, not a throw', () => {
    // The gate runs this outside any try/catch on purpose, so a throw here would crash the whole gate.
    write('scripts/operations/alpha-io.mjs', 'export const a = 1;\n');
    expect(() => scanOperationIoFidelity(root, EMPTY)).not.toThrow();
    expect(scanOperationIoFidelity(root, EMPTY).errors.map((e) => e.descriptor.kind)).toEqual(['io-fidelity-missing']);
  });

  it('an absent scripts/operations/ is no modules and no findings', () => {
    expect(scanOperationIoFidelity(root, EMPTY).errors).toEqual([]);
  });
});

describe('the REGISTRATION — the gate actually calls this scan', () => {
  it('check-standards.mjs imports and invokes scanOperationIoFidelity', () => {
    // PR #1235's lesson, applied to this rule: pinning the walk is not pinning the wiring. Deleting the call
    // site would otherwise leave every assertion above green while the gate checked nothing.
    const gate = readFileSync(join(ROOT, 'scripts', 'check-standards.mjs'), 'utf8');
    expect(gate).toMatch(/import\s*\{[^}]*\bscanOperationIoFidelity\b[^}]*\}\s*from\s*'\.\/lib\/operation-io-fidelity\.mjs'/);
    expect(gate).toMatch(/scanOperationIoFidelity\(ROOT\)/);
  });
});

describe('importsRealRepoHelper — the two edge cases, which fail in opposite directions (PR #1549 r2)', () => {
  const H = "from '../helpers/real-repo.mjs'";

  it('a COMMENT naming an export is not usage — the false PASS', () => {
    // The round-1 fix stripped import statements and looked for the exported name. A comment survives that,
    // so `// TODO: use withRealRepo here` satisfied the gate with nothing real behind it — the #3264 vacuity
    // one layer further in than where it was just closed.
    const src = `import { withRealRepo } ${H};\n// TODO: use withRealRepo here\nit('x', () => {});\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
  });

  it('a block comment naming an export is not usage either', () => {
    const src = `import { withRealRepo } ${H};\n/* withRealRepo goes here one day */\nit('x', () => {});\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
  });

  it('an ALIASED import that IS used counts — the false ERROR', () => {
    // The other direction, and the reason neither could be waved off as pedantry: an alias binds its
    // right-hand side, so the exported name never appears again and genuinely-real work was failed loudly.
    const src = `import { withRealRepo as withRepo } ${H};\nit('x', () => withRepo(() => {}));\n`;
    expect(importsRealRepoHelper(src)).toBe(true);
  });

  it('an aliased import that is NOT used still fails', () => {
    const src = `import { withRealRepo as withRepo } ${H};\nit('x', () => {});\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
  });

  it('a namespace import is NOT judged here — the scan refuses it by name instead', () => {
    const src = `import * as h ${H};\nit('x', () => h.withNarrowClone(() => {}));\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
    expect(unjudgeableHelperImport(src)).toBe('namespace');
  });

  it('importing something the harness does NOT export is not proof', () => {
    // A file can import from the module without touching any entry point that builds a real repo.
    const src = `import { FIXTURE_SLUG } ${H};\nit('x', () => expect(FIXTURE_SLUG).toBeTruthy());\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
  });
});

describe('the forms this check REFUSES to judge, rather than guessing (PR #1549 r3 → option B)', () => {
  const H = "'../helpers/real-repo.mjs'";
  const V = "import { it, expect } from 'vitest';\n";

  // Three rounds each found a real defect in the previous regex: comments counted as usage, aliases were
  // rejected, and the dynamic branch both passed a decorative `await import(…)` and rejected any realistic
  // file. The conclusion was not "the fourth patch is right" — it was that deciding whether a binding is used
  // is a parser's job. So the check owns ONE form and says so about the rest.

  it('a dynamic import is not judged here', () => {
    const src = `${V}const h = await import(${H});\nit('x', () => h.withRealRepo(() => {}));\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
  });

  it('…and is REFUSED by name, so it cannot read as "no fidelity test"', () => {
    // The whole point of option B. Silently answering false would be a wrong answer wearing the same face as
    // a right one: the module would report as untested when it is in fact tested, just unreadably.
    const src = `${V}const h = await import(${H});\nit('x', () => h.withRealRepo(() => {}));\n`;
    expect(unjudgeableHelperImport(src)).toBe('dynamic');
  });

  it('a destructured dynamic import is refused too', () => {
    const src = `${V}const { withNarrowClone } = await import(${H});\nit('x', () => withNarrowClone(() => {}));\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
    expect(unjudgeableHelperImport(src)).toBe('dynamic');
  });

  it('a namespace import is refused — the same parser question, one indirection further', () => {
    const src = `${V}import * as h from ${H};\nit('x', () => h.withNarrowClone(() => {}));\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
    expect(unjudgeableHelperImport(src)).toBe('namespace');
  });

  it('a STATIC named import is judged, not refused — the form the check owns', () => {
    const src = `${V}import { withRealRepo } from ${H};\nit('x', () => withRealRepo(() => {}));\n`;
    expect(importsRealRepoHelper(src)).toBe(true);
    expect(unjudgeableHelperImport(src)).toBe('');
  });

  it('a DECORATIVE static import is judged and FAILED, never called undecidable', () => {
    // The distinction that keeps the refusal from becoming an escape hatch: a form the check owns and finds
    // wanting must fail, not be excused as unjudgeable.
    const src = `${V}import { withRealRepo } from ${H};\nit('x', () => {});\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
    expect(unjudgeableHelperImport(src)).toBe('');
  });
});

describe('the refusal reaches the SCAN, not just the predicate (mutation-found gap)', () => {
  // The predicate tests above all call `unjudgeableHelperImport` directly. Disabling the refusal inside
  // `findIoModulesWithoutFidelityTest` left every one of them green — the scan-level behaviour was untested,
  // which is this item's own vacuity class one more time. Found by mutation, not by reading.
  const dynamicTest = (name) => ({
    file: `scripts/operations/__tests__/${name}-dyn.test.mjs`,
    content:
      `import { it } from 'vitest';\nconst h = await import('./helpers/real-repo.mjs');\n`
      + `import { createSinks } from '../${name}-io.mjs';\n`
      + `it('real', () => h.withNarrowClone(() => {}));\n`,
  });

  it('raises io-fidelity-undecidable for a test that reaches the harness dynamically', () => {
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict'], tests: [dynamicTest('record-verdict')], allowlist: [], baseline: [],
    });
    expect(kinds(r)).toContain('io-fidelity-undecidable');
    expect(r.errors.find((e) => e.descriptor.kind === 'io-fidelity-undecidable').descriptor.file)
      .toBe('scripts/operations/__tests__/record-verdict-dyn.test.mjs');
  });

  it('a judgeable file raises no undecidable error', () => {
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict'], tests: [fidelityTest('record-verdict')], allowlist: [], baseline: [],
    });
    expect(kinds(r)).not.toContain('io-fidelity-undecidable');
  });

  it('a plain stub test raises no undecidable error either — it is judged and simply fails', () => {
    const r = findIoModulesWithoutFidelityTest({
      ioModules: ['record-verdict'], tests: [stubTest('record-verdict')], allowlist: [], baseline: [],
    });
    expect(kinds(r)).toContain('io-fidelity-missing');
    expect(kinds(r)).not.toContain('io-fidelity-undecidable');
  });
});

describe('a MENTION is not a USE — strings are not code (PR #1549 r4)', () => {
  const H = "'../helpers/real-repo.mjs'";
  const V = "import { it, expect } from 'vitest';\n";

  it('a name in a test TITLE does not satisfy the check', () => {
    // The round-4 survivor, run against the shipped code rather than a mutation of it: the harness was
    // imported, the name appeared in the title, the body was fully stubbed, and the gate passed. Same #3264
    // vacuity as the decorative import, one layer deeper — the name was outside the import, just not in code.
    const src = `${V}import { withRealRepo } from ${H};\n`
      + `import { createSinks } from '../record-verdict-io.mjs';\n`
      + `it('mentions withRealRepo in its title but never calls it', () => { const run = () => ''; expect(run()).toBe(''); });\n`;
    expect(importsRealRepoHelper(src)).toBe(false);
  });

  it('nor in a template literal', () => {
    expect(importsRealRepoHelper(`${V}import { withRealRepo } from ${H};\nit(\`withRealRepo() rocks\`, () => {});\n`)).toBe(false);
  });

  it('CALL POSITION is what counts — every harness export is a function taking a callback', () => {
    expect(importsRealRepoHelper(`${V}import { withRealRepo } from ${H};\nit('x', () => withRealRepo(() => {}));\n`)).toBe(true);
  });

  it('an awaited call counts', () => {
    expect(importsRealRepoHelper(`${V}import { withBareOrigin } from ${H};\nit('x', async () => { await withBareOrigin(() => {}); });\n`)).toBe(true);
  });

  it('an aliased call counts', () => {
    expect(importsRealRepoHelper(`${V}import { withRealRepo as w } from ${H};\nit('x', () => w(() => {}));\n`)).toBe(true);
  });
});
