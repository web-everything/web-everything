/** Effects remain outside FlowEngine; overlay add owns the admission decision. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiptGuard, auditGuard, ciDefinitionGuard, resolveHotpatchKnobs } from '../../hotpatch-guards.mjs';
import { createHotpatchReaders } from '../../hotpatch-readers.mjs';
import { laneHistoryProofEnv, scrubGitRepoEnv } from '../../lane-git-hardening.mjs';
import { execFileSyncThrottled } from '../../gh-throttle.mjs';
import { ensureFreshGithubAppEnv } from '../../github-app-auth-env.mjs';
import { resolveOriginRepository } from '../../../operations/prototype-retire.mjs';
import { netDiffFingerprint } from '../../net-diff-fingerprint.mjs';
import { resolveDaemonKey } from '../../../operations/prototype-load.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fallback = 'Escalate to the operator: restore readable evidence or use the normal merge path.';
const result = outcome => ({ outcome, ...(outcome === 'unknown' ? { escalate: true, fallback } : {}) });
export function hardenedGit({ exec = execFileSync, env = process.env, cwd = root } = {}) {
  const gitEnv = { ...laneHistoryProofEnv(scrubGitRepoEnv(env)), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const run = args => String(exec('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 30000, maxBuffer: 2097152 })).trim();
  return { run, verify(sha) {
    if (run(['replace', '-l'])) throw Error('replace objects refuse hotpatch proof');
    const graft = run(['rev-parse', '--git-path', 'info/grafts']);
    if (fs.existsSync(resolve(cwd, graft))) throw Error('grafts refuse hotpatch proof');
    if (run(['rev-parse', '--verify', `${sha}^{commit}`]) !== sha) throw Error('commit mismatch');
  } };
}
export function createHotpatchAdapter(io) {
  const policy = async () => {
    const p = resolveHotpatchKnobs(await io.readers.settings());
    if (p.invalid.length) throw Error('invalid hotpatch policy');
    return p.value;
  };
  const read = async (run, guard) => {
    try {
      if (guard === 'receipt') return result((await receiptGuard(run.sha, io.readers)).outcome);
      if (guard === 'audit') return result((await auditGuard(run.sha, io.readers)).outcome);
      if (guard === 'pinned') return result(await io.pinned(run) ? 'pass' : 'unknown');
      if (guard === 'loaded') {
        if (!await io.pinned(run)) return result('unknown');
        return result((await io.list(run)).some(r => r.ref === `hotpatch/${run.sha}`) ? 'pass' : 'wait');
      }
      if (guard === 'live') { const o = await io.live(run); return result(['pass', 'fail', 'superseded'].includes(o) ? o : 'unknown'); }
      const pr = await io.pr(run.pr);
      if (pr.state !== 'open' || pr.head.sha !== run.sha) return result(guard === 'ready' ? 'superseded' : 'fail');
      if (pr.head.repo.full_name !== io.repo || !/^[a-f0-9]{40}$/.test(pr.head.sha)) return result('fail');
      if (guard === 'intake') return result((await ciDefinitionGuard(run.sha, io.readers)).outcome);
      if (guard !== 'ready') throw Error('unknown guard');
      const evidence = await Promise.all([read(run, 'receipt'), read(run, 'audit'), ciDefinitionGuard(run.sha, io.readers)]);
      const outcome = ['unknown', 'fail', 'wait'].find(o => evidence.some(r => r.outcome === o)) ?? 'pass';
      return result(outcome);
    } catch { return result('unknown'); }
  };
  return { io, policy, read, async perform(run, step) {
    if (step === 'pin') return io.pin(run);
    if (step === 'audit') return io.audit(run); // Output is never evidence.
    if (step === 'load') {
      if ((await read(run, 'ready')).outcome !== 'pass') throw Error('readiness changed; escalate and re-evaluate');
      return io.add(run); // Existing guarded prototype registration path, no rebuild/adoption.
    }
    if (step === 'unload') {
      if ((await read(run, 'live')).outcome !== 'fail') throw Error('unload not authorized');
      return io.remove(run);
    }
    throw Error('undeclared effect');
  } };
}
export async function productionAdapter({ env = { ...process.env }, exec = execFileSync, authenticate = ensureFreshGithubAppEnv } = {}) {
  env.WE_GH_DAEMON_CALLER = 'hot-patch.mjs';
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const auth = await authenticate({ env, daemon: true, perOwner: true, caller: 'hot-patch.mjs' });
  if (!auth.applied) throw Error('App identity unavailable; restore App authentication before retrying');
  const git = hardenedGit({ exec, env }); let calls = 0;
  const boundedExec = (cmd, args, opts) => {
    if (cmd === 'gh' && ++calls > 100) throw Error('API budget exceeded; operator must retry with complete bounded evidence');
    return exec(cmd, args, cmd === 'git' ? { ...opts, env: { ...laneHistoryProofEnv(scrubGitRepoEnv(opts.env)), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } } : opts);
  };
  const gh = args => ({ code: 0, stdout: String(execFileSyncThrottled('gh', args, { cwd: root, env, encoding: 'utf8', timeout: 30000,
    maxBuffer: 2097152, throttle: { caller: 'hot-patch.mjs', exec: (a, o) => boundedExec('gh', a, o) } })) });
  const origin = resolveOriginRepository({ git: args => ({ code: 0, stdout: git.run(args) }), gh });
  if (!origin.repo) throw Error('origin unavailable');
  const api = args => { const r = origin.gh(['api', ...args]); if (r.code) throw Error('API unavailable'); return JSON.parse(r.stdout); };
  const config = JSON.parse(fs.readFileSync(join(root, 'scripts/settings/prototype-load.json'), 'utf8'));
  const expand = p => p.replace(/^~\//, `${env.HOME}/`);
  const clone = daemon => {
    const key = resolveDaemonKey(config.daemons, config.daemonAliases, daemon);
    const d = config.daemons[key.key ?? key];
    if (!d || d.unsupported || d.repo) throw Error('unsupported daemon; use a supported WE daemon');
    if (d.clone) return resolve(expand(config.workspaceRoot), expand(d.clone));
    const p = JSON.parse(String(exec('plutil', ['-convert', 'json', '-o', '-', join(expand(config.launchAgentsDir), `${d.label}.plist`)],
      { env, encoding: 'utf8', timeout: 30000, maxBuffer: 2097152 })));
    if (!p.WorkingDirectory?.startsWith('/')) throw Error('daemon clone unavailable');
    return p.WorkingDirectory;
  };
  const overlay = (action, r) => JSON.parse(String(exec('node', [join(root, config.loaderCli), action, `--clone=${clone(r.daemon)}`, '--json',
    ...(action === 'list' ? [] : [`--ref=hotpatch/${r.sha}`, `--expected-sha=${r.sha}`, `--pr=${r.pr}`, '--reason=hotpatch-flow'])],
    { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 2097152 })));
  const pinned = r => api([`repos/${origin.repo}/git/ref/heads/hotpatch/${r.sha}`]).object.sha === r.sha;
  const readers = createHotpatchReaders({ env, exec: boundedExec });
  return createHotpatchAdapter({ repo: origin.repo, readers, now: () => new Date().toISOString(),
    executorCommit: git.run(['rev-parse', 'HEAD']), netDiff: sha => netDiffFingerprint(root, 'origin/main', sha, { exec: (c, args, opts) => boundedExec(c, args, { ...opts, env, timeout: 30000, maxBuffer: 2097152 }) }),
    pr: n => api([`repos/${origin.repo}/pulls/${n}`]), pinned,
    pin: r => {
      clone(r.daemon); git.verify(r.sha);
      try { if (pinned(r)) return; } catch (e) { if (e.status !== 404 && !String(e.stderr).includes('HTTP 404')) throw e; }
      const ref = api([`repos/${origin.repo}/git/refs`, '-X', 'POST', '-f', `ref=refs/heads/hotpatch/${r.sha}`, '-f', `sha=${r.sha}`]);
      if (ref.object?.sha !== r.sha || !pinned(r)) throw Error('pin unconfirmed');
    },
    audit: r => exec('node', [join(root, 'scripts/operations/run.mjs'), 'codex-audit', '--base=origin/main', `--head=${r.sha}`],
      { cwd: root, env, encoding: 'utf8', timeout: 7200000, maxBuffer: 2097152 }),
    add: r => overlay('add', r), list: r => { const v = overlay('list', r); if (v.corrupt || !Array.isArray(v.list)) throw Error('list unreadable'); return v.list; },
    remove: r => overlay('remove', r), live: async r => {
      const p = api([`repos/${origin.repo}/pulls/${r.pr}`]);
      if (p.merged_at) return 'superseded';
      if (p.state === 'closed') return 'fail';
      if (p.state !== 'open' || !p.head?.sha) return 'unknown';
      const receipt = await receiptGuard(r.sha, readers);
      return receipt.outcome === 'fail' ? 'fail' : receipt.outcome === 'pass' ? 'pass' : 'unknown';
    },
  });
}
