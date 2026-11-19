/** Literal-call lint tripwire only, NOT the security boundary. Aliases/dynamic commands need later slices. */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
function literalLaunches(source) {
  const found = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText();
      const arg = node.arguments[0];
      if (/^(?:spawn|exec|execFile|fork)(?:Sync|Fn)?$/.test(name) && arg && ts.isStringLiteralLike(arg)
        && /^(?:claude|codex)(?: |$)/.test(arg.text)) found.push(arg.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile('source.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  return found;
}
function offenders() {
  const found = [];
  function scan(path, ancestors = new Set()) {
    const real = realpathSync(path);
    if (ancestors.has(real)) throw Error(`cyclic source directory: ${path}`);
    if (statSync(path).isDirectory()) {
      const next = new Set([...ancestors, real]);
      for (const entry of readdirSync(path)) {
        if (!['__tests__', 'tests', 'fixtures', 'node_modules', '.git'].includes(entry)) scan(join(path, entry), next);
      }
    } else if (path.endsWith('.mjs') && !/\.(?:test|spec)\.mjs$/.test(path) && literalLaunches(readFileSync(path, 'utf8')).length) {
      found.push(relative(root, path));
    }
  }
  for (const dir of ['scripts', '.claude/skills']) scan(join(root, dir));
  return found.sort();
}
describe('literal agent process call tripwire', () => {
  it('rejects every new offender outside the explicit S1 baseline', () => {
    const allowed = JSON.parse(readFileSync(join(root, 'scripts/lib/agent-launch-approved.json'), 'utf8'));
    expect(offenders().filter(path => !allowed.includes(path))).toEqual([]);
  });
  it('recognizes all literal process primitives, strings with commands and namespace calls', () => {
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'spawnFn']) {
      expect(literalLaunches(`cp.${name}('codex', []); ${name}("claude -p hello");`)).toHaveLength(2);
    }
    expect(literalLaunches('spawn(`claude`, []);')).toHaveLength(1);
    expect(literalLaunches("spawn('git', []); log('claude'); spawn(agent, []); // exec('codex')")).toEqual([]);
    const allowed = ['old.mjs'];
    expect(['old.mjs', 'new.mjs'].filter(path => !allowed.includes(path))).toEqual(['new.mjs']);
  });
});
