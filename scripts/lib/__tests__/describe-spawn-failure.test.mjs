import { describe, it, expect } from 'vitest';
import { describeSpawnFailure, describeDispatchFailure, redactSpawnText } from '../describe-spawn-failure.mjs';

const settings = '{"env":{"PATH":"/Users/x/.claude/github-app-token/gh-shim.d/abc:/usr/bin","GH_TOKEN":"ghs_abcdefghijklmnop123456"}}';
const spawnError = (extra = {}) => Object.assign(
  new Error(`Command failed: claude --bg -n fix-3794 --settings ${settings} --model sonnet # Conveyor fix-agent brief\nsecond brief line\nreal stderr line`),
  { status: 1, stderr: 'Error: session name "fix-3794" is already in use\nrun `claude agents`\n', stdout: '', ...extra },
);

describe('describeSpawnFailure', () => {
  it('names the exit code and the stderr tail, never the argv, brief or settings JSON', () => {
    const out = describeSpawnFailure(spawnError(), { label: 'claude --bg' });
    expect(out).toBe('claude --bg failed (exit 1): Error: session name "fix-3794" is already in use | run `claude agents`');
    expect(out).not.toMatch(/--settings|Conveyor|gh-shim|\n/);
  });
  it('redacts tokens that appear in stderr, and any settings JSON', () => {
    const out = describeSpawnFailure(spawnError({ stderr: `bad --settings ${settings} with ghp_ABCDEFGHIJKLMNOP1234 and Bearer abcdefghijkl1234` }));
    expect(out).not.toMatch(/ghs_|ghp_|gh-shim|abcdefghijkl1234/);
    expect(out).toContain('<redacted');
  });
  it('reports a signal or a code when there is no exit status, and falls back to stdout', () => {
    expect(describeSpawnFailure({ signal: 'SIGKILL', message: 'spawnSync claude ETIMEDOUT', code: 'ETIMEDOUT' })).toBe('spawn failed (signal SIGKILL, code ETIMEDOUT): spawnSync claude ETIMEDOUT');
    expect(describeSpawnFailure({ code: 'ENOENT', message: 'spawnSync claude ENOENT' })).toContain('code ENOENT');
    expect(describeSpawnFailure(spawnError({ stderr: '', stdout: 'only stdout' }))).toContain('only stdout');
  });
  it('never falls back to a `Command failed: <argv>` message', () => {
    expect(describeSpawnFailure(spawnError({ stderr: '', stdout: '' }))).toBe('spawn failed (exit 1): no output');
  });
  it('caps a long stderr to its tail', () => {
    const out = describeSpawnFailure(spawnError({ stderr: `${'a'.repeat(5000)} END` }), { maxChars: 50 });
    expect(out.length).toBeLessThan(120);
    expect(out).toMatch(/END$/);
  });
  it('keeps the CLI phrases the daemon-log parsers match', () => {
    expect(describeSpawnFailure(spawnError({ stderr: 'Workspace not trusted. Run `claude` in /x once' }))).toMatch(/workspace not trusted/i);
  });
});

describe('describeDispatchFailure', () => {
  it('uses the spawn description for a spawn error and the first line for any other error', () => {
    expect(describeDispatchFailure(spawnError())).toMatch(/^claude --bg failed \(exit 1\): Error: session name/);
    expect(describeDispatchFailure(new Error('lane-9 lost its race\nstack'))).toBe('lane-9 lost its race');
    expect(describeDispatchFailure('plain')).toBe('plain');
  });
});

describe('redactSpawnText', () => {
  it('is a no-op on clean text', () => { expect(redactSpawnText('nothing secret')).toBe('nothing secret'); });
});
