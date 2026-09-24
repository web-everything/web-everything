import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const execFileSync = vi.fn(() => '[]');
  return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
});
import { execFileSync } from 'node:child_process';
import { main } from '../operator-queue.mjs';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';
import { recordUnsupported } from '../../conveyor/unsupported-repo.mjs';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it('reports owed unsupported work in text and JSON and uses the constellation slugs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-unsupported-'));
  const unsupportedPath = join(dir, 'rows.json');
  const row = { kind: 'unsupported-repo', prNumber: 49, action: 'fix', why: 'WE-only worker.' };
  try {
    recordUnsupported({ repo: 'plateau-app', rows: [row], path: unsupportedPath });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    main(['--json'], { unsupportedPath });
    expect(execFileSync.mock.calls.map(([, args]) => args[3])).toEqual(Object.values(CONSTELLATION_REPOS).map(({ slug }) => slug));
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ ready: [], pending: [], notReady: [], stoodDown: [], stuck: [], errors: [], unsupported: [{ ...row, repo: 'plateau-app', at: expect.any(String) }], laneDecisions: [] });
    log.mockClear();
    main([], { unsupportedPath });
    expect(log.mock.calls.flat()).toContain('UNSUPPORTED REPO — owed work the conveyor cannot dispatch for this repo:');
    expect(log.mock.calls.flat()).toContain('plateau-app#49  fix  WE-only worker.');
    log.mockClear();
    main(['--repo=chalbert/frontierui', '--json'], { unsupportedPath });
    expect(JSON.parse(log.mock.calls[0][0]).unsupported).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
