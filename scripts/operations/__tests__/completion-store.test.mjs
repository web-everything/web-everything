/**
 * @file completion-store.test.mjs — the fs shell over completion-record.mjs (#3436).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { newCompletionRecord } from '../completion-record.mjs';
import {
  completionLockRoot,
  completionPath,
  completionsDir,
  createFileCompletionStore,
  deleteCompletion,
  listCompletionSessions,
  readCompletion,
  resolveCompletionsDir,
  tryReadCompletion,
  withCompletionLock,
  writeCompletion,
} from '../completion-store.mjs';
import { reserve } from '../../readiness/file-locks.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-op-completions-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sample = () => newCompletionRecord({ session: 'review-701', kind: 'review', pr: 701, now: () => '2026-09-03T00:00:00.000Z' });

describe('the fs shell', () => {
  it('writes atomically and leaves no temp file behind', () => {
    writeCompletion(sample(), dir);
    expect(readdirSync(dir)).toEqual(['review-701.json']);
    expect(JSON.parse(readFileSync(join(dir, 'review-701.json'), 'utf8'))).toEqual(sample());
  });

  // #4314 (prevention guard owed by web-everything/web-everything#2831's independent review, finding 4: "a lint rule
  // enforcing `finally` cleanup blocks for temp file handles, or a property-based test that asserts directory
  // size remains constant after simulated concurrent accesses"). writeCompletion's temp-file-then-rename write
  // had no cleanup on a failed rename: a real (not mocked) EISDIR — renaming the temp file onto a path that is
  // itself a directory, which is exactly the shape a corrupted/concurrently-modified completions dir can take —
  // left the `.tmp` file behind forever (`listCompletionSessions`/`readdirSync` never reap it; nothing else
  // does either). The directory-size property this guards: after ANY writeCompletion call, successful or not,
  // the completions directory holds no `.tmp` file.
  it('leaves no temp file behind when the write fails partway through (a real rename failure, not a mock)', () => {
    const record = sample();
    const path = completionPath(record.session, dir);
    mkdirSync(path); // makes the destination itself a directory, so renameSync(tmp, path) throws EISDIR
    expect(() => writeCompletion(record, dir)).toThrow();
    const leftoverTemps = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftoverTemps).toEqual([]);
  });

  it('round-trips through the file store handle', () => {
    const store = createFileCompletionStore(dir);
    store.write(sample());
    expect(store.read('review-701')).toEqual(sample());
    expect(store.list()).toEqual(['review-701']);
    store.delete('review-701');
    expect(store.read('review-701')).toBeNull();
    expect(() => store.delete('review-701')).not.toThrow();
  });

  it('lists only well-formed completion files, ignoring temp and stray names', () => {
    writeCompletion(sample(), dir);
    writeFileSync(join(dir, 'review-701.json.123.tmp'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(listCompletionSessions(dir)).toEqual(['review-701']);
    expect(listCompletionSessions(join(dir, 'nope'))).toEqual([]);
  });

  it('resolves the sidecar by SCRIPT location, and OPERATION_COMPLETIONS_DIR overrides it', () => {
    const previous = process.env.OPERATION_COMPLETIONS_DIR;
    try {
      delete process.env.OPERATION_COMPLETIONS_DIR;
      expect(resolveCompletionsDir()).toBe(completionsDir());
      expect(completionsDir()).toMatch(/[/\\]\.operations[/\\]completions$/);
      process.env.OPERATION_COMPLETIONS_DIR = dir;
      expect(resolveCompletionsDir()).toBe(dir);
    } finally {
      if (previous === undefined) delete process.env.OPERATION_COMPLETIONS_DIR;
      else process.env.OPERATION_COMPLETIONS_DIR = previous;
    }
  });

  it('creates the completions directory on first write', () => {
    const nested = join(dir, 'deep', 'completions');
    writeCompletion(sample(), nested);
    expect(readdirSync(nested)).toEqual(['review-701.json']);
  });

  it('deleteCompletion on a directory that does not exist is a no-op', () => {
    mkdirSync(join(dir, 'empty'), { recursive: true });
    expect(() => deleteCompletion('review-701', join(dir, 'empty'))).not.toThrow();
  });

  it('refuses a session slug that could escape the completions directory', () => {
    expect(() => completionPath('../escape', dir)).toThrow(/invalid completion session slug/);
  });
});

describe('writeCompletion with `expectPrior` (#4306) — the conditional backstop write', () => {
  it('omitting `expectPrior` is byte-identical to before this option existed — no lock dir, bare path returned', () => {
    const path = writeCompletion(sample(), dir);
    expect(path).toBe(completionPath('review-701', dir));
    expect(readdirSync(dir)).toEqual(['review-701.json']); // no `.locks` subdirectory ever created
  });

  it('writes and returns {written:true, path} when the on-disk record still matches what was planned against', () => {
    writeCompletion(sample(), dir);
    const plannedAgainst = tryReadCompletion('review-701', dir);
    const next = { ...sample(), status: 'done', outcome: 'gate-red', updatedAt: '2026-09-03T00:10:00.000Z' };
    const result = writeCompletion(next, dir, { expectPrior: plannedAgainst });
    expect(result).toEqual({ written: true, path: completionPath('review-701', dir) });
    expect(tryReadCompletion('review-701', dir).status).toBe('done');
  });

  it('refuses (writes nothing) when a DIFFERENT record landed between the plan read and this write — the exact race a fresh `started` report must win', () => {
    writeCompletion(sample(), dir);
    const plannedAgainst = tryReadCompletion('review-701', dir); // the reaper's own snapshot, taken at plan time
    // A fresh generation's `started` report lands in between — same session NAME, different generation.
    const interloper = { ...sample(), sessionId: 'session-B', updatedAt: '2026-09-03T00:05:00.000Z' };
    writeCompletion(interloper, dir);
    const backstop = { ...sample(), status: 'done', outcome: 'unreported-exit', updatedAt: '2026-09-03T00:10:00.000Z' };
    const result = writeCompletion(backstop, dir, { expectPrior: plannedAgainst });
    expect(result).toEqual({ written: false, reason: 'changed' });
    expect(tryReadCompletion('review-701', dir)).toEqual(interloper); // untouched — the interloper's record wins
  });

  it('`expectPrior: null` means "planned against nothing on disk" — refuses once something has appeared', () => {
    const first = writeCompletion(sample(), dir, { expectPrior: null });
    expect(first).toEqual({ written: true, path: completionPath('review-701', dir) });
    const second = writeCompletion({ ...sample(), status: 'done' }, dir, { expectPrior: null });
    expect(second).toEqual({ written: false, reason: 'changed' });
  });
});

describe('withCompletionLock (#4306) — the per-name critical section, reusing file-locks.mjs', () => {
  it('runs `fn` and returns its value, releasing the lock afterward', () => {
    const result = withCompletionLock('fix-9', () => 'the critical section ran', { dir });
    expect(result).toBe('the critical section ran');
    // released — a second acquisition for the SAME name succeeds immediately, no timeout needed.
    expect(withCompletionLock('fix-9', () => 'again', { dir, waitMs: 50 })).toBe('again');
  });

  it('releases the lock even when `fn` throws', () => {
    expect(() => withCompletionLock('fix-9', () => { throw new Error('boom'); }, { dir })).toThrow('boom');
    expect(withCompletionLock('fix-9', () => 'still free', { dir, waitMs: 50 })).toBe('still free');
  });

  it('gives up with a clear, bounded-wait error when another owner already holds the same name', () => {
    const lockRoot = completionLockRoot(dir);
    const heldAt = Date.now();
    reserve(lockRoot, 'completion:fix-9', 'someone-else', heldAt, new Date(heldAt).toISOString());
    const start = Date.now();
    expect(() => withCompletionLock('fix-9', () => 'should never run', {
      dir, waitMs: 60, pollMs: 10, sleep: () => {},
    })).toThrow(/could not acquire completion lock for "fix-9"/);
    expect(Date.now() - start).toBeLessThan(2000); // bounded, never an unbounded wait
  });

  it('a DIFFERENT name is never blocked by another name\'s held lock', () => {
    const lockRoot = completionLockRoot(dir);
    const heldAt = Date.now();
    reserve(lockRoot, 'completion:fix-9', 'someone-else', heldAt, new Date(heldAt).toISOString());
    expect(withCompletionLock('fix-10', () => 'unrelated', { dir, waitMs: 50 })).toBe('unrelated');
  });
});

describe('a corrupt record is REFUSED, never read as absent', () => {
  it('tryReadCompletion THROWS on a corrupt file rather than returning null', () => {
    writeFileSync(join(dir, 'fix-9.json'), '{"v":1,"session":"fix-9"');
    expect(() => tryReadCompletion('fix-9', dir)).toThrow(/refusing to read completion record for fix-9[\s\S]*never treated as one that was never written/);
  });

  it('tryReadCompletion returns null ONLY when the file genuinely does not exist', () => {
    expect(tryReadCompletion('review-missing', dir)).toBeNull();
    expect(() => readCompletion('review-missing', dir)).toThrow(/no completion record for "review-missing"/);
  });
});
