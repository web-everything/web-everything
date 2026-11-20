/**
 * @file breaks/transient-fetch-retries-before-needs-you.mjs — live break, 2026-11-20 12:28 ET.
 * An ssh connect blip failed one `git fetch` in overlay main sync and raised overlay-main-sync-needs-you
 * ("operator review required"); it recovered about a minute later.
 * FIX — `we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs` `retryGit`: a transient network class on `fetch`
 * is retried 3x with backoff (5/15/45 s) before escalating; auth and unknown errors escalate at once.
 * RED = the transient failure escalates on the first attempt (or an auth failure is retried).
 * GREEN = two transient failures then success returns ok after 3 calls; an auth failure is called once.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = `
const m = await import(process.argv[1]);
const out = { transientCalls: 0, authCalls: 0, transientOk: false, authThrew: false };
const mk = (stderr, key, failures) => (args) => (++out[key] <= failures ? { status: 128, stdout: '', stderr } : { status: 0, stdout: '', stderr: '' });
try { out.transientOk = m.retryGit(mk('ssh: Could not resolve host: x', 'transientCalls', 2), ['fetch'], {}, { gitBackoff() {} }).status === 0; } catch {}
try { m.retryGit(mk('Permission denied (publickey).', 'authCalls', 99), ['fetch'], {}, { gitBackoff() {} }); } catch { out.authThrew = true; }
console.log(JSON.stringify(out));`;

function probe(root) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs')).href],
    { encoding: 'utf8', timeout: 30_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { return null; }
}
const violations = o => !o ? ['retryGit is not reachable'] : [
  ...(o.transientOk && o.transientCalls === 3 ? [] : [`transient fetch not retried to success (calls=${o.transientCalls})`]),
  ...(o.authThrew && o.authCalls === 1 ? [] : [`auth failure retried or swallowed (calls=${o.authCalls})`]),
];

export default {
  id: 'transient-fetch-retries-before-needs-you',
  title: 'a transient fetch failure retries with backoff before any needs-you',
  card: 'opportunity #31',
  fixedBy: { sha: 'HEAD', where: 'lane/transient-fetch-retry', paths: ['scripts/lib/daemon-rebuild/overlay-main-sync.mjs'] },
  fixPresent(root) { return violations(probe(root)).length === 0; },
  async run() { return { violations: violations(probe(process.cwd())) }; },
  judge(report) { return report.violations; },
};
