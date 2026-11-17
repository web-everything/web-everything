/**
 * @file scripts/operations/__tests__/dispatch-claude-provider-completion-reset.test.mjs
 * @description Regression test for #x2psfwz — `review-<PR>` / `fix-<PR>` / `ci-heal-<PR>` / `inspect-<PR>`
 *   session names carry no attempt suffix (session-slug.mjs's `mintSessionSlug` forbids one for every
 *   PR_KIND), so a round-2 dispatch for the same PR reuses the exact name round 1 used. Round 1's own agent
 *   brief wrote a completion record under that name (`status: done` at whichever exit it took, #3436). Left in
 *   place, any reader of that record would read round 2 as already finished before round 2 has even started —
 *   purely because it inherited round 1's name.
 *
 *   The fix: `defaultClaudeProvider` (the actual `claude --bg` spawn point) deletes any existing completion
 *   record for a PR_KIND session slug immediately before spawning — closing the window at its source, rather
 *   than relying on round 2's own agent brief to overwrite it later (a crash before that first action would
 *   leave round 1's stale `done` in place the whole time).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultClaudeProvider } from '../dispatch-lane-io.mjs';
import { newCompletionRecord, writeCompletion, completionPath } from '../completion-store.mjs';

let dir;
let prevCompletionsDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'completion-reset-'));
  // `defaultClaudeProvider`'s own `deleteCompletion` call resolves the sidecar via `resolveCompletionsDir()`
  // (env override or the real repo root) — point it at this test's throwaway dir, never the real sidecar.
  prevCompletionsDir = process.env.OPERATION_COMPLETIONS_DIR;
  process.env.OPERATION_COMPLETIONS_DIR = dir;
});

afterEach(() => {
  if (prevCompletionsDir === undefined) delete process.env.OPERATION_COMPLETIONS_DIR;
  else process.env.OPERATION_COMPLETIONS_DIR = prevCompletionsDir;
  rmSync(dir, { recursive: true, force: true });
});

const BANNER = (id, name) => `backgrounded · ${id} · ${name}\n`;

describe('#x2psfwz — defaultClaudeProvider resets a PR_KIND session\'s completion record at spawn time', () => {
  it('a round-2 dispatch for "review-1234" deletes round 1\'s stale done record BEFORE spawning', () => {
    const record = newCompletionRecord({ session: 'review-1234', kind: 'review', pr: 1234, now: () => '2026-09-24T10:00:00Z' });
    writeCompletion({ ...record, status: 'done', outcome: 'accept' }, dir);
    expect(existsSync(completionPath('review-1234', dir))).toBe(true);

    const handle = defaultClaudeProvider(
      { mode: 'ordinary', launchGuard: null, sessionId: 'minted-1', cwd: '/repo', prompt: '# go', sessionSlug: 'review-1234' },
      { spawnAgent: () => BANNER('abcd1234', 'review-1234') },
    );

    expect(handle).toBe('abcd1234');
    // THE FIX: round 1's stale completion record is gone before round 2's session ever starts.
    expect(existsSync(completionPath('review-1234', dir))).toBe(false);
  });

  it('every PR_KIND resets (review/fix/ci-heal/inspect), never an item-kind session (conveyor-/prepare- have no reuse problem to begin with)', () => {
    for (const [slug, kind] of [['fix-99', 'fix'], ['ci-heal-99', 'fix'], ['inspect-99', 'inspect']]) {
      writeCompletion({ ...newCompletionRecord({ session: slug, kind, pr: 99, now: () => '2026-09-24T10:00:00Z' }), status: 'done' }, dir);
      defaultClaudeProvider({ mode: 'ordinary', launchGuard: null, sessionId: 'm', cwd: '/repo', prompt: '# go', sessionSlug: slug }, { spawnAgent: () => BANNER('x', slug) });
      expect(existsSync(completionPath(slug, dir))).toBe(false);
    }

    // An item-kind session slug never had this ambiguity (mintSessionSlug's attempt suffix disambiguates
    // retries), and completion records are only ever written for review/fix/inspect kinds anyway (#3436) — but
    // the guard must still leave any (foreign/unrelated) file alone rather than assuming it may always delete.
    writeCompletion({ ...newCompletionRecord({ session: 'conveyor-500', kind: 'review', pr: null, item: 500, now: () => '2026-09-24T10:00:00Z' }), status: 'done' }, dir);
    defaultClaudeProvider({ mode: 'ordinary', launchGuard: null, sessionId: 'm', cwd: '/repo', prompt: '# go', sessionSlug: 'conveyor-500' }, { spawnAgent: () => BANNER('y', 'conveyor-500') });
    expect(existsSync(completionPath('conveyor-500', dir))).toBe(true);
  });

  it('no existing record for this name → still spawns cleanly, no error (the common, non-reuse case)', () => {
    expect(() =>
      defaultClaudeProvider({ mode: 'ordinary', launchGuard: null, sessionId: 'm', cwd: '/repo', prompt: '# go', sessionSlug: 'review-777' }, { spawnAgent: () => BANNER('z', 'review-777') }),
    ).not.toThrow();
  });
});
