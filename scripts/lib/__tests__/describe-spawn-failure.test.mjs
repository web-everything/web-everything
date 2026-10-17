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

  // PR #5472 red team: opaque credential values (no token shape) are redacted by position and by name.
  it('redacts a whole --settings object however it is nested or quoted', () => {
    for (const s of [`--settings {"worktree":{"a":"b"},"env":{"X":"opaque1"}} tail`, `--settings '{"env":{"X":"opaque1"}}' tail`,
      `--settings={"env":{"S":"{\\"a\\":{}}","X":"opaque1"}} tail`]) {
      expect(redactSpawnText(s, { env: {} })).toBe('--settings <redacted> tail');
    }
  });
  it('redacts every value of an env object, whatever the key is called', () => {
    expect(redactSpawnText('{"env":{"WHATEVER":"opaque1"},"ok":1}', { env: {} })).toBe('{"env":"<redacted>","ok":1}');
  });
  it('keeps JSON-encoded text parseable when it redacts inside it', () => {
    const text = JSON.stringify({ error: 'x --settings {"env":{"A":"opaque1"}} y', inner: 'z {"env":{"A":"opaque1"}}' });
    const out = redactSpawnText(text, { env: {} });
    expect(out).not.toContain('opaque1');
    expect(() => JSON.parse(out)).not.toThrow();
  });
  it('redacts credential-named values in shell, JSON, header and URL forms', () => {
    const out = redactSpawnText([
      'GH_TOKEN=opaque1', 'export ANTHROPIC_API_KEY=opaque2', '{"api_key":"opa\\"que3"}', 'Authorization: Basic opaque4',
      'https://u:opaque5@host/x', 'password: opaque6', 'KEY_ID=opaque7',
    ].join(' '), { env: {} });
    expect(out).not.toMatch(/opaque|que3/);
  });
  it("redacts the literal value of this process's own credential-named env vars", () => {
    expect(redactSpawnText('child said: s3cretValue!!', { env: { SOME_SECRET: 's3cretValue!!' } })).toBe('child said: <redacted-env>');
  });
  it('covers the flag, URL-username, deep-escape, env-array and shell-quoting variants', () => {
    const out = redactSpawnText([
      '{"Authorization":"Basic opaque1"}', 'AUTHORIZATION=opaque2', '--token opaque3 --verbose', 'https://opaque4@github.com/o/r',
      '\\\\\\"GH_TOKEN\\\\\\":\\\\\\"opaque5\\\\\\"', '\\"GH_TOKEN\\":\\"x\\\\\\"opaque6\\"', '"env":[{"name":"FOO","value":"opaque7"}]',
      '{"name":"GH_TOKEN","value":"opaque8"}', 'A_TOKEN=`x opaque9`', "B_TOKEN=$'x opaqueA'", "C_TOKEN='it'\\''s opaqueB'",
    ].join('\n'), { env: {} });
    expect(out).not.toMatch(/opaque/);
    expect(out).toContain('--verbose');
  });
  it('redacts a whole credential header value, every cookie included, without eating a JSON string close', () => {
    expect(redactSpawnText('request failed; Cookie: theme=light; session=opaque1', { env: {} })).toBe('request failed; Cookie: <redacted>');
    expect(redactSpawnText("curl -H 'Set-Cookie: sid=opaque2; Path=/' https://h", { env: {} })).toBe("curl -H 'Set-Cookie: <redacted>' https://h");
    const json = JSON.stringify({ error: 'x Cookie: a=1; s=opaque3\nnext', ok: 1 });
    const out = redactSpawnText(json, { env: {} });
    expect(out).not.toContain('opaque3');
    expect(JSON.parse(out)).toEqual({ error: 'x Cookie: <redacted>\nnext', ok: 1 });
  });
  it('redacts every cookie-list form: quoted values, flags, env, curl -b, folding, arrays, escapes, URL encoding', () => {
    const q = "'";
    const inputs = ['Cookie: a="1"; s=opaque1', JSON.stringify({ e: 'Cookie: a="1"; s=opaque2', ok: 1 }), 'curl --cookie a=1;s=opaque3 https://h',
      'COOKIE=a=1;s=opaque4 next', `curl -sS -b ${q}a=1; s=opaque5${q} https://h`, `${q}Cookie: a=1; it${q}\\${q}${q}s=opaque6${q}`,
      'Cookie: a=1;\r\n  s=opaque7\r\nnext: ok', JSON.stringify([['Cookie', 'a=1; s=opaque8']]), JSON.stringify({ e: 'Cookie: a=1\\; s=opaque9' }),
      'GET /x?h=Cookie%3Aa%3D1%3B%20s%3DopaqueA&z=1', JSON.stringify(['claude', '--token', 'opaqueB', '--model', 'x'])];
    for (const text of inputs) {
      const out = redactSpawnText(text, { env: {} });
      expect(out).not.toContain('opaque');
      if (/^[[{]/.test(text)) expect(() => JSON.parse(out)).not.toThrow();
    }
    for (const text of ['COOKIE=a=1; s=opaqueC next', `curl -b${q}a=1; s=opaqueD${q} https://h`, 'x-api-key: "opaqueE"',
      JSON.stringify({ e: 'x-api-key: "opaqueF"', ok: 1 }), 'Authorization: Bearer "opaqueG" x']) {
      const out = redactSpawnText(text, { env: {} });
      expect(out).not.toContain('opaque');
      if (/^[[{]/.test(text)) expect(() => JSON.parse(out)).not.toThrow();
    }
    // A header value ending in a space never reads its JSON string's closing quote as an opening one.
    expect(redactSpawnText('{"e":"Cookie: a ","ok":1}', { env: {} })).toBe('{"e":"Cookie: <redacted>","ok":1}');
    expect(redactSpawnText('the cookie consent banner', { env: {} })).toBe('the cookie consent banner');
    expect(redactSpawnText('["gh","auth","login"]', { env: {} })).toBe('["gh","auth","login"]');
    expect(redactSpawnText('git checkout -b lane/x failed', { env: {} })).toBe('git checkout -b lane/x failed');
    expect(redactSpawnText(JSON.stringify({ e: 'x', ok: 1, list: ['a', 'b'] }), { env: {} })).toBe('{"e":"x","ok":1,"list":["a","b"]}');
  });
  it('keeps the key it redacts, and leaves effect keys and token counts alone', () => {
    expect(redactSpawnText('{"GH_TOKEN":"opaque1","key":"dispatch:3794","input_tokens":55}', { env: {} }))
      .toBe('{"GH_TOKEN":"<redacted-env>","key":"dispatch:3794","input_tokens":55}');
    expect(redactSpawnText('"env":["GH_TOKEN=x"],"next":1', { env: {} })).toBe('"env":"<redacted>","next":1');
  });
  it('stays linear on long adversarial text', () => {
    const started = Date.now();
    for (const text of ['a.'.repeat(100000), 'a='.repeat(100000), 'a://'.repeat(50000), '"a":'.repeat(50000), '--settings {"'.repeat(20000),
      ' '.repeat(300000), ' -b'.repeat(100000), 'cookie '.repeat(45000), 'Cookie: ="'.repeat(30000), 'Cookie: =\\\\"'.repeat(30000)]) {
      redactSpawnText(text, { env: {} });
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('still reaches a credential that follows a non-credential name', () => {
    expect(redactSpawnText('Command failed: GH_TOKEN=opaque1 claude', { env: {} })).toBe('Command failed: GH_TOKEN=<redacted> claude');
  });
  it('leaves ordinary words alone', () => {
    const text = 'author: me, keyboard monkey; session name "fix-3794" is already in use';
    expect(redactSpawnText(text, { env: {} })).toBe(text);
  });
});
