// Native bun:test setup for the bun-trial slice (backlog xkd7crs). Mirrors vitest.setup.ts WITHOUT any
// vitest API: plain bun:test hooks, loaded through bunfig.toml `[test] preload`. vitest stays the gate.
import { beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runner-neutral stand-in for what vitest sets automatically: production guards still key off VITEST.
process.env.VITEST ??= 'true';
// hermetic git (mirrors vitest.shared.ts#hermeticGitEnv)
{
  const config = join(tmpdir(), 'we-test-gitconfig');
  const contents = '[user]\n\tname = WE Test\n\temail = test@example.invalid\n';
  if (!existsSync(config) || readFileSync(config, 'utf8') !== contents) writeFileSync(config, contents);
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}

const owned: Array<{ dir: string; envKey?: string }> = [];
function ownedTmpDir(prefix: string, envKey?: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  owned.push({ dir, envKey });
  return dir;
}
afterAll(() => {
  for (const { dir, envKey } of owned.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
    if (envKey && process.env[envKey] === dir) delete process.env[envKey];
    if (process.env.PATH?.startsWith(`${dir}:`)) process.env.PATH = process.env.PATH.slice(dir.length + 1);
  }
});

if (process.env.WE_TEST_SANDBOX !== '0') {
  const fakeGhDir = ownedTmpDir('we-fake-gh-');
  const fakeGhPath = join(fakeGhDir, 'gh');
  writeFileSync(fakeGhPath,
    '#!/bin/sh\necho "To get started with GitHub CLI, please run:  gh auth login" >&2\n'
    + 'echo "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token." >&2\nexit 1\n');
  chmodSync(fakeGhPath, 0o755);
  process.env.PATH = `${fakeGhDir}:${process.env.PATH || ''}`;
  for (const key of Object.keys(process.env)) {
    if (key === 'WE_TELEMETRY') continue;
    if (['WE_', 'CONVEYOR_', 'GH_', 'CLAUDE_'].some((p) => key.startsWith(p))) delete process.env[key];
  }
  // the hermetic git vars above start with GIT_, not stripped
}
process.env.WE_UNDER_TEST = '1';

const ownsCoordinationRoot = process.env.WE_COORDINATION_ROOT === undefined;
let testCoordinationRoot: string | undefined;
if (ownsCoordinationRoot) process.env.WE_COORDINATION_ROOT = ownedTmpDir('we-coord-test-', 'WE_COORDINATION_ROOT');
if (process.env.WE_GH_THROTTLE_LOCK_ROOT === undefined) process.env.WE_GH_THROTTLE_LOCK_ROOT = ownedTmpDir('we-gh-throttle-test-', 'WE_GH_THROTTLE_LOCK_ROOT');
if (process.env.WE_DAEMON_STATE_DIR === undefined) process.env.WE_DAEMON_STATE_DIR = ownedTmpDir('we-daemon-state-test-', 'WE_DAEMON_STATE_DIR');
if (process.env.CONVEYOR_NO_LEGACY_QUEUE === undefined) process.env.CONVEYOR_NO_LEGACY_QUEUE = '1';
if (process.env.WE_TELEMETRY === undefined) process.env.WE_TELEMETRY = '0';

let envSnapshot: Record<string, string | undefined> | undefined;
beforeEach(() => {
  envSnapshot = { ...process.env };
  if (ownsCoordinationRoot) {
    testCoordinationRoot = mkdtempSync(join(tmpdir(), 'we-coord-test-'));
    process.env.WE_COORDINATION_ROOT = testCoordinationRoot;
  }
});
afterEach(() => {
  if (testCoordinationRoot) rmSync(testCoordinationRoot, { recursive: true, force: true });
  if (!envSnapshot) return;
  for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key];
  for (const [key, value] of Object.entries(envSnapshot)) if (process.env[key] !== value) process.env[key] = value;
  envSnapshot = undefined;
});
