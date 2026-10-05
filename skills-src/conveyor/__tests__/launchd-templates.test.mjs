import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const templates = [root, join(root, 'launchd')].flatMap((dir) =>
  readdirSync(dir).filter((name) => /^com\.we\..*\.plist\.example$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') })));
const environment = (text) => text.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? '';
const envFor = (name) => environment(templates.find((template) => template.name === name)?.text ?? '');

describe('launchd templates', () => {
  it('pins the restart interval in every daemon environment', () => {
    expect(templates.length).toBeGreaterThanOrEqual(10);
    for (const { name, text } of templates) {
      expect(environment(text), name).toMatch(/<key>WE_DAEMON_RESTART_MIN_INTERVAL_MS<\/key>\s*<string>120000<\/string>/);
    }
  });

  it('pins the load-flake reverify settings', () => {
    const env = envFor('com.we.conveyor-pass-daemon.load-flake-reverify.plist.example');
    expect(env).toMatch(/<key>WE_LOAD_FLAKE_REVERIFY_MAX_LOAD_PER_CORE<\/key>\s*<string>1\.25<\/string>/);
    expect(env).toMatch(/<key>WE_LOAD_FLAKE_REVERIFY_MODE<\/key>\s*<string>ci<\/string>/);
  });

  it('pins the verify settings', () => {
    const env = envFor('com.we.verify-daemon.plist.example');
    expect(env).toMatch(/<key>WE_VERIFY_RELATED<\/key>\s*<string>import-only<\/string>/);
    expect(env).toMatch(/<key>WE_VERIFY_TEST_TIMEOUT_FACTOR<\/key>\s*<string>3<\/string>/);
  });

  it('keeps private key paths as placeholders', () => {
    for (const { name, text } of templates) {
      expect(text.replaceAll('&lt;path-to-private-key.pem&gt;', ''), name).not.toMatch(/\.pem</);
      expect(text, name).not.toContain('/.secrets/');
    }
  });
});
