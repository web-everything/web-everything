// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { computeSoakClosure, soakScopeRun } from '../soak-scope.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(ROOT, 'scripts/conveyor/soak/soak-scope.mjs');
const RED_TEAM = 'scripts/lib/review-red-team-on-skip.mjs';
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
});
