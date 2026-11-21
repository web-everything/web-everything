/** Literal-call lint tripwire only, NOT the security boundary. Aliases/dynamic commands need later slices.
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
  for (const dir of ['scripts', '.claude/skills']) walk(join(root, dir));
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
  it('rejects one extra launch in an approved file, while preserving the existing site', () => {
    const existing = "spawn('claude', []);";
    const pins = { 'approved.mjs': 1 };
    const scan = source => ({ 'approved.mjs': literalLaunches(source).length });
    expect(overPin(scan(existing), pins)).toEqual([]);
    expect(overPin(scan(`${existing}\nexecFile('codex', []);`), pins)).toEqual([['approved.mjs', 2]]);
    expect(overPin({ 'new.mjs': 1 }, pins)).toEqual([['new.mjs', 1]]);
    expect(overPin({ 'approved.mjs': 0 }, pins)).toEqual([]);
  });
  it('fails closed on a malformed pin rather than exempting its file', () => {
    for (const pin of [null, '1', -1, 1.5]) expect(() => overPin({ 'old.mjs': 1 }, { 'old.mjs': pin })).toThrow(/invalid launch pin/);
  });
});
