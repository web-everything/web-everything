// @repo-scanning-test scope=full — the manifest check lists every tracked *.real.test.mjs.
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const methods = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']);
const childProcess = (node) => node && ts.isStringLiteral(node) && /^(node:)?child_process$/.test(node.text);

/** Pure syntax scan: detects literal commands, without executing test code. */
export function scansRealProcess(source) {
  const tree = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const functions = new Map();
  const namespaces = new Set();
  const walk = (node, visit) => { visit(node); ts.forEachChild(node, (child) => walk(child, visit)); };
  const isRequire = (node) => node && ts.isCallExpression(node)
    && node.expression.getText(tree) === 'require' && childProcess(node.arguments[0]);
  walk(tree, (node) => {
    if (ts.isImportDeclaration(node) && childProcess(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const entry of bindings.elements) functions.set(entry.name.text, (entry.propertyName ?? entry.name).text);
      }
    }
    if (ts.isVariableDeclaration(node) && isRequire(node.initializer)) {
      if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const entry of node.name.elements) functions.set(entry.name.getText(tree), (entry.propertyName ?? entry.name).getText(tree));
      }
    }
  });
  let found = false;
  walk(tree, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    let method;
    if (ts.isIdentifier(callee)) method = functions.get(callee.text);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      if (namespaces.has(callee.expression.getText(tree)) || isRequire(callee.expression)) {
        method = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.argumentExpression?.text;
      }
    }
    if (!methods.has(method)) return;
    const command = node.arguments[0];
    if (!command) return;
    if (command.getText(tree).replace(/\s/g, '') === 'process.execPath') found = true;
    if (ts.isStringLiteral(command) || ts.isNoSubstitutionTemplateLiteral(command)) {
      const value = command.text;
      if (/^(node|git|gh)$/.test(value)
        || (/^exec(Sync)?$/.test(method) && /^(node|git|gh)(?:\s|$)/.test(value))) found = true;
    }
  });
  return found;
}

/** A real-tier file must actually start a real process: a literal command scan, any child_process import, or a
 *  spawn/git helper import. A rename to `*.real.test.mjs` alone must not move a mock test out of PR validation. */
export function startsRealProcess(source) {
  if (scansRealProcess(source)) return true;
  // AST only (comments and strings never count): a child_process or spawn-helper binding must be CALLED.
  const tree = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const helper = (text) => /^(node:)?child_process$/.test(text) || /(spawn|run-?git|git-?run|exec-?file)/i.test(text);
  const bound = new Set();
  const walk = (node, visit) => { visit(node); ts.forEachChild(node, (child) => walk(child, visit)); };
  walk(tree, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && helper(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) bound.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bound.add(clause.namedBindings.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const e of clause.namedBindings.elements) bound.add(e.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(tree) === 'require' && ts.isStringLiteral(node.initializer.arguments[0] ?? node)
      && helper(node.initializer.arguments[0].text)) {
      if (ts.isIdentifier(node.name)) bound.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) for (const e of node.name.elements) bound.add(e.name.getText(tree));
    }
  });
  let called = false;
  walk(tree, (node) => {
    if (!ts.isCallExpression(node)) return;
    let callee = node.expression;
    while (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) callee = callee.expression;
    if (ts.isIdentifier(callee) && bound.has(callee.text)) called = true;
  });
  return called;
}

/** PURE: problems with the real tier given tracked `*.real.test.mjs` files, the manifest list and a source reader. */
export function realTierProblems(tracked, manifest, read) {
  const problems = [];
  const listed = new Set(manifest);
  for (const file of tracked) {
    if (!listed.has(file)) problems.push(`${file}: real-tier file not listed in scripts/settings/real-tier-manifest.json`);
    else if (!startsRealProcess(read(file))) problems.push(`${file}: real-tier file never starts a real process (import child_process, git or a spawn helper)`);
  }
  for (const file of manifest) if (!tracked.includes(file)) problems.push(`${file}: listed in the real-tier manifest but not a tracked *.real.test.mjs`);
  return problems;
}

describe('real-tier manifest guard', () => {
  it('fails an unlisted rename, a listed file that starts no process, and a stale manifest entry', () => {
    const sources = { 'a.real.test.mjs': `import { it } from 'vitest'; it('x', () => {});`, 'b.real.test.mjs': `import { spawnSync } from 'node:child_process'; spawnSync(cmd, []);` };
    const read = (file) => sources[file];
    expect(realTierProblems(['a.real.test.mjs', 'b.real.test.mjs'], ['a.real.test.mjs'], read).join('\n')).toContain('b.real.test.mjs: real-tier file not listed');
    expect(realTierProblems(['a.real.test.mjs'], ['a.real.test.mjs'], read).join('\n')).toContain('never starts a real process');
    expect(realTierProblems([], ['gone.real.test.mjs'], read).join('\n')).toContain('not a tracked');
    expect(realTierProblems(['b.real.test.mjs'], ['b.real.test.mjs'], read)).toEqual([]);
  });
  it('a comment, string or unused import never counts as starting a process', () => {
    expect(startsRealProcess(`// import { spawn } from 'node:child_process'\nimport { it } from 'vitest';`)).toBe(false);
    expect(startsRealProcess(`import { spawnSync } from 'node:child_process'; const x = 1;`)).toBe(false);
    expect(startsRealProcess(`import { spawnSync } from 'node:child_process'; spawnSync(cmd, []);`)).toBe(true);
    expect(startsRealProcess(`import { runGit } from './helpers/run-git.mjs'; runGit(['status']);`)).toBe(true);
  });
  it('every tracked *.real.test.mjs is listed in the manifest and starts a real process', () => {
    const root = process.cwd();
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
      .split('\0').filter((file) => file.endsWith('.real.test.mjs')).sort();
    const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/settings/real-tier-manifest.json'), 'utf8')).realTierFiles;
    expect(realTierProblems(tracked, manifest, (file) => readFileSync(resolve(root, file), 'utf8'))).toEqual([]);
  });
});

describe('real-process syntax scan', () => {
  for (const method of methods) {
    for (const command of ["'node'", 'process.execPath', "'git'", "'gh'"]) {
      it(`flags ${method}(${command}) through an aliased import`, () => {
        expect(scansRealProcess(`import { ${method} as run } from 'node:child_process'; run(${command}, []);`)).toBe(true);
      });
    }
  }
  it.each([
    `import * as cp from 'child_process'; cp.spawn('git', []);`,
    `import cp from 'node:child_process'; cp['execSync']('gh pr list');`,
    `const { execFile: run } = require('child_process'); run(process.execPath, []);`,
    `const cp = require('node:child_process'); cp.spawnSync('node', []);`,
    `require('child_process').exec('git status');`,
  ])('flags namespace, require and shell forms: %s', (source) => {
    expect(scansRealProcess(source)).toBe(true);
  });
  it.each([
    `// spawn('node');\nconst text = "execSync('git')";`,
    `import { spawn } from 'somewhere-else'; spawn('node');`,
    `import { spawn } from 'child_process'; spawn('echo', ['git']);`,
    `import { exec } from 'child_process'; exec('github --help');`,
    `import { execFile } from 'child_process'; execFile(command, []);`,
    `import { spawn } from 'child_process'; spawn();`,
  ])('passes non-command text and unrelated calls: %s', (source) => {
    expect(scansRealProcess(source)).toBe(false);
  });
});

it('warns about new offenders and retired baseline entries without gating PRs', () => {
  try {
    const root = process.cwd();
    const guardPath = 'scripts/__tests__/real-process-guard.test.mjs';
    const files = execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    }).split('\0').filter((file) => /\.test\.(mjs|ts)$/.test(file) && !file.endsWith('.real.test.mjs') && file !== guardPath);
    const baseline = new Set(JSON.parse(readFileSync(resolve(root, 'scripts/settings/real-process-test-baseline.json'), 'utf8')).files);
    const offenders = files.filter((file) => scansRealProcess(readFileSync(resolve(root, file), 'utf8'))).sort();
    const current = new Set(offenders);
    const added = offenders.filter((file) => !baseline.has(file));
    const retired = [...baseline].filter((file) => !current.has(file)).sort();
    if (added.length) console.warn('R1063a new real-process tests (move to *.real.test.mjs):\n' + added.join('\n'));
    if (retired.length) console.warn('R1063a baseline entries no longer offending (remove):\n' + retired.join('\n'));
  } catch (error) {
    console.warn('R1063a real-process scan incomplete; inspect manually:', error.message);
  }
});
