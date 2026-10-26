/** @file #101 — the operator send-back body leads the fixer's prompt as its must-fix items. */
import { describe, it, expect, vi } from 'vitest';
import { dispatchFix, readFixBriefTemplate, withOperatorSendBack } from '../reconcile-fix-dispatch.mjs';

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
  it('renders the real fresh-session brief with its re-arm step and operator exemption', () => {
    const spawnAgent = vi.fn(() => '');
    const sourceRoot = process.cwd();
    const result = dispatchFix({ pr: 1764, itemNum: '3438', lane: 9,
      laneRef: 'lane/3438-fix', scope: ['we:scripts/conveyor/reconcile-fix-dispatch.mjs'],
      operatorSendBack: { login: 'chalbert', body: 'Fix the export.' },
    }, {
      root: '/repo', readBrief: () => readFixBriefTemplate(sourceRoot),
      mintSessionId: () => '22222222-2222-4222-8222-222222222222', spawnAgent,
      wrapFix: false, readFixClaim: () => null, acquireClaim: () => ({ ok: true }), releaseClaim: () => {},
      postNotice: () => false, readHistoryInputs: () => null,
      ensureSessionCwd: (cwd) => cwd, grantConflictHelper: () => {},
      isolateSession: () => ({ write: { ok: true }, hooks: { ok: true } }),
      resolveSettingsEnv: () => null, advisorFor: () => ({ enabled: false }), recordAdvisor: () => {},
    });
    // The template documents these two literal placeholder examples.
    expect(result.unknownTokens).toEqual(['{{LIKE_THIS}}', '{{PLACEHOLDERS}}']);
    const prompt = spawnAgent.mock.calls[0][0].at(-1);
    expect(prompt).toContain('### 7. Re-arm the review');
    expect(prompt).toContain('scripts/conveyor/rearm-review.mjs" 1764 --repo=we');
    expect(prompt).toContain('Do not touch any review label, with ONE sanctioned exception: the re-arm step in your brief, running `node scripts/conveyor/rearm-review.mjs <pr> --repo=<repo>`, is authorized by the operator and you must run it.');
  });
});
