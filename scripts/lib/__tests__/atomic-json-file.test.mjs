/**
 * @file scripts/lib/__tests__/atomic-json-file.test.mjs
 * @description Unit proof of {@link writeJsonAtomic} (card #4188, bornAs `x5qketq`, epic #4075): a real temp
 *   directory only (never the operator's own files) — proves the write actually lands, the rename is genuinely
 *   atomic (no leftover `.tmp` survives success), and a validation failure never touches the real target path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic, withFileLock } from '../atomic-json-file.mjs';

describe('writeJsonAtomic', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-atomic-json-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes valid, re-readable JSON to the target path', () => {
    const target = join(dir, 'out.json');
    writeJsonAtomic(target, { a: 1, b: ['x', 'y'] });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ a: 1, b: ['x', 'y'] });
  });

  it('overwrites an existing file completely', () => {
    const target = join(dir, 'out.json');
    writeFileSync(target, JSON.stringify({ old: true }));
    writeJsonAtomic(target, { fresh: true });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ fresh: true });
  });

  it('leaves NO leftover `.tmp` file after a successful write', () => {
    const target = join(dir, 'out.json');
    writeJsonAtomic(target, { a: 1 });
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('throws on an unserializable value (e.g. a BigInt) and never touches the target path', () => {
    const target = join(dir, 'out.json');
    writeFileSync(target, JSON.stringify({ untouched: true }));
    expect(() => writeJsonAtomic(target, { bad: 10n })).toThrow();
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ untouched: true });
    // No stray temp file left behind by the failed attempt either.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('throws when the destination directory does not exist, and never silently swallows the error', () => {
    expect(() => writeJsonAtomic(join(dir, 'no-such-dir', 'out.json'), { a: 1 })).toThrow();
  });

  it('pretty-prints with a trailing newline (matches this repo\'s own JSON-file convention)', () => {
    const target = join(dir, 'out.json');
    writeJsonAtomic(target, { a: 1 });
    const text = readFileSync(target, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\n`);
  });

  // PR #2735 (A3 red-team of #2726/#4188) finding 3: writing to a PATH THAT IS ITSELF A SYMLINK (an operator's
  // real `~/.claude.json` can be one — a dotfile-manager setup) must land the new content at the symlink's REAL
  // TARGET, never replace the symlink itself with a plain file. `renameSync(tmp, path)` onto a symlink's own
  // path unlinks the symlink and puts a plain file there instead — silently breaking whatever else pointed at
  // the same real file through that link.
  it('writes THROUGH a symlinked target, never replacing the symlink itself', () => {
    const real = join(dir, 'real.json');
    writeFileSync(real, JSON.stringify({ old: true }));
    const link = join(dir, 'link.json');
    symlinkSync(real, link);

    writeJsonAtomic(link, { fresh: true });

    expect(lstatSync(link).isSymbolicLink()).toBe(true); // still a symlink — never replaced
    expect(JSON.parse(readFileSync(link, 'utf8'))).toEqual({ fresh: true }); // reading through it sees the new content
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ fresh: true }); // the REAL file itself was updated
  });

  // PR #2735 finding 4: a rename failure (a real cross-device/EXDEV failure, an ENOSPC, a permission error)
  // must not leave the `.tmp` file behind — it is dead weight that would otherwise accumulate forever next to
  // the real target. Injects a failing `renameSyncFn` (the same DI seam this repo's other IO-shell functions
  // already use for fs calls) rather than monkey-patching `node:fs` itself.
  it('cleans up its own `.tmp` file when the final rename fails, never leaves it behind', () => {
    const target = join(dir, 'out.json');
    const renameSyncFn = () => { throw Object.assign(new Error('simulated EXDEV'), { code: 'EXDEV' }); };
    expect(() => writeJsonAtomic(target, { a: 1 }, { renameSyncFn })).toThrow(/simulated EXDEV/);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(existsSync(target)).toBe(false); // the rename never happened — target untouched
  });
});

// LIVE-CAUGHT (2026-09-26, card #4188): atomicity alone does not prevent a LOST UPDATE between two concurrent
// read-modify-write callers — see `dispatch-lane-io.mjs#grantDispatchTrust`/`#revokeDispatchTrust`'s own docs
// for the real incident this closed. These tests prove the mutex primitive directly.
describe('withFileLock', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-file-lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('runs `fn` and returns its value when uncontended', () => {
    const lockPath = join(dir, 'trust.json.lock');
    const result = withFileLock(lockPath, () => 42);
    expect(result).toBe(42);
  });

  it('releases the lock file after `fn` returns — no leftover lock on success', () => {
    const lockPath = join(dir, 'trust.json.lock');
    withFileLock(lockPath, () => {});
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock even when `fn` throws', () => {
    const lockPath = join(dir, 'trust.json.lock');
    expect(() => withFileLock(lockPath, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a SECOND caller is genuinely excluded while the lock is held — proves mutual exclusion, not just a flag', () => {
    const lockPath = join(dir, 'trust.json.lock');
    const order = [];
    withFileLock(lockPath, () => {
      // A second acquire attempt while we still hold it must NOT succeed immediately — it has to wait
      // (and here, time out, since nothing ever releases from inside this nested call).
      order.push('first-acquired');
      expect(() => withFileLock(lockPath, () => { order.push('SHOULD NOT RUN'); }, { timeoutMs: 100, pollMs: 10 }))
        .toThrow(/timed out/);
      order.push('second-attempt-timed-out');
    });
    expect(order).toEqual(['first-acquired', 'second-attempt-timed-out']);
  });

  it('a STALE lock (older than `staleMs`) is stolen rather than honored forever', () => {
    const lockPath = join(dir, 'trust.json.lock');
    // A pid outside any real OS pid range — provably "no such process" (ESRCH) once pid-liveness is checked,
    // never flaky-by-coincidence the way a small reused pid like `99999` theoretically could be.
    writeFileSync(lockPath, '999999999');
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    const result = withFileLock(lockPath, () => 'acquired-after-steal', { staleMs: 1_000, timeoutMs: 2_000, pollMs: 10 });
    expect(result).toBe('acquired-after-steal');
    expect(existsSync(lockPath)).toBe(false); // released cleanly after the steal + run
  });

  it('a FRESH contended lock is NOT stolen — waits, then times out loudly rather than double-running', () => {
    const lockPath = join(dir, 'trust.json.lock');
    writeFileSync(lockPath, '999999999'); // fresh — mtime is "now"
    expect(() => withFileLock(lockPath, () => 'should never run', { staleMs: 60_000, timeoutMs: 100, pollMs: 10 }))
      .toThrow(/timed out/);
  });

  it.each(['before takeover', 'after takeover'])('EPERM preserves an aged holder %s', (stage) => {
    const lockPath = join(dir, 'permission.lock');
    const holder = 999999999;
    writeFileSync(lockPath, `${holder}\n`);
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    const fn = vi.fn();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('signal permission denied'), { code: 'EPERM' });
    });
    // The post-move probe must also honor a holder that became live after the first read.
    if (stage === 'after takeover') kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    try {
      expect(() => withFileLock(lockPath, fn, { staleMs: 1_000, timeoutMs: 0 })).toThrow(/timed out/);
      expect(kill).toHaveBeenCalledWith(holder, 0);
      expect(kill).toHaveBeenCalledTimes(stage === 'after takeover' ? 2 : 1);
      expect(fn).not.toHaveBeenCalled();
      expect(readFileSync(lockPath, 'utf8')).toBe(`${holder}\n`);
      expect(readdirSync(dir)).toEqual(['permission.lock']);
    } finally { kill.mockRestore(); }
  });

  // PR #2735 (A3 red-team of #2726/#4188) finding 2, MOST SERIOUS of the lock family: a takeover that decides
  // "stale" from one read and then acts on that decision UNCONDITIONALLY (the pre-fix `unlinkSync`) can end up
  // removing a DIFFERENT file than the one it inspected — a sibling process can, in the gap between the
  // decision and the action, have already fully stolen the same original stale lock and re-acquired a FRESH,
  // GENUINELY LIVE one of its own at the identical path (real risk under real CPU load — see this file's own
  // header). Deterministic, single-process reproduction: `onBeforeStaleTakeover` (a test-only hook, a no-op for
  // every real caller) simulates exactly that gap by swapping the stale lock for a fresh, alive one at the
  // instant this call has already committed to "stale" — proving the fix re-validates what it is ABOUT to
  // remove instead of trusting the earlier read.
  it('never acts on a stale decision once the lock has become genuinely live again in the meantime', () => {
    const lockPath = join(dir, 'race.lock');
    writeFileSync(lockPath, '999999999'); // provably-dead holder — genuinely stale
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    let fnRan = false;
    const call = () => withFileLock(lockPath, () => { fnRan = true; }, {
      staleMs: 1_000,
      timeoutMs: 200,
      pollMs: 10,
      onBeforeStaleTakeover: () => {
        // Simulate a sibling that, in the gap between OUR decision and OUR action, already fully stole the
        // original stale lock and re-acquired a fresh one of its own — alive (our own pid — unambiguously so)
        // and genuinely still needed.
        unlinkSync(lockPath);
        writeFileSync(lockPath, String(process.pid));
      },
    });

    expect(call).toThrow(/timed out/); // must back off — never barge into a sibling's live lock
    expect(fnRan).toBe(false);
    // The simulated sibling's lock must still be standing, completely untouched by our failed steal attempt.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });
});

it('#4429 private temporary and replacement files under permissive umask', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { writeJsonAtomic } from ${JSON.stringify(join(process.cwd(), 'scripts/lib/atomic-json-file.mjs'))};
    import { mkdtempSync, statSync, renameSync, chmodSync, readdirSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    process.umask(0);
    const dir = mkdtempSync(join(tmpdir(), 'atomic-private-'));
    const target = join(dir, 'out.json');
    const modes = [];
    try {
      for (let i = 0; i < 2; i++) {
        if (i) chmodSync(target, 0o666);
        writeJsonAtomic(target, { i }, { mode: 0o600, renameSyncFn: (tmp, dest) => {
          modes.push(statSync(tmp).mode & 0o777);
          renameSync(tmp, dest);
        } });
        modes.push(statSync(target).mode & 0o777);
      }
      console.log(JSON.stringify({ modes, files: readdirSync(dir) }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  `], { encoding: 'utf8' }));
  expect(result).toEqual({ modes: [0o600, 0o600, 0o600, 0o600], files: ['out.json'] });
});
