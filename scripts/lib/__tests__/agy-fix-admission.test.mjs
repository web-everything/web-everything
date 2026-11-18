// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveAgyFixAdmission } from '../agy-fix-admission.mjs';

describe('repair scope admission', () => {
  it.each([
    ['doc-fix', 'scripts/operations/fix-run.mjs'], ['doc-fix', 'src/_data/blocks.json'],
    ['test-fix', 'src'], ['test-fix', 'src/main.ts'], ['test-fix', '__fixtures__/data.json'],
  ])('refuses explicit %s on mismatched scope %s even at size 1', (taskKind, path) => {
    expect(deriveAgyFixAdmission({ taskKind, size: 1, scope: [path] })).toBeNull();
  });
  it.each(['notes.md', 'notes.mdx', 'notes.txt', 'notes.rst', 'docs', 'docs/example.mjs', 'backlog/item.md', 'agent-memory-src/topic'])
  ('admits real documentation scope %s', path => {
    expect(deriveAgyFixAdmission({ taskKind: 'doc-fix', size: 1, scope: [`we:${path}`] }))
      .toEqual({ kind: 'doc-fix', size: 1, scope: [path] });
  });
  it.each(['tests', 'tests/helpers/run.mjs', 'src/__tests__', 'src/__tests__/case.ts', 'src/foo.test.ts', 'src/foo.spec.mjs'])
  ('admits real test scope %s', path => {
    expect(deriveAgyFixAdmission({ taskKind: 'test-fix', size: 1, scope: [path] })?.kind).toBe('test-fix');
  });
  it.each(['fix', 'feature'])('admits bounded size-1 source scope for %s', taskKind => {
    expect(deriveAgyFixAdmission({ taskKind, size: 1, scope: ['src/main.ts'] }))
      .toEqual({ kind: taskKind, size: 1, scope: ['src/main.ts'] });
  });
  it.each(['.git/config', '.GIT/config', '.github/workflows/ci.yml', '.github', 'package.json',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json',
    'scripts/settings/agy-build.json', 'scripts/settings', 'scripts', 'nested/package.json'])
  ('refuses protected scope %s with operator fallback via null admission', path => {
    expect(deriveAgyFixAdmission({ taskKind: 'fix', size: 1, scope: [path] })).toBeNull();
  });
  it.each([
    { size: 1, scope: ['a.md', 'b.md'] }, { size: 0, scope: ['a.md'] },
    { size: 2, scope: ['a.md'] }, { size: 1, scope: [] }, { size: 1, scope: ['fui:docs'] },
    { size: 1, scope: ['../a.md'] }, { scope: ['a.md'] },
  ])('refuses missing, oversized or unsafe evidence %j', item => {
    expect(deriveAgyFixAdmission({ taskKind: 'doc-fix', ...item })).toBeNull();
  });
});
