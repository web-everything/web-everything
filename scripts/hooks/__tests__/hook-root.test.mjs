import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hookRoot } from '../../lib/hook-root.mjs';
import { pinnedFixture } from './pinned-fixture.mjs';

let fixture;
beforeAll(() => { fixture = pinnedFixture(); }, 30_000);
afterAll(() => fixture?.cleanup());

describe('hook root validation', () => {
  function withRoot(value, fn) {
    const previous = process.env.WE_HOOK_ROOT;
    try {
      if (value === undefined) delete process.env.WE_HOOK_ROOT;
      else process.env.WE_HOOK_ROOT = value;
      fn();
    } finally {
      if (previous === undefined) delete process.env.WE_HOOK_ROOT;
      else process.env.WE_HOOK_ROOT = previous;
    }
  }
  it('preserves the script-parent derivation with WE_HOOK_ROOT unset', () => {
    withRoot(undefined, () => expect(hookRoot(pathToFileURL(join(fixture.temp, 'scripts/guard.mjs')))).toBe(fixture.temp));
  });
  it('uses an absolute existing directory and refuses invalid overrides', () => {
    withRoot(fixture.primary, () => expect(hookRoot(import.meta.url)).toBe(fixture.primary));
    const file = join(fixture.temp, 'file'); writeFileSync(file, '');
    for (const root of ['', 'relative', join(fixture.temp, 'missing'), file]) {
      withRoot(root, () => expect(() => hookRoot(import.meta.url)).toThrow());
    }
  });
});

describe('real guards launched from a trusted snapshot', () => {
  for (const kind of ['primary', 'lane']) {
    it(`guard-lane denies primary edits from a ${kind} cwd`, () => {
      const cwd = fixture[kind];
      const result = fixture.run(cwd, 'scripts/guard-lane.mjs', {
        tool_name: 'Write', cwd, tool_input: { file_path: join(fixture.primary, 'scripts/example.mjs'), content: '' },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('guard-lane:');
    });
    it(`guard-bash classifies the real primary from a ${kind} cwd`, () => {
      const cwd = fixture[kind];
      const result = fixture.run(cwd, 'scripts/guard-bash.mjs', {
        tool_name: 'Bash', cwd: fixture.primary, tool_input: { command: 'node scripts/backlog.mjs resolve 2287' },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toContain('must run in a LANE clone');
    });
    it(`both guards protect seeded daemon paths from a ${kind} cwd`, () => {
      const cwd = fixture[kind];
      const daemon = join(fixture.temp, 'wev-review-daemon');
      mkdirSync(daemon, { recursive: true });
      const file = join(daemon, 'notes.md');
      expect(fixture.run(cwd, 'scripts/guard-lane.mjs', {
        tool_name: 'Write', cwd, tool_input: { file_path: file, content: '' },
      })).toMatchObject({ status: 2, stderr: expect.stringContaining('DAEMON CLONE') });
      const bash = fixture.run(cwd, 'scripts/guard-bash.mjs', {
        tool_name: 'Bash', cwd, tool_input: { command: `cp fix.md ${file}` },
      });
      expect(bash.status).toBe(0);
      expect(JSON.parse(bash.stdout).hookSpecificOutput.permissionDecisionReason).toContain('DAEMON CLONE');
    });
    it(`invisible-character lint scopes real scripts/ and docs/ from a ${kind} cwd`, () => {
      const cwd = fixture[kind];
      for (const file of ['scripts/example.mjs', 'docs/example.md']) {
        const result = fixture.run(cwd, 'scripts/lint-invisible-characters.mjs', {
          tool_name: 'Write', cwd, tool_input: { file_path: join(cwd, file), content: '\u200b' },
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('U+200B');
      }
      expect(fixture.run(cwd, 'scripts/lint-invisible-characters.mjs', {
        tool_name: 'Write', cwd, tool_input: { file_path: join(cwd, 'reports/example.md'), content: '\u200b' },
      }).status).toBe(0);
    });
  }
  it('measures verification of a cached snapshot containing the real scripts', () => {
    const cwd = fixture.primary;
    const result = fixture.run(cwd, 'scripts/guard-bash.mjs', {
      tool_name: 'Bash', cwd, tool_input: { command: 'pwd' },
    });
    expect(result.status).toBe(0);
    const timings = [...result.stderr.matchAll(/snapshot verification ([0-9.]+) ms/g)];
    expect(timings).toHaveLength(1);
    console.info(`Real scripts cached snapshot verification: ${timings[0][1]} ms`);
  });
  it('overrides inherited roots and canonicalizes a nested symlink cwd', async () => {
    const { symlinkSync } = await import('node:fs');
    const nested = join(fixture.primary, 'nested'); mkdirSync(nested);
    const alias = join(fixture.temp, 'alias'); symlinkSync(nested, alias, 'dir');
    fixture.env.WE_HOOK_ROOT = resolve(fixture.temp, 'wrong');
    try {
      const result = fixture.run(alias, 'scripts/lint-invisible-characters.mjs', {
        tool_name: 'Write', tool_input: { file_path: join(fixture.primary, 'docs/example.md'), content: '\u200b' },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('U+200B');
    } finally { delete fixture.env.WE_HOOK_ROOT; }
  });
});
