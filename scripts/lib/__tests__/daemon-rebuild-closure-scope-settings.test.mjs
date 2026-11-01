// @vitest-environment happy-dom
// Keep Vite's browser asset transformation active using the repository's declared DOM runner.
import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonRebuildSettingsPath, resolveClosureScopeMode, resolveSkipUnrelated } from '../daemon-rebuild/skip-unrelated.mjs';
import { resolveWrongBranchHealSettings } from '../daemon-rebuild/wrong-branch-heal.mjs';

const root = mkdtempSync(join(tmpdir(), 'closure-scope-settings-'));
const env = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'absent.json') };
const expectedPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon-rebuild-settings.json');
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('default rebuild settings resolve to the module-relative filesystem path in a DOM environment', () => {
  expect(document.defaultView).toBe(window);
  expect(daemonRebuildSettingsPath()).toBe(expectedPath);
  expect(JSON.parse(readFileSync(daemonRebuildSettingsPath(), 'utf8')).closureScope).toEqual({ mode: 'shadow' });
});

it('default rebuild settings supply tool provenance without a path override', () => {
  expect(resolveClosureScopeMode(env)).toEqual({ mode: 'shadow', source: 'tool' });
  expect(resolveClosureScopeMode({ ...env, WE_DAEMON_CLOSURE_SCOPE: 'on' })).toEqual({ mode: 'off', source: 'env' });
});

it('default rebuild settings remain usable through skip and wrong-branch callers', () => {
  expect(resolveSkipUnrelated(env)).toBe(true);
  expect(resolveSkipUnrelated({ ...env, WE_DAEMON_REBUILD_SKIP_UNRELATED: 'false' })).toBe(false);
  const read = vi.fn(() => JSON.stringify({ wrongBranchHeal: { branches: ['ops/test'], pathPrefixes: ['store/'] } }));
  expect(resolveWrongBranchHealSettings({ read })).toEqual({ branches: ['ops/test'], pathPrefixes: ['store/'] });
  expect(read).toHaveBeenCalledWith(expectedPath);
  expect(resolveWrongBranchHealSettings({ read: () => '{' })).toEqual({
    branches: ['ops/review-requests'], pathPrefixes: ['verdict-ledger/'],
  });
});
