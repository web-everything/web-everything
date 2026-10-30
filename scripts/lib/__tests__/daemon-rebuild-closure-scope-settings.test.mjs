import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { daemonRebuildSettingsPath, resolveClosureScopeMode } from '../daemon-rebuild/closure-scope-settings.mjs';
import { resolveSkipUnrelated } from '../daemon-rebuild/skip-unrelated.mjs';

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = join(libDir, 'daemon-rebuild-settings.json');
let scratch;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

it('resolves the shipped settings to a filesystem path under the Vite transform', () => {
  expect(daemonRebuildSettingsPath()).toBe(settingsPath);
  expect(JSON.parse(readFileSync(daemonRebuildSettingsPath(), 'utf8'))).toHaveProperty('closureScope');
});

it('both default policy readers load shipped settings without a caller path override', () => {
  scratch = mkdtempSync(join(tmpdir(), 'closure-settings-'));
  const env = { WE_PLATFORM_PREFERENCES_FILE: join(scratch, 'absent.json') };
  expect(resolveClosureScopeMode(env)).toEqual({ mode: 'shadow', source: 'tool' });
  expect(resolveSkipUnrelated(env)).toBe(true);
});

it('native Node resolves settings relative to the module from an unrelated working directory', () => {
  scratch = mkdtempSync(join(tmpdir(), 'closure-settings-'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { daemonRebuildSettingsPath } from ${JSON.stringify(pathToFileURL(join(libDir, 'daemon-rebuild/closure-scope-settings.mjs')).href)};
    process.stdout.write(daemonRebuildSettingsPath());
  `], { cwd: scratch, encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(settingsPath);
});
