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

  it('keeps verify defaults in the settings file and only distinct overrides in the template', () => {
    const template = templates.find(({ name }) => name === 'com.we.verify-daemon.plist.example').text;
    const env = envFor('com.we.verify-daemon.plist.example');
    expect(template).not.toContain('WE_VERIFY_RELATED');
    expect(template).not.toContain('WE_VERIFY_TEST_TIMEOUT_FACTOR');
    expect(template).toContain('scripts/verify-settings.json');
    expect(env).not.toContain('WE_VERIFY_STANDARDS');
    const settings = JSON.parse(readFileSync(join(root, '../../scripts/verify-settings.json'), 'utf8'));
    const keys = { relatedMode: 'WE_VERIFY_RELATED', testTimeoutFactor: 'WE_VERIFY_TEST_TIMEOUT_FACTOR',
      standards: 'WE_VERIFY_STANDARDS', phaseAdmission: 'WE_VERIFY_PHASE_ADMISSION', fastTargets: 'WE_VERIFY_FAST_TARGETS',
      matchRequestVariants: 'WE_VERIFY_MATCH_REQUEST_VARIANTS', supersede: 'WE_VERIFY_SUPERSEDE', restartInFlight: 'WE_VERIFY_RESTART_IN_FLIGHT',
      runAllPhases: 'WE_VERIFY_RUN_ALL_PHASES', isolatedRetry: 'WE_VERIFY_ISOLATED_RETRY',
      relatedMaxTests: 'WE_VERIFY_RELATED_MAX_TESTS', relatedDepth: 'WE_VERIFY_RELATED_DEPTH', alwaysRunTests: 'WE_VERIFY_ALWAYS_RUN_TESTS',
      skipLocalForCardOnly: 'WE_VERIFY_SKIP_LOCAL_FOR_CARD_ONLY' };
    const overrides = Object.fromEntries([...env.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)]
      .map(([, key, value]) => [key, value]));
    for (const [key, value] of Object.entries(settings)) {
      expect(keys[key], `unmapped setting ${key}`).toBeDefined();
      const serialized = typeof value === 'boolean' ? (value ? '1' : '0') : Array.isArray(value) ? value.join(',') : String(value);
      expect(overrides[keys[key]], key).not.toBe(serialized);
    }
  });

  it('keeps private key paths as placeholders', () => {
    for (const { name, text } of templates) {
      expect(text.replaceAll('&lt;path-to-private-key.pem&gt;', ''), name).not.toMatch(/\.pem</);
      expect(text, name).not.toContain('/.secrets/');
    }
  });
});
