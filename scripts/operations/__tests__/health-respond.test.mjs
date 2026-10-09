// @vitest-environment node
import { it, expect } from 'vitest';
import { makeGitOverlay } from '../../lib/hermetic-git-overlay.mjs';
import { DEFAULT_REPO_ROOT } from '../../lib/hermetic-tests.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLatestDecisions } from '../../conveyor/health-responder-state.mjs';
import { healthRespondOperation } from '../health-respond.mjs';
import { createRegistry, isReadOnlyOperation } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
it('prints the same read-only decision feed for a human/Plateau with no effect or run writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'health-feed-'));
  try {
    const dir = join(root, '.conveyor', 'health-responder'); mkdirSync(dir, { recursive: true });
    const records = Array.from({ length: 60 }, (_, i) => ({ episodeId: `episode-${i}`, rule: 'disabled', decision: 'hold' }));
    const file = join(dir, 'decisions.jsonl'), text = records.map((r) => JSON.stringify(r) + '\n').join('');
    writeFileSync(file, text);
    const declaration = healthRespondOperation({ readDecisions: () => readLatestDecisions({ stateRoot: root }) });
    expect(isReadOnlyOperation(declaration)).toBe(true);
    const registry = createRegistry(); registry.register(declaration);
    const result = await runOperationCli({ declaration, registry, argv: ['--json'], store: createMemoryRunStore(), sinks: {}, newRunId: () => 'memory-only-health-feed' });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.lines.join('\n')).verdict.records).toEqual(records.slice(-50));
    expect(readFileSync(file, 'utf8')).toBe(text); expect(readdirSync(dir)).toEqual(['decisions.jsonl']);
    writeFileSync(file, text + '{'); expect(readLatestDecisions({ stateRoot: root }).error).toMatch(/partial/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('is registered in the common operation CLI', async () => {
  const { OPERATIONS } = await import('../run.mjs');
  expect(OPERATIONS['health-respond']).toBeTypeOf('function');
}, 60_000); // the first dynamic import of the whole operations registry can exceed the 5s default on a loaded host

it('real CLI prints the feed without writing the state root or operation bookkeeping', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = mkdtempSync(join(tmpdir(), 'health-feed-cli-'));
  // origin/main pinned to HEAD in a git overlay: the runner-freshness check stays local.
  const overlay = makeGitOverlay(DEFAULT_REPO_ROOT);
  try {
    const dir = join(root, '.conveyor', 'health-responder'); mkdirSync(dir, { recursive: true });
    const row = { episodeId: 'replay-D1', smell: 'draft-not-promoted', subject: 'fixture/repo#1', decision: 'hold', rule: 'disabled', inputs: {}, reason: 'disabled', result: 'not-submitted' };
    const text = JSON.stringify(row) + '\n'; writeFileSync(join(dir, 'decisions.jsonl'), text);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../run.mjs', import.meta.url)), 'health-respond', '--json'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, ...overlay.env, CONVEYOR_STATE_ROOT: root, OPERATIONS_RUNS_DIR: join(root, 'runs'), OPERATIONS_CALL_LOG_DIR: join(root, 'calls') },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout).verdict.records).toEqual([row]);
    expect(readdirSync(root)).toEqual(['.conveyor']);
    expect(readdirSync(dir)).toEqual(['decisions.jsonl']); expect(readFileSync(join(dir, 'decisions.jsonl'), 'utf8')).toBe(text);
  } finally { overlay.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
