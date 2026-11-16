import { describe, it, expect } from 'vitest';
import * as rules from '../check-standards-rules.mjs';

describe('account routing prevention rules', () => {
  it('flags direct agents/stop calls outside the shared helper, including aliases and template literals', () => {
    const docs = [{ file: 'scripts/new-reader.mjs', content: "run('claude', ['agents', '--json']); execute(`claude`, [`stop`, id]);" }];
    expect(rules.scanClaudeSessionAccess?.(docs) ?? []).toHaveLength(2);
    expect(rules.scanClaudeSessionAccess?.([{ file: 'scripts/lib/claude-sessions.mjs', content: docs[0].content }]) ?? []).toEqual([]);
    expect(rules.scanClaudeSessionAccess?.([{ file: 'scripts/new-reader.mjs', content: "run('git', ['stop']); // exec('claude', ['agents'])" }]) ?? []).toEqual([]);
  });
  it('direct session commands fail the gate whenever routing.accountB is on or the map is unknown', () => {
    const policy = rules.claudeSessionAccessPolicy;
    expect(typeof policy).toBe('function');
    const map = accountB => () => ({ accounts: {}, daemons: {}, routing: { accountB } });
    const unavailable = () => { throw new Error('claude-account: account map unavailable'); };
    // Switch on: every remaining reader in the WHOLE repository fails, even in a scoped (diff-only) run,
    // so flipping routing.accountB cannot pass a gate that never looked at the unmigrated readers.
    expect(policy({ scoped: false, loadMap: map(true) })).toMatchObject({ severity: 'err', wholeRepo: true, reason: 'routing.accountB is on' });
    expect(policy({ scoped: true, loadMap: map(true) })).toMatchObject({ severity: 'err', wholeRepo: true });
    // Unknown switch state is treated as on.
    expect(policy({ scoped: false, loadMap: unavailable })).toMatchObject({ severity: 'err', wholeRepo: true, reason: expect.stringMatching(/account map unavailable/) });
    expect(policy({ scoped: true, loadMap: unavailable })).toMatchObject({ severity: 'err', wholeRepo: true });
    // Switch off: new/edited readers fail the scoped gate; the documented legacy debt only warns in full scans.
    expect(policy({ scoped: true, loadMap: map(false) })).toMatchObject({ severity: 'err', wholeRepo: false });
    expect(policy({ scoped: false, loadMap: map(false) })).toMatchObject({ severity: 'warn', wholeRepo: false });
    expect(policy({ scoped: false, loadMap: () => ({ accounts: {}, daemons: {} }) })).toMatchObject({ severity: 'warn', wholeRepo: false });
  });
  it('flags TMPDIR reads in tests but allows os.tmpdir and production env handling', () => {
    const content = "join(process.env.TMPDIR, 'a'); join(process.env['TMPDIR'], 'b');";
    expect(rules.scanTestTmpdir?.([{ file: 'scripts/__tests__/a.test.mjs', content }]) ?? []).toHaveLength(2);
    expect(rules.scanTestTmpdir?.([{ file: 'scripts/a.mjs', content }, { file: 'scripts/a.test.mjs', content: 'join(tmpdir(), name)' }]) ?? []).toEqual([]);
  });
  it('rejects TODO placeholders in acceptance and edge cases of committed cards', () => {
    expect(rules.findCardSectionPlaceholders?.('## Acceptance\n- [A1] TODO: command\n## Edge cases this change must handle\n1. TODO: behavior\n## History\nTODO: harmless historical note') ?? []).toHaveLength(2);
    expect(rules.findCardSectionPlaceholders?.('## Acceptance\n- [A1] Run the named test\n## Edge cases this change must handle\n1. Invalid config refuses') ?? []).toEqual([]);
  });
});
