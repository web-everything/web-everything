import { describe, it, expect } from 'vitest';
import { buildReadyArgs, createDraftPromoteProvider } from '../draft-promote-provider.mjs';

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
