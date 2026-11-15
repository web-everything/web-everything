import { describe, it, expect } from 'vitest';
import * as rules from '../check-standards-rules.mjs';

describe('account routing prevention rules', () => {
  it('flags direct agents/stop calls outside the shared helper, including aliases and template literals', () => {
    const docs = [{ file: 'scripts/new-reader.mjs', content: "run('claude', ['agents', '--json']); execute(`claude`, [`stop`, id]);" }];
    expect(rules.scanClaudeSessionAccess?.(docs) ?? []).toHaveLength(2);
    expect(rules.scanClaudeSessionAccess?.([{ file: 'scripts/lib/claude-sessions.mjs', content: docs[0].content }]) ?? []).toEqual([]);
    expect(rules.scanClaudeSessionAccess?.([{ file: 'scripts/new-reader.mjs', content: "run('git', ['stop']); // exec('claude', ['agents'])" }]) ?? []).toEqual([]);
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
