import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve filesystem paths before joining: Vite rewrites literal new URL(rel, import.meta.url)
// expressions as browser asset URLs under happy-dom, which Node's file readers cannot use.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const settingsPath = resolve(here, '../fixtures/lean-hooks-claude-settings.json');

// Dispatch tests exercise argv and lifecycle plumbing without an operator HOME or pinned clone.
// Keep the real hook parser, guard inventory and target-file validation; only supply fixture roots.
// Security tests use the unmocked reader and independently exercise missing/invalid settings.
export function withLeanRepairSettingsFixture(actual) {
  return {
    ...actual,
    LEAN_FIX_HOOKS_SETTINGS: () => actual.LEAN_FIX_HOOKS_SETTINGS(settingsPath, {
      repoRoot, guardRoot: repoRoot,
    }),
  };
}
