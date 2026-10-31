/**
 * @file daemon-boot-smoke.test.mjs — #4468. Unit coverage for `checkDaemonEntriesBoot`'s own contract (injected
 * `runChild`, no real subprocess) plus three REAL-subprocess tests that actually spawn `node` and dynamically
 * import fixture (or, for one of them, the real production) entries on disk — the exact path a candidate
 * rebuild's live smoke exercises. A soak-registered reproduction of the same fixture-TDZ shape, gated on
 * `fixPresent`/RED-before-GREEN-after, lives separately in
 * `we:scripts/conveyor/soak/breaks/daemon-entry-boot-crash.mjs` — it exercises the SAME fixture entry via the
 * SAME override this file uses, not the real production entry list (only this file's own last test does that).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildEntryBootScript, checkDaemonEntriesBoot, DAEMON_BOOT_SMOKE_CHECK, DAEMON_ENTRIES_ENV, DAEMON_ENTRY_MODULES,
  isSafeRelativeEntry, pickSmokeDiagnostics, resolveDaemonEntries, resolveBootSettings, smokeErrorClass, writeStderrTail,
} from '../daemon-boot-smoke.mjs';
import { budgetedRunChild } from '../daemon-rebuild/smoke.mjs';
import { redactDetail } from '../daemon-rebuild/smoke-classify/redact-detail.mjs';
import { smokeSurfaceEntries } from '../daemon-rebuild/skip-unrelated.mjs';

describe('resolveDaemonEntries', () => {
  it.each([undefined, 'off', 'shadow'])('keeps boot discovery inert with unreadable LaunchAgents in mode %s', async mode => {
    const home = mkdtempSync(join(tmpdir(), 'boot-shadow-home-'));
    try {
      const env = { HOME: home, WE_SMOKE_LIVE_CLONE: process.cwd(),
        ...(mode === undefined ? {} : { WE_DAEMON_CLOSURE_SCOPE: mode }) };
      const fixed = await checkDaemonEntriesBoot({ root: process.cwd(), env: { HOME: home },
        runChild: async () => '{"ok":true}', now: () => 0 });
      const result = await checkDaemonEntriesBoot({ root: process.cwd(), env,
        runChild: async () => '{"ok":true}', now: () => 0 });
      expect(result).toEqual(fixed);
      expect(result.ok).toBe(true);
      expect(result.entries.map(entry => entry.entry)).toEqual(DAEMON_ENTRY_MODULES);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each(['off', 'shadow', 'on'])('keeps the skip surface fixed despite unreadable LaunchAgents in mode %s', mode => {
    const home = mkdtempSync(join(tmpdir(), 'surface-home-'));
    try {
      const env = { HOME: home, WE_SMOKE_LIVE_CLONE: process.cwd(), WE_DAEMON_CLOSURE_SCOPE: mode };
      expect(smokeSurfaceEntries(env)).toEqual(smokeSurfaceEntries({}));
      expect(smokeSurfaceEntries({ ...env, [DAEMON_ENTRIES_ENV]: 'custom.mjs' })).toContain('custom.mjs');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each(['off', 'shadow'])('does not call an injected runtime discovery in mode %s', mode => {
    let discovered = false;
    const result = resolveDaemonEntries({ WE_DAEMON_CLOSURE_SCOPE: mode, WE_SMOKE_LIVE_CLONE: 'live-clone' }, {
      runtimeEntries() { discovered = true; return [...DAEMON_ENTRY_MODULES, 'extra.mjs']; },
    });
    expect(discovered).toBe(false);
    expect(result).toEqual({ entries: DAEMON_ENTRY_MODULES, overridden: false });
  });

  it('uses the real list when no override is set', () => {
    expect(resolveDaemonEntries({})).toEqual({ entries: DAEMON_ENTRY_MODULES, overridden: false });
  });

  it('boots the fixed list for a minimal clone without daemon entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'boot-smoke-minimal-'));
    try {
      const r = await checkDaemonEntriesBoot({ root, env: { WE_SMOKE_LIVE_CLONE: root },
        runChild: async () => '{"ok":true}' });
      expect(r.ok).toBe(true);
      expect(r.entries.map(entry => entry.entry)).toEqual(DAEMON_ENTRY_MODULES);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('boots the fixed list when only a candidate root is supplied', async () => {
    const r = await checkDaemonEntriesBoot({ root: '.', env: {}, runChild: async () => '{"ok":true}' });
    expect(r.ok).toBe(true);
    expect(r.entries.map(entry => entry.entry)).toEqual(DAEMON_ENTRY_MODULES);
  });

  it('fails closed on missing fixed entries in a real boot of a minimal clone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'boot-smoke-missing-'));
    try {
      const r = await checkDaemonEntriesBoot({ root, env: { ...process.env, WE_SMOKE_LIVE_CLONE: root, [DAEMON_ENTRIES_ENV]: '' },
        budgets: { daemonBootMs: 15_000 }, diagnosticsDir: join(root, 'diagnostics') });
      expect(r.ok).toBe(false);
      expect(r.entries).toHaveLength(DAEMON_ENTRY_MODULES.length);
      expect(r.entries.every(entry => !entry.ok && entry.kind === 'import failed')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails closed on an unreadable live clone when the boot tree has daemon entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'boot-smoke-live-'));
    let spawned = false;
    try {
      const r = await checkDaemonEntriesBoot({ root: process.cwd(), env: {
        WE_DAEMON_CLOSURE_SCOPE: 'on', WE_SMOKE_LIVE_CLONE: join(root, 'missing') },
        runChild: async () => { spawned = true; return '{"ok":true}'; } });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('runtime entries unreadable');
      expect(spawned).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('uses cloneRuntimeEntries when a clone root is known', () => {
    let observed;
    const runtimeEntries = options => { observed = options; return [...DAEMON_ENTRY_MODULES, 'clone.mjs']; };
    const env = { WE_DAEMON_CLOSURE_SCOPE: 'on' };
    expect(resolveDaemonEntries(env, { root: 'clone-root', runtimeEntries }).entries).toContain('clone.mjs');
    expect(observed).toEqual({ root: 'clone-root', entries: [], env });
  });

  it('discovers LaunchAgents against the live clone while booting a disposable candidate', () => {
    let observed;
    const runtimeEntries = options => { observed = options; return DAEMON_ENTRY_MODULES; };
    const env = { WE_DAEMON_CLOSURE_SCOPE: 'on', WE_SMOKE_LIVE_CLONE: 'live-clone', HOME: 'isolated-home' };
    resolveDaemonEntries(env, { root: 'candidate-tree', runtimeEntries });
    expect(observed.root).toBe('live-clone');
    expect(observed.env).toBe(env);
  });

  it('fails closed when clone entry discovery is unreadable', async () => {
    let spawned = false;
    const r = await checkDaemonEntriesBoot({ root: 'clone-root', env: { WE_DAEMON_CLOSURE_SCOPE: 'on' },
      runtimeEntries() { throw new Error('plist unreadable'); },
      runChild: async () => { spawned = true; return '{"ok":true}'; },
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('runtime entries unreadable');
    expect(spawned).toBe(false);
  });

  it('parses a comma-separated override, trimming whitespace and dropping empties, and reports overridden:true', () => {
    expect(resolveDaemonEntries({ [DAEMON_ENTRIES_ENV]: ' a.mjs, b.mjs ,,c.mjs' }))
      .toEqual({ entries: ['a.mjs', 'b.mjs', 'c.mjs'], overridden: true });
  });

  it('ignores a blank override', () => {
    expect(resolveDaemonEntries({ [DAEMON_ENTRIES_ENV]: '   ' })).toEqual({ entries: DAEMON_ENTRY_MODULES, overridden: false });
  });
});

describe('isSafeRelativeEntry — the resolution-safety gate', () => {
  it.each(DAEMON_ENTRY_MODULES)('accepts every real production entry: %s', (rel) => {
    expect(isSafeRelativeEntry(rel)).toBe(true);
  });

  it.each([
    ['../../etc/passwd', 'parent-directory traversal'],
    ['skills-src/../../../etc/passwd', 'traversal buried mid-path'],
    ['/etc/passwd', 'a leading-slash absolute path'],
    ['\\\\host\\share\\evil.mjs', 'a leading-backslash path'],
    ['data:text/javascript,alert(1)', 'a data: URL'],
    ['https://evil.example/payload.mjs', 'an https: URL'],
    ['file:///etc/passwd', 'a file: URL'],
    ['%2e%2e/evil.mjs', 'a percent-encoded ".." traversal — resolves outside the root even though the raw string has no literal ".."'],
    ['a/%2e%2e/../../etc/passwd', 'a mixed encoded + literal traversal'],
    ['', 'an empty string'],
  ])('refuses %s (%s)', (rel) => {
    expect(isSafeRelativeEntry(rel)).toBe(false);
  });
});

describe('buildEntryBootScript', () => {
  // The BUILT string (the child harness's own source) legitimately contains a real `import(...)` call — it has
  // to, to boot the entry. What must stay clean of a literal "import(" is THIS FILE's own source (the module
  // daemon-boot-smoke.mjs itself), never the string it constructs at runtime — see the file header's own note
  // on the split-token trick, mirrored from `daemon-live-smoke.mjs#DISPATCH_DRY_RUN_LINES`.
  it('produces a script that dynamically imports ONE entry by URL, never a static "import … from" line', () => {
    const script = buildEntryBootScript('a.mjs');
    expect(script).toContain("await import(new URL(\"a.mjs\", 'file://' + process.cwd() + '/').href);");
    expect(script).not.toMatch(/^\s*import\s+['"{]/m);
  });

  it('carries the disambiguating marker `withNewCheckDefaults`-style test fixtures key off of', () => {
    expect(buildEntryBootScript('a.mjs')).toContain('daemon-boot-smoke:entry-boot');
  });
});

describe('checkDaemonEntriesBoot — injected runChild (no real subprocess)', () => {
  // #4468 review — one child PER ENTRY now (never one shared child for the whole list, to avoid a cross-entry
  // ESM module-cache false negative). `runChild` is therefore called ONCE per entry; a fixture keys its reply
  // off `args[2]` (the entry's own script) rather than returning one combined array.
  const scriptedEntry = (args) => {
    const m = /new URL\("([^"]+)"/.exec(String(args?.[2] || ''));
    return m ? m[1] : null;
  };
  // Raw child stderr tails go to owner-only files here, never into the user's real daemon state dir.
  let diagnosticsDir;
  beforeEach(() => { diagnosticsDir = mkdtempSync(join(tmpdir(), 'we-boot-diag-')); });
  afterEach(() => rmSync(diagnosticsDir, { recursive: true, force: true }));
  const sevenEntries = { [DAEMON_ENTRIES_ENV]: Array.from({ length: 7 }, (_, i) => `fixture-${i}.mjs`).join(',') };
  const ctx = (runChild) => ({ root: '/candidate', runtimeEntries: () => DAEMON_ENTRY_MODULES,
    budgets: { daemonBootMs: 1000 }, runChild, env: {}, diagnosticsDir });

  it('refuses all seven boots at 1275ms left instead of starting doomed 45s children', async () => {
    let calls = 0;
    const runChild = budgetedRunChild({ deadline: 1275, now: () => 0, runChild: async (_cmd, _args, opts) => {
      calls++;
      throw new Error(`timed out after ${opts.timeoutMs}ms (process group killed)`);
    } });
    const r = await checkDaemonEntriesBoot({ ...ctx(runChild), env: sevenEntries, budgets: { daemonBootMs: 45000 } });
    expect(r.entries).toHaveLength(7);
    expect(calls).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.entries.every(e => e.kind === 'child failed: skipped: rebuild smoke budget exhausted (1275ms left)')).toBe(true);
    expect(r.detail).not.toContain('timed out');
  });

  it('boots healthy entries with ample shared budget', async () => {
    const seen = [];
    const runChild = budgetedRunChild({ deadline: 90000, now: () => 0, runChild: async (_cmd, _args, opts) => {
      seen.push(opts);
      return '{"ok":true}';
    } });
    expect((await checkDaemonEntriesBoot({ ...ctx(runChild), env: sevenEntries, budgets: { daemonBootMs: 45000 } })).ok).toBe(true);
    expect(seen).toHaveLength(7);
    expect(seen.every(opts => opts.timeoutMs === 45000 && !('minChildMs' in opts))).toBe(true);
  });

  it('resolves and logs the boot floor knob and clamps it to the requested cap', async () => {
    expect(resolveBootSettings({})).toMatchObject({ bootMinChildMs: 10000 });
    for (const invalid of ['0', '-1', 'abc', '9007199254740992']) {
      expect(resolveBootSettings({ WE_SMOKE_BOOT_MIN_CHILD_MS: invalid }).bootMinChildMs).toBe(10000);
    }
    const lines = [];
    const floors = [];
    const env = { WE_SMOKE_BOOT_MIN_CHILD_MS: '20000' };
    expect(resolveBootSettings(env)).toMatchObject({ bootMinChildMs: 20000, sources: { bootMinChildMs: 'env' } });
    await checkDaemonEntriesBoot({ ...ctx(async (_cmd, _args, opts) => {
      floors.push(opts.minChildMs);
      return '{"ok":true}';
    }), env, log: { error: line => lines.push(line) } });
    expect(floors).toEqual(Array(DAEMON_ENTRY_MODULES.length).fill(1000));
    expect(lines[0]).toContain('"bootMinChildMs":"env"');
    floors.length = 0;
    await checkDaemonEntriesBoot({ ...ctx(async (_cmd, _args, opts) => {
      floors.push(opts.minChildMs);
      return '{"ok":true}';
    }), budgets: { daemonBootMs: 45000 }, env });
    expect(floors).toEqual(Array(DAEMON_ENTRY_MODULES.length).fill(20000));
  });

  it('passes when every entry reports ok', async () => {
    const r = await checkDaemonEntriesBoot(ctx(async () => '{"ok":true}'));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('booted clean');
  });

  it('fails and names the broken entry when one entry reports ok:false', async () => {
    const broken = DAEMON_ENTRY_MODULES[2];
    const runChild = async (cmd, args) => (scriptedEntry(args) === broken
      ? '{"ok":false,"error":"ReferenceError: Cannot access \'X\' before initialization"}'
      : '{"ok":true}');
    const r = await checkDaemonEntriesBoot(ctx(runChild));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(broken);
    expect(r.detail).toContain('before initialization');
  });

  it('fails on every broken entry, not just the first', async () => {
    const broken = new Set([DAEMON_ENTRY_MODULES[0], DAEMON_ENTRY_MODULES[1]]);
    const runChild = async (cmd, args) => (broken.has(scriptedEntry(args)) ? '{"ok":false,"error":"boom"}' : '{"ok":true}');
    const r = await checkDaemonEntriesBoot(ctx(runChild));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('2/');
    expect(r.detail).toContain(DAEMON_ENTRY_MODULES[0]);
    expect(r.detail).toContain(DAEMON_ENTRY_MODULES[1]);
  });

  it.each(['SIGTRAP', 'SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL'])('retries %s once after initial boots drain', async (signal) => {
    const calls = [];
    const broken = DAEMON_ENTRY_MODULES[0];
    const r = await checkDaemonEntriesBoot(ctx(async (cmd, args) => {
      const entry = scriptedEntry(args);
      calls.push(entry);
      if (entry === broken && calls.length === 1) {
        throw Object.assign(new Error('native abort'), { signal, status: null, stderr: 'native stack' });
      }
      return '{"ok":true}';
    }));
    expect(r.ok).toBe(true);
    expect(calls).toEqual([...DAEMON_ENTRY_MODULES, broken]);
    expect(r.detail).toContain(`retried after ${signal}`);
    expect(r.entries[0].attempts[0]).toMatchObject({ signal, exitCode: null, stderrFile: expect.any(String) });
    expect(readFileSync(r.entries[0].attempts[0].stderrFile, 'utf8')).toBe('native stack\n');
  });

  it('rejects a second signal death and keeps the last 30 stderr lines in a 0600 file only', async () => {
    let calls = 0;
    const r = await checkDaemonEntriesBoot({ ...ctx(async () => {
      calls++;
      throw Object.assign(new Error('native abort'), { signal: 'SIGTRAP', status: null,
        stderr: Array.from({ length: 40 }, (_, i) => `stack line ${i}`).join('\n') + '\n' });
    }), env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' } });
    expect(calls).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('signal=SIGTRAP, exitCode=null, attempts=2');
    expect(r.detail).not.toContain('stack line');
    const file = r.entries[0].stderrFile;
    expect(r.detail).toContain(`stderr=${file}`);
    expect(file.startsWith(diagnosticsDir)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(30);
    expect(lines[0]).toBe('stack line 10');
    expect(lines[29]).toBe('stack line 39');
  });

  it.each([
    Object.assign(new Error('exit failure'), { status: 1, signal: null, stderr: 'real failure' }),
    Object.assign(new Error('timeout'), { status: null, signal: 'SIGKILL' }),
    '{"ok":false,"error":"bad import"}',
  ])('does not retry non-native failures', async (failure) => {
    let calls = 0;
    const r = await checkDaemonEntriesBoot({ ...ctx(async () => {
      calls++;
      if (failure instanceof Error) throw failure;
      return failure;
    }), env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' } });
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
    if (failure.status === 1) expect(r.detail).toContain('exitCode=1');
  });

  it('bounds initial concurrency and retries failed entries serially', async () => {
    const pending = [];
    const calls = [];
    const promise = checkDaemonEntriesBoot(ctx((cmd, args) => new Promise((resolve, reject) => {
      calls.push(scriptedEntry(args));
      pending.push({ resolve, reject });
    })));
    expect(calls).toHaveLength(3);
    pending[0].reject(Object.assign(new Error('native abort'), { signal: 'SIGTRAP' }));
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toHaveLength(4);
    pending[1].reject(Object.assign(new Error('native abort'), { signal: 'SIGABRT' }));
    pending[2].resolve('{"ok":true}');
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toHaveLength(6);
    for (const child of pending.slice(3)) child.resolve('{"ok":true}');
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toHaveLength(7);
    pending[6].resolve('{"ok":true}');
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toHaveLength(8);
    pending[7].resolve('{"ok":true}');
    expect((await promise).ok).toBe(true);
  });

  it('resolves settings with provenance, supports disabling retries, and logs sources', async () => {
    const env = { WE_SMOKE_BOOT_SIGNAL_RETRIES: '0', WE_SMOKE_BOOT_CONCURRENCY: '1', [DAEMON_ENTRIES_ENV]: 'fixture.mjs' };
    expect(resolveBootSettings(env)).toMatchObject({ bootSignalRetries: 0, bootConcurrency: 1,
      sources: { bootSignalRetries: 'env', bootConcurrency: 'env' } });
    expect(resolveBootSettings({ WE_SMOKE_BOOT_CONCURRENCY: '0', WE_SMOKE_BOOT_SIGNAL_RETRIES: '-1' }))
      .toMatchObject({ bootSignalRetries: 1, bootConcurrency: 3 });
    const lines = [];
    let calls = 0;
    const r = await checkDaemonEntriesBoot({ ...ctx(async () => {
      calls++;
      throw Object.assign(new Error('abort'), { signal: 'SIGTRAP' });
    }), env, log: { error: line => lines.push(line) } });
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
    expect(lines[0]).toContain('"bootSignalRetries":"env"');
  });

  it('preserves a reported import failure when a pending timer later causes a timeout', async () => {
    const error = 'SyntaxError: broken module | at /candidate/fixture.mjs:1:1';
    const r = await checkDaemonEntriesBoot({ ...ctx(async () => {
      throw Object.assign(new Error('timed out after 45000ms (process group killed)'), {
        stdout: JSON.stringify({ ok: false, error }), signal: 'SIGKILL',
      });
    }), env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' } });
    expect(r.entries[0]).toMatchObject({ ok: false, kind: 'import failed',
      errorClass: 'SyntaxError: broken module', files: ['fixture.mjs'] });
    expect(readFileSync(r.entries[0].stderrFile, 'utf8')).toContain('SyntaxError: broken module');
    expect(r.entries[0].attempts).toHaveLength(1);
  });

  it.each(['success', 'import failure', 'invalid output', 'timeout'])('measures each entry duration for %s', async (outcome) => {
    let t = 1000;
    const r = await checkDaemonEntriesBoot({ ...ctx(async () => {
      t += 1234;
      if (outcome === 'timeout') throw new Error('timed out after 45000ms (process group killed)');
      return { success: '{"ok":true}', 'import failure': '{"ok":false,"error":"SyntaxError: broken"}',
        'invalid output': 'invalid' }[outcome];
    }), env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' }, now: () => t });
    expect(r.entries[0].elapsedMs).toBe(1234);
    expect(r.entries[0].attempts[0].elapsedMs).toBe(1234);
  });

  it('fails when ONE entry\'s own child throws (killed / crashed before it could report) — the other entries still get judged', async () => {
    const brokenChild = DAEMON_ENTRY_MODULES[3];
    const runChild = async (cmd, args) => {
      if (scriptedEntry(args) === brokenChild) throw new Error('timed out after 1000ms (process group killed)');
      return '{"ok":true}';
    };
    const r = await checkDaemonEntriesBoot(ctx(runChild));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('child failed');
    expect(r.detail).toContain(brokenChild);
    expect(r.detail).toContain('1/'); // only the one broken entry, not every entry
  });

  it('carries only the first 80 chars of a long child error line as its class', async () => {
    const error = `ReferenceError: boom ${'e'.repeat(60)} tailword ${'e'.repeat(9_000)}`;
    const r = await checkDaemonEntriesBoot(ctx(async () => JSON.stringify({ ok: false, error })));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(`class=${error.slice(0, 80)}`);
    expect(r.detail).not.toContain('tailword');
  });

  it('fails on unparsable child output rather than silently passing', async () => {
    const r = await checkDaemonEntriesBoot(ctx(async () => 'not json'));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('unparsable');
  });

  it('never carries the unparsable output itself: V8 quotes it, the class masks the quote', async () => {
    const r = await checkDaemonEntriesBoot(ctx(async () => 'xq unparsablesentinel'));
    expect(r.ok).toBe(false);
    expect(r.entries[0].kind).toBe('unparsable child output');
    expect(r.entries[0].errorClass).toMatch(/^SyntaxError: /);
    expect(JSON.stringify(r)).not.toContain('unparsablesentinel');
    expect(readFileSync(r.entries[0].stderrFile, 'utf8')).toContain('unparsablesentinel');
  });

  it('refuses an unsafe override entry BEFORE spawning anything (#4468 review — traversal/absolute/scheme)', async () => {
    let spawned = false;
    const r = await checkDaemonEntriesBoot({
      root: '/candidate', budgets: { daemonBootMs: 1000 },
      runChild: async () => { spawned = true; return '{"ok":true}'; },
      env: { [DAEMON_ENTRIES_ENV]: '../../etc/passwd' },
    });
    expect(spawned).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('unsafe entry path');
    expect(r.detail).toContain('../../etc/passwd');
  });

  it('marks the detail loudly whenever the override is what actually supplied the entries', async () => {
    const r = await checkDaemonEntriesBoot({
      root: '/candidate', budgets: { daemonBootMs: 1000 },
      runChild: async () => '{"ok":true}',
      env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' },
    });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('override active');
  });

  it('never mentions the override when the real list is what ran', async () => {
    const r = await checkDaemonEntriesBoot(ctx(async () => '{"ok":true}'));
    expect(r.detail).not.toContain('override');
  });
});

describe('DAEMON_BOOT_SMOKE_CHECK — the SMOKE_CHECKS row shape', () => {
  it('runs code from the tree under test, so it is never eligible for a transient verdict', () => {
    expect(DAEMON_BOOT_SMOKE_CHECK.mayBeTransient).toBe(false);
  });

  it('carries codeEntries so #4044 skip-unchanged can walk its real import closure', () => {
    expect(DAEMON_BOOT_SMOKE_CHECK.codeEntries).toEqual(DAEMON_ENTRY_MODULES);
  });
});

describe('checkDaemonEntriesBoot — real subprocess, real dynamic import (no fakes)', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'daemon-boot-smoke-real-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('boots a clean fixture entry clean', async () => {
    writeFileSync(join(dir, 'clean-entry.mjs'), 'export const ok = 1;\n');
    const r = await checkDaemonEntriesBoot({
      root: dir, budgets: { daemonBootMs: 15_000 }, env: { ...process.env, [DAEMON_ENTRIES_ENV]: 'clean-entry.mjs' },
    });
    expect(r.ok).toBe(true);
  });

  it('catches a genuine ESM circular-import TDZ at boot — the #2921 failure shape, reproduced for real', async () => {
    writeFileSync(join(dir, 'tdz-a.mjs'), "import { b } from './tdz-b.mjs';\nexport const a = 1;\nconsole.log(b);\n");
    writeFileSync(join(dir, 'tdz-b.mjs'), "import { a } from './tdz-a.mjs';\nexport const b = a + 1;\n");
    writeFileSync(join(dir, 'tdz-entry.mjs'), "import './tdz-a.mjs';\n");
    const r = await checkDaemonEntriesBoot({
      root: dir, budgets: { daemonBootMs: 15_000 }, env: { ...process.env, [DAEMON_ENTRIES_ENV]: 'tdz-entry.mjs' },
      diagnosticsDir: join(dir, 'diag'),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('tdz-entry.mjs');
    expect(r.detail).toContain('ReferenceError');
    expect(r.detail).toContain('before initialization');
  });

  it('with real MULTIPLE entries, checks every one and reports only the broken one — never stops at the first (real subprocess, #4468 review)', async () => {
    writeFileSync(join(dir, 'clean-a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'tdz-a.mjs'), "import { b } from './tdz-b.mjs';\nexport const a = 1;\nconsole.log(b);\n");
    writeFileSync(join(dir, 'tdz-b.mjs'), "import { a } from './tdz-a.mjs';\nexport const b = a + 1;\n");
    writeFileSync(join(dir, 'tdz-entry.mjs'), "import './tdz-a.mjs';\n");
    writeFileSync(join(dir, 'clean-c.mjs'), 'export const c = 1;\n');
    const r = await checkDaemonEntriesBoot({
      root: dir, budgets: { daemonBootMs: 15_000 },
      env: { ...process.env, [DAEMON_ENTRIES_ENV]: 'clean-a.mjs,tdz-entry.mjs,clean-c.mjs' },
      diagnosticsDir: join(dir, 'diag'),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('1/3');
    expect(r.detail).toContain('tdz-entry.mjs');
    expect(r.detail).not.toContain('clean-a.mjs:'); // the clean entries are never reported as failures
    expect(r.detail).not.toContain('clean-c.mjs:');
  });

  it('boots every REAL production daemon entry clean on this tree (the wiring test)', async () => {
    const r = await checkDaemonEntriesBoot({ root: process.cwd(), runtimeEntries: () => DAEMON_ENTRY_MODULES, budgets: { daemonBootMs: 45_000 } });
    expect(r.ok).toBe(true);
    for (const entry of DAEMON_ENTRY_MODULES) expect(r.detail).toContain(entry);
  }, 60_000);
});

describe('smoke diagnostics carry an allow-listed summary, never raw child text (operator send-back 2026-10-17)', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-boot-diag-summary-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Words that are not secret-shaped, so only the design (not a redactor) can keep them out.
  const words = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}word${i}x`);
  // Every word of the raw stderr that is not part of the error class must be absent from the summary.
  const assertOnlyClass = (summary, stderr, errorClass) => {
    for (const w of stderr.match(/[A-Za-z0-9]{6,}/g)) if (!String(errorClass).includes(w)) expect(summary).not.toContain(w);
  };

  it.each([
    ['a quoted multi-line credential opening on the class line', [
      ...words('frame', 40),
      'TypeError: config load failed for "password: alphacred1x',
      'bravocred2x charliecred3x"',
      'DB_PASSWORD="deltacred4x',
      'echocred5x"',
    ], 'TypeError: config load failed for <…>'],
    ['a CR-joined line after the class', ['RangeError: size limit\rfoxtrotcred6x', ...words('after', 5)], 'RangeError: size limit'],
    ['text past 80 chars on the class line', [`RangeError: ${'a'.repeat(68)}golfcred7x`, 'hotelcred8x'], `RangeError: ${'a'.repeat(68)}`],
    ['an escaped quote inside a quoted string', ['SyntaxError: bad "indiacred9x\\"julietcred10x" token', 'kilocred11x'], 'SyntaxError: bad <…> token'],
  ])('%s: the alert-bound summary holds the error class only', async (_name, lines, errorClass) => {
    const stderr = `${lines.join('\n')}\n`;
    const r = await checkDaemonEntriesBoot({
      root: '/candidate', budgets: { daemonBootMs: 1000 }, env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' }, diagnosticsDir: dir,
      // The bounded-child failure shape: its message carries the first stderr line.
      runChild: async () => { throw Object.assign(new Error(`exited 1: ${lines[0]}`), { status: 1, signal: null, stderr }); },
    });
    expect(r.ok).toBe(false);
    expect(r.entries[0].errorClass).toBe(errorClass);
    const summary = JSON.stringify(r);
    assertOnlyClass(summary, stderr, errorClass);
    // The raw tail is in the local owner-only file the summary names, and only there.
    const file = r.entries[0].stderrFile;
    expect(r.detail).toContain(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(`${stderr.trimEnd().split(/\r\n|[\n\r]/).slice(-30).join('\n')}\n`);
  });

  it('an import failure keeps its stack frames in the file, never in the summary', async () => {
    const error = 'ReferenceError: Cannot access \'secretname\' before initialization | at file:///x/limaframe.mjs:3 | at file:///x/mikeframe.mjs:9';
    const r = await checkDaemonEntriesBoot({
      root: '/candidate', budgets: { daemonBootMs: 1000 }, env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' }, diagnosticsDir: dir,
      runChild: async () => JSON.stringify({ ok: false, error }),
    });
    expect(r.entries[0].errorClass).toBe('ReferenceError: Cannot access <…> before initialization');
    for (const w of ['secretname', 'limaframe', 'mikeframe']) expect(JSON.stringify(r)).not.toContain(w);
    expect(readFileSync(r.entries[0].stderrFile, 'utf8')).toContain('mikeframe');
  });

  it('a summary field that is not its allow-listed type never carries text', async () => {
    const r = await checkDaemonEntriesBoot({
      root: '/candidate', budgets: { daemonBootMs: 1000 }, env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' }, diagnosticsDir: dir,
      runChild: async () => { throw Object.assign(new Error('x'), { status: 'novembercred12x', signal: 'oscarcred13x', stderr: '' }); },
    });
    expect(r.entries[0]).toMatchObject({ signal: null, exitCode: null, errorClass: null });
    expect(JSON.stringify(r)).not.toMatch(/novembercred|oscarcred/);
    expect(pickSmokeDiagnostics({ errorClass: 'not a class papacred14x', stderrFile: 'a\nquebeccred15x', launchStartedAt: 'romeocred16x' }))
      .toMatchObject({ errorClass: null, stderrFile: null, launchStartedAt: null });
  });

  it('smokeErrorClass: first matching line, 80 chars, quotes masked; null when no line matches', () => {
    expect(smokeErrorClass('warning\nTypeError: x is not a function\nError: second')).toBe('TypeError: x is not a function');
    // The operator's pattern as written: a bare `Error:` or a coded `Error [ERR_X]:` line is not a class line.
    expect(smokeErrorClass('Error: plain')).toBeNull();
    expect(smokeErrorClass("Error [ERR_MODULE_NOT_FOUND]: Cannot find 'x'")).toBeNull();
    expect(smokeErrorClass('  TypeError: indented')).toBeNull();
    expect(smokeErrorClass("TypeError: can't open `sierra` file")).toBe('TypeError: can<…>');
    expect(smokeErrorClass(`TypeError: x${String.fromCharCode(0x2028)}tangocred17x`)).toBe('TypeError: x');
    expect(smokeErrorClass('')).toBeNull();
    // Typographic, guillemet and fullwidth quotes are masked; bidi/zero-width characters dropped; token shapes redacted.
    const q = (o, c) => `TypeError: bad ${String.fromCharCode(o)}uniformword1x${String.fromCharCode(c)} end`;
    for (const [o, c] of [[0x201c, 0x201d], [0x2018, 0x2019], [0xab, 0xbb], [0xff02, 0xff02]]) expect(smokeErrorClass(q(o, c))).toBe('TypeError: bad <…> end');
    expect(smokeErrorClass(`TypeError: a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x200b)}c`)).toBe('TypeError: abc');
    expect(smokeErrorClass('FetchError: to https://x:ghp_victorword2xAAAA@h failed')).not.toContain('victorword2x');
  });

  it('writeStderrTail: a fresh 0600 file under a 0700 dir; nothing to write or a failed write yields null', () => {
    const sub = join(dir, 'diag');
    const file = writeStderrTail(Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'), { dir: sub, label: 'boot-scripts/x.mjs' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(sub).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8').trimEnd().split('\n')).toEqual(Array.from({ length: 30 }, (_, i) => `line ${i + 20}`));
    expect(writeStderrTail('', { dir: sub })).toBeNull();
    writeFileSync(join(dir, 'not-a-dir'), '');
    expect(writeStderrTail('x', { dir: join(dir, 'not-a-dir') })).toBeNull();
  });

  // V8 copies raw input into a JSON parse message without escaping its quotes, so pairing quotes leaves the text
  // between them raw (self-review, PR 5460): only one cleanly bounded string may be masked in place.
  const v8JsonError = (input) => { try { JSON.parse(input); } catch (e) { return String(e); } throw new Error('parsed'); };
  const sevenEntries = { [DAEMON_ENTRIES_ENV]: Array.from({ length: 7 }, (_, i) => `fixture-${i}.mjs`).join(',') };
  const ctx = (runChild) => ({ root: '/candidate', budgets: { daemonBootMs: 1000 }, env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' }, diagnosticsDir: dir, runChild });

  it('an import failure parsing malformed JSON never carries the copied input in its class', async () => {
    // V8 copies about 10 chars of the input around the bad token: `…"{"pw": hotel"... is not valid JSON`.
    const error = v8JsonError('{"pw": hotel, "b": "india"}');
    const r = await checkDaemonEntriesBoot(ctx(async () => JSON.stringify({ ok: false, error })));
    expect(error).toContain('hotel');
    expect(r.entries[0].errorClass).toMatch(/^SyntaxError: [^"']*<…>$/);
    expect(JSON.stringify(r)).not.toContain('hotel');
    expect(readFileSync(r.entries[0].stderrFile, 'utf8')).toContain('hotel');
  });

  it.each(['x"julietcred3x"', "'kilocred4x", 'a", limacred5x, "b'])('unparsable output %s: a fixed class, the output only in the file', async (out) => {
    const r = await checkDaemonEntriesBoot(ctx(async () => out));
    expect(r.entries[0]).toMatchObject({ kind: 'unparsable child output', errorClass: 'SyntaxError: unparsable child output' });
    expect(JSON.stringify(r)).not.toMatch(/julietcred|kilocred|limacred/);
  });

  it('smokeErrorClass: several quotes, an unclean quote or a quote after the first hide everything from the first', () => {
    expect(smokeErrorClass('TypeError: a "x", mikecred6x, "y"')).toBe('TypeError: a <…>');
    expect(smokeErrorClass('TypeError: bad ..."novembercred7x" here')).toBe('TypeError: bad ...<…>');
    expect(smokeErrorClass('TypeError: bad "x"oscarcred8x')).toBe('TypeError: bad <…>');
    expect(smokeErrorClass(`TypeError: bad ${String.fromCharCode(0x201c)}x${String.fromCharCode(0x201d)} papacred9x ${String.fromCharCode(0x2019)}`)).toBe('TypeError: bad <…>');
    expect(smokeErrorClass(v8JsonError('{"pw": quebeccred10x}'))).not.toContain('quebeccred10x');
  });

  it('smokeErrorClass: a class-shaped line inside a quote opened on an earlier line is never the class', () => {
    expect(smokeErrorClass('Error: cfg "pw: a\nTypeError: romeocred11x"\n')).toBeNull();
    expect(smokeErrorClass('Error: cfg "pw: a\nTypeError: sierracred12x"\nRangeError: real one')).toBe('RangeError: real one');
    // A contraction is not an opening quote.
    expect(smokeErrorClass("warning: can't load x\nTypeError: y is not a function")).toBe('TypeError: y is not a function');
  });

  it('a bounded-child timeout still reads as one; its stderr stays in the file', async () => {
    const r = await checkDaemonEntriesBoot(ctx(async () => {
      throw Object.assign(new Error('timed out after 1000ms (process group killed)'), { status: null, signal: 'SIGKILL', stderr: 'tangocred13x\n' });
    }));
    expect(r.entries[0].kind).toBe('child failed: timed out after 1000ms (process group killed)');
    expect(r.detail).toContain('child failed: timed out after 1000ms');
    expect(JSON.stringify(r)).not.toContain('tangocred13x');
  });

  it('redactDetail keeps a whole boot or dispatch summary (its file path is near the end), other details at 500', () => {
    const summary = `timeout; ${'x'.repeat(600)}; stderrFile=/state/smoke-diagnostics/a.log`;
    expect(redactDetail(summary, 'dispatch-smoke')).toBe(summary);
    expect(redactDetail(summary, 'daemon-entries-boot')).toBe(summary);
    expect(redactDetail(summary)).toHaveLength(500);
  });

  it('a bad injected clock never makes the check throw', async () => {
    const r = await checkDaemonEntriesBoot({ ...ctx(async () => 'not json'), now: () => Number.NaN });
    expect(r.ok).toBe(false);
    expect(r.entries[0].startedAt).toBeNull();
  });
});
