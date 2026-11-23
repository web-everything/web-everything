// @repo-scanning-test scope=full — the manifest check lists every tracked *.real.test.mjs.
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

/** Conservative proof, separate from the warning-only syntax scan above. Resolve lexical symbols and
 * follow direct local calls from active tests. Unknown conditions, callback consumers and test modifiers
 * do not prove execution. Authors must expose a direct call when this deliberately small analysis cannot
 * prove one. Mocking/patching makes the entire file ineligible; no mock implementation is executed here. */
export function startsRealProcess(source, file = 'scripts/__tests__/sample.real.test.mjs') {
  const tree = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = name => name === tree.fileName ? tree : undefined;
  const program = ts.createProgram([tree.fileName], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const symbol = node => checker.getSymbolAtLocation(node);
  const property = node => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
  const functionNode = node => node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node));
  // Exact repo module AND export identity; pure siblings such as gitBlobOid never qualify.
  const moduleId = text => /^(node:)?child_process$/.test(text) ? 'child_process'
    : text === 'vitest' ? 'vitest' : text.startsWith('.') ? resolve(dirname(resolve(file)), text) : text;
  const processExport = (module, name) => module === 'child_process' ? methods.has(name)
    : module === resolve('scripts/lib/git-run.mjs') && name === 'gitRun';
  function value(node, seen = new Set()) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (functionNode(node)) return { fn: node };
    if (ts.isParenthesizedExpression(node)) return value(node.expression, seen);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = value(node.expression, seen), name = property(node);
      if (base?.module && base.name === '*') return { module: base.module, name };
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && !symbol(node.expression) && ts.isStringLiteral(node.arguments[0] ?? tree)) {
      return { module: moduleId(node.arguments[0].text), name: '*' };
    }
    if (!ts.isIdentifier(node)) return;
    const declaration = symbol(node)?.valueDeclaration ?? symbol(node)?.declarations?.[0];
    if (!declaration) {
      if (['it', 'test', 'describe', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach'].includes(node.text)) return { module: 'vitest', name: node.text };
      return;
    }
    if (ts.isImportSpecifier(declaration)) return {
      module: moduleId(declaration.parent.parent.parent.moduleSpecifier.text),
      name: (declaration.propertyName ?? declaration.name).text,
    };
    if (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) {
      const imp = ts.isImportClause(declaration) ? declaration.parent : declaration.parent.parent;
      return { module: moduleId(imp.moduleSpecifier.text), name: '*' };
    }
    if (functionNode(declaration)) return { fn: declaration };
    if (ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const) return value(declaration.initializer, seen);
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const binding = declaration.parent.parent;
      if (ts.isVariableDeclaration(binding) && binding.parent.flags & ts.NodeFlags.Const) {
        const base = value(binding.initializer, seen);
        if (base?.module && base.name === '*') return { module: base.module, name: (declaration.propertyName ?? declaration.name).text };
      }
    }
  }
  let unsafe = tree.parseDiagnostics.length > 0;
  const walk = (node, visit) => { visit(node); ts.forEachChild(node, (child) => walk(child, visit)); };
  walk(tree, (node) => {
    const name = property(node) ?? (ts.isIdentifier(node) ? value(node)?.name : undefined)
      ?? (ts.isBindingElement(node) ? (node.propertyName ?? node.name).getText(tree) : undefined);
    if (['mock', 'doMock', 'spyOn', 'fn', 'stubGlobal', 'replaceProperty', 'defineProperty', 'assign', 'only'].includes(name)) unsafe = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const target = value(node.left);
      if (target?.module || target?.fn) unsafe = true;
    }
  });
  if (unsafe) return false;
  // Return both process evidence and control flow so a call after return/throw cannot qualify.
  function run(node, stack = new Set()) {
    if (!node || functionNode(node)) return { process: false };
    if (ts.isBlock(node)) {
      for (const statement of node.statements) {
        const result = run(statement, stack);
        if (result.process || result.stop) return result;
      }
      return { process: false };
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return { ...run(node.expression, stack), stop: ts.isReturnStatement(node) ? 'return' : 'throw' };
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const condition = ts.isIfStatement(node) ? node.expression : node.condition;
      if (![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(condition.kind)) return { process: false, stop: 'unknown' };
      const yes = ts.isIfStatement(node) ? node.thenStatement : node.whenTrue;
      const no = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
      return run(condition.kind === ts.SyntaxKind.TrueKeyword ? yes : no, stack);
    }
    if (ts.isCallExpression(node)) {
      if (node.questionDotToken || node.expression.questionDotToken) return { process: false };
      const callee = value(node.expression);
      if (callee?.module && processExport(callee.module, callee.name) && node.arguments.length) return { process: true };
      if (callee?.fn && !callee.fn.asteriskToken) {
        if (stack.has(callee.fn) || stack.size >= 32) return { process: false, stop: 'unknown' };
        const result = run(callee.fn.body, new Set([...stack, callee.fn]));
        if (result.process) return { process: true };
        if (result.stop && result.stop !== 'return') return result;
      }
      return { process: node.arguments.some(arg => run(arg, stack).process) };
    }
    // Do not descend into loops, deferred callbacks, classes, catch blocks or short-circuit branches.
    if (ts.isExpressionStatement(node) || ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) return run(node.expression, stack);
    if (ts.isVariableStatement(node)) return { process: node.declarationList.declarations.some(d => run(d.initializer, stack).process) };
    if (ts.isTryStatement(node)) return run(node.tryBlock, stack);
    if (ts.isIterationStatement(node, false) || ts.isSwitchStatement(node)) return { process: false, stop: 'unknown' };
    return { process: false };
  }
  function suite(statements, inheritedHooks = []) {
    const stop = statements.findIndex(statement => ts.isReturnStatement(statement) || ts.isThrowStatement(statement));
    const reachable = stop < 0 ? statements : statements.slice(0, stop);
    const calls = reachable.filter(ts.isExpressionStatement).map(s => s.expression).filter(ts.isCallExpression);
    const hooks = [...inheritedHooks, ...calls.filter(call => {
      const api = value(call.expression);
      return api?.module === 'vitest' && ['beforeAll', 'beforeEach', 'afterAll', 'afterEach'].includes(api.name);
    }).map(call => value(call.arguments[0])?.fn).filter(fn => fn && !fn.asteriskToken)];
    return calls.some(call => {
      const api = value(call.expression), fn = value(call.arguments[1])?.fn;
      if (api?.module !== 'vitest' || !fn || fn.asteriskToken) return false;
      // Numeric timeouts are supported; option objects can skip a test and need explicit analysis.
      if (call.arguments[2] && !ts.isNumericLiteral(call.arguments[2])) return false;
      if (api.name === 'describe') return ts.isBlock(fn.body) && suite([...fn.body.statements], hooks);
      return ['it', 'test'].includes(api.name) && (run(fn.body).process || hooks.some(hook => run(hook.body).process));
    });
  }
  return suite([...tree.statements]);
}

/** PURE: problems with the real tier given tracked `*.real.test.mjs` files, the manifest list and a source reader. */
export function realTierProblems(tracked, manifest, read) {
  const problems = [];
  if (!Array.isArray(manifest) || manifest.length === 0) return ['real-tier manifest must not be empty'];
  const listed = new Set(manifest);
  for (const file of tracked) {
    if (!listed.has(file)) problems.push(`${file}: real-tier file not listed in scripts/settings/real-tier-manifest.json`);
    else if (!startsRealProcess(read(file), file)) problems.push(`${file}: real-tier file never starts a real process (use a direct, unmocked subprocess call reachable from an active test)`);
  }
  for (const file of manifest) if (!tracked.includes(file)) problems.push(`${file}: listed in the real-tier manifest but not a tracked *.real.test.mjs`);
  return problems;
}

describe('real-tier manifest guard', () => {
  it.each([
    `import { spawn } from './mock-spawn.mjs'; it('mock', () => spawn('node'));`,
    `import { runGit } from './helpers/run-git.mjs'; it('mock', () => runGit(['status']));`,
    `import { spawn } from 'node:child_process'; vi.mock('node:child_process'); it('mock', () => spawn('node'));`,
    `import * as cp from 'node:child_process'; vi.spyOn(cp, 'spawn').mockImplementation(() => ({})); it('mock', () => cp.spawn('node'));`,
    `import { spawn } from 'node:child_process'; it('shadow', () => { const spawn = () => {}; spawn('node'); });`,
    `import { spawn } from 'node:child_process'; function unused() { spawn('node'); } it('empty', () => {});`,
    "import { spawn } from 'node:child_process'; it.skip('skip', () => spawn('node'));",
    "import { spawn } from 'node:child_process'; describe.skip('skip', () => { it('nested', () => spawn('node')); });",
    `import { spawn } from 'node:child_process'; it('dead', () => { if (false) spawn('node'); });`,
    `import { spawn } from 'node:child_process'; it('dead', () => { return; spawn('node'); });`,
    `import { spawn } from 'node:child_process'; it('unused callback', () => ignore(() => spawn('node')));`,
  ])('rejects mock-only, unreachable and skipped process claims: %s', source => {
    expect(realTierProblems(['a.real.test.mjs'], ['a.real.test.mjs'], () => source).join('\n')).toContain('never starts a real process');
  });
  it('rejects an empty real-tier inventory', () => {
    expect(realTierProblems([], [], () => '')).toContain('real-tier manifest must not be empty');
  });
  it('never permits an empty real test collection', async () => {
    const { default: config } = await import('../../vitest.real.config.ts');
    expect(config.test.passWithNoTests ?? false).toBe(false);
    const source = readFileSync(resolve('vitest.real.config.ts'), 'utf8');
    expect(source).not.toMatch(/\bpassWithNoTests\s*:/);
    expect(config.test.env.WE_TEST_HERMETIC).toBe('1');
    expect(config.test.env.WE_TEST_SANDBOX).toBe('0');
  });
  it('reports install failures, suite failures and timeouts from a separate dependent job', () => {
    const workflow = yaml.safeLoad(readFileSync(resolve('.github/workflows/real-tests.yml'), 'utf8'));
    const report = workflow.jobs.report;
    expect(report?.needs).toBe('real');
    expect(report?.if).toBe('failure() || cancelled()');
    expect(workflow.jobs.real.steps.every(step => !step['continue-on-error'])).toBe(true);
    expect(workflow.jobs.real.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['persist-credentials']).toBe(false);
    expect(workflow.on).not.toHaveProperty('pull_request');
    expect(workflow.jobs.real.steps.find(step => step.id === 'real').env?.GH_TOKEN).toBeUndefined();
    expect(report.steps.some(step => step.run?.includes('gh issue create'))).toBe(true);
  });
  it('fails an unlisted rename, a listed file that starts no process, and a stale manifest entry', () => {
    const sources = { 'a.real.test.mjs': `import { it } from 'vitest'; it('x', () => {});`, 'b.real.test.mjs': `import { spawnSync } from 'node:child_process'; it('real', () => spawnSync(cmd, []));` };
    const read = (file) => sources[file];
    expect(realTierProblems(['a.real.test.mjs', 'b.real.test.mjs'], ['a.real.test.mjs'], read).join('\n')).toContain('b.real.test.mjs: real-tier file not listed');
    expect(realTierProblems(['a.real.test.mjs'], ['a.real.test.mjs'], read).join('\n')).toContain('never starts a real process');
    expect(realTierProblems([], ['gone.real.test.mjs'], read).join('\n')).toContain('not a tracked');
    expect(realTierProblems(['b.real.test.mjs'], ['b.real.test.mjs'], read)).toEqual([]);
  });
  it('a comment, string or unused import never counts as starting a process', () => {
    expect(startsRealProcess(`// import { spawn } from 'node:child_process'\nimport { it } from 'vitest';`)).toBe(false);
    expect(startsRealProcess(`import { spawnSync } from 'node:child_process'; const x = 1;`)).toBe(false);
    expect(startsRealProcess(`import { spawnSync } from 'node:child_process'; spawnSync(cmd, []);`)).toBe(false);
    expect(startsRealProcess(`import { gitRun } from '../lib/git-run.mjs'; it('real', () => gitRun('git', ['status']));`)).toBe(true);
  });
  it.each([
    `import { it as check } from 'vitest'; import { spawnSync as launch } from 'node:child_process'; const helper = () => launch(process.execPath, []); check('real', () => helper());`,
    `import * as cp from 'child_process'; describe('suite', () => { it('real', () => cp['spawnSync']('git', [])); });`,
    `const { execFileSync: launch } = require('node:child_process'); test('real', () => launch('git', []));`,
    `import { spawnSync } from 'node:child_process'; beforeAll(() => spawnSync('git', [])); it('active', () => {});`,
    `import { gitRun as launch } from '../lib/git-run.mjs'; test('real', () => launch('git', []));`,
  ])('accepts direct calls, lexical helper chains and active hooks: %s', source => {
    expect(startsRealProcess(source)).toBe(true);
  });
  it.each([
    `import { gitBlobOid } from '../lib/git-run.mjs'; it('pure', () => gitBlobOid('text'));`,
    `import { gitRun } from './fixtures/git-run.mjs'; it('mock', () => gitRun('git', []));`,
    "import { spawn } from 'node:child_process'; describe.skip('skip', () => { beforeAll(() => spawn('node')); it('empty', () => {}); });",
    "import { spawn } from 'node:child_process'; beforeAll(() => spawn('node')); it.skip('skip', () => {});",
    "import { spawn } from 'node:child_process'; it.skipIf(true)('skip', () => spawn('node'));",
    `import { spawn } from 'node:child_process'; it('uncertain', () => { if (flag) spawn('node'); });`,
    `import { spawn } from 'node:child_process'; it('shadow param', spawn => spawn('node'));`,
    `import cp from 'node:child_process'; cp.spawn = () => {}; it('mock', () => cp.spawn('node'));`,
    "import { spawn } from 'node:child_process'; it('unfocused', () => spawn('node')); it.only('selected', () => {});",
    `import { spawn } from 'node:child_process'; function* lazy() { spawn('node'); } it('generator', () => lazy());`,
    `import { spawn } from 'node:child_process'; const mock = vi.mock; mock('node:child_process'); it('mock', () => spawn('node'));`,
    `import { spawn } from 'node:child_process'; const { mock: fake } = vi; fake('node:child_process'); it('mock', () => spawn('node'));`,
    `import { spawn } from 'node:child_process'; function stop() { throw Error('stop'); } it('unreachable', () => { stop(); spawn('node'); });`,
    `import { spawn } from 'node:child_process'; it('loop', () => { while (true) {} spawn('node'); });`,
    `import { spawn } from 'node:child_process'; describe('suite', () => { return; it('never registered', () => spawn('node')); });`,
    `import { spawn } from 'node:child_process'; it('skip option', () => spawn('node'), { skip: true });`,
    `import { spawn } from 'node:child_process'; it('generator', function* () { spawn('node'); });`,
    `import { spawn } from 'node:child_process'; function recurse() { recurse(); spawn('node'); } it('recursion', () => recurse());`,
  ])('fails closed for unsupported or inactive paths: %s', source => {
    expect(startsRealProcess(source)).toBe(false);
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
