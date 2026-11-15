import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as accounts from '../lib/claude-account.mjs';
import { partitionLocal } from '../readiness/claimScope.mjs';
import * as rules from '../check-standards-rules.mjs';

// Execute the runner's actual section, with a small filesystem corpus and no Git subprocess.
const runner = readFileSync('scripts/check-standards.mjs', 'utf8');
const section = runner.slice(runner.indexOf('// PR #5169:'), runner.indexOf('// ── 6f-i-c.'));
function checkRouting(accountB, scoped = false, raw, content = "execFileSync('claude', ['agents', '--json']);") {
  const root = mkdtempSync(join(tmpdir(), 'routing-standards-'));
  const setting = 'scripts/settings/claude-accounts.json';
  const reader = 'scripts/legacy-reader.mjs';
  const err = vi.fn();
  const warn = vi.fn();
  try {
    mkdirSync(join(root, 'scripts/settings'), { recursive: true });
    const map = JSON.parse(readFileSync('scripts/settings/claude-accounts.json', 'utf8'));
    map.routing = { accountB };
    if (raw !== 'missing') writeFileSync(join(root, setting), raw ?? JSON.stringify(map));
    writeFileSync(join(root, reader), content);
    runInNewContext(section, {
      ROOT: root, SCOPE_TO_FILES: scoped, EFFECTIVE_FILES: new Set([setting]),
      execFileSync: () => `${setting}\n${reader}\n`, readFileSync, existsSync, join,
      ...rules, ...accounts, err, warn,
    });
    const findings = err.mock.calls.map(([message, descriptor]) => ({ message, descriptor }));
    return {
      errors: (scoped ? partitionLocal(findings, { fileSet: new Set([setting]), local: true }).blocking : findings).map(f => f.message),
      warnings: warn.mock.calls.map(([message]) => message),
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('account routing prevention rules', () => {
  it('accountB on turns legacy session-reader warnings into errors', () => {
    expect(checkRouting(true).errors).toEqual([expect.stringContaining('scripts/legacy-reader.mjs:1')]);
    expect(checkRouting(true).warnings).toEqual([]);
  });
  it.each([false, undefined])('accountB=%j keeps full-scan legacy readers as warnings', accountB => {
    expect(checkRouting(accountB).errors).toEqual([]);
    expect(checkRouting(accountB).warnings).toEqual([expect.stringContaining('scripts/legacy-reader.mjs:1')]);
  });
  it('a scoped settings-only enable checks remaining readers outside the diff', () => {
    expect(checkRouting(true, true).errors).toEqual([expect.stringContaining('scripts/legacy-reader.mjs:1')]);
    expect(checkRouting(false, true).errors).toEqual([]);
  });
  it('accountB on permits a corpus with no legacy readers', () => {
    expect(checkRouting(true, true, undefined, 'export const migrated = true;')).toEqual({ errors: [], warnings: [] });
  });
  it.each(['true', null, 1])('malformed accountB=%j refuses the map and treats legacy readers as errors', accountB => {
    const result = checkRouting(accountB);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('account map unavailable'), expect.stringContaining('scripts/legacy-reader.mjs:1'),
    ]));
    expect(result.warnings).toEqual([]);
  });
  it.each(['missing', '{', 'null', '[]', '{}'])('unavailable map %s cannot bypass the prerequisite', raw => {
    expect(checkRouting(undefined, true, raw).errors).toEqual(expect.arrayContaining([
      expect.stringContaining('account map unavailable'), expect.stringContaining('scripts/legacy-reader.mjs:1'),
    ]));
  });
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
