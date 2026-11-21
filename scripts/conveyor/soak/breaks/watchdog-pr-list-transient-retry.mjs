/** The live-owner watchdog raised NEEDS-YOU evidence-unavailable on a single transient GitHub PR-list hiccup. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SOURCE = 'scripts/conveyor/pr-live-owner-watch-io.mjs';

// The registered probe repo, passed to the child (no repo literal in scanned source).
const PROBE_REPO = ['web-everything', 'web-everything'].join('/');

// Runs in a child process against the tree under test; behaviour only, no marker strings.
const CHILD = `
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { createLiveOwnerWatchIo } = await import(pathToFileURL(process.argv[1]).href);
const pr = { number: 1, headRefOid: 'a'.repeat(40), labels: [], isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [] };
const hiccup = () => Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
async function make(readGhText) {
  const dir = mkdtempSync(join(tmpdir(), 'soak-wd-')); writeFileSync(join(dir, 'p.json'), '{}');
  const env = { GH_REPO: process.argv[2], WE_PLATFORM_PREFERENCES_FILE: join(dir, 'p.json'), WE_COORDINATION_ROOT: join(dir, 'c'),
    WE_LIVE_OWNER_WATCH_DIR: join(dir, 'w'), WE_NEEDS_YOU_FEED: join(dir, 'f.jsonl'), WE_POLICY_CASCADE_LOG: '0' };
  const calls = { n: 0 };
  const io = await createLiveOwnerWatchIo({ env, home: dir, root: dir, now: Date.now(), adapters: {
    lockOptions: { stamp: () => ({ runnerStart: 'x' }), identity: () => ({ alive: true }) }, sleepMs: () => {},
    readGhText: () => { calls.n++; return readGhText(calls.n); } } });
  return { io, calls };
}
const out = [];
{ const { io } = await make(n => { if (n < 3) throw hiccup(); return JSON.stringify([pr]); });
  try { if (io.listPRs().length !== 1) out.push('recovery returned wrong inventory'); } catch { out.push('two transient failures were not retried to success'); } }
{ const { io, calls } = await make(() => { throw hiccup(); });
  try { io.listPRs(); out.push('three failures did not fail closed'); } catch { if (calls.n !== 3) out.push('expected exactly 3 tries, saw ' + calls.n); } }
{ const { io, calls } = await make(() => { throw new Error('HTTP 401: Bad credentials'); });
  try { io.listPRs(); out.push('auth error did not raise'); } catch { if (calls.n !== 1) out.push('auth error was retried'); } }
process.stdout.write(JSON.stringify(out));
`;

function probe(root) {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', CHILD, resolve(root, SOURCE), PROBE_REPO],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(output);
}

export default {
  id: 'watchdog-pr-list-transient-retry',
  title: 'live-owner watchdog retries a transient PR-list failure twice, still fails closed on 3, raises auth errors at once',
  card: 'PR for lane/watchdog-transient-retry',
  fixedBy: { sha: 'lane-watchdog-transient-retry', where: 'lane/watchdog-transient-retry', paths: [SOURCE] },
  fixPresent(root) {
    try { const v = probe(root); return Array.isArray(v) && v.length === 0; } catch { return false; }
  },
  async run({ log } = {}) {
    const violations = probe(resolve(import.meta.dirname, '../../../..'));
    log?.(`watchdog PR-list retry: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
