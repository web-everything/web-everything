import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { withFixtureEnv } from './fixtures/with-fixture-env.mjs';

describe('withFixtureEnv', () => {
  const header = '#!/usr/bin/env node\n';
  const body = '\nconsole.log(JSON.stringify({ first: process.env.FIXTURE_FIRST, second: process.env.FIXTURE_SECOND }));\n';

  it.each([
    ['ordinary paths', '/tmp/fixture/pr.json'],
    ['replacement metacharacters', "/tmp/$&/$`/$'/$$/pr.json"],
    ['quotes, backslashes and multiple newlines', '/tmp/"quoted"/\\path\nfirst\nsecond\r\t/pr.json'],
  ])('round-trips %s through an executable shim', (_, value) => {
    const source = header + body;
    const generated = withFixtureEnv(source, { FIXTURE_FIRST: value, FIXTURE_SECOND: value });
    expect(generated.startsWith(header)).toBe(true);
    expect(generated.endsWith(body)).toBe(true);
    // Execute the generated JavaScript: values must survive serialization and insertion literally.
    const result = spawnSync(process.execPath, ['-'], {
      input: generated, encoding: 'utf8', timeout: 5000,
      env: { FIXTURE_FIRST: 'stale', FIXTURE_SECOND: 'stale' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ first: value, second: value });
  });

  it.each(['console.log("no shebang");\n', '#!/usr/bin/env node'])('rejects a missing or unterminated shebang: %j', source => {
    expect(() => withFixtureEnv(source, { FIXTURE_FIRST: 'value' })).toThrow('newline-terminated shebang');
  });
});
