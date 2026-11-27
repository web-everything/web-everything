/** Literal-call lint tripwire only, NOT the security boundary. Same-file aliases over-approximate names
 * (shadowing is ignored); dynamic commands and cross-file re-exports remain out of scope.
 * @repo-scanning-test scope=full — complete literal launch counts under scripts and symlinked skills.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
function literalLaunches(source) {
  const found = [];
  const aliases = new Set();
  const primitive = /^(?:spawn|exec|execFile|fork)(?:Sync|Fn)?$/;
  const file = ts.createSourceFile('source.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function collect(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && ['node:child_process', 'child_process'].includes(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if (primitive.test((specifier.propertyName ?? specifier.name).text)) aliases.add(specifier.name.text);
        }
      }
    }
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const)) {
      for (const declaration of node.declarations) {
        if (!declaration.initializer) continue;
        if (ts.isIdentifier(declaration.name) && ts.isPropertyAccessExpression(declaration.initializer)
          && primitive.test(declaration.initializer.name.text)) aliases.add(declaration.name.text);
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const binding of declaration.name.elements) {
            if (!binding.dotDotDotToken && ts.isIdentifier(binding.name)
              && primitive.test((binding.propertyName ?? binding.name).text)) aliases.add(binding.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(file);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
          ? callee.argumentExpression.text : callee.getText();
      const arg = node.arguments[0];
      if ((primitive.test(name) || (ts.isIdentifier(callee) && aliases.has(callee.text))) && arg && ts.isStringLiteralLike(arg)
        && /^(?:claude|codex)(?: |$)/.test(arg.text)) found.push(arg.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}
function offenders(dirs = ['scripts', '.claude/skills']) {
  const found = {};
  function walk(path, ancestors = new Set()) {
    const real = realpathSync(path);
    if (ancestors.has(real)) throw Error(`cyclic source directory: ${path}`);
    if (statSync(path).isDirectory()) {
      const next = new Set([...ancestors, real]);
      for (const entry of readdirSync(path)) {
        if (!['__tests__', 'tests', 'fixtures', 'node_modules', '.git'].includes(entry)) walk(join(path, entry), next);
      }
    } else if (path.endsWith('.mjs') && !/\.(?:test|spec)\.mjs$/.test(path)) {
      const count = literalLaunches(readFileSync(path, 'utf8')).length;
      if (count) found[relative(root, path)] = count;
    }
  }
  for (const dir of dirs) walk(join(root, dir));
  return found;
}
function overPin(counts, pins) {
  for (const [file, pin] of Object.entries(pins)) {
    if (!Number.isSafeInteger(pin) || pin < 0) throw Error(`invalid launch pin for ${file}`);
  }
  return Object.entries(counts).filter(([file, count]) => count > (Object.hasOwn(pins, file) ? pins[file] : 0));
}
describe('literal agent process call tripwire', () => {
  it('rejects unlisted files and count increases within the explicit S1 baseline', () => {
    const allowed = JSON.parse(readFileSync(join(root, 'scripts/lib/agent-launch-approved.json'), 'utf8'));
    expect(overPin(offenders(), allowed)).toEqual([]);
  });
  it('recognizes all literal process primitives, strings with commands and namespace calls', () => {
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'spawnFn']) {
      expect(literalLaunches(`cp.${name}('codex', []); ${name}("claude -p hello");`)).toHaveLength(2);
    }
    expect(literalLaunches('spawn(`claude`, []);')).toHaveLength(1);
    expect(literalLaunches("spawn('git', []); log('claude'); spawn(agent, []); // exec('codex')")).toEqual([]);
  });
  it('recognizes renamed, destructured, member-bound and element-access launch primitives', () => {
    for (const command of ['claude', 'codex']) {
      expect(literalLaunches(`
        import { spawn as run } from 'node:child_process'; run('${command}', []);
        const { execFile: x } = cp; x('${command}', []);
        const s = cp.spawn; s('${command}');
        cp['spawn']('${command}');
        const r = require('child_process').spawn; r('${command}');
      `)).toHaveLength(5);
      expect(literalLaunches(`
        import { spawn as run } from './other.mjs'; run('${command}');
        const s = cp.spawnOther; s('${command}');
      `)).toHaveLength(0);
    }
  });
  it('rejects one extra launch in an approved file, while preserving the existing site', () => {
    const existing = "spawn('claude', []);";
    const pins = { 'approved.mjs': 1 };
    const scan = source => ({ 'approved.mjs': literalLaunches(source).length });
    expect(overPin(scan(existing), pins)).toEqual([]);
    expect(overPin(scan(`${existing}\nexecFile('codex', []);`), pins)).toEqual([['approved.mjs', 2]]);
    expect(overPin({ 'new.mjs': 1 }, pins)).toEqual([['new.mjs', 1]]);
    expect(overPin({ 'approved.mjs': 0 }, pins)).toEqual([]);
  });
  it('refuses an unreadable source scope instead of reporting no launches', () => {
    expect(() => offenders(['scripts/__missing_agent_launch_scope__'])).toThrow(/ENOENT/);
  });
  it('fails closed on a malformed pin rather than exempting its file', () => {
    for (const pin of [null, '1', -1, 1.5]) expect(() => overPin({ 'old.mjs': 1 }, { 'old.mjs': pin })).toThrow(/invalid launch pin/);
  });
});
