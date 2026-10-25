import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildReadyArgs, createDraftPromoteProvider } from '../draft-promote-provider.mjs';
import { runGhSync } from '../gh-throttle.mjs';

vi.mock('../gh-throttle.mjs', () => ({ runGhSync: vi.fn() }));

describe('draft-promote-provider (draft-first PRs)', () => {
  it('buildReadyArgs is exactly `gh pr ready <pr>`, pr coerced to a string', () => {
    expect(buildReadyArgs(42)).toEqual(['pr', 'ready', '42']);
    expect(buildReadyArgs('42')).toEqual(['pr', 'ready', '42']);
  });

  it('the adapter shells buildReadyArgs through the injected exec and hands its result straight back', () => {
    const seen = [];
    const provider = createDraftPromoteProvider({ cwd: '/repo', exec: (args) => { seen.push(args); return 'ok'; } });
    expect(provider.ready(42)).toBe('ok');
    expect(seen).toEqual([['pr', 'ready', '42']]);
  });

  describe('exec role isolation', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.mocked(runGhSync).mockReset();
    });

    it('the default exec explicitly passes worker in a copied env when the process role is observer', () => {
      vi.stubEnv('WE_GITHUB_APP_ROLE', 'observer');
      const originalEnv = process.env;
      const before = { ...process.env };
      vi.mocked(runGhSync).mockReturnValue('ready\n');
      const provider = createDraftPromoteProvider({ cwd: '/repo', repo: 'example/project' });

      expect(provider.ready(42)).toBe('ready');
      expect(runGhSync).toHaveBeenCalledTimes(1);
      const [args, opts] = vi.mocked(runGhSync).mock.calls[0];
      expect(args).toEqual(['pr', 'ready', '42', '--repo', 'example/project']);
      expect(process.env).toBe(originalEnv);
      expect(process.env).toEqual(before);
      expect(opts.env?.WE_GITHUB_APP_ROLE).toBe('worker');
      expect(opts.env).not.toBe(process.env);
      expect(opts.env).toEqual({ ...before, WE_GITHUB_APP_ROLE: 'worker' });
    });

    it('leaves a custom injected exec and its observer process env unaffected', () => {
      vi.stubEnv('WE_GITHUB_APP_ROLE', 'observer');
      const originalEnv = process.env;
      const before = { ...process.env };
      const exec = vi.fn(() => {
        expect(process.env).toBe(originalEnv);
        expect(process.env).toEqual(before);
        return 'custom output\n';
      });
      const provider = createDraftPromoteProvider({ cwd: '/repo', repo: 'example/project', exec });

      expect(provider.ready(42)).toBe('custom output\n');
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(['pr', 'ready', '42', '--repo', 'example/project']);
      expect(runGhSync).not.toHaveBeenCalled();
      expect(process.env).toBe(originalEnv);
      expect(process.env).toEqual(before);
    });
  });


  it('is named "gh", matching the sibling forge-land-provider adapter', () => {
    expect(createDraftPromoteProvider({ exec: () => '' }).name).toBe('gh');
  });

  // we:backlog/x4ua3v8 — the cwd-inferred-repo fix: a caller that KNOWS the PR's repo (the multi-repo daemon
  // path) must be able to pin it explicitly rather than let `gh` infer it from `cwd`'s git remote.
  it('buildReadyArgs appends --repo <repo> when a repo is given, byte-identical when omitted', () => {
    expect(buildReadyArgs(42, 'plateauapp/plateau-app')).toEqual(['pr', 'ready', '42', '--repo', 'plateauapp/plateau-app']);
    expect(buildReadyArgs(42, undefined)).toEqual(['pr', 'ready', '42']);
    expect(buildReadyArgs(42, null)).toEqual(['pr', 'ready', '42']);
  });

  it('the adapter threads its bound repo through to every ready() call', () => {
    const seen = [];
    const provider = createDraftPromoteProvider({
      cwd: '/repo', repo: 'frontier-ui/frontierui', exec: (args) => { seen.push(args); return 'ok'; },
    });
    expect(provider.ready(7)).toBe('ok');
    expect(seen).toEqual([['pr', 'ready', '7', '--repo', 'frontier-ui/frontierui']]);
  });
  describe('ready() exec error diagnostics', () => {
    const command = 'Command failed: gh pr ready 42 --repo example/project';

    function readyError(original) {
      const provider = createDraftPromoteProvider({
        repo: 'example/project',
        exec: () => { throw original; },
      });
      try {
        provider.ready(42);
      } catch (error) {
        return error;
      }
      throw new Error('Expected ready() to throw');
    }

    it('puts stderr after the original command on the first line, preferring it over stdout', () => {
      const original = Object.assign(new Error(`${command}\noriginal trailing detail`), {
        stderr: 'GraphQL: Resource not accessible by integration',
        stdout: 'irrelevant stdout',
      });
      const error = readyError(original);
      expect(error.message.split('\n')[0]).toBe(`${command}: ${original.stderr}`);
    });

    it('keeps the original error as cause and preserves stderr and exit status', () => {
      const original = Object.assign(new Error(command), { stderr: 'permission denied', status: 1 });
      const error = readyError(original);
      expect(error).not.toBe(original);
      expect(error.cause).toBe(original);
      expect(error.stderr).toBe(original.stderr);
      expect(error.status).toBe(1);
    });

    it.each([undefined, ''])('falls back to stdout when stderr is %j', (stderr) => {
      const original = Object.assign(new Error(command), { stderr, stdout: 'stdout failure detail' });
      expect(readyError(original).message.split('\n')[0]).toBe(`${command}: stdout failure detail`);
    });

    it('bounds 5000-character stderr to at most 400 detail characters plus an ellipsis', () => {
      const original = Object.assign(new Error(command), { stderr: 'x'.repeat(5000) });
      const firstLine = readyError(original).message.split('\n')[0];
      expect(firstLine.startsWith(`${command}: `)).toBe(true);
      const detail = firstLine.slice(`${command}: `.length);
      expect(detail).toMatch(/^x{1,400}(?:…|\.\.\.)$/u);
    });

    it('collapses multiline stderr and repeated whitespace into one first-line diagnostic', () => {
      const original = Object.assign(new Error(command), {
        stderr: ' \n GraphQL:\t permission   denied\r\n  for this repository \n ',
      });
      expect(readyError(original).message.split('\n')[0])
        .toBe(`${command}: GraphQL: permission denied for this repository`);
    });

    it.each(['ghp', 'gho', 'ghu', 'ghs', 'ghr', 'github_pat'])(
      'redacts %s tokens from stderr and fallback stdout diagnostics', (prefix) => {
        const token = `${prefix}_Synthetic_123abc`;
        for (const stream of ['stderr', 'stdout']) {
          const original = Object.assign(new Error(command), { [stream]: `denied token ${token} for repository` });
          const firstLine = readyError(original).message.split('\n')[0];
          expect(firstLine).toMatch(/^Command failed: .*: denied token .+ for repository$/);
          expect(firstLine).not.toContain(token);
          expect(firstLine).not.toContain('Synthetic_123abc');
        }
      },
    );

    it.each(['ghp', 'gho', 'ghu', 'ghs', 'ghr', 'github_pat'])(
      'redacts a %s token straddling the 400-character boundary before bounding diagnostics', (prefix) => {
        const token = `${prefix}_Synthetic_123abc`;
        for (const stream of ['stderr', 'stdout']) {
          // Only the first two token characters fit before the truncation boundary.
          const original = Object.assign(new Error(command), {
            [stream]: `${'x'.repeat(397)} ${token} ${'y'.repeat(5000)}`,
          });
          const message = readyError(original).message;
          expect(message.startsWith(`${command}: `)).toBe(true);
          const detail = message.slice(`${command}: `.length);
          expect(message).not.toContain(token);
          expect(detail).not.toContain(`${prefix}_`);
          expect(detail).not.toContain(token.slice(0, 2));
          expect(detail.length).toBeLessThanOrEqual(401);
          expect(detail).toBe(`${'x'.repeat(397)} <r…`);
        }
      },
    );

    it('redacts a token glued to a preceding word character', () => {
      const original = Object.assign(new Error(command), { stderr: 'credential_ghp_Synthetic_123abc rejected' });
      const message = readyError(original).message;
      expect(message).not.toContain('Synthetic_123abc');
    });

    it.each([{}, { stderr: '', stdout: '' }])(
      'rethrows the identical original error unchanged when no output is available (%j)', (output) => {
        const original = Object.assign(new Error(`${command}\noriginal trailing detail`), output, { status: 2 });
        const before = Object.getOwnPropertyDescriptors(original);
        expect(readyError(original)).toBe(original);
        expect(Object.getOwnPropertyDescriptors(original)).toEqual(before);
      },
    );

    it.each(['', 'ready\n'])('returns successful exec output %j unchanged', (output) => {
      const seen = [];
      const provider = createDraftPromoteProvider({
        repo: 'example/project', exec: (args) => { seen.push(args); return output; },
      });
      expect(provider.ready(42)).toBe(output);
      expect(seen).toEqual([['pr', 'ready', '42', '--repo', 'example/project']]);
    });
  });
});
