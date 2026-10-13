/**
 * @file scripts/lib/__tests__/git-grep-gate.test.mjs
 * @description runGitGrepGate (#4490): only git grep's exit 1 means "no match"; every other outcome is a
 * failed scan that is emitted, never reported clean. `run` is injected, so no real git is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { runGitGrepGate } from '../git-grep-gate.mjs';

const failWith = (props, message = 'boom') => () => { throw Object.assign(new Error(message), props); };

describe('runGitGrepGate', () => {
  it('exit status 1 is a genuine no-match: ok, no lines, emit never called', () => {
    const emit = vi.fn();
    const r = runGitGrepGate('x', { run: failWith({ status: 1 }), emit, kind: 'k' });
    expect(r).toEqual({ ok: true, lines: [] });
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    ['status 128', { status: 128 }],
    ['status 2', { status: 2 }],
    ['ENOBUFS with no status', { code: 'ENOBUFS' }],
    ['git missing (ENOENT)', { code: 'ENOENT' }],
  ])('%s is a failed scan: emitted once with the kind, ok:false, never clean', (_n, props) => {
    const emit = vi.fn();
    const r = runGitGrepGate('x', { run: failWith(props), emit, kind: 'my-kind', file: 'f.mjs', label: 'gate X' });
    expect(r).toEqual({ ok: false, lines: [] });
    expect(emit).toHaveBeenCalledTimes(1);
    const [msg, meta] = emit.mock.calls[0];
    expect(meta).toEqual({ kind: 'my-kind', file: 'f.mjs', global: true });
    expect(msg).toMatch(/gate X.*INCOMPLETE/);
  });

  it('success: lines split on newline, blanks dropped; pathspecs after `--`, pattern after `-e`', () => {
    const run = vi.fn(() => 'a:1:x\n\nb:2:y\n');
    const r = runGitGrepGate('pat', { run, emit: vi.fn(), kind: 'k', pathspecs: ['.', ':!node_modules'], cwd: '/c' });
    expect(r).toEqual({ ok: true, lines: ['a:1:x', 'b:2:y'] });
    const [cmd, args, opts] = run.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args.slice(args.indexOf('--'))).toEqual(['--', '.', ':!node_modules']);
    expect(opts.cwd).toBe('/c');
    expect(opts.maxBuffer).toBeGreaterThan(0);
  });

  it('a pattern starting with `-` follows `-e`, never parsed as an option', () => {
    const run = vi.fn(() => '');
    runGitGrepGate('-foo', { run, emit: vi.fn(), kind: 'k' });
    const args = run.mock.calls[0][1];
    expect(args[args.indexOf('-e') + 1]).toBe('-foo');
    expect(args.indexOf('-e')).toBeLessThan(args.indexOf('--'));
  });

  it('the failure note keeps only the first line of a multi-line error message', () => {
    const emit = vi.fn();
    runGitGrepGate('x', { run: failWith({ status: 128 }, 'first line\nSECRET second\nthird'), emit, kind: 'k' });
    const msg = emit.mock.calls[0][0];
    expect(msg).toContain('first line');
    expect(msg).not.toMatch(/SECRET|third/);
  });
});
