/**
 * @file scripts/conveyor/__tests__/health-watch-heavy-run.test.mjs
 * @description heavy-enforce: the health-watch tick's `heavyRunSamples` probe wiring and its own per-tick sample
 *   append for the `heavy-run-ungated` smell. Same mocks as health-watch.test.mjs (real core and registry, the
 *   desktop-notify transport intercepted so a test run never pings the operator). Kept in its own file so it
 *   does not collide with sibling overlays appending to health-watch.test.mjs.
 */
import { it, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tick, healthDir } from '../../../../scripts/conveyor/health-watch.mjs';

const episodeReplay = ((fn) => fn())(() => ({ send: mock(() => ({ ok: true })) }));
const __actual0 = { ...(await import('../../../../scripts/conveyor/branch-sync.mjs')) };
mock.module('../../../../scripts/conveyor/branch-sync.mjs', () => ({
  ...__actual0, notifyDesktopChecked: episodeReplay.send,
}));

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-watch-heavy-run-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it('heavy-run history fixture reaches the detector without appending fixture observations', async () => {
  const flags = {
    'state-root': dir, 'logs-dir': join(dir, 'logs'), 'lock-root': join(dir, 'locks'),
    'self-sync-dir': join(dir, 'sync'), 'no-gh': true, 'no-diagnose': true,
    'ps-fixture': join(dir, 'ps.txt'), 'heavy-run-samples-file': join(dir, 'samples.jsonl'),
    now: '2026-10-04T00:10:00Z',
  };
  for (const key of ['logs-dir', 'lock-root', 'self-sync-dir']) mkdirSync(flags[key]);
  writeFileSync(flags['ps-fixture'], '10 1 0 00:01 claude\n11 10 0 00:01 vitest run x\n');
  const history = JSON.stringify({ at: '2026-10-04T00:09:00Z', count: 1, runs: [{ pid: 11, programName: 'claude', command: 'vitest run x' }] }) + '\n';
  writeFileSync(flags['heavy-run-samples-file'], history);
  const result = await tick(flags);
  expect(result.transitions.some((t) => t.type === 'opened' && t.key === 'heavy-run-ungated::host')).toBe(true);
  expect(readFileSync(flags['heavy-run-samples-file'], 'utf8')).toBe(history);
  expect(existsSync(join(healthDir(dir), 'heavy-run-samples.jsonl'))).toBe(false);
});

it('a process-probe tick appends its own observation after evaluation', async () => {
  const flags = {
    'state-root': dir, 'logs-dir': join(dir, 'logs'), 'lock-root': join(dir, 'locks'),
    'self-sync-dir': join(dir, 'sync'), 'no-gh': true, 'no-diagnose': true,
  };
  for (const key of ['logs-dir', 'lock-root', 'self-sync-dir']) mkdirSync(flags[key]);
  // Exercise the actual child-process transport without relying on sandbox permission to read host ps.
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "10 1 0 00:01 claude\\n11 10 0 00:01 vitest run x\\n"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try { await tick(flags); } finally { process.env.PATH = oldPath; }
  const lines = readFileSync(join(healthDir(dir), 'heavy-run-samples.jsonl'), 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toMatchObject({ at: expect.any(String), count: 1, runs: [{ pid: 11, programName: 'claude', command: 'vitest run x' }] });
});
