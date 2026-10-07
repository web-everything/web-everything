/**
 * @file #4077 — the operator queue's HEALTH section (`--with-health`): printed FIRST, its first line the health
 *   watch's last-tick-completed age, read from the health store under the pinned state root (#4052).
 */
import { it, expect, afterEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const __actual0 = { ...(await import('node:child_process')) };
mock.module('node:child_process', () => {
  const actual = __actual0;
  const execFileSync = mock(() => '[]');
  return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
});
import { main } from '../../../../scripts/operations/operator-queue.mjs';

const saved = process.env.CONVEYOR_STATE_ROOT;
afterEach(() => {
  mock.restore(); mock.clearAllMocks();
  if (saved === undefined) delete process.env.CONVEYOR_STATE_ROOT; else process.env.CONVEYOR_STATE_ROOT = saved;
});

it('prints HEALTH first (last-tick age, then open episodes) with --with-health, and nothing without it', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-health-'));
  const unsupportedPath = join(root, 'rows.json');
  try {
    const dir = join(root, '.conveyor', 'health');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(dir, 'last-tick.json'), JSON.stringify({ completedAt: now - 3 * 60_000, durationMs: 900, mode: 'shadow' }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: { 'clone-stale::clone:k': {
      key: 'clone-stale::clone:k', smell: 'clone-stale', subject: 'clone:k', status: 'open', severity: 'high',
      openedAt: now - 10 * 60_000, id: 'x', recommendation: 'fix the smoke gate',
    } } }));
    process.env.CONVEYOR_STATE_ROOT = root;
    const log = spyOn(console, 'log').mockImplementation(() => {});
    main(['--with-health'], { unsupportedPath });
    const first = log.mock.calls[0][0].split('\n');
    expect(first[0]).toMatch(/^HEALTH — last health tick completed 3m ago \(shadow mode, 1 open episode\(s\)\)$/);
    expect(first[1]).toMatch(/\[high\] clone-stale {2}clone:k {2}open 10m — fix the smoke gate/);
    log.mockClear();
    main(['--with-health', '--json'], { unsupportedPath });
    expect(JSON.parse(log.mock.calls[0][0]).health[0]).toMatch(/^HEALTH — last health tick completed 3m ago/);
    log.mockClear();
    main([], { unsupportedPath });
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/HEALTH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
