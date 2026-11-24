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

  it('passes on the current tree', () => {
    expect(b.judge(b.run({}))).toEqual([]);
  });
});
