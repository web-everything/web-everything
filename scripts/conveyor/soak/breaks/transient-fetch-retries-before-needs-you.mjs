/**
 * @file breaks/transient-fetch-retries-before-needs-you.mjs — live break, 2026-11-20 12:28 ET.
 * An ssh connect blip failed one `git fetch` in overlay main sync and raised overlay-main-sync-needs-you
 * ("operator review required"); it recovered about a minute later.
 * FIX — `we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs` `retryGit`: a transient network class on `fetch`
 * is retried 3x with backoff (5/15/45 s) before escalating with the attempt count; auth and unknown errors
 * escalate at once.
 * RED = the transient failure escalates on the first attempt, an auth/unknown failure is retried, the delays
 *       are not 5/15/45 s, or exhausted retries do not escalate with the attempt count.
 * GREEN = two transient failures then success -> ok after 3 calls; auth/unknown -> 1 call; exhaustion ->
 *         4 calls, delays 5/15/45 s, escalation naming 4 attempts.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = `
const m = await import(process.argv[1]);
const fail = stderr => ({ status: 128, stdout: '', stderr });
const drive = (result, failures) => {
  const o = { calls: 0, sleeps: [], ok: false, message: '' };
  try { o.ok = m.retryGit(() => (++o.calls <= failures ? result : { status: 0, stdout: '', stderr: '' }), ['fetch'], {}, { gitBackoff: ms => o.sleeps.push(ms) }).status === 0; }
  catch (e) { o.message = String(e.message); }
  return o;
};
console.log(JSON.stringify({
  recover: drive(fail('ssh: Could not resolve host: x'), 2),
  auth: drive(fail('Permission denied (publickey).'), 99),
  unknown: drive(fail('fatal: something odd'), 99),
  exhaust: drive(fail('Connection reset by peer'), 99),
}));`;

function probe(root) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs')).href],
    { encoding: 'utf8', timeout: 30_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { return null; }
}
const recovers = o => !!o && o.recover.ok && o.recover.calls === 3;
const violations = o => !o ? ['retryGit is not reachable'] : [
  ...(recovers(o) ? [] : [`transient fetch not retried to success (calls=${o.recover.calls})`]),
  ...(o.auth.calls === 1 && !o.auth.ok ? [] : [`auth failure retried (calls=${o.auth.calls})`]),
  ...(o.unknown.calls === 1 && !o.unknown.ok ? [] : [`unknown failure retried (calls=${o.unknown.calls})`]),
  ...(o.exhaust.calls === 4 && JSON.stringify(o.exhaust.sleeps) === '[5000,15000,45000]' && /after 4 attempts/.test(o.exhaust.message)
    ? [] : [`exhausted retries wrong (calls=${o.exhaust.calls} sleeps=${o.exhaust.sleeps} message=${o.exhaust.message})`]),
];

export default {
  id: 'transient-fetch-retries-before-needs-you',
  title: 'a transient fetch failure retries with backoff before any needs-you',
  card: 'opportunity #31',
  fixedBy: { sha: 'HEAD', where: 'lane/transient-fetch-retry', paths: ['scripts/lib/daemon-rebuild/overlay-main-sync.mjs'] },
  // Presence is the recovery behaviour only; the remaining contract (auth/unknown/exhaustion) is judged by run().
  fixPresent(root) { return recovers(probe(root)); },
  async run() { return { violations: violations(probe(process.cwd())) }; },
  judge(report) { return report.violations; },
};
