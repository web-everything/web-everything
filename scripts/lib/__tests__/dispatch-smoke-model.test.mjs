import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runRealDispatchSmoke } from '../daemon-load-overlay.mjs';
import { DEFAULT_ROUTING_POLICY } from '../dispatch-routing-policy.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('overlay smoke model pin', () => {
  it.each([true, false])('pins the cheapest Claude policy alias (haiku available=%s)', async (haiku) => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    if (!haiku) delete policy.aliases.claude.haiku;
    const spawn = vi.fn(() => ({ status: 1, stderr: 'stop after capturing launch' }));
    const diagnosticsDir = mkdtempSync(join(tmpdir(), 'smoke-model-diag-'));
    dirs.push(diagnosticsDir);
    const result = await runRealDispatchSmoke({ tree: '/tree', env: {}, routingPolicy: policy, spawn, log: { error: vi.fn() }, diagnosticsDir });
    dirs.push(result.scratch);
    expect(spawn.mock.calls[0][1][7]).toBe(haiku ? policy.aliases.claude.haiku : policy.aliases.claude.sonnet);
  });

  it('the subprocess harness forwards the pinned model as a launch table', () => {
    const tree = mkdtempSync(join(tmpdir(), 'smoke-model-'));
    dirs.push(tree);
    mkdirSync(join(tree, 'scripts/operations'), { recursive: true });
    mkdirSync(join(tree, 'scripts/lib'), { recursive: true });
    writeFileSync(join(tree, 'scripts/operations/dispatch-lane-io.mjs'), `
      export const dispatchSessionCwd = () => ${JSON.stringify(tree)};
      export const ensureDispatchSessionCwd = p => p;
      export const resolveGhShimSettingsEnv = () => ({});
      export const defaultClaudeProvider = request => { console.log(JSON.stringify(request.table)); return 'fake'; };
    `);
    writeFileSync(join(tree, 'scripts/lib/dispatch-bg-isolation.mjs'), 'export const isolateDispatchSession = () => ({});');
    const stdout = execFileSync(process.execPath, [resolve('scripts/lib/dispatch-smoke-launch.mjs'),
      tree, 'fix-999998', 'fix', '999998', 'fake-id', 'smoke', DEFAULT_ROUTING_POLICY.aliases.claude.haiku], { encoding: 'utf8' });
    expect(JSON.parse(stdout.trim().split('\n')[0])).toMatchObject({ model: DEFAULT_ROUTING_POLICY.aliases.claude.haiku });
  });
});
