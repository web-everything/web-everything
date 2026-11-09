// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { computeSoakClosure, soakScopeRun } from '../soak-scope.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(THIS_FILE), '../../../..');
const CLI = join(ROOT, 'scripts/conveyor/soak/soak-scope.mjs');
const CI_YML = join(ROOT, '.github/workflows/ci.yml');
// Built by join, never one quoted literal: this file sits inside the soak seed, so a quoted
// repo path here would put RED_TEAM in the closure by the literal scan alone (#6573 review).
const RED_TEAM = ['scripts', 'lib', 'review-red-team-on-skip.mjs'].join('/');
// Same rule: each runtime file is joined from parts so this file never names it whole.
const RUNTIME_FILES = [
  ['schemas', 'worker-result.v1.json'].join('/'),
  ['package', 'json'].join('.'),
  ['package-lock', 'json'].join('.'),
  ['', 'gitignore'].join('.'),
  ['docs', 'agent', 'reviewer-expectations.md'].join('/'),
  ['src', '_data', 'backlog.js'].join('/'),
];
const temporaryRoots = [];

function fixtureRoot() {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'soak-scope-'));
  temporaryRoots.push(root);
  return root;
}

function writeFixture(root, path, source) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

// The minimal soak tree: its config plus the runtime copy list (red-green.mjs#RUNTIME_PATHS).
function soakFixture(root, runtimePaths = ['runtime/neutral.json']) {
  writeFixture(root, 'vitest.soak.config.ts', 'export default {};\n');
  writeFixture(root, 'scripts/conveyor/soak/red-green.mjs',
    `export const RUNTIME_PATHS = Object.freeze(${JSON.stringify(runtimePaths)});\n`);
}

function runCli(input, root = ROOT) {
  return spawnSync(process.execPath, [CLI], {
    cwd: ROOT,
    env: { ...process.env, SOAK_SCOPE_ROOT: root },
    input,
    encoding: 'utf8',
    timeout: 25_000,
    maxBuffer: 1024 * 1024,
  });
}

function expectCliOutput(result, output) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(output);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('soak scope', () => {
  it('does not name the red-team helper as one literal, so the real-repo cases test import following', () => {
    const source = readFileSync(THIS_FILE, 'utf8');
    for (const path of [RED_TEAM, ...RUNTIME_FILES]) {
      expect(source.includes(`'${path}'`) || source.includes(`"${path}"`) || source.includes(`\`${path}\``), path).toBe(false);
    }
  });

  it('includes the real red-team helper reached by the red-team-skip soak case', () => {
    const closure = computeSoakClosure({ root: ROOT });
    expect(closure).toBeInstanceOf(Set);
    expect(closure.has(RED_TEAM)).toBe(true);
    expect(closure.has('scripts/conveyor/soak/breaks/red-team-skip-never-settles.soak.test.mjs')).toBe(true);
    expect(closure.has('vitest.soak.config.ts')).toBe(true);
    // The soak config's own dependencies (dotted `./vitest.shared`, setupFiles/globalSetup literals).
    for (const path of ['vitest.shared.ts', 'vitest.setup.ts', 'vitest.globalSetup.mjs',
      ['scripts', 'lib', 'test-tmp-root.mjs'].join('/')]) {
      expect(closure.has(path), path).toBe(true);
    }
    // Files the soak world copies by name outside scripts/ (sim/world.mjs#buildWeTemplate) — the
    // schema is read at import time by scripts/operations/worker-result.mjs (#6573 red team).
    for (const path of RUNTIME_FILES) expect(closure.has(path), path).toBe(true);
  }, 25_000);

  it.each(RUNTIME_FILES.map((path) => [path]))('CLI selects the soak for the runtime file %s', (path) => {
    expectCliOutput(runCli(`${path}\n`), 'run=true');
  }, 30_000);

  it.each([
    ['backlog/123-x.md', false],
    [RED_TEAM, true],
  ])('soakScopeRun selects %s: %s', (path, expected) => {
    expect(soakScopeRun({ root: ROOT, changed: [path] })).toBe(expected);
  }, 25_000);

  it.each([
    ['backlog/1-x.md\n', 'run=false'],
    [`${RED_TEAM}\n`, 'run=true'],
  ])('CLI scopes stdin %j to %s', (input, expected) => {
    expectCliOutput(runCli(input), expected);
  }, 30_000);

  it('CLI fails closed with run=true and exit 0 for a nonexistent root', () => {
    const root = fixtureRoot();
    // A missing child of our fresh fixture cannot depend on host permissions or files.
    expectCliOutput(runCli('backlog/1-x.md\n', join(root, 'nonexistent')), 'run=true');
  }, 30_000);

  it('computes the real repository closure in less than 20 seconds', () => {
    const start = performance.now();
    const closure = computeSoakClosure({ root: ROOT });
    const elapsed = performance.now() - start;
    expect(closure).toBeInstanceOf(Set);
    expect(closure.has(RED_TEAM)).toBe(true);
    expect(elapsed).toBeLessThan(20_000);
  }, 25_000);

  it('follows a fixture a → b → c import chain without including unrelated d', () => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'vitest.soak.config.ts',
      "export default { test: { include: ['scripts/conveyor/soak/**/*.soak.test.mjs'] } };\n");
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs', "import '../../../fixture/b.mjs';\n");
    // Dependencies live outside soak/: otherwise the directory seed alone would pass.
    writeFixture(root, 'fixture/b.mjs', "import './c.mjs';\n");
    writeFixture(root, 'fixture/c.mjs', 'export const c = true;\n');
    writeFixture(root, 'fixture/d.mjs', 'export const d = true;\n');
    writeFixture(root, 'scripts/conveyor/soak/support.txt', 'also a scope seed\n');

    const closure = computeSoakClosure({ root });
    expect(closure).toBeInstanceOf(Set);
    expect(closure.has('scripts/conveyor/soak/a.soak.test.mjs')).toBe(true);
    expect(closure.has('scripts/conveyor/soak/support.txt')).toBe(true);
    expect(closure.has('vitest.soak.config.ts')).toBe(true);
    expect(closure.has('fixture/b.mjs')).toBe(true);
    expect(closure.has('fixture/c.mjs')).toBe(true);
    expect(closure.has('fixture/d.mjs')).toBe(false);
  });
  it('follows literal repo-path spawn/read targets and their imports', () => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs',
      "spawnSync('node', ['scripts/tools-lit/runner.mjs']);\n");
    writeFixture(root, 'scripts/tools-lit/runner.mjs', "import './helper.mjs';\n");
    writeFixture(root, 'scripts/tools-lit/helper.mjs', 'export const h = 1;\n');
    writeFixture(root, 'scripts/tools-lit/other.mjs', 'export const o = 1;\n');

    const closure = computeSoakClosure({ root });
    expect(closure.has('scripts/tools-lit/runner.mjs')).toBe(true);
    expect(closure.has('scripts/tools-lit/helper.mjs')).toBe(true);
    expect(closure.has('scripts/tools-lit/other.mjs')).toBe(false);
  });

  // Every valid static/dynamic import spelling must reach a dependency outside the legacy scope.
  it.each([
    ['side-effect import without whitespace (single quote)', "import'../../../fixture/dep.mjs';"],
    ['side-effect import without whitespace (double quote)', 'import"../../../fixture/dep.mjs";'],
    ['side-effect import with a newline', "import\n  '../../../fixture/dep.mjs';"],
    ['named import without whitespace', "import{x}from'../../../fixture/dep.mjs';"],
    ['default import across lines', "import x\nfrom\n'../../../fixture/dep.mjs';"],
    ['re-export star without whitespace', "export*from'../../../fixture/dep.mjs';"],
    ['re-export named', "export { x } from \"../../../fixture/dep.mjs\";"],
    ['dynamic import', "await import('../../../fixture/dep.mjs');"],
    ['dynamic import with a template literal', 'await import(`../../../fixture/dep.mjs`);'],
    ['require', "require('../../../fixture/dep.mjs');"],
    ['require with a template literal', 'require(`../../../fixture/dep.mjs`);'],
    ['extensionless import', "import '../../../fixture/dep';"],
    ['dot-slash repo-root literal', "new URL('./scripts/x/dep.mjs', ROOT_URL);"],
    ['import after a quoted keyword', "const K = 'import'; import '../../../fixture/dep.mjs';"],
    ['import after a quoted from', "const K = 'from'; import '../../../fixture/dep.mjs';"],
    ['template import after a quoted require(', 'const K = `require(`; import(`../../../fixture/dep.mjs`);'],
    ['file-relative non-import literal', "new URL('../../../fixture/dep.mjs', import.meta.url);"],
    ['config-style relative literal', "export default { setupFiles: ['../../../fixture/dep.mjs'] };"],
    ['dotted extensionless basename', "import '../../../fixture/dep.v2';"],
    ['import URL with a query string', "import '../../../fixture/dep.mjs?fresh=1';"],
    ['dynamic import URL with a hash', "await import('../../../fixture/dep.mjs#v');"],
    ['import URL with a query and a hash', "export * from '../../../fixture/dep.mjs?a=1#b';"],
    ['repo-root literal under any top-level folder', "readFileSync(join(ROOT, 'fixture/dep.mjs'));"],
    ['repo-root literal with a query string', "copy('fixture/dep.mjs?raw');"],
  ])('follows %s', (_name, source) => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs', `${source}\n`);
    writeFixture(root, 'fixture/dep.mjs', 'export const x = 1;\n');
    writeFixture(root, 'scripts/x/dep.mjs', 'export const x = 1;\n');
    writeFixture(root, 'fixture/dep.v2.mjs', 'export const x = 2;\n');

    const closure = computeSoakClosure({ root });
    const target = source.includes('./scripts/x/') ? 'scripts/x/dep.mjs'
      : source.includes('dep.v2') ? 'fixture/dep.v2.mjs' : 'fixture/dep.mjs';
    expect(closure.has(target)).toBe(true);
    expect(soakScopeRun({ root, changed: [target] })).toBe(true);
  });

  it('follows existing files named by literal under any top-level folder, and top-level files', () => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs', [
      "copy(['schemas/s.v1.json', 'app.json', '.ignorefile', 'docs/agent/list.md', 'docs']);",
      // A fixture name that does not exist outside the code folders is not a dependency.
      "writeCard('backlog/1-fake.md');",
      '',
    ].join('\n'));
    writeFixture(root, 'schemas/s.v1.json', '{}\n');
    writeFixture(root, 'schemas/other.json', '{}\n');
    writeFixture(root, 'app.json', '{}\n');
    writeFixture(root, '.ignorefile', 'node_modules\n');
    writeFixture(root, 'docs/agent/list.md', '- x\n');
    writeFixture(root, 'docs/index.mjs', 'export {};\n');
    writeFixture(root, 'backlog/2-real.md', '---\n---\n');

    const closure = computeSoakClosure({ root });
    for (const path of ['schemas/s.v1.json', 'app.json', '.ignorefile', 'docs/agent/list.md']) {
      expect(closure.has(path), path).toBe(true);
    }
    expect(closure.has('schemas/other.json')).toBe(false);
    expect(closure.has('backlog/1-fake.md')).toBe(false);
    // A bare folder word is not a file: `'docs'` must not pull in docs/index.mjs.
    expect(closure.has('docs/index.mjs')).toBe(false);
    expect(soakScopeRun({ root, changed: ['backlog/2-real.md'] })).toBe(false);
  });

  it('keeps every file of the soak world runtime copy list in scope, even when a PR deletes it', () => {
    const root = fixtureRoot();
    soakFixture(root, ['scripts', 'schemas/rt.v1.json', 'app.json', 'data']);
    writeFixture(root, 'scripts/x.mjs', 'export {};\n');
    writeFixture(root, 'app.json', '{}\n');
    writeFixture(root, 'data/a.json', '{}\n');

    const closure = computeSoakClosure({ root });
    expect(closure.has('app.json')).toBe(true);
    expect(closure.has('schemas/rt.v1.json')).toBe(true); // deleted by the PR
    expect(closure.has('scripts')).toBe(false); // folders are left to the import graph
    expect(closure.has('data/a.json')).toBe(false);
    expect(soakScopeRun({ root, changed: ['schemas/rt.v1.json'] })).toBe(true);
  });

  it('fails open (run=true) when the runtime copy list cannot be read', () => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/red-green.mjs', 'export const RUNTIME_PATHS = computed();\n');
    expect(soakScopeRun({ root, changed: ['backlog/1-x.md'] })).toBe(true);
    expectCliOutput(runCli('backlog/1-x.md\n', root), 'run=true');
  }, 30_000);

  // Any list shape that could hide an entry must fail open rather than parse partially.
  it.each([
    ['a spread entry', "export const RUNTIME_PATHS = Object.freeze([...BASE, 'a.json']);"],
    ['a template entry', "export const RUNTIME_PATHS = Object.freeze([`schemas/${v}.json`, 'a.json']);"],
    ['an empty list', 'export const RUNTIME_PATHS = Object.freeze([]);'],
    ['a second definition', "export const RUNTIME_PATHS = Object.freeze(['a.json']);\nRUNTIME_PATHS = ['b.json'];"],
    ['a bracket inside an entry', "export const RUNTIME_PATHS = Object.freeze(['a]b.json', 'c.json']);"],
    ['an entry that is not a string', "export const RUNTIME_PATHS = Object.freeze(['a.json', B]);"],
  ])('fails open (run=true) on a runtime copy list with %s', (_name, source) => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/red-green.mjs', `${source}\n`);
    expect(soakScopeRun({ root, changed: ['backlog/1-x.md'] })).toBe(true);
  });

  it('reads the exported runtime copy list, not an earlier prefixed identifier', () => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/red-green.mjs',
      "const OLD_RUNTIME_PATHS = Object.freeze([]);\nexport const RUNTIME_PATHS = Object.freeze(['schemas/a.json']);\n");
    expect(computeSoakClosure({ root }).has('schemas/a.json')).toBe(true);
    expect(soakScopeRun({ root, changed: ['backlog/1-x.md'] })).toBe(false);
  });

  it('accepts the plain runtime copy list shape', () => {
    const root = fixtureRoot();
    soakFixture(root, ['a.json', 'schemas/b.json']);
    expect(soakScopeRun({ root, changed: ['schemas/b.json'] })).toBe(true);
    expect(soakScopeRun({ root, changed: ['backlog/1-x.md'] })).toBe(false);
  });

  it('follows a file-relative new URL literal without a ./ prefix', () => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs', "import '../../../fixture/loader.mjs';\n");
    // Outside the soak seed, so only the new URL literal can bring data.json in.
    writeFixture(root, 'fixture/loader.mjs',
      "readFileSync(new URL('data.json', import.meta.url)); new URL('https://example.test/x');\n");
    writeFixture(root, 'fixture/data.json', '{}\n');
    const closure = computeSoakClosure({ root });
    expect(closure.has('fixture/data.json')).toBe(true);
    expect([...closure].some((path) => path.includes('example.test'))).toBe(false);
  });

  it('follows a percent-encoded import URL to the decoded file', () => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs', "import '../../../fixture/dep%20x.mjs?v=1';\n");
    writeFixture(root, 'fixture/dep x.mjs', 'export const x = 1;\n');
    expect(computeSoakClosure({ root }).has('fixture/dep x.mjs')).toBe(true);
  });

  it('does not scan the soak tooling unit tests, which the soak never runs, unless a soak file imports them', () => {
    const root = fixtureRoot();
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs', "import './__tests__/helper.mjs';\n");
    writeFixture(root, 'scripts/conveyor/soak/__tests__/unit.test.mjs', "import '../../../../fixture/unit-only.mjs';\n");
    writeFixture(root, 'scripts/conveyor/soak/__tests__/helper.mjs', "import '../../../../fixture/helper-dep.mjs';\n");
    writeFixture(root, 'fixture/unit-only.mjs', 'export const u = 1;\n');
    writeFixture(root, 'fixture/helper-dep.mjs', 'export const h = 1;\n');

    const closure = computeSoakClosure({ root });
    expect(closure.has('scripts/conveyor/soak/__tests__/unit.test.mjs')).toBe(true);
    expect(closure.has('fixture/unit-only.mjs')).toBe(false);
    expect(closure.has('fixture/helper-dep.mjs')).toBe(true);
  });

  it('never resolves a literal naming the root itself to a sibling outside the repository', () => {
    const parent = fixtureRoot();
    const root = join(parent, 'repo');
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs',
      "new URL('../../../', import.meta.url); read('docs/../../repo.mjs'); read('./scripts/../../repo.mjs');\n");
    writeFixture(root, 'docs/x.md', '- x\n');
    // `<root>.mjs` beside the repository must stay out of the closure.
    writeFixture(parent, 'repo.mjs', "import './repo/outside-dep.mjs';\n");

    const closure = computeSoakClosure({ root });
    expect([...closure].some((path) => path.startsWith('..'))).toBe(false);
    expect(closure.has('repo.mjs')).toBe(false);
  });

  it('discovers dependencies without executing their source', () => {
    const root = fixtureRoot();
    const marker = join(root, 'executed');
    soakFixture(root);
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs', "import '../../../fixture/hostile.mjs';\n");
    writeFixture(root, 'fixture/hostile.mjs', [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'ran');`,
      "throw new Error('dependency source was executed');",
      "import './transitive.mjs';",
      '',
    ].join('\n'));
    writeFixture(root, 'fixture/transitive.mjs', 'export const t = 1;\n');

    const closure = computeSoakClosure({ root });
    expect(closure.has('fixture/hostile.mjs')).toBe(true);
    expect(closure.has('fixture/transitive.mjs')).toBe(true);
    expectCliOutput(runCli('fixture/transitive.mjs\n', root), 'run=true');
    expect(() => readFileSync(marker)).toThrow();
  }, 30_000);
});

// Run the real ci.yml "Does this PR touch daemon code?" step with git stubbed, so the shell glue
// (legacy grep OR derived scope, fail-open to run=true) is defended, not just the script.
describe('ci.yml daemon-soak scope step wiring', () => {
  const scopeStep = yaml.load(readFileSync(CI_YML, 'utf8')).jobs['daemon-soak-scope'].steps
    .find((step) => step.id === 'scope');

  function runStep({ files, node = '' }) {
    const dir = fixtureRoot();
    const output = join(dir, 'output');
    const values = {
      'github.event_name': 'pull_request',
      'github.event.pull_request.base.sha': 'a'.repeat(40),
      'github.event.pull_request.head.sha': 'b'.repeat(40),
    };
    const substitute = (value) => String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
      if (!(key in values)) throw new Error(`unmodelled workflow expression: ${key}`);
      return values[key];
    });
    const script = `git() { printf '%s\\n' "$SCOPE_FILES"; }\n${node}\n${substitute(scopeStep.run)}`;
    // GitHub runs `run:` steps as `bash --noprofile --norc -eo pipefail {0}`.
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 25_000,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(scopeStep.env ?? {}).map(([key, value]) => [key, substitute(value)])),
        GITHUB_OUTPUT: output,
        SCOPE_FILES: files,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(output, 'utf8').trim();
  }

  it('lists changed paths unquoted so non-ASCII names match the scope keys', () => {
    expect(scopeStep.run).toMatch(/git -c core\.quotePath=false diff --name-only/);
  });

  it('runs the soak for a derived-only path outside the legacy grep', () => {
    expect(runStep({ files: RED_TEAM })).toBe('run=true');
  }, 30_000);

  it('skips the soak when neither the legacy grep nor the derived scope selects it', () => {
    expect(runStep({ files: 'backlog/1-x.md' })).toBe('run=false');
  }, 30_000);

  it.each([
    ['the scope script crashes', 'node() { cat >/dev/null; return 1; }'],
    ['the scope script prints nothing', 'node() { cat >/dev/null; return 0; }'],
    ['the scope script prints garbage', "node() { cat >/dev/null; echo 'run=maybe'; }"],
    ['node is missing', 'node() { cat >/dev/null; return 127; }'],
  ])('fails open to run=true when %s', (_name, node) => {
    expect(runStep({ files: 'backlog/1-x.md', node })).toBe('run=true');
  }, 30_000);
});
