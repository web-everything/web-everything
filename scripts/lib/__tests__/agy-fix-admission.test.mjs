// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criticalWorkVerdict } from '../critical-work.mjs';
import { deriveAgyFixAdmission, isAdmissibleTargetPath } from '../agy-fix-admission.mjs';

import { admissibleTargets, refusedTargets } from './fixtures/agy-target-path-cases.mjs';

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
    expect(deriveAgyFixAdmission({ size: 1, scope: ['we:docs/guide.md'] }, { scope: 'we:docs' }))
      .toEqual({ kind: 'doc-fix', size: 1, scope: ['docs/guide.md'] });
  });
  it('admits a test item inside its declared launch scope', () => {
    expect(deriveAgyFixAdmission({ taskKind: 'test-fix', size: 1, scope: ['src/__tests__/a.test.ts'] },
      { scope: ['src/__tests__/a.test.ts'] })?.kind).toBe('test-fix');
  });
  it('refuses a test item outside the launch scope', () => {
    expect(deriveAgyFixAdmission({ size: 1, scope: ['src/a.test.ts'] },
      { scope: ['src/b.test.ts'] })).toBeNull();
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
  it.each(admissibleTargets)('admits allowlisted path %s independently of kind', path => {
    expect(isAdmissibleTargetPath(path)).toBe(true);
    for (const taskKind of ['doc-fix', 'test-fix', 'fix', 'feature'])
      expect(admit({ taskKind, size: 1, scope: [`we:${path}`] })).not.toBeNull();
  });
  it.each(refusedTargets)('refuses non-allowlisted scope %s for every kind', path => {
    expect(isAdmissibleTargetPath(path)).toBe(false);
    for (const taskKind of ['doc-fix', 'test-fix', 'fix', 'feature'])
      expect(admit({ taskKind, size: 1, scope: [path] })).toBeNull();
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

describe('tests of critical subjects and fixtures are not admissible (audit: gate regression tests)', () => {
  it.each([
    'scripts/lib/__tests__/fixtures/agy-target-path-cases.mjs',
    'scripts/lib/__tests__/required-status-checks.test.mjs',
    'scripts/lib/__tests__/agy-confined-build.test.mjs',
  ])('refuses %s', path => { expect(isAdmissibleTargetPath(path)).toBe(false); });
  it('still admits a test whose subject is not critical', () => {
    expect(isAdmissibleTargetPath('docs/guide.md')).toBe(true);
  });
});
