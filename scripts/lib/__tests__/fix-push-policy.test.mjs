import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveFixPushPolicy, loadFixPushPolicy, parsePushBeforeGate, formatFixPushPolicyLine, STANDARD_FIX_PUSH_POLICY, FIX_PUSH_BEFORE_GATE_ENV,
} from '../fix-push-policy.mjs';

describe('fix.pushBeforeGate — the policy cascade', () => {
  it('standard default is ON (operator go 2026-10-10)', () => {
    expect(STANDARD_FIX_PUSH_POLICY.pushBeforeGate).toBe(true);
    expect(resolveFixPushPolicy({})).toEqual({ pushBeforeGate: true, source: 'standard', invalid: [] });
  });
  it('each higher layer wins: standard → platform → tool → env, and names its source', () => {
    expect(resolveFixPushPolicy({ platform: { pushBeforeGate: false } })).toMatchObject({ pushBeforeGate: false, source: 'platform' });
    expect(resolveFixPushPolicy({ platform: { pushBeforeGate: false }, tool: { pushBeforeGate: true } })).toMatchObject({ pushBeforeGate: true, source: 'tool' });
    expect(resolveFixPushPolicy({ tool: { pushBeforeGate: true }, env: { [FIX_PUSH_BEFORE_GATE_ENV]: 'off' } })).toMatchObject({ pushBeforeGate: false, source: 'env' });
  });
  it('an invalid value never overrides a lower layer; it is reported', () => {
    const p = resolveFixPushPolicy({ platform: { pushBeforeGate: false }, tool: { pushBeforeGate: 'maybe' }, env: { [FIX_PUSH_BEFORE_GATE_ENV]: '' } });
    expect(p).toMatchObject({ pushBeforeGate: false, source: 'platform' });
    expect(p.invalid).toEqual(['tool.pushBeforeGate="maybe"']);
    expect(formatFixPushPolicyLine(p)).toBe('fix-push-policy: pushBeforeGate=false (platform); ignored invalid tool.pushBeforeGate="maybe"');
  });
  it('parses the on/off spellings', () => {
    for (const v of [true, 'true', 'on', '1', 'YES']) expect(parsePushBeforeGate(v)).toBe(true);
    for (const v of [false, 'false', 'off', '0', 'no']) expect(parsePushBeforeGate(v)).toBe(false);
    expect(parsePushBeforeGate('x')).toBeNull();
  });
  it('loadFixPushPolicy reads the platform file and the tool settings; a missing file is the standard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-push-policy-'));
    try {
      const platformPath = join(dir, 'delivery-platform-preferences.json');
      expect(loadFixPushPolicy({ env: {}, platformPath, readTool: () => ({}) })).toMatchObject({ pushBeforeGate: true, source: 'standard' });
      writeFileSync(platformPath, JSON.stringify({ mergeDelivery: { strategy: 'drain-direct' }, fix: { pushBeforeGate: false } }));
      expect(loadFixPushPolicy({ env: {}, platformPath, readTool: () => ({}) })).toMatchObject({ pushBeforeGate: false, source: 'platform' });
      expect(loadFixPushPolicy({ env: {}, platformPath, readTool: () => ({ fix: { pushBeforeGate: true } }) })).toMatchObject({ pushBeforeGate: true, source: 'tool' });
      expect(loadFixPushPolicy({ env: {}, platformPath, readTool: () => { throw new Error('boom'); } })).toMatchObject({ source: 'platform' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
