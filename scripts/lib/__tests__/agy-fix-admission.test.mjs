// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criticalWorkVerdict } from '../critical-work.mjs';
import { deriveAgyFixAdmission } from '../agy-fix-admission.mjs';

const admit = item => deriveAgyFixAdmission(item, { scope: item.scope });

it('marks depth-1 local enforcement imports, the AgY spawn/juror chain and existing sibling tests critical', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const entrypoints = ['scripts/lib/agy-confined-build.mjs', 'scripts/lib/agy-sandbox.mjs',
    'scripts/lib/agy-fix-admission.mjs', 'scripts/operations/agy-fix-provider.mjs'];
  const targets = new Set([...entrypoints,
    'scripts/gemini-direct-task.mjs', 'scripts/lib/agy-review-juror.mjs',
    'scripts/lib/antigravity-judge-spawn.mjs', 'scripts/lib/antigravity-model-effort.mjs',
    'scripts/lib/antigravity-run-evidence.mjs', 'scripts/lib/judge-spawn.mjs',
    'scripts/lib/policy-cascade.mjs', 'scripts/lib/mandate-fence.mjs', 'scripts/lib/critical-work.mjs',
    'scripts/lib/provider-quota-hold.mjs', 'scripts/lib/secret-scrub.mjs', 'scripts/lib/bounded-child.mjs',
    'scripts/lib/dispatch-routing-policy.mjs', 'scripts/lib/dispatch-routing-policy.json',
    'scripts/lib/provider-routing.mjs', 'scripts/lib/dispatch-routing-policy-source.mjs',
  ]);
  // Inspect only entrypoint imports (depth 1): deeper generic infrastructure is intentionally
  // not critical merely by transitive import. The named spawn/juror chain is pinned above.
  for (const path of entrypoints) {
    const source = readFileSync(resolve(root, path), 'utf8');
    const imports = source.matchAll(/^import\s+[^;]*?\s+from\s*['"](\.{1,2}\/[^'"]+)['"]/gm);
    for (const [, specifier] of imports) {
      const dependency = relative(root, resolve(root, dirname(path), specifier));
      if (dependency !== '..' && !dependency.startsWith('../')) targets.add(dependency);
    }
  }
  for (const path of targets) {
    const sibling = path.endsWith('.mjs') ? path.replace(/([^/]+)\.mjs$/, '__tests__/$1.test.mjs') : null;
    for (const target of [path, ...(sibling && existsSync(resolve(root, sibling)) ? [sibling] : [])]) {
      expect(criticalWorkVerdict({ filesTouched: [target] }).critical, target).toBe(true);
    }
  }
});

describe('repair scope admission', () => {
  it.each([
    [['docs/guide.md'], ['docs/agent']],
    [['docs/guide.md'], ['docs']],
    [['docs'], ['docs/a.md', 'src/main.ts']],
    [undefined, ['docs/a.md']],
    [['docs'], []],
    [['docs'], ['docs-other/guide.md']],
    [['docs'], Array(1)],
    [Array.from({ length: 21 }, (_, i) => `docs/${i}.md`), ['docs/0.md']],
  ])('refuses widening or missing routing evidence: launch %j item %j', (launchScope, scope) => {
    expect(deriveAgyFixAdmission({ size: 1, scope }, { scope: launchScope })).toBeNull();
  });
  it('admits only item paths contained in a launch entry, normalizing repo prefixes', () => {
    expect(deriveAgyFixAdmission({ size: 1, scope: ['we:docs/guide.md'] }, { scope: 'we:docs,tests' }))
      .toEqual({ kind: 'doc-fix', size: 1, scope: ['docs/guide.md'] });
  });
  it('admits a test item inside a broader source launch scope', () => {
    expect(deriveAgyFixAdmission({ taskKind: 'test-fix', size: 1, scope: ['src/__tests__/a.ts'] }, { scope: ['src'] })?.kind)
      .toBe('test-fix');
  });
  it.each(['docs/agent', 'docs/agent/testing.md', 'scripts/hooks', 'scripts/hooks/check.mjs',
    'scripts/lib/review-policy.mjs', 'scripts/lib/new-policy.mjs', 'scripts/lib/critical-work.mjs',
    'scripts/settings/agy-build.json', '.github', '.github/CODEOWNERS', 'AGENTS.md'])
  ('refuses effective critical path %s with next-provider/operator fallback', path => {
    expect(admit({ size: 1, scope: [path] })).toBeNull();
  });
  it('refuses explicit critical metadata even for ordinary scope', () => {
    expect(admit({ size: 1, scope: ['docs/guide.md'], humanRequired: true })).toBeNull();
  });
  it.each([
    ['doc-fix', 'scripts/operations/fix-run.mjs'], ['doc-fix', 'src/_data/blocks.json'],
    ['test-fix', 'src'], ['test-fix', 'src/main.ts'], ['test-fix', '__fixtures__/data.json'],
  ])('refuses explicit %s on mismatched scope %s even at size 1', (taskKind, path) => {
    expect(admit({ taskKind, size: 1, scope: [path] })).toBeNull();
  });
  it.each(['notes.md', 'notes.mdx', 'notes.txt', 'notes.rst', 'docs', 'docs/example.mjs', 'backlog/item.md', 'agent-memory-src/topic'])
  ('admits real documentation scope %s', path => {
    expect(admit({ taskKind: 'doc-fix', size: 1, scope: [`we:${path}`] }))
      .toEqual({ kind: 'doc-fix', size: 1, scope: [path] });
  });
  it.each(['tests', 'tests/helpers/run.mjs', 'src/__tests__', 'src/__tests__/case.ts', 'src/foo.test.ts', 'src/foo.spec.mjs'])
  ('admits real test scope %s', path => {
    expect(admit({ taskKind: 'test-fix', size: 1, scope: [path] })?.kind).toBe('test-fix');
  });
  it.each(['fix', 'feature'])('admits bounded size-1 source scope for %s', taskKind => {
    expect(admit({ taskKind, size: 1, scope: ['src/main.ts'] }))
      .toEqual({ kind: taskKind, size: 1, scope: ['src/main.ts'] });
  });
  it.each(['.git/config', '.GIT/config', '.github/workflows/ci.yml', '.github', 'package.json',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json',
    'docs/.github/workflows/x.yml', 'tests/deep/pnpm-lock.yaml', 'docs/scripts/settings/config.json',
    'scripts/settings/agy-build.json', 'scripts/settings', 'scripts', 'nested/package.json'])
  ('refuses protected scope %s with operator fallback via null admission', path => {
    expect(admit({ taskKind: 'fix', size: 1, scope: [path] })).toBeNull();
  });
  it.each([
    { size: 1, scope: Array.from({ length: 21 }, (_, i) => `docs/${i}.md`) }, { size: 0, scope: ['a.md'] },
    { size: NaN, scope: ['a.md'] },
    { size: 2, scope: ['a.md'] }, { size: 1, scope: [] }, { size: 1, scope: ['fui:docs'] },
    { size: 1, scope: ['../a.md'] }, { scope: ['a.md'] },
  ])('refuses missing, oversized or unsafe evidence %j', item => {
    expect(admit({ taskKind: 'doc-fix', ...item })).toBeNull();
  });
  it.each([2, 20])('admits %s scope entries independently of size', count => {
    const scope = Array.from({ length: count }, (_, i) => `docs/${i}.md`);
    expect(admit({ taskKind: 'doc-fix', size: 1, scope }))
      .toEqual({ kind: 'doc-fix', size: 1, scope });
  });
});

it.each([
  'scripts/lib/agy-confined-build.mjs', 'scripts/lib/agy-sandbox.mjs',
  'scripts/lib/agy-fix-admission.mjs', 'scripts/operations/agy-fix-provider.mjs',
  'scripts/settings/agy-build.json', 'scripts/lib/agy-confined-future.mjs',
  'scripts/lib/__tests__/agy-confined-build.test.mjs',
  'scripts/lib/__tests__/agy-confined-launcher.test.mjs',
  'scripts/lib/__tests__/agy-confined-future.test.mjs',
  'scripts/lib/__tests__/agy-sandbox.test.mjs', 'scripts/lib/__tests__/agy-fix-admission.test.mjs',
])('shared verdict marks confinement path %s critical and refuses size-1 admission', path => {
  expect(criticalWorkVerdict({ filesTouched: [path] }).critical).toBe(true);
  expect(admit({ taskKind: 'fix', size: 1, scope: [path] })).toBeNull();
});
it('shared verdict keeps ordinary documentation non-critical and admissible', () => {
  expect(criticalWorkVerdict({ filesTouched: ['docs/guide.md'] }).critical).toBe(false);
  expect(admit({ size: 1, scope: ['docs/guide.md'] })).not.toBeNull();
});
