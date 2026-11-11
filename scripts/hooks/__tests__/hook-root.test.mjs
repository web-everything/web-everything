import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hookRoot } from '../../lib/hook-root.mjs';
import { pinnedFixture, removeFixture } from './pinned-fixture.mjs';

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

describe('real guards launched from the dedicated clone', () => {
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
  // The clone holds only scripts/, so each guard below decides from operated-checkout data
  // that a clone-rooted guard could not see.
  function laneFile(rel, text) {
    const path = join(fixture.lane, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }
  it('backlog guard reads child cards from the operated checkout', () => {
    const parent = laneFile('backlog/100-parent.md', '---\nkind: story\nsize: 3\n---\n# Parent\n\nA sized story.\n');
    laneFile('backlog/101-child.md', '---\nkind: task\nparent: 100\n---\n# Child\n\nIts child.\n');
    expect(existsSync(join(fixture.clone, 'backlog'))).toBe(false);
    const result = fixture.run(fixture.lane, 'scripts/backlog-guard.mjs', {
      tool_name: 'Write', cwd: fixture.lane, tool_input: { file_path: parent },
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('#100 is a sized `story` that also has children');
  });
  it('memory guard reads the operated checkout memory index', () => {
    laneFile('.claude/agent-memory/MEMORY.md', `# Memory\n\n- ${'x'.repeat(240)}\n`);
    expect(existsSync(join(fixture.clone, '.claude/agent-memory'))).toBe(false);
    const result = fixture.run(fixture.lane, 'scripts/check-memory.mjs', {});
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('(> 200)');
    expect(result.stdout + result.stderr).not.toContain('no memory index');
  });
  it('locus lint sweeps the operated checkout corpus', () => {
    laneFile('backlog/0200-leak.md', '---\nkind: task\nstatus: open\n---\n# Leak\n\nMentions scripts/leak.ts bare.\n');
    const result = fixture.run(fixture.lane, 'scripts/lint-locus-prefix.mjs', {}, ['--all']);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('backlog/0200-leak.md');
    expect(result.stderr).toContain('scripts/leak.ts');
  });
  it('real guards run from a non-Git scratch cwd against the primary beside the clone', () => {
    const primary = join(dirname(fixture.clone), 'webeverything');
    mkdirSync(join(primary, 'scripts'), { recursive: true });
    fixture.git(primary, 'init', '-q', '-b', 'main');
    const scratch = join(fixture.temp, 'operations/dispatch/worker');
    mkdirSync(scratch, { recursive: true });
    try {
      const bash = fixture.run(scratch, 'scripts/guard-bash.mjs', {
        tool_name: 'Bash', cwd: primary, tool_input: { command: 'node scripts/backlog.mjs resolve 2287' },
      });
      expect(bash.status, bash.stderr).toBe(0);
      expect(JSON.parse(bash.stdout).hookSpecificOutput.permissionDecisionReason).toContain('must run in a LANE clone');
      const lane = fixture.run(scratch, 'scripts/guard-lane.mjs', {
        tool_name: 'Write', cwd: scratch, tool_input: { file_path: join(primary, 'scripts/example.mjs'), content: '' },
      });
      expect(lane.status).toBe(2);
      expect(lane.stderr).toContain('guard-lane:');
    } finally { removeFixture(primary); }
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
