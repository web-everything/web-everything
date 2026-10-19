import { expect, it, vi } from 'vitest';
import { readDeclaredSettings, readSettings } from '../../lib/settings-files.mjs';
import { logCascadeSources, resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { resolveFixSettings } from '../fix-takeover.mjs';
import { planRoundEscalation } from '../fix-resume.mjs';
import { NEGOTIATION_ROUND_CAP } from '../../lib/jury-core.mjs';

it('resolves stronger-model settings and round escalation from the real settings file with source layers reported', () => {
  const env = { WE_POLICY_CASCADE_LOG: '1' };
  const logs = [];
  const stderr = vi.spyOn(console, 'error').mockImplementation(line => logs.push(line));
  resetCascadeLogForTest();
  try {
    const declared = readDeclaredSettings();
    const fix = resolveFixSettings({ env });
    expect.soft(fix.strongerModelFromRound).toBe(4);
    expect.soft(fix.strongerModelFromRound).toBeLessThan(NEGOTIATION_ROUND_CAP);
    expect(fix.sources.strongerModelFromRound).toBe('settings');
    expect(declared.owners['fix.strongerModelFromRound']).toBe('settings/fix.json');
    expect(readSettings().fix.strongerModelFromRound).toBe(fix.strongerModelFromRound);

    // The fix resolver returns source metadata; exercise the shared source reporter explicitly.
    logCascadeSources('fixer-settings-1018', {
      value: { strongerModelFromRound: fix.strongerModelFromRound },
      sources: { strongerModelFromRound: fix.sources.strongerModelFromRound },
    }, { env });
    expect.soft(logs.join('\n')).toContain('strongerModelFromRound=4 (settings)');

    const ladder = {
      policy: { rungs: [{ id: 'stronger-model', action: 'dispatch', taskType: 'fix:stronger-model' }] },
      routes: { 'stronger-model': { provider: 'claude', model: 'sonnet' } },
    };
    expect.soft(planRoundEscalation({ round: 3, fromRound: fix.strongerModelFromRound, fixerLadder: ladder })).toBeNull();
    expect(planRoundEscalation({ round: 4, fromRound: fix.strongerModelFromRound, fixerLadder: ladder })).toMatchObject({ round: 4 });
    expect(resolveFixSettings({ env: { WE_FIX_STRONGER_MODEL_FROM_ROUND: '2' } })).toMatchObject({
      strongerModelFromRound: 2, sources: { strongerModelFromRound: 'env' },
    });
    console.info(`fixer settings proof: ${JSON.stringify({ strongerModelFromRound: fix.strongerModelFromRound, source: fix.sources.strongerModelFromRound })}`);
  } finally {
    stderr.mockRestore();
    resetCascadeLogForTest();
  }
});
