import { expect, it } from 'vitest';
import b, { registrationEvidenceReplay } from './overlay-auto-retire-evidence.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('requires freshness evidence for both cached and recorded landed tips', async () => {
  const checks = await registrationEvidenceReplay();
  expect(checks.filter((c) => c.name.startsWith('omitted-freshness-'))).toEqual([
    expect.objectContaining({ name: 'omitted-freshness-preserves-feature', ok: true }),
    expect.objectContaining({ name: 'omitted-freshness-preserves-gone', ok: true }),
  ]);
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});
