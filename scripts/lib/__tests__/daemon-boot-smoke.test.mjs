/**
 * @file daemon-boot-smoke.test.mjs — #4468. Unit coverage for `checkDaemonEntriesBoot`'s own contract (injected
 * `runChild`, no real subprocess) plus three REAL-subprocess tests that actually spawn `node` and dynamically
 * import fixture (or, for one of them, the real production) entries on disk — the exact path a candidate
 * rebuild's live smoke exercises. A soak-registered reproduction of the same fixture-TDZ shape, gated on
 * `fixPresent`/RED-before-GREEN-after, lives separately in
 * `we:scripts/conveyor/soak/breaks/daemon-entry-boot-crash.mjs` — it exercises the SAME fixture entry via the
 * SAME override this file uses, not the real production entry list (only this file's own last test does that).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildEntryBootScript, checkDaemonEntriesBoot, DAEMON_BOOT_SMOKE_CHECK, DAEMON_ENTRIES_ENV, DAEMON_ENTRY_MODULES,
  isSafeRelativeEntry, resolveDaemonEntries, resolveBootSettings,
} from '../daemon-boot-smoke.mjs';

describe('resolveDaemonEntries', () => {
  it('uses the real list when no override is set', () => {
    expect(resolveDaemonEntries({})).toEqual({ entries: DAEMON_ENTRY_MODULES, overridden: false });
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
  const ctx = (runChild) => ({ root: '/candidate', budgets: { daemonBootMs: 1000 }, runChild, env: {} });

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
    expect(r.entries[0].attempts[0]).toMatchObject({ signal, exitCode: null, stderrTail: 'native stack' });
  });

  it('rejects a second signal death and retains the last 30 stderr lines', async () => {
    let calls = 0;
    const r = await checkDaemonEntriesBoot({ ...ctx(async () => {
      calls++;
      throw Object.assign(new Error('native abort'), { signal: 'SIGTRAP', status: null,
        stderr: Array.from({ length: 40 }, (_, i) => `stack line ${i}`).join('\n') + '\n' });
    }), env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs' } });
    expect(calls).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('signal=SIGTRAP, exitCode=null');
    expect(r.detail).toContain('stack line 39');
    expect(r.entries[0].stderrTail.split('\n')).toHaveLength(30);
    expect(r.entries[0].stderrTail).toMatch(/^stack line 10\n/);
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

  it('keeps the head of a single-line child error over 8 KB, redacted', async () => {
    const error = `ReferenceError: boom ghp_secretAAAA ${'e'.repeat(9_000)}`;
    const r = await checkDaemonEntriesBoot(ctx(async () => JSON.stringify({ ok: false, error })));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('ReferenceError: boom');
    expect(r.detail).not.toContain('ghp_secretAAAA');
  });

  it('redacts a child error before bounding it, so a quoted secret straddling the 8 KB cut never leaks', async () => {
    const error = `token=${'e'.repeat(7_960)} "password": "alpha bravo charlie delta echo foxtrot golf hotel"`;
    expect(error.indexOf('alpha')).toBeLessThan(8_000);
    expect(error.indexOf('hotel')).toBeGreaterThan(8_000);
    const r = await checkDaemonEntriesBoot(ctx(async () => JSON.stringify({ ok: false, error })));
    for (const w of ['bravo', 'charlie', 'hotel']) {
      expect(r.detail).not.toContain(w);
      expect(JSON.stringify(r.entries)).not.toContain(w);
    }
  });

  it('fails on unparsable child output rather than silently passing', async () => {
    const r = await checkDaemonEntriesBoot(ctx(async () => 'not json'));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('unparsable');
  });

  it('redacts a secret quoted by the unparsable-output error in entries[].error', async () => {
    const r = await checkDaemonEntriesBoot(ctx(async () => 'x ghp_secretAAAA'));
    expect(r.ok).toBe(false);
    expect(r.entries[0].error).toContain('unparsable child output');
    expect(JSON.stringify(r.entries)).not.toContain('ghp_secretAAAA');
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
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('1/3');
    expect(r.detail).toContain('tdz-entry.mjs');
    expect(r.detail).not.toContain('clean-a.mjs:'); // the clean entries are never reported as failures
    expect(r.detail).not.toContain('clean-c.mjs:');
  });

  it('boots every REAL production daemon entry clean on this tree (the wiring test)', async () => {
    const r = await checkDaemonEntriesBoot({ root: process.cwd(), budgets: { daemonBootMs: 45_000 } });
    expect(r.ok).toBe(true);
    for (const entry of DAEMON_ENTRY_MODULES) expect(r.detail).toContain(entry);
  }, 60_000);
});
