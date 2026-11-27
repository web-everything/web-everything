/**
 * @file scripts/lib/__tests__/dispatch-bg-isolation.test.mjs
 * @description #x9fbg1x — {@link ensureWorktreeIsolationOff}'s merge contract: additive, idempotent, never
 *   throws. Every fs call is injected — no real filesystem touched, mirroring `gh-app-shim.test.mjs`'s own
 *   in-memory-store convention for `ensureSettingsFileEnv`/`ensureSettingsFilePermissions`.
 */
import { pinnedHookScript } from '../pinned-hook-command.mjs';
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, readdirSync, copyFileSync, symlinkSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DISPATCH_WORKTREE_SETTINGS, ensureWorktreeIsolationOff, hasWorktreeIsolationOff,
  isolateDispatchSession, dispatchGuardHooks, ensureDispatchGuardHooks, shellPath, dispatchBroadcastHooks,
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
// repo's PreToolUse guards, preserving pinned launcher commands.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('xl5reby dispatched worker effective settings include the repo guard hooks', () => {
  // New fixtures never consult checkout settings, host processes, or the user's HOME.
  const temps = [];
  afterEach(() => { for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true }); });
  const broadcast = { type: 'command', command: 'node scripts/broadcast-inject.mjs' };
  const guards = [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/guard-bash.mjs' }] },
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node scripts/guard-lane.mjs' }] },
  ];
  const events = ['UserPromptSubmit', 'PostToolUse'];
  const registered = () => ({ PreToolUse: guards, ...Object.fromEntries(events.map(e => [e, [{ hooks: [broadcast] }]])) });
  function fixture(name = 'repo', source = JSON.stringify({ hooks: registered() }), local = {}) {
    const base = mkdtempSync(join(tmpdir(), 'dispatch-broadcast-')); temps.push(base);
    const repoRoot = join(base, name), cwd = join(base, 'scratch'), home = join(base, 'home');
    for (const dir of [join(repoRoot, '.claude'), join(repoRoot, 'scripts'), join(cwd, '.claude'), home]) mkdirSync(dir, { recursive: true });
    if (source !== undefined && source !== 'MISSING') writeFileSync(join(repoRoot, '.claude/settings.json'), source);
    const path = join(cwd, '.claude/settings.local.json'); writeFileSync(path, JSON.stringify(local));
    const options = { repoRoot, cwd };
    const read = () => JSON.parse(readFileSync(path, 'utf8'));
    const run = command => spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, TMPDIR: base } });
    return { base, repoRoot, cwd, path, options, read, run, home };
  }
  const wantedBroadcast = repoRoot => [{ hooks: [{ type: 'command', command: `node ${shellPath(join(repoRoot, 'scripts/broadcast-inject.mjs'))}` }] }];
  const hooksOf = (settings, event) => settings.hooks[event].flatMap(g => g.hooks);

  it('red→green: the operator broadcast hook rides into the scratch worker as an absolute command', () => {
    const hooks = registered();
    for (const e of events) hooks[e][0].hooks.push({ type: 'command', command: 'node scripts/record-touch.mjs' });
    const f = fixture('repo', JSON.stringify({ hooks }));
    const r = isolateDispatchSession(f.cwd, { ensureHooks: o => ensureDispatchGuardHooks({ ...o, repoRoot: f.repoRoot }) });
    expect(r.hooks.ok).toBe(true);
    for (const e of events) expect(f.read().hooks[e]).toEqual(wantedBroadcast(f.repoRoot));
  });

  for (const name of ['r$(touch PWNED)', 'r`touch PWNED2`', 'q"x', "'y z", 'a b']) {
    it(`red→green: shellPath round-trips literal ${name}`, () => {
      const f = fixture(name); const out = f.run(`printf %s ${shellPath(f.repoRoot)}`);
      expect(out.status).toBe(0); expect(out.stdout).toBe(f.repoRoot);
      for (const dir of [f.base, f.cwd]) for (const marker of ['PWNED', 'PWNED2']) expect(existsSync(join(dir, marker))).toBe(false);
    });
    for (const emitter of ['broadcast', 'legacy', 'fallback']) it(`red→green: ${emitter} safely executes from hostile root ${name}`, () => {
      const f = fixture(name);
      for (const script of ['broadcast-inject.mjs', 'guard-lane.mjs']) writeFileSync(join(f.repoRoot, 'scripts', script),
        "import {writeFileSync} from 'node:fs'; import {fileURLToPath} from 'node:url'; writeFileSync('RAN', fileURLToPath(import.meta.url));");
      const groups = emitter === 'broadcast' ? dispatchBroadcastHooks({ repo: { status: 'unreadable', hooks: null }, repoRoot: f.repoRoot })?.UserPromptSubmit
        : dispatchGuardHooks({ repoRoot: f.repoRoot, preToolUse: emitter === 'legacy' ? [guards[1]] : null });
      expect(groups?.length).toBeGreaterThan(0);
      const out = f.run(groups[0].hooks[0].command);
      for (const dir of [f.base, f.cwd]) for (const marker of ['PWNED', 'PWNED2']) expect(existsSync(join(dir, marker))).toBe(false);
      expect(out.status, out.stderr).toBe(0);
      expect(readFileSync(join(f.cwd, 'RAN'), 'utf8')).toBe(join(f.repoRoot, 'scripts', emitter === 'broadcast' ? 'broadcast-inject.mjs' : 'guard-lane.mjs'));
    });
  }
  it('green→green: safe paths retain the existing double-quoted spelling', () => {
    for (const p of ['/r', '/nope', '/workspace/example-project']) expect(shellPath(p)).toBe(`"${p}"`);
  });

  for (const pre of [[{ matcher: 'Bash', hooks: 7 }, { matcher: 'Edit|Write', hooks: [null] }], 'x']) {
    it(`red→green: malformed local input preserves guards and unrelated keys (${JSON.stringify(pre)})`, () => {
      const local = { env: { KEEP: 'yes' }, hooks: { PreToolUse: pre, PostToolUse: 7,
        UserPromptSubmit: [null, { hooks: 5 }, { hooks: [null, { command: 3 }] }], Stop: { sentinel: [7] } } };
      const f = fixture('repo', JSON.stringify({ hooks: registered() }), local);
      expect(ensureDispatchGuardHooks(f.options).ok).toBe(true);
      expect(f.read().hooks.PreToolUse).toEqual(dispatchGuardHooks({ preToolUse: guards, repoRoot: f.repoRoot }));
      for (const e of events) expect(f.read().hooks[e]).toEqual(wantedBroadcast(f.repoRoot));
      expect(f.read().env).toEqual(local.env); expect(f.read().hooks.Stop).toEqual(local.hooks.Stop);
    });
  }
  for (const async of [true, false]) it(`${async ? 'red→green: async copy cannot displace blocking guard' : 'green→green: reversed key order dedupes canonically'}`, () => {
    const f = fixture(); const command = `node "${f.repoRoot}/scripts/guard-bash.mjs"`;
    writeFileSync(f.path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command, type: 'command', ...(async ? { async: true } : {}) }] }] } }));
    expect(ensureDispatchGuardHooks(f.options).ok).toBe(true);
    const copies = hooksOf(f.read(), 'PreToolUse').filter(h => h.command === command);
    expect(copies).toContainEqual({ type: 'command', command }); expect(copies).toHaveLength(async ? 2 : 1);
  });
  it('red→green: duplicate wanted hooks merge once; all three events are byte-idempotent and counted', () => {
    const hooks = registered(); hooks.PreToolUse = [...guards, guards[0]];
    const f = fixture('repo', JSON.stringify({ hooks }));
    expect(ensureDispatchGuardHooks(f.options).count).toBe(5);
    expect(hooksOf(f.read(), 'PreToolUse')).toHaveLength(2);
    for (const e of events) expect(f.read().hooks[e]).toEqual(wantedBroadcast(f.repoRoot));
    const once = readFileSync(f.path, 'utf8'); ensureDispatchGuardHooks(f.options);
    expect(readFileSync(f.path, 'utf8')).toBe(once);
  });

  it('red→green: selector exact allowlist strips every hook and group option, retaining string matcher', () => {
    const rejected = ['node scripts/broadcast-inject.mjs --x', 'echo; node scripts/broadcast-inject.mjs',
      'node scripts/run-pinned-guard.mjs scripts/broadcast-inject.mjs', 'node scripts/lint-locus-prefix.mjs', 'node scripts/record-touch.mjs', 'node scripts/backlog-guard.mjs'];
    const group = { matcher: 'Bash', async: true, timeout: 9, hooks: [null, ...rejected.map(command => ({ type: 'command', command })),
      { ...broadcast, type: 'prompt' }, { ...broadcast, async: true, timeout: 1 }] };
    expect(dispatchBroadcastHooks({ repoRoot: '/r', repo: { status: 'ok', hooks: { UserPromptSubmit: [group] } } })).toEqual({
      UserPromptSubmit: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/r/scripts/broadcast-inject.mjs"' }] }], PostToolUse: [],
    });
  });
  for (const [label, source, selected] of [
    ['ENOENT', 'MISSING', events], ['invalid JSON', '{broken', events], ['empty object', '{}', []], ['null hooks', '{"hooks":null}', []],
    ['null top level', 'null', []], ['array top level', '[]', []], ['number top level', '7', []], ['array hooks', '{"hooks":[]}', []],
    ['non-array event', '{"hooks":{"UserPromptSubmit":7}}', []], ['only PostToolUse', JSON.stringify({ hooks: { PostToolUse: [{ hooks: [broadcast] }] } }), ['PostToolUse']],
  ]) it(`red→green: read status ${label} selects broadcasts only as registered or unreadable`, () => {
    const f = fixture('repo', source); expect(ensureDispatchGuardHooks(f.options).ok).toBe(true);
    for (const e of events) expect(f.read().hooks[e]).toEqual(selected.includes(e) ? wantedBroadcast(f.repoRoot) : []);
  });
  it('red→green: selector refuses malformed groups, hooks and non-string matchers', () => {
    expect(dispatchBroadcastHooks({ repoRoot: '/r', repo: { status: 'ok', hooks: {
      UserPromptSubmit: [null, 5, { hooks: 7 }, { hooks: [null, 5, { type: 'command', command: 7 }] }, { matcher: {}, hooks: [broadcast] }], PostToolUse: 'x',
    } } })).toEqual({ UserPromptSubmit: [], PostToolUse: [] });
  });
  for (const [label, hooks, expectedPre, expectedBroadcast] of [
    ['PreToolUse malformed', { PreToolUse: [{ hooks: 7 }] }, [guards[1], guards[0]], []],
    ['PreToolUse mixed', { PreToolUse: [{ hooks: 7 }, null, 5, { matcher: 3, hooks: guards[0].hooks }, guards[1]] }, [guards[1]], []],
    ['UserPromptSubmit malformed (green→green guard preservation)', { PreToolUse: guards, UserPromptSubmit: [{ hooks: 7 }] }, guards, []],
    ['PostToolUse mixed', { PreToolUse: guards, PostToolUse: [{ hooks: 7 }, { hooks: [broadcast] }] }, guards, ['PostToolUse']],
  ]) it(`repo sanitization: ${label}`, () => {
    const f = fixture('repo', JSON.stringify({ hooks })); expect(ensureDispatchGuardHooks(f.options).ok).toBe(true);
    expect(f.read().hooks.PreToolUse).toEqual(dispatchGuardHooks({ repoRoot: f.repoRoot, preToolUse: expectedPre }));
    for (const e of events) expect(f.read().hooks[e] ?? []).toEqual(expectedBroadcast.includes(e) ? wantedBroadcast(f.repoRoot) : []);
  });

  it('red→green: installed commands deliver and ack both events from scratch with isolated HOME, store and clock', () => {
    const f = fixture(); copyFileSync(join(REPO, 'scripts/broadcast-inject.mjs'), join(f.repoRoot, 'scripts/broadcast-inject.mjs'));
    const store = join(f.base, 'store'); mkdirSync(store);
    const now = Date.parse('2026-11-27T12:00:00Z');
    const clock = join(f.base, 'clock.mjs'); writeFileSync(clock, `Date.now = () => ${now};`);
    const item = (id, text) => ({ id, text, by: 'probe', at: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
      filter: { kind: null, repo: null }, targets: ['probe-session-1'], refused: null });
    const items = [item('probe-ups', 'probe text UPS')];
    expect(ensureDispatchGuardHooks(f.options).ok).toBe(true);
    for (const [i, e] of events.entries()) {
      if (i) items.push(item('probe-pts', 'probe text PTS'));
      writeFileSync(join(store, 'broadcasts.json'), JSON.stringify({ items }));
      const command = f.read().hooks[e]?.[0]?.hooks[0]?.command; expect(command).toBeTypeOf('string');
      const out = spawnSync('sh', ['-c', command], { cwd: f.cwd, input: JSON.stringify({ session_id: 'probe-session-1', hook_event_name: e, cwd: f.cwd }),
        encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env: { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: f.home, TMPDIR: f.base,
          AGENT_BROADCAST_DIR: store, NODE_OPTIONS: `--import=${clock}` } });
      expect(out.status).toBe(0); expect(out.stderr).not.toContain('Cannot find module');
      const output = JSON.parse(out.stdout).hookSpecificOutput; expect(output.hookEventName).toBe(e);
      expect(output.additionalContext).toContain(i ? 'probe text PTS' : 'probe text UPS');
      if (i) expect(output.additionalContext).not.toContain('probe text UPS');
      expect(JSON.parse(readFileSync(join(store, 'acks', `${i ? 'probe-pts' : 'probe-ups'}.probe-session-1.json`), 'utf8')).event).toBe(e);
    }
  });

  it('isolateDispatchSession (the one call every dispatch path makes) preserves pinned guard-bash and guard-lane commands', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dispatch-guards-'));
    try {
      const r = isolateDispatchSession(cwd, {
        ensureHooks: (options) => ensureDispatchGuardHooks({ ...options, repoRoot: REPO }),
      });
      expect(r.hooks.ok).toBe(true);
      const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
      const cmds = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
      expect(cmds.some((c) => c.includes('guard-bash.mjs'))).toBe(true);
      expect(cmds.some((c) => c.includes('guard-lane.mjs'))).toBe(true);
      const repo = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'));
      expect(settings.hooks.PreToolUse).toEqual(repo.hooks.PreToolUse);
      for (const c of cmds) expect(pinnedHookScript(c), c).not.toBeNull();
      const bash = settings.hooks.PreToolUse.find((g) => g.matcher === 'Bash');
      expect(pinnedHookScript(bash.hooks[0].command)).toBe('scripts/guard-bash.mjs');
      expect(settings.worktree).toEqual({ bgIsolation: 'none' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('the hooks ride only in the local file, never in the --settings worktree patch (no double run)', () => {
    expect(isolateDispatchSession(mkdtempSync(join(tmpdir(), 'dispatch-guards-'))).worktreeSettings).toEqual({ bgIsolation: 'none' });
  });

  it('only PreToolUse deny guards are carried, never bookkeeping hooks', () => {
    const repo = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'));
    const all = dispatchGuardHooks({ preToolUse: repo.hooks.PreToolUse, repoRoot: '/r' }).flatMap((g) => g.hooks.map((h) => h.command));
    expect(all).toEqual(repo.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command)));
    expect(all.map(pinnedHookScript)).toContain('scripts/guard-bash.mjs');
    expect(all.some((c) => c.includes('scripts/lint-locus-prefix.mjs --pre;'))).toBe(true);
    expect(all.join(' ')).not.toMatch(/bootstrap-session|session-reaper|broadcast-inject/);
  });

  it('rejects unknown and incomplete pinned wrappers while retaining legacy direct hooks', () => {
    const repo = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'));
    const command = repo.hooks.PreToolUse.find((g) => g.matcher === 'Bash').hooks[0].command;
    const invalid = [
      `echo ${command}`,
      command.replace('run-pinned-guard.mjs', 'other-launcher.mjs'),
      command.replace(' || exit 2', ''),
      command.replace('scripts/guard-bash.mjs;', 'scripts/guard-bash.mjs-extra;'),
      command.replace('scripts/guard-bash.mjs;', 'scripts/guard-bash.mjs\n;'),
      // The non-blocking Stop form must never become a PreToolUse guard.
      repo.hooks.Stop[0].hooks[0].command.replace('guard-stop-passive-wait.mjs', 'guard-bash.mjs'),
    ];
    expect(dispatchGuardHooks({ repoRoot: '/r', preToolUse: [{ matcher: 'Bash', hooks: [
      ...invalid.map((command) => ({ type: 'command', command })),
      { type: 'prompt', command },
      { type: 'command', command: 'node scripts/guard-bash.mjs' },
    ] }] })).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/r/scripts/guard-bash.mjs"' }] }]);
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
