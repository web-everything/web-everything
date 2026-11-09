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
    expect(source.includes(RED_TEAM)).toBe(false);
  });

  it('includes the real red-team helper reached by the red-team-skip soak case', () => {
    const closure = computeSoakClosure({ root: ROOT });
    expect(closure).toBeInstanceOf(Set);
    expect(closure.has(RED_TEAM)).toBe(true);
    expect(closure.has('scripts/conveyor/soak/breaks/red-team-skip-never-settles.soak.test.mjs')).toBe(true);
    expect(closure.has('vitest.soak.config.ts')).toBe(true);
  }, 25_000);

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
    writeFixture(root, 'vitest.soak.config.ts', 'export default {};\n');
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
  ])('follows %s', (_name, source) => {
    const root = fixtureRoot();
    writeFixture(root, 'vitest.soak.config.ts', 'export default {};\n');
    writeFixture(root, 'scripts/conveyor/soak/a.soak.test.mjs', `${source}\n`);
    writeFixture(root, 'fixture/dep.mjs', 'export const x = 1;\n');
    writeFixture(root, 'scripts/x/dep.mjs', 'export const x = 1;\n');

    const closure = computeSoakClosure({ root });
    const target = source.includes('./scripts/x/') ? 'scripts/x/dep.mjs' : 'fixture/dep.mjs';
    expect(closure.has(target)).toBe(true);
    expect(soakScopeRun({ root, changed: [target] })).toBe(true);
  });

  it('discovers dependencies without executing their source', () => {
    const root = fixtureRoot();
    const marker = join(root, 'executed');
    writeFixture(root, 'vitest.soak.config.ts', 'export default {};\n');
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
    const result = spawnSync('bash', ['-e', '-c', script], {
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
