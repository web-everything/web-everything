/**
 * @file codex-delivery-provider-sandbox-guards.test.mjs — #4807 always-on guards for the live sandbox proof
 * (`codex-delivery-provider-sandbox.test.mjs`). They need Git and a shell, never Codex.
 *
 *   1. The checked-result boundary (`checkProcessResult` / `expectSuccess` / `expectDenied`): a launch error, a
 *      timeout, a signal or a null status is NEVER classified as a sandbox denial. The pre-#4807 suite asserted
 *      `status !== 0`, which a null status satisfies — `legacyDeniedPredicate` below pins that old defect.
 *   2. A BOUNDED syntax guard (TypeScript parser) over exactly the proof suite and its helper: the suite must not
 *      import or invoke raw child-process APIs, and the helper's single raw `spawnSync` must feed
 *      `checkProcessResult` directly. This is deliberately not a repo-wide subprocess lint.
 *   3. The clone-topology fixture: production lanes are `git clone --reference` clones with a directory `.git`.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  ProcessCheckError, checkProcessResult, createLaneFixture, expectDenied, expectSuccess, git, runChecked, shellQuote,
  verifyCloneTopology,
} from './helpers/codex-sandbox-fixture.mjs';

const ts = createRequire(import.meta.url)('typescript');
const here = dirname(fileURLToPath(import.meta.url));
const SUITE = join(here, 'codex-delivery-provider-sandbox.test.mjs');
const HELPER = join(here, 'helpers/codex-sandbox-fixture.mjs');

// ── 2. the bounded syntax guard ────────────────────────────────────────────────────────────────────────────
const CHILD_PROCESS = /^(node:)?child_process$/;
const RAW_APIS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

/** Violations of the process-check rules in one source text. `role` is 'suite' (no raw spawn) or 'helper' (one checked site). */
export function findProcessViolations(source, role) {
  const sf = ts.createSourceFile('probe.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const violations = [];
  const imports = [];
  const rawCalls = [];
  const specifierOf = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);
  const calleeName = (expr) => (ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : null);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && CHILD_PROCESS.test(specifierOf(node.moduleSpecifier) ?? '')) {
      imports.push(node);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads = ts.isIdentifier(callee) && callee.text === 'require' || callee.kind === ts.SyntaxKind.ImportKeyword;
      if (loads && CHILD_PROCESS.test(specifierOf(node.arguments[0]) ?? '')) imports.push(node);
      const name = calleeName(callee);
      if (name && RAW_APIS.has(name)) rawCalls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (role === 'suite') {
    if (imports.length) violations.push('suite must not import child_process; use the checked helper');
    if (rawCalls.length) violations.push(`suite must not call raw process APIs (${rawCalls.map((c) => calleeName(c.expression)).join(', ')})`);
    return violations;
  }
  const named = imports.filter(ts.isImportDeclaration).flatMap((d) => {
    const b = d.importClause?.namedBindings;
    return b && ts.isNamedImports(b) ? b.elements.map((e) => e.name.text) : ['<non-named import>'];
  });
  if (imports.length !== 1 || named.join() !== 'spawnSync') violations.push('helper must import exactly `spawnSync` from child_process, once');
  if (rawCalls.length !== 1 || calleeName(rawCalls[0].expression) !== 'spawnSync') {
    violations.push('helper must contain exactly one raw spawn site, a `spawnSync` call');
  } else {
    const parent = rawCalls[0].parent;
    const checked = ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)
      && parent.expression.text === 'checkProcessResult' && parent.arguments[2] === rawCalls[0];
    if (!checked) violations.push('the raw `spawnSync` result must be passed directly to `checkProcessResult(command, args, <result>)`');
  }
  return violations;
}

// ── 1. process-check boundary ──────────────────────────────────────────────────────────────────────────────
/** The pre-#4807 negative assertion: `expect(sandbox(...).status).not.toBe(0)`. */
const legacyDeniedPredicate = (raw) => raw.status !== 0;

describe('4807 checked process results', () => {
  const launchError = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  const timeout = Object.assign(new Error('spawnSync sh ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const unhealthy = [
    ['ENOENT launch failure', { status: null, signal: null, error: launchError, stdout: '', stderr: '' }, /ENOENT/],
    ['timeout', { status: null, signal: 'SIGTERM', error: timeout, stdout: '', stderr: '' }, /ETIMEDOUT/],
    ['signal without error', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, /SIGKILL/],
    ['null status', { status: null, signal: null, stdout: '', stderr: '' }, /non-integer exit status \(null\)/],
    ['undefined status', { signal: null, stdout: '', stderr: '' }, /non-integer exit status \(undefined\)/],
    ['fractional status', { status: 1.5, signal: null, stdout: '', stderr: '' }, /non-integer exit status \(1\.5\)/],
    ['missing result', undefined, /no result/],
  ];

  it.each(unhealthy)('rejects %s — even though the legacy `status !== 0` check accepted it', (_name, raw, message) => {
    if (raw) expect(legacyDeniedPredicate(raw)).toBe(true); // the old defect, pinned for every row that has a result
    expect(() => checkProcessResult('codex', ['sandbox'], raw)).toThrow(message);
    expect(() => checkProcessResult('codex', ['sandbox'], raw)).toThrow(ProcessCheckError);
  });

  it('puts command, status, signal, stdout and stderr in the failure diagnostics', () => {
    const raw = { status: null, signal: 'SIGKILL', stdout: 'out text\n', stderr: 'err text\n' };
    let caught;
    try { checkProcessResult('sh', ['-c', "echo 'it'"], raw); } catch (e) { caught = e; }
    expect(caught.message).toContain(`sh -c 'echo '\\''it'\\'''`);
    expect(caught.message).toContain('status: null');
    expect(caught.message).toContain('signal: SIGKILL');
    expect(caught.message).toContain('stdout: out text');
    expect(caught.message).toContain('stderr: err text');
    expect(caught.details).toMatchObject({ command: 'sh', status: null, signal: 'SIGKILL' });
  });

  it('accepts a healthy process with any integer status (classification is the caller\'s job)', () => {
    expect(checkProcessResult('x', [], { status: 0, signal: null, stdout: 'a', stderr: 'b' })).toEqual({ status: 0, stdout: 'a', stderr: 'b' });
    expect(checkProcessResult('x', [], { status: 126, signal: null }).status).toBe(126);
  });

  it('a denial can be required to carry the sandbox refusal text, not just a nonzero status', () => {
    const refusal = /Operation not permitted/;
    expect(expectDenied('sh', ['-c', 'echo "sh: x: Operation not permitted" >&2; exit 1'], {}, refusal).status).toBe(1);
    expect(() => expectDenied('sh', ['-c', 'echo "unknown flag" >&2; exit 2'], {}, refusal)).toThrow(/denial signature/);
    expect(() => expectDenied('sh', ['-c', 'exit 127'], {}, refusal)).toThrow(/denial signature/);
  });

  it('real launch failure is a ProcessCheckError, never a denial', () => {
    expect(() => expectDenied('definitely-not-a-real-binary-4807', [])).toThrow(/ENOENT/);
  });

  it('real signal and real timeout are not denials', () => {
    expect(() => expectDenied('sh', ['-c', 'kill -9 $$'])).toThrow(/signal SIGKILL/);
    expect(() => runChecked('sleep', ['5'], { timeout: 100 })).toThrow(ProcessCheckError);
  });

  it('setup / positive control demand status zero; a denial demands a genuine nonzero status', () => {
    expect(expectSuccess('sh', ['-c', 'exit 0']).status).toBe(0);
    expect(() => expectSuccess('sh', ['-c', 'exit 3'])).toThrow(/expected exit status 0/);
    expect(expectDenied('sh', ['-c', 'echo denied >&2; exit 1']).stderr).toContain('denied');
    expect(() => expectDenied('sh', ['-c', 'exit 0'])).toThrow(/expected a nonzero exit status/);
  });

  it('shellQuote round-trips spaces and apostrophes through a real shell', () => {
    for (const value of ["a b", "it's", "a'b c'd", '$(echo no)', '`echo no`']) {
      expect(expectSuccess('sh', ['-c', `printf %s ${shellQuote(value)}`]).stdout).toBe(value);
    }
  });
});

describe('4807 bounded process-check syntax guard', () => {
  const suite = readFileSync(SUITE, 'utf8');
  const helper = readFileSync(HELPER, 'utf8');
  const CHECKED = "checkProcessResult(command, args, spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options }))";

  it('accepts the live suite and the checked helper as shipped', () => {
    expect(findProcessViolations(suite, 'suite')).toEqual([]);
    expect(findProcessViolations(helper, 'helper')).toEqual([]);
  });

  it.each([
    ['unchecked git init (the pre-#4807 shape)', "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['init', '-q', d]);"],
    ['namespace import', "import * as cp from 'child_process';\ncp.execSync('git init');"],
    ['require', "const { spawnSync } = require('node:child_process');"],
    ['dynamic import', "const cp = await import('node:child_process');"],
    ['re-export', "export { spawnSync } from 'node:child_process';"],
    ['bare execFileSync call', 'execFileSync("git", ["init"]);'],
  ])('rejects a suite bypass: %s', (_name, source) => {
    expect(findProcessViolations(source, 'suite').length).toBeGreaterThan(0);
  });

  it('the unchanged suite text would be rejected had it kept the legacy raw spawn', () => {
    const legacy = `${suite}\nimport { spawnSync } from 'node:child_process';\nspawnSync('git', ['init', '-q', base]);\n`;
    expect(findProcessViolations(legacy, 'suite')).toEqual(expect.arrayContaining([expect.stringContaining('suite must not')]));
  });

  it('every expectDenied call in the live suite passes a denial signature (4th argument)', () => {
    const sf = ts.createSourceFile('suite.mjs', suite, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const calls = [];
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'expectDenied') calls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.arguments.length).toBe(4);
    expect(suite).toContain('const DENIAL = /Operation not permitted/;');
  });

  it('rejects helper mutations that leave the raw spawn unchecked', () => {
    expect(helper).toContain(CHECKED); // the mutations below are not vacuous
    const unchecked = helper.replace(CHECKED, "spawnSync(command, args, { encoding: 'utf8', ...options })");
    expect(findProcessViolations(unchecked, 'helper')).toEqual(expect.arrayContaining([expect.stringContaining('checkProcessResult')]));
    const wrongSink = helper.replace(CHECKED, "String(spawnSync(command, args, { encoding: 'utf8', ...options }))");
    expect(findProcessViolations(wrongSink, 'helper').length).toBeGreaterThan(0);
    const secondSite = `${helper}\nexport const sneaky = (c) => spawnSync(c, []);\n`;
    expect(findProcessViolations(secondSite, 'helper')).toEqual(expect.arrayContaining([expect.stringContaining('exactly one raw spawn site')]));
    const extraImport = helper.replace("import { spawnSync } from 'node:child_process';", "import { spawnSync, execSync } from 'node:child_process';");
    expect(findProcessViolations(extraImport, 'helper')).toEqual(expect.arrayContaining([expect.stringContaining('exactly `spawnSync`')]));
  });
});

// ── 3. the clone-topology fixture (no Codex) ───────────────────────────────────────────────────────────────
describe('4807 production-shaped clone fixture', () => {
  it('builds independent reference clones below the real home, then cleans only its own root', () => {
    const fx = createLaneFixture();
    try {
      expect(fx.base.startsWith(realHome())).toBe(true);
      expect(fx.impl).not.toBe(fx.we);
      for (const [side, lane] of [['impl', fx.impl], ['we', fx.we]]) {
        const t = fx.topology[side];
        expect(t.gitDir).toBe(join(lane, '.git'));
        expect(t.commonDir).toBe(join(lane, '.git'));
        expect(t.alternates.some((line) => line.endsWith(`${side}-primary/.git/objects`))).toBe(true);
      }
      expect(readFileSync(join(fx.we, '.git/hooks/pre-commit'), 'utf8')).toBe('orig\n');
      expect(git(fx.we, 'log', '--format=%s').stdout.trim()).toBe('seed');
      expect(existsSync(fx.sibling)).toBe(true);
      expect(readFileSync(fx.secret, 'utf8')).toBe('secret\n');
    } finally {
      fx.cleanup();
    }
    expect(existsSync(fx.base)).toBe(false);
  });

  it('tolerates paths with spaces and apostrophes in the owned root', () => {
    const fx = createLaneFixture({ prefix: ".we 4807 it's-" });
    try {
      expect(fx.topology.we.gitDir).toBe(join(fx.we, '.git'));
    } finally {
      fx.cleanup();
    }
    expect(existsSync(fx.base)).toBe(false);
  });

  it('removes the owned root when setup fails after it was created', () => {
    let owned;
    expect(() => createLaneFixture({ onBase: (b) => { owned = b; throw new Error('injected setup failure'); } })).toThrow(/injected/);
    expect(owned).toBeTruthy();
    expect(existsSync(owned)).toBe(false);
  });

  it('rejects a plain `git init` scratch repo (the pre-#4807 fixture) as not production-shaped', () => {
    const fx = createLaneFixture();
    try {
      const scratch = join(fx.base, 'scratch');
      mkdirSync(scratch);
      git(scratch, 'init', '-q');
      expect(() => verifyCloneTopology(scratch, fx.wePrimary)).toThrow();
      expect(() => verifyCloneTopology(fx.we, fx.wePrimary)).not.toThrow();
      expect(() => verifyCloneTopology(fx.we, fx.base)).toThrow(/alternates|ENOENT/);
    } finally {
      fx.cleanup();
    }
  });
});

// The fixture's base is `realpathSync`'d, and under hermetic tests the home is a per-file fake under the OS temp dir
// (`/var/...` -> `/private/var/...` on macOS), so the claim "below home" must compare canonical paths.
function realHome() { return realpathSync(homedir()); }
