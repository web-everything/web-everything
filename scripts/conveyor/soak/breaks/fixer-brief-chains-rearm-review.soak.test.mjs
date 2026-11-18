import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import b from './fixer-brief-chains-rearm-review.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('fixer rearm-review brief source replay', () => {
  let root;
  const command = 'node "{{WE_ROOT}}/scripts/conveyor/rearm-review.mjs" {{PR_NUM}} --repo={{REPO}}';
  const marker = 'Run `rearm-review.mjs` as its OWN Bash call';
  const writeBrief = text => writeFileSync(join(root, 'skills-src/conveyor/fix-agent-brief.md'), text);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fixer-rearm-soak-'));
    mkdirSync(join(root, 'skills-src/conveyor'), { recursive: true });
    vi.stubEnv('SOAK_TREE_ROOT', root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('recognizes the explicit standalone-call fix marker', () => {
    writeBrief(marker);
    expect(b.fixPresent(root)).toBe(true);
    writeBrief(command);
    expect(b.fixPresent(root)).toBe(false);
  });

  it.each([' && node completion-cli.mjs', '; node completion-cli.mjs', ' | node completion-cli.mjs', ' \\', ' \\   '])(
    'reproduces the permission-denied command shape with suffix %s even with the fix marker', async suffix => {
      writeBrief(`${marker}\n${command}${suffix}\n`);
      expect(b.judge(await b.run({}))).toHaveLength(1);
    },
  );

  it('accepts standalone rearm with separate completion and fix-end lines (including CRLF)', async () => {
    writeBrief(`${marker}\r\n${command}\r\nnode completion-cli.mjs\r\nnode fix-procedure.mjs fix-end\r\n`);
    expect(b.judge(await b.run({}))).toEqual([]);
  });

  it('fails closed when the brief cannot be read', async () => {
    expect(() => b.fixPresent(root)).toThrow();
    await expect(b.run({})).rejects.toThrow();
  });
});
