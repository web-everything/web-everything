/**
 * @file scripts/operations/__tests__/command-redact.test.mjs
 * @description Tests for `command-redact.mjs#redactCommandLine` — PR #2220 review (security): a host process's
 * full argv is persisted to the durable telemetry NDJSON and printed by `telemetry-cli report`, so
 * credential-shaped values must be masked and control characters neutralised before either happens.
 */
import { describe, it, expect } from 'vitest';

import { REDACTED, redactCommandLine } from '../command-redact.mjs';

describe('redactCommandLine — credential-shaped argv values are masked, identity is kept', () => {
  const cases = [
    ['--flag=value', 'node tool.mjs --token=abc123SECRET --verbose', 'abc123SECRET', `node tool.mjs --token=${REDACTED} --verbose`],
    ['--flag value', 'node tool.mjs --api-key abc123SECRET --verbose', 'abc123SECRET', `node tool.mjs --api-key ${REDACTED} --verbose`],
    ['quoted flag value with spaces', 'run --password="hunter 2 trombone" go', 'hunter 2 trombone', `run --password=${REDACTED} go`],
    ['env assignment', 'GITHUB_TOKEN=abc123SECRET node build.mjs', 'abc123SECRET', `GITHUB_TOKEN=${REDACTED} node build.mjs`],
    ['Authorization header (quoted)', "curl -H 'Authorization: Bearer abc123SECRET' https://x.test", 'abc123SECRET', `curl -H 'Authorization: ${REDACTED}' https://x.test`],
    ['bare Bearer', 'curl -H "X-Auth: Bearer abc123SECRETvalue" https://x.test', 'abc123SECRETvalue', `curl -H "X-Auth: Bearer ${REDACTED}" https://x.test`],
    ['URL user:pass', 'psql postgres://admin:hunter2Trombone@db.internal/app', 'hunter2Trombone', `psql postgres://admin:${REDACTED}@db.internal/app`],
    ['URL lone token userinfo', 'git clone https://ghp_abcdefghijklmnop1234@github.com/o/r', 'ghp_abcdefghijklmnop1234', `git clone https://${REDACTED}@github.com/o/r`],
    ['known-prefix token in a bare argument', 'node x.mjs sk-abcdefghijklmnopqrstuv', 'sk-abcdefghijklmnopqrstuv', `node x.mjs ${REDACTED}`],
  ];
  for (const [name, input, secret, expected] of cases) {
    it(`masks: ${name}`, () => {
      const out = redactCommandLine(input);
      expect(out).not.toContain(secret);
      expect(out).toBe(expected);
    });
  }

  it('leaves an ordinary command line untouched (identity is the point of keeping argv)', () => {
    const plain = '/Applications/Spotify.app/Contents/MacOS/Spotify Helper --type=gpu-process --no-sandbox';
    expect(redactCommandLine(plain)).toBe(plain);
    expect(redactCommandLine('git -C /w/lane-3 log --oneline -5')).toBe('git -C /w/lane-3 log --oneline -5');
  });

  it('does not swallow the next FLAG as the value of a valueless credential-named flag', () => {
    expect(redactCommandLine('tool --no-auth --verbose')).toBe('tool --no-auth --verbose');
  });

  it('is idempotent — redacting an already-redacted line changes nothing', () => {
    const once = redactCommandLine("curl --token=abc123SECRET -H 'Authorization: Bearer xyz98765432' postgres://u:pw12345678@h/d");
    expect(redactCommandLine(once)).toBe(once);
  });

  it('replaces C0/C1 control characters (ANSI/OSC escapes, BEL, NUL, CR) so a crafted title cannot drive a terminal', () => {
    const out = redactCommandLine('node a.mjs \u001b[2J\u001b]0;pwned\u0007 x\u0000y\r\n\u009b');
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(out).toContain('node a.mjs');
  });

  it('a secret is masked BEFORE any caller truncation — masking a straddling value cannot leave half of it', () => {
    const line = `${'x'.repeat(470)} --token=SECRETSECRETSECRET`;
    expect(redactCommandLine(line).slice(0, 480)).not.toContain('SECRET');
  });

  it('is total on non-string / hostile input', () => {
    for (const junk of [undefined, null, 42, {}, [], '']) expect(() => redactCommandLine(junk)).not.toThrow();
    expect(redactCommandLine(undefined)).toBe('');
    expect(redactCommandLine(null)).toBe('');
  });
});


// PR #2220 finding 3: both the input cap and linear matching protect the resident tick path.
import { performance } from 'node:perf_hooks';
import { MAX_REDACT_INPUT } from '../command-redact.mjs';

describe('redactCommandLine — finding 3 bounded, linear work', () => {
  const shapes = ['token', 'a.', 'token ', '--token ', 'Bearer ', 'authorization ', '://', 'x', 'eyJaaaaaaaaaaa-'];
  for (const length of [MAX_REDACT_INPUT, 4 * MAX_REDACT_INPUT]) {
    for (const shape of shapes) {
      it(`time budget: ${JSON.stringify(shape)} at ${length} characters`, () => {
        const input = 'node ' + shape.repeat(Math.ceil(length / shape.length)).slice(0, length - 5);
        expect(input).toHaveLength(length);
        const start = performance.now();
        const result = redactCommandLine(input);
        const elapsed = performance.now() - start;
        expect(typeof result).toBe('string');
        expect(elapsed).toBeLessThan(250);
      });
    }
  }

  it('exports the 4096-character cap and leaves exactly-at-cap ordinary input intact', () => {
    expect(MAX_REDACT_INPUT).toBe(4096);
    const input = 'x'.repeat(MAX_REDACT_INPUT);
    expect(redactCommandLine(input)).toBe(input);
  });

  it('drops the final 256 characters if the cap window contains no whitespace', () => {
    const result = redactCommandLine('x'.repeat(MAX_REDACT_INPUT * 4));
    expect(result).toBe('x'.repeat(MAX_REDACT_INPUT - 256) + '…');
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(MAX_REDACT_INPUT + 1);
  });

  it('retreats to the last whitespace so a Bearer token straddling the cap leaves no prefix', () => {
    const prefix = 'x'.repeat(MAX_REDACT_INPUT - 12) + ' Bearer';
    const result = redactCommandLine(prefix + ' abcdefghijklSECRET');
    expect(result).toBe(prefix + '…');
    expect(result).not.toContain('abcd');
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(MAX_REDACT_INPUT + 1);
  });
});

describe('redactCommandLine — finding 4 colon headers and controls', () => {
  it.each([
    ['quoted X-Api-Key', 'curl -H "X-Api-Key: abc123SECRET" https://x.test', ['abc123SECRET'], 'curl -H "X-Api-Key: [REDACTED]" https://x.test'],
    ['unquoted X-Api-Key', 'curl -H X-Api-Key: abc123SECRET https://x.test', ['abc123SECRET'], 'curl -H X-Api-Key: [REDACTED] https://x.test'],
    ['quoted Cookie', 'curl -H "Cookie: session=abc123SECRET; theme=dark" https://x.test', ['abc123SECRET', 'theme=dark'], 'curl -H "Cookie: [REDACTED]" https://x.test'],
    ['unquoted Cookie', 'Cookie: session=abc123SECRET; theme=dark', ['abc123SECRET', 'theme=dark'], 'Cookie: [REDACTED]'],
    ['Set-Cookie', "Set-Cookie: session=abc123SECRET; Path=/; HttpOnly", ['abc123SECRET', 'HttpOnly'], 'Set-Cookie: [REDACTED]'],
    ['Proxy-Authorization Basic', 'Proxy-Authorization: Basic abc123SECRET', ['abc123SECRET'], 'Proxy-Authorization: [REDACTED]'],
    ['X-Auth-Token', 'X-Auth-Token: abc123SECRET', ['abc123SECRET'], 'X-Auth-Token: [REDACTED]'],
    ['vertical tab in value', '--token=abc\x0bdef', ['abc', 'def'], '--token=[REDACTED]'],
    ['form feed in value', '--token=abc\x0cdef', ['abc', 'def'], '--token=[REDACTED]'],
    ['NUL in name', '--to\x00ken=SECRET', ['SECRET'], '--to?ken=[REDACTED]'],
    ['NUL in spaced name', '--to\x00ken SECRET', ['SECRET'], '--to?ken [REDACTED]'],
    ['NUL in header name', 'X-Api-K\x00ey: abc123SECRET', ['abc123SECRET'], 'X-Api-K?ey: [REDACTED]'],
    ['ANSI in value', '--token=a\x1b[31mSECRET', ['SECRET', '[31m'], '--token=[REDACTED]'],
    ['short header scheme token', 'X-Auth: Bearer abc', ['abc'], 'X-Auth: [REDACTED]'],
    ['later sensitive header', 'Content-Type: application/json X-Api-Key: abc123SECRET', ['abc123SECRET'], 'Content-Type: application/json X-Api-Key: [REDACTED]'],
  ])('masks %s', (_name, input, secrets, expected) => {
    const result = redactCommandLine(input);
    for (const secret of secrets) expect(result).not.toContain(secret);
    expect(result).toBe(expected);
    expect(redactCommandLine(result)).toBe(result);
  });

  it.each([
    'node build.mjs --verbose',
    'Content-Type: application/json',
    'Accept: text/html',
    'node build.mjs --output=dist --format json',
  ])('leaves non-sensitive input untouched: %s', (input) => {
    expect(redactCommandLine(input)).toBe(input);
  });
});
