import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const settingsPath = fileURLToPath(new URL('../fixtures/lean-hooks-claude-settings.json', import.meta.url));

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
