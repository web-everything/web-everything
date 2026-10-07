import { it, expect, afterEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const __actual0 = { ...(await import('node:child_process')) };
mock.module('node:child_process', () => {
  const actual = __actual0;
  const execFileSync = mock(() => '[]');
  return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
});
import { execFileSync } from 'node:child_process';
const __actual1 = { ...(await import('../../../../scripts/lib/gh-throttle.mjs')) };
mock.module('../../../../scripts/lib/gh-throttle.mjs', () => ({ ...__actual1, execFileSyncThrottled: (...args) => execFileSync(...args) }));
import { main } from '../../../../scripts/operations/operator-queue.mjs';
import { CONSTELLATION_REPOS } from '../../../../scripts/lib/constellation-repos.mjs';
import { recordUnsupported } from '../../../../scripts/conveyor/unsupported-repo.mjs';

afterEach(() => { mock.restore(); mock.clearAllMocks(); });
it('reports owed unsupported work in text and JSON and uses the constellation slugs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-unsupported-'));
  const unsupportedPath = join(dir, 'rows.json');
  const row = { kind: 'unsupported-repo', prNumber: 49, action: 'fix', why: 'WE-only worker.' };
  try {
    recordUnsupported({ repo: 'plateau-app', rows: [row], path: unsupportedPath });
    const log = spyOn(console, 'log').mockImplementation(() => {});
    main(['--json'], { unsupportedPath });
    expect(execFileSync.mock.calls.map(([, args]) => args[3])).toEqual(Object.values(CONSTELLATION_REPOS).map(({ slug }) => slug));
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ ready: [], rulingNeeded: [], pending: [], notReady: [], stoodDown: [], stuck: [], errors: [], unsupported: [{ ...row, repo: 'plateau-app', at: expect.any(String) }], laneDecisions: [], backpressure: [], reconcileNotes: [] });
    log.mockClear();
    main([], { unsupportedPath });
    expect(log.mock.calls.flat()).toContain('UNSUPPORTED REPO — owed work the conveyor cannot dispatch for this repo:');
    expect(log.mock.calls.flat()).toContain('plateau-app#49  fix  WE-only worker.');
    log.mockClear();
    main(['--repo=frontier-ui/frontierui', '--json'], { unsupportedPath });
    expect(JSON.parse(log.mock.calls[0][0]).unsupported).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
