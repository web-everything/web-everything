/**
 * @file git-run.test.mjs — proof for `parseIsShallow` / `ensureFullHistory`, the fix for the live PR #2752
 *   incident: a shallow checkout that fetches a brand-new ref inherits the shallow boundary onto it, so a
 *   later `git merge-tree` between that ref and a fully-deepened `base` fails `fatal: refusing to merge
 *   unrelated histories` — a checkout defect, not a real conflict. See `git-run.mjs#ensureFullHistory`'s own
 *   header for the full incident and the live before/after evidence gathered against the real branch.
 */
import { describe, it, expect, vi } from 'vitest';
import { gitRun, parseIsShallow, ensureFullHistory } from '../git-run.mjs';

describe('gitRun', () => {
  it('kills a timed-out command and reports failure with the timeout and first argument', () => {
    const r = gitRun('sleep', ['5'], { timeoutMs: 200 });
    expect(r.status).not.toBe(0);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/timed out/);
    expect(r.stderr).toContain('git timed out after 200ms');
    expect(r.stderr).toContain('5');
  }, 10000);

  it('passes stdin through without changing bytes and preserves success', () => {
    const input = Buffer.from([0, 255, 10, 65]);
    const r = gitRun(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input, encoding: 'buffer' });
    expect(r).toEqual({ status: 0, stdout: input, stderr: '' });
  });

  it('preserves a command failure status and stderr', () => {
    const r = gitRun(process.execPath, ['-e', 'process.stderr.write("failed"); process.exit(7)']);
    expect(r).toEqual({ status: 7, stdout: '', stderr: 'failed' });
  });

  it.each([
    [undefined, 180000], ['250', 250], ['0', 180000], ['-1', 180000],
    ['', 180000], ['invalid', 180000], ['Infinity', 180000],
  ])('resolves WE_GIT_RUN_TIMEOUT_MS=%s to %s', async (value, expected) => {
    vi.stubEnv('WE_GIT_RUN_TIMEOUT_MS', value);
    vi.resetModules();
    try {
      const { GIT_RUN_TIMEOUT_MS } = await import('../git-run.mjs');
      expect(GIT_RUN_TIMEOUT_MS).toBe(expected);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('parseIsShallow', () => {
  it("exit 0, stdout 'true' → true", () => {
    expect(parseIsShallow('true\n', 0)).toBe(true);
  });
  it("exit 0, stdout 'false' → false", () => {
    expect(parseIsShallow('false\n', 0)).toBe(false);
  });
  it('non-zero exit → null (inconclusive, never treated as shallow)', () => {
    expect(parseIsShallow('', 128)).toBeNull();
  });
  it('unparseable stdout at exit 0 → null', () => {
    expect(parseIsShallow('garbage', 0)).toBeNull();
  });
});

// A scripted `run` keyed on the git subcommand (args[0]), mirroring the pattern already established in
// rebase-drop-manifest.test.mjs / rebase-drop-content.test.mjs.
function scriptedRun(script) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const handler = script[args[0]];
    const res = typeof handler === 'function' ? handler(args, opts) : handler;
    return { status: 0, stdout: '', stderr: '', ...(res || {}) };
  };
  return { run, calls };
}

describe('ensureFullHistory', () => {
  it('not shallow → no unshallow fetch is attempted', () => {
    const { run, calls } = scriptedRun({ 'rev-parse': { stdout: 'false\n' } });
    const r = ensureFullHistory(run, { cwd: '/repo' });
    expect(r).toEqual({ ok: true, wasShallow: false, unshallowed: false });
    expect(calls.map((c) => c.args[0])).toEqual(['rev-parse']); // no fetch call at all
  });
  it('shallow → unshallows via `git fetch <remote> --unshallow`', () => {
    const { run, calls } = scriptedRun({ 'rev-parse': { stdout: 'true\n' }, fetch: { status: 0 } });
    const r = ensureFullHistory(run, { cwd: '/repo', remote: 'origin' });
    expect(r).toEqual({ ok: true, wasShallow: true, unshallowed: true });
    expect(calls[1]).toEqual({ cmd: 'git', args: ['fetch', 'origin', '--unshallow', '--quiet'], cwd: '/repo' });
  });
  it('shallow but the unshallow fetch itself fails → reported, not thrown', () => {
    const { run } = scriptedRun({
      'rev-parse': { stdout: 'true\n' },
      fetch: { status: 1, stderr: 'fatal: Could not read from remote repository.\n' },
    });
    const r = ensureFullHistory(run, { cwd: '/repo' });
    expect(r).toEqual({
      ok: false, wasShallow: true,
      reason: 'fetch --unshallow failed (fatal: Could not read from remote repository.)',
    });
  });
  it('an inconclusive shallow probe (non-zero exit) is treated as not shallow — never loops an unshallow attempt', () => {
    const { run, calls } = scriptedRun({ 'rev-parse': { status: 1, stderr: 'git: command not found' } });
    const r = ensureFullHistory(run, { cwd: '/repo' });
    expect(r).toEqual({ ok: true, wasShallow: false, unshallowed: false });
    expect(calls).toHaveLength(1);
  });
});
