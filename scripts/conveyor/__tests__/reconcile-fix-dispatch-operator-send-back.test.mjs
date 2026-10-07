/** @file #101 — the operator send-back body leads the fixer's prompt as its must-fix items. */
import { describe, it, expect } from 'vitest';
import { withOperatorSendBack } from '../reconcile-fix-dispatch.mjs';

describe('withOperatorSendBack', () => {
  it('puts the body and the operator login in front of the prompt', () => {
    const out = withOperatorSendBack('BASE', { login: 'chalbert', body: 'MUST FIX: rename the export.' });
    expect(out.startsWith('# Operator send-back')).toBe(true);
    expect(out).toContain('@chalbert');
    expect(out).toContain('MUST FIX: rename the export.');
    expect(out.endsWith('BASE')).toBe(true);
  });
  it('leaves the prompt alone with no send-back', () => {
    expect(withOperatorSendBack('BASE', null)).toBe('BASE');
  });
});
