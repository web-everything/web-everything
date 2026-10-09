/**
 * @file scripts/lib/__tests__/dispatch-bg-isolation.test.mjs
 * @description #x9fbg1x — {@link ensureWorktreeIsolationOff}'s merge contract: additive, idempotent, never
 *   throws. Every fs call is injected — no real filesystem touched, mirroring `gh-app-shim.test.mjs`'s own
 *   in-memory-store convention for `ensureSettingsFileEnv`/`ensureSettingsFilePermissions`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync, copyFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DISPATCH_WORKTREE_SETTINGS, ensureWorktreeIsolationOff, hasWorktreeIsolationOff,
  isolateDispatchSession, dispatchGuardHooks, ensureDispatchGuardHooks,
} from '../dispatch-bg-isolation.mjs';

function memoryFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFile: (p) => {
      if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files[p];
    },
    writeFile: (p, body) => { files[p] = body; },
    mkdir: () => {},
  };
}

describe('DISPATCH_WORKTREE_SETTINGS', () => {
  it('is exactly the documented guard-off patch', () => {
    expect(DISPATCH_WORKTREE_SETTINGS).toEqual({ worktree: { bgIsolation: 'none' } });
  });
});

describe('ensureWorktreeIsolationOff', () => {
  it('creates the file fresh when neither it nor the .claude dir exists', () => {
    const fs = memoryFs();
    const path = '/scratch/dispatch/sess-1/.claude/settings.local.json';
    const result = ensureWorktreeIsolationOff({ cwd: '/scratch/dispatch/sess-1', ...fs });
    expect(result).toEqual({ ok: true, path });
    expect(JSON.parse(fs.files[path])).toEqual({ worktree: { bgIsolation: 'none' } });
  });

  it('is ADDITIVE — an existing env block (the gh-shim\'s own write) survives untouched', () => {
    const path = '/lane/.claude/settings.local.json';
    const fs = memoryFs({ [path]: JSON.stringify({ env: { PATH: '/shim:/usr/bin' } }) });
    ensureWorktreeIsolationOff({ cwd: '/lane', ...fs });
    expect(JSON.parse(fs.files[path])).toEqual({
      env: { PATH: '/shim:/usr/bin' },
      worktree: { bgIsolation: 'none' },
    });
  });

  it('is ADDITIVE within worktree too — an unrelated sibling key under `worktree` survives', () => {
    const path = '/lane/.claude/settings.local.json';
    const fs = memoryFs({ [path]: JSON.stringify({ worktree: { someOtherFlag: true } }) });
    ensureWorktreeIsolationOff({ cwd: '/lane', ...fs });
    expect(JSON.parse(fs.files[path])).toEqual({ worktree: { someOtherFlag: true, bgIsolation: 'none' } });
  });

  it('is IDEMPOTENT — calling it twice leaves the same result', () => {
    const path = '/lane/.claude/settings.local.json';
    const fs = memoryFs();
    ensureWorktreeIsolationOff({ cwd: '/lane', ...fs });
    ensureWorktreeIsolationOff({ cwd: '/lane', ...fs });
    expect(JSON.parse(fs.files[path])).toEqual({ worktree: { bgIsolation: 'none' } });
  });

  it('treats a corrupt existing file as empty rather than fatal', () => {
    const path = '/lane/.claude/settings.local.json';
    const fs = memoryFs({ [path]: '{ not json' });
    const result = ensureWorktreeIsolationOff({ cwd: '/lane', ...fs });
    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.files[path])).toEqual({ worktree: { bgIsolation: 'none' } });
  });

  it('NEVER THROWS — a write failure resolves to {ok:false}, never an exception', () => {
    const writeFile = () => { throw new Error('EACCES'); };
    expect(() => ensureWorktreeIsolationOff({ cwd: '/lane', readFile: () => { throw new Error('ENOENT'); }, writeFile, mkdir: () => {} }))
      .not.toThrow();
    const result = ensureWorktreeIsolationOff({ cwd: '/lane', readFile: () => { throw new Error('ENOENT'); }, writeFile, mkdir: () => {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('write-failed');
  });

  it('answers {ok:false, reason:"no-cwd"} rather than writing anywhere when cwd is missing', () => {
    expect(ensureWorktreeIsolationOff({})).toEqual({ ok: false, reason: 'no-cwd' });
  });
});

describe('hasWorktreeIsolationOff', () => {
  it('reads back true once the override is on disk', () => {
    const path = '/lane/.claude/settings.local.json';
    const fs = memoryFs({ [path]: JSON.stringify({ worktree: { bgIsolation: 'none' } }) });
    expect(hasWorktreeIsolationOff('/lane', { readFile: fs.readFile })).toBe(true);
  });

  it('is false when nothing has been written, never throws', () => {
    expect(hasWorktreeIsolationOff('/lane', { readFile: () => { throw new Error('ENOENT'); } })).toBe(false);
  });
});

// xl5reby — a dispatched worker starts in a scratch dir with no repo settings; its OWN settings must carry the
// repo's PreToolUse guards, by absolute path.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('xl5reby dispatched worker effective settings include the repo guard hooks', () => {
  it('isolateDispatchSession (the one call every dispatch path makes) writes guard-bash and guard-lane by absolute path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dispatch-guards-'));
    try {
      const r = isolateDispatchSession(cwd);
      expect(r.hooks.ok).toBe(true);
      const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
      const cmds = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
      expect(cmds.some((c) => c.includes('guard-bash.mjs'))).toBe(true);
      expect(cmds.some((c) => c.includes('guard-lane.mjs'))).toBe(true);
      for (const c of cmds) {
        const m = /^node "(\/[^"]+\.mjs)"/.exec(c);
        expect(m, c).not.toBeNull();
        expect(existsSync(m[1]), m[1]).toBe(true);
      }
      const bash = settings.hooks.PreToolUse.find((g) => g.matcher === 'Bash');
      expect(bash.hooks[0].command).toMatch(/guard-bash\.mjs"$/);
      expect(settings.worktree).toEqual({ bgIsolation: 'none' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('the hooks ride only in the local file, never in the --settings worktree patch (no double run)', () => {
    expect(isolateDispatchSession(mkdtempSync(join(tmpdir(), 'dispatch-guards-'))).worktreeSettings).toEqual({ bgIsolation: 'none' });
  });

  it('only PreToolUse deny guards are carried, never bookkeeping hooks', () => {
    const repo = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'));
    const all = dispatchGuardHooks({ preToolUse: repo.hooks.PreToolUse, repoRoot: '/r' }).flatMap((g) => g.hooks.map((h) => h.command));
    expect(all).toContain('node "/r/scripts/guard-bash.mjs"');
    expect(all).toContain('node "/r/scripts/lint-locus-prefix.mjs" --pre');
    expect(all.join(' ')).not.toMatch(/bootstrap-session|session-reaper|broadcast-inject/);
  });

  it('falls back to the Bash and Edit/Write guards when the repo settings are unreadable', () => {
    const fs = memoryFs();
    const r = ensureDispatchGuardHooks({ cwd: '/w', repoRoot: '/nope', ...fs });
    expect(r.ok).toBe(true);
    const cmds = JSON.parse(fs.files['/w/.claude/settings.local.json']).hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds).toEqual(['node "/nope/scripts/guard-lane.mjs"', 'node "/nope/scripts/guard-bash.mjs"']);
  });

  it('is additive and idempotent: other keys and existing hooks survive, no duplicate on a second call', () => {
    const path = '/w/.claude/settings.local.json';
    const fs = memoryFs({ [path]: JSON.stringify({ env: { A: '1' }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }) });
    ensureDispatchGuardHooks({ cwd: '/w', repoRoot: '/nope', ...fs });
    const once = fs.files[path];
    ensureDispatchGuardHooks({ cwd: '/w', repoRoot: '/nope', ...fs });
    expect(fs.files[path]).toBe(once);
    const parsed = JSON.parse(once);
    expect(parsed.env).toEqual({ A: '1' });
    expect(parsed.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command))).toContain('echo mine');
  });

  it('never throws on a write failure', () => {
    const r = ensureDispatchGuardHooks({ cwd: '/w', repoRoot: '/nope', readFile: () => { throw new Error('x'); }, writeFile: () => { throw new Error('disk full'); }, mkdir: () => {} });
    expect(r.ok).toBe(false);
  });

  it('the guard runs from a dispatch-style cwd with an absolute path and denies a redirect write at a primary checkout', () => {
    // HERMETIC (xcu4cqf): the guard derives the constellation primaries from ITS OWN location
    // (`<workspace>/<repo>/scripts/guard-bash.mjs`). Build a throwaway workspace whose `webeverything/scripts/`
    // holds a COPY of the guard beside symlinks to every other script, so the primary it protects is a tmp
    // directory — not whatever sibling checkout (or lane pool) the machine running the suite happens to have.
    const cwd = mkdtempSync(join(tmpdir(), 'dispatch-guards-'));
    // realpath'd: the guard's CLI check compares `process.argv[1]` with its realpath'd `import.meta.url`.
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-guards-ws-')));
    try {
      const primary = join(ws, 'webeverything');
      const scripts = join(primary, 'scripts');
      mkdirSync(scripts, { recursive: true });
      for (const name of readdirSync(join(REPO, 'scripts'))) {
        if (name === 'guard-bash.mjs') copyFileSync(join(REPO, 'scripts', name), join(scripts, name));
        else symlinkSync(join(REPO, 'scripts', name), join(scripts, name));
      }
      const ev = JSON.stringify({ tool_name: 'Bash', cwd: primary, tool_input: { command: 'echo x > scratch-should-never-exist.txt' } });
      const out = spawnSync('node', [join(scripts, 'guard-bash.mjs')], { cwd, input: ev, encoding: 'utf8' });
      expect(out.status).toBe(0);
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
