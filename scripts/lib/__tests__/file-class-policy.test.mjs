import { test, expect, vi } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { classify, evaluate, cascadeLoosening, digestOf, recordOnly } from '../file-class-policy.mjs';
const fixture = n => JSON.parse(readFileSync(`scripts/lib/__tests__/fixtures/file-class-policy/${n}.json`, 'utf8'));
const chain = [fixture('policy.company'), fixture('manifest.web-everything')], presets = [fixture('preset.ours')];
const input = change => ({ chain, presets, change });
const keys = fs => fs.map(f => `${f.path}|${f.kind}`).sort();
test('PR 7336 fixture evaluates to the recorded verdict (committed-generated, not-writer)', () => {
  const e = fixture('live.ev7336'), got = evaluate(input(fixture('live.ch7336')));
  expect(got.files).toEqual(e.files); expect(keys(got.findings)).toEqual(keys(e.findings));
  expect(got.verdict).toBe(e.verdict.predicate.verdict);
});
test.each(fixture('vectors'))('$id $target $note', v => {
  const x = v.input;
  if (v.target === 'rule:cascadeLoosening') expect(cascadeLoosening(x).length === 0).toBe(v.expect === 'valid');
  else if (v.target === 'rule:classifyClaim') {
    const c = classify(x.chain, x.presets, x.path);
    const got = c.ambiguous ? 'ambiguous' : c.class ? { class: c.class, level: c.row.level, via: c.row.via, row: c.row.row } : { unmatched: c.unmatched ?? 'closed' };
    expect(JSON.stringify(got) === JSON.stringify(x.expect)).toBe(v.expect === 'valid');
  } else {
    const got = evaluate(x), e = x.evaluation;
    expect(got.files).toEqual(e.files); expect(keys(got.findings)).toEqual(keys(e.findings));
    expect(got.verdict).toBe(e.verdict.predicate.verdict);
  }
});
const timings = writer => input({ ...fixture('live.ch7336'), files: [{ path: 'scripts/ci/test-timings.json', status: 'modified' }],
  ignore: chain[1].rows.filter(r => r.class === 'generated').map(r => r.glob), writer });
test('a bot-owned timings change by the named app passes; by anyone else fails not-writer', () => {
  const identity = chain[1].rows.find(r => r.class === 'bot-owned').params.writers[0];
  expect(evaluate(timings({ identity, proof: { provenanceTier: 'probe' } })).verdict).toBe('pass');
  for (const id of [null, { ...identity, app: 'impostor' }, { ...identity, ref: 'refs/heads/other' }])
    expect(keys(evaluate(timings({ identity: id })).findings)).toContain('scripts/ci/test-timings.json|not-writer');
});
test('missing writer proof refuses instead of treating absence as success', () => {
  const identity = chain[1].rows.find(r => r.class === 'bot-owned').params.writers[0];
  expect(evaluate(timings({ identity })).verdict).toBe('unknown');
});
test('an ambiguous or unmatched path gives unknown, never pass', () => {
  for (const rows of [[], [{ glob: 'x', class: 'source' }, { glob: 'x', class: 'append-only' }], [{ glob: 'x', class: 'x-unknown' }]])
    expect(evaluate({ chain: [{ id: 'policy', rows }], presets: [], change: { files: [{ path: 'x', status: 'modified' }] } }).verdict).toBe('unknown');
});
test('record-only writer pins policy/head and never produces exit code, label or status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-class-')), exit = vi.spyOn(process, 'exit'), before = process.exitCode;
  try {
    for (const n of [7336, 7378]) {
      const x = input(fixture(`live.ch${n}`)), path = join(dir, `${n}.json`), e = recordOnly(x, path);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(e)));
      expect(e.policy).toEqual(chain.map(p => ({ uri: p.id, digest: digestOf(p) })));
      expect(e.head).toBe(x.change.head); expect(keys(e.findings)).toEqual(keys(fixture(`live.ev${n}`).findings));
      for (const k of ['exitCode', 'label', 'status']) expect(e).not.toHaveProperty(k);
    }
    expect(exit).not.toHaveBeenCalled(); expect(process.exitCode).toBe(before);
  } finally { exit.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
test.each(['', 'abc', 'g'.repeat(40), 'a'.repeat(41), 'a'.repeat(40) + '\n'])('head binding refuses non-40-hex head %j', head => {
  expect(() => recordOnly(input({ ...fixture('live.ch7336'), head }))).toThrow(/head/);
});
test('unreadable or incomplete input refuses; no fail-open catch', () => {
  for (const x of ['missing-file-class-input.json', {}, { chain, change: {} }, { chain: [], change: { files: [] } }])
    expect(() => recordOnly(x)).toThrow();
});
// Inspect module specifiers: the shared guard floor exports the engine's path as inert data.
const importsEngine = (source, path = 'script.mjs') => {
  if (!source.includes('file-class-policy.mjs')) return false;
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
  expect(tree.parseDiagnostics, path).toEqual([]);
  let found = false;
  const visit = node => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require'
        || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require') ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteralLike(specifier) && /(?:^|\/)file-class-policy\.mjs$/.test(specifier.text)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
};
test.each([
  "import { recordOnly } from './file-class-policy.mjs';",
  "import './file-class-policy.mjs';",
  "export { recordOnly } from './file-class-policy.mjs';",
  "export * from './file-class-policy.mjs';",
  "const engine = import('./file-class-policy.mjs');",
  'const engine = import(`./file-class-policy.mjs`);',
  "const engine = require('./file-class-policy.mjs');",
  "const engine = require(\n './file-class-policy.mjs',\n);",
  "const engine = module.require('./file-class-policy.mjs');",
])('importer guard rejects executable engine reference %s', source => expect(importsEngine(source)).toBe(true));
test('importer guard accepts exported path data and comments', () => {
  expect(importsEngine("export const paths = ['scripts/lib/file-class-policy.mjs'];")).toBe(false);
  expect(importsEngine("// import './file-class-policy.mjs';")).toBe(false);
});
test('importer guard refuses malformed source mentioning the engine', () => {
  expect(() => importsEngine("import './file-class-policy.mjs")).toThrow();
});
test('no other script imports the module for merge decisions', () => {
  const walk = p => readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)]);
  const callers = walk('scripts').filter(p => /\.[cm]?[jt]s$/.test(p) && !p.includes('__tests__') && !p.endsWith('/file-class-policy.mjs'))
    .filter(p => importsEngine(readFileSync(p, 'utf8'), p));
  expect(callers).toEqual([]);
});
