// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criticalWorkVerdict } from '../critical-work.mjs';
import { deriveAgyFixAdmission, isAdmissibleTargetPath, isAdmissibleTargetScope } from '../agy-fix-admission.mjs';

import * as admission from '../agy-fix-admission.mjs';

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
    expect(deriveAgyFixAdmission({ taskKind: 'test-fix', size: 1, scope: ['blocks/selection/__tests__/a.test.ts'] },
      { scope: ['blocks/selection/__tests__/a.test.ts'] })?.kind).toBe('test-fix');
  });
  it('refuses a test item outside the launch scope', () => {
    expect(deriveAgyFixAdmission({ size: 1, scope: ['blocks/selection/a.test.ts'] },
      { scope: ['blocks/selection/b.test.ts'] })).toBeNull();
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

describe('the repair-dispatch chain tests that hold enforcement assertions are not admissible', () => {
  it.each([
    'scripts/operations/__tests__/fix-run.test.mjs',
    'scripts/conveyor/__tests__/fix-executor-routing.test.mjs',
    'scripts/lib/__tests__/fix-executor-chain.test.mjs',
  ])('refuses %s', path => { expect(isAdmissibleTargetPath(path)).toBe(false); });
});

it('admits existing docs directories only as scopes, never as applied files', () => {
  expect(isAdmissibleTargetScope('docs')).toBe(true);
  // Existing directories still pass through the critical-work boundary.
  expect(isAdmissibleTargetScope('docs/agent')).toBe(false);
  expect(isAdmissibleTargetScope('docs/nonexistent-directory')).toBe(false);
  expect(isAdmissibleTargetPath('docs')).toBe(false);
  expect(isAdmissibleTargetPath('docs/agent')).toBe(false);
});

it('admits only allowlisted tests directory scopes while refusing them as applied files', () => {
  expect(isAdmissibleTargetScope('tests')).toBe(false);
  expect(isAdmissibleTargetPath('tests')).toBe(false);
  expect(admit({ size: 1, scope: ['tests'] })).toBeNull();
  expect(isAdmissibleTargetScope('blocks/selection/__tests__')).toBe(true);
});

it('marks every agy-build settings key direct-only while repair dispatch stays size 1', () => {
  const text = readFileSync(new URL('../../../docs/agent/testing.md', import.meta.url), 'utf8');
  const settings = JSON.parse(readFileSync(new URL('../../settings/agy-build.json', import.meta.url), 'utf8'));
  for (const key of Object.keys(settings)) expect(text).toContain(`| \`${key}\` | Direct build only |`);
  expect(text).toContain('For direct `runConfinedAgyBuild` calls only');
  expect(text).toContain('Repair dispatch always requires `size === 1`');
  expect(admit({ taskKind: 'doc-fix', size: 3, scope: ['docs'] })).toBeNull();
});

it.each([
  [{ humanRequired: true }, { humanRequired: false }],
  [{ risk: 'high' }, { risk: 'low' }],
  [{ tags: ['security'] }, { tags: [] }],
  [{ risk: 'low' }, { risk: 'high' }],
  [{ humanRequired: false }, { humanRequired: true }],
  [{ tags: [] }, { tags: ['security'] }],
])('restriction metadata can only tighten launch %j with item %j', (launch, item) => {
  expect(deriveAgyFixAdmission({ size: 1, scope: ['docs/guide.md'], ...item },
    { scope: ['docs'], ...launch })).toBeNull();
});
it.each(['guard', 'gate', 'ledger', 'audit', 'sandbox', 'settings', 'merge'])(
  'refuses enforcement name %s even under an allowlisted subject', name => {
    expect(isAdmissibleTargetPath(`blocks/selection/${name}.test.ts`)).toBe(false);
    expect(isAdmissibleTargetScope(`blocks/selection/${name}/__tests__`)).toBe(false);
  });

it('exports a frozen directory allowlist for documentation admission', () => {
  expect(admission.AGY_DOC_DIRECTORY_PREFIXES).toEqual(['docs/']);
  expect(Object.isFrozen(admission.AGY_DOC_DIRECTORY_PREFIXES)).toBe(true);
});
it.each(refusedTargets)('refuses forbidden file %s as a scope too', path => {
  expect(isAdmissibleTargetScope(path)).toBe(false);
});
