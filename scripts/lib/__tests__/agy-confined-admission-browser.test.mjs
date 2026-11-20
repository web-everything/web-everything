// @vitest-environment happy-dom
import { expect, it } from 'vitest';

// Confined admission is also imported by dispatch/CLI tests in browser transform mode.
// A dynamic new URL rooted above scripts/ made Vite eagerly import the checkout
// as thousands of assets, stalling these imports before the assertions ran.
it('loads repair admission through the browser transform and preserves scope refusals', async () => {
  const { deriveAgyFixAdmission, isAdmissibleTargetScope, isAdmissibleTargetPath } = await import('../agy-fix-admission.mjs');
  expect(deriveAgyFixAdmission({ size: 1, scope: ['docs/guide.md'] }, { scope: ['docs'] }))
    .toEqual({ kind: 'doc-fix', size: 1, scope: ['docs/guide.md'] });
  expect(isAdmissibleTargetScope('docs')).toBe(true);
  expect(isAdmissibleTargetScope('docs/agent')).toBe(false);
  expect(isAdmissibleTargetScope('docs/nonexistent-directory')).toBe(false);
  expect(isAdmissibleTargetPath('docs')).toBe(false);
  expect(isAdmissibleTargetScope('docs/../scripts')).toBe(false);
  expect(isAdmissibleTargetScope('scripts/settings')).toBe(false);
});
