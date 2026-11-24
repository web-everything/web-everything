import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import b, { packageChains, probe } from './deps-job-builtins-only-import-chain.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

defineBreakTest(b);

const ENTRY = 'scripts/lib/daemon-rebuild/deps-job.mjs';
const checkouts = [];
function checkoutWith(files) {
  const checkout = mkdtempSync(join(tmpdir(), 'deps-soak-'));
  checkouts.push(checkout);
  Object.entries(files).forEach(([path, source]) => {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), source);
  });
  return checkout;
}
afterEach(() => {
  checkouts.splice(0).forEach(checkout => rmSync(checkout, { recursive: true, force: true }));
  vi.mocked(spawnSync).mockClear();
});

describe('deps job import walker', () => {
  it.each([
    "class C { [import('ext')](x = import('lazy-default')) { require('lazy-body'); } }",
    "const C = class { [require('ext')]() { import('lazy-body'); } };",
    "const o = { [import('ext')](x = require('lazy-default')) { import('lazy-body'); } };",
    "class C { static async [import('ext')]() { import('lazy-body'); } }",
    "const o = { async *[require('ext')]() { import('lazy-body'); } };",
    "class C { get [import('ext')]() { return require('lazy-body'); } }",
    "class C { set [require('ext')](x) { import('lazy-body'); } }",
    "const o = { get [import('ext')]() { return import('lazy-body'); } };",
    "const o = { set [require('ext')](x) { import('lazy-body'); } };",
    "class C { [(() => import('ext'))()]() {} }",
    "import { createRequire } from 'node:module'; const o = { [createRequire(import.meta.url)('ext')]() {} };",
  ])('catches startup loads in computed method names while leaving bodies and defaults lazy: %s', source => {
    expect(packageChains('e.mjs', () => source)).toEqual(['e.mjs -> ext']);
  });

  it.each([
    "function lazy() { class C { [import('ext')]() {} } }",
    "const lazy = () => ({ [require('ext')]() {} });",
    "class C { [() => import('ext')]() {} }",
    "const o = { [() => require('ext')]() {} };",
  ])('keeps deferred computed names and functions inside names lazy: %s', source => {
    expect(packageChains('e.mjs', () => source)).toEqual([]);
  });

  it.each([
    "class C { [import('./rule.mjs')]() {} }",
    "const o = { [require('./rule.mjs')]() {} };",
  ])('follows relative loads from computed method names through the import chain: %s', entry => {
    const files = { 'entry.mjs': entry, 'rule.mjs': "import 'ext';" };
    expect(packageChains('entry.mjs', p => files[p])).toEqual(['entry.mjs -> rule.mjs -> ext']);
  });

  it.each([
    'class C { [import(name)]() {} }',
    'const o = { get [require(name)]() {} };',
  ])('reports non-literal loads in computed method names as unknown: %s', source => {
    expect(packageChains('e.mjs', () => source)).toEqual(['e.mjs -> <non-literal specifier>']);
  });

  it('names the chain for a top-level package import reached through a relative module', () => {
    const files = {
      'entry.mjs': "import {\n x\n} from './rule.mjs';\nimport 'node:fs';",
      'rule.mjs': "import MarkdownIt from 'markdown-it';",
    };
    expect(packageChains('entry.mjs', p => files[p])).toEqual(['entry.mjs -> rule.mjs -> markdown-it']);
  });

  it('catches re-exports and startup dynamic loads, allows uncalled function bodies', () => {
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

  it.each([
    "(() => import('ext'))();",
    "(() => require('ext'))();",
    "(async () => import('ext'))();",
    "((() => (import('ext'))))();",
    "(() => (() => import('ext'))())();",
    "import { createRequire } from 'node:module'; (() => createRequire(import.meta.url)('ext'))();",
    "((x = import('ext')) => {})();",
    "(function (x = require('ext')) {})();",
    "(async (x = import('ext')) => {})();",
    "(({ x = import('ext') } = {}) => {})();",
    "(function ([x = require('ext')] = []) {})();",
    "((x = (() => import('ext'))()) => {})();",
  ])('catches loads in invoked function bodies and defaults: %s', source => {
    expect(packageChains('e.mjs', () => source)).toEqual(['e.mjs -> ext']);
  });

  it.each([
    "const lazy = () => import('ext');",
    "function lazy(x = import('ext')) {}",
    "const lazy = (x = require('ext')) => {};",
    "(() => () => import('ext'))();",
    "((x = () => import('ext')) => {})();",
  ])('leaves uncalled function bodies and defaults lazy: %s', source => {
    expect(packageChains('e.mjs', () => source)).toEqual([]);
  });

  it.each([
    "(() => import('./rule.mjs'))();",
    "((x = import('./rule.mjs')) => {})();",
  ])('follows relative loads from IIFEs through the import chain: %s', entry => {
    const files = { 'entry.mjs': entry, 'rule.mjs': "import 'ext';" };
    expect(packageChains('entry.mjs', p => files[p])).toEqual(['entry.mjs -> rule.mjs -> ext']);
  });

  it.each([
    '(() => import(name))();',
    '((x = require(name)) => {})();',
  ])('reports non-literal IIFE loads as unknown: %s', source => {
    expect(packageChains('e.mjs', () => source)).toEqual(['e.mjs -> <non-literal specifier>']);
  });

  it('passes on the current tree', () => {
    expect(b.judge(b.run({}))).toEqual([]);
  });

  it('ENTRY exists in the checkout and matches the break metadata', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    expect(b.fixedBy.paths).toEqual([ENTRY]);
    expect(existsSync(join(root, ENTRY))).toBe(true);
    expect(() => probe(root)).not.toThrow();
  });

  it('probe and judge name micromatch, markdown-it and js-yaml in the pre-fix deps-job chain fixture', () => {
    // Import edges from 186ce82511^, retaining only the three reviewed package paths.
    // Use source fixtures so this regression also runs in shallow CI checkouts.
    const common = [ENTRY, 'scripts/lib/daemon-overlays.mjs', 'scripts/lib/daemon-self-sync.mjs',
      'scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-rebuild/index.mjs',
      'scripts/lib/daemon-rebuild/rebuild.mjs', 'scripts/lib/daemon-rebuild/evidence-readers.mjs',
      'scripts/lib/daemon-rebuild/state.mjs', 'scripts/lib/daemon-rebuild/audited-tip.mjs'];
    const review = [...common, 'scripts/operations/prototype-load.mjs',
      'scripts/lib/net-diff-fingerprint.mjs', 'scripts/lib/review-escalation.mjs'];
    const chains = [
      [...review, 'scripts/lib/review-care-exempt-paths.mjs', 'micromatch'],
      [...review, 'markdown-it'],
      [...common, 'scripts/operations/prototype-load-io.mjs', 'scripts/daemon-overlay.mjs',
        'scripts/operations/prototype-retire.mjs', 'scripts/conveyor/supersede-rule.mjs',
        'scripts/conveyor/stand-down.mjs', 'scripts/conveyor/fix-dispatch-claim.mjs',
        'scripts/operations/dispatch-lane-io.mjs', 'scripts/conveyor/pr-watch.mjs',
        'scripts/merge-ai-prs.mjs', 'scripts/conveyor/pr-comments-complete.mjs',
        'scripts/conveyor/fix-loop-ledger.mjs', 'scripts/conveyor/main-red-recovery.mjs',
        'scripts/conveyor/ci-heal-escalation-mark.mjs', 'scripts/conveyor/ci-auth-diagnosis.mjs', 'js-yaml'],
    ];
    const edges = new Map();
    chains.forEach(chain => chain.slice(0, -1).forEach((path, i) => {
      const next = chain[i + 1];
      const spec = next.startsWith('scripts/') ? `./${posix.relative(posix.dirname(path), next)}` : next;
      if (!edges.has(path)) edges.set(path, new Set());
      edges.get(path).add(`import ${JSON.stringify(spec)};`);
    }));
    const checkout = checkoutWith(Object.fromEntries([...edges].map(([path, imports]) => [path, [...imports].join('\n')])));
    expect(b.judge(probe(checkout))).toEqual(chains.map(chain => chain.join(' -> ')));
  });

  it.each([
    [0, false, true], [0, true, true],
    [1, false, false], [1, true, false],
    [128, false, false], [null, true, false],
  ])('fixPresent follows ancestry independently of probe violations (git status %s, violations %s)', (status, violations, expected) => {
    const checkout = checkoutWith({ [ENTRY]: violations ? "import 'ext';" : "import 'node:fs';" });
    expect(b.judge(probe(checkout))).toEqual(violations ? [`${ENTRY} -> ext`] : []);
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValueOnce({ status });
    expect(b.fixedBy.sha).toBe('186ce82511');
    expect(b.fixPresent(checkout)).toBe(expected);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith('git', ['merge-base', '--is-ancestor', '186ce82511', 'HEAD'], {
      cwd: checkout, maxBuffer: 1024 * 1024,
    });
  });

  it.fails.each([
    ['invoked named function', "function boot() { require('ext'); } boot();"],
    ['aliased createRequire', "import { createRequire as makeRequire } from 'node:module'; makeRequire(import.meta.url)('ext');"],
    ['eval', "eval(\"require('ext')\");"],
  ])('known waived gap (dlv:DEPS-SOAK-HARDEN): %s', (_gap, source) => {
    expect(packageChains('e.mjs', () => source)).toEqual(['e.mjs -> ext']);
  });
});
