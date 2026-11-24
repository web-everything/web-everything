import { describe, expect, it } from 'vitest';
import b, { packageChains } from './deps-job-builtins-only-import-chain.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('deps job import walker', () => {
  it('names the chain for a top-level package import reached through a relative module', () => {
    const files = {
      'entry.mjs': "import {\n x\n} from './rule.mjs';\nimport 'node:fs';",
      'rule.mjs': "import MarkdownIt from 'markdown-it';",
    };
    expect(packageChains('entry.mjs', p => files[p])).toEqual(['entry.mjs -> rule.mjs -> markdown-it']);
  });

  it('catches re-exports and non-indented dynamic loads, allows indented lazy loads', () => {
    expect(packageChains('e.mjs', () => "export * from 'ext';\nconst x = await import('other');")).toEqual([
      'e.mjs -> ext', 'e.mjs -> other',
    ]);
    expect(packageChains('e.mjs', () => "function f() {\n  return import('lazy');\n}")).toEqual([]);
  });

  it.each([
    ["const s = '/*'; import x from 'ext'; const e = '*/';", ['e.mjs -> ext']],
    ["  import x from 'ext';", ['e.mjs -> ext']],
    ["const a = 1; import x from 'ext';", ['e.mjs -> ext']],
    ["await import(\n'ext'\n);", ['e.mjs -> ext']],
    ["{ await import('ext'); }", ['e.mjs -> ext']],
    ["(async () => { await import('ext'); })();", ['e.mjs -> ext']],
    ['await import(`ext`);', ['e.mjs -> ext']],
    ['const n = "x"; await import(n);', ['e.mjs -> <non-literal specifier>']],
    ["import 'node:missing-builtin';", ['e.mjs -> node:missing-builtin']],
    ["// import x from 'ext';\n/* import y from 'ext'; */\nimport 'node:fs';", []],
    ["import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); r('ext');", ['e.mjs -> ext']],
    ["import { createRequire } from 'node:module'; createRequire(import.meta.url)('ext');", ['e.mjs -> ext']],
    ["export function f() { return import('ext'); }", []],
  ])('judges startup loads from the AST: %s', (source, expected) => {
    expect(packageChains('e.mjs', () => source)).toEqual(expected);
  });

  it('passes on the current tree', () => {
    expect(b.judge(b.run({}))).toEqual([]);
  });
});
