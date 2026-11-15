/** R918 / PR #6732: audit revocation must be checked for the tip actually being adopted. */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchReadyCandidate } from '../../../lib/daemon-rebuild/adopt.mjs';
import { makeAuditedTipGate } from '../../../lib/daemon-rebuild/audited-tip.mjs';
import { planRebuild } from '../../../lib/daemon-rebuild/plan.mjs';
import { makeGit } from '../../../lib/daemon-rebuild/shared.mjs';

/** R928: a failed identity write cannot erase the live plan's audit hold. */
async function checkHoldWriteFailure(dir, violations) {
  const git = makeGit({ cwd: dir, env: process.env,
    run: (args, opts) => spawnSync('git', args, { ...opts, encoding: 'utf8' }) });
  const ok = (args) => {
    const r = git(args);
    if (r.status !== 0) throw new Error(r.stderr || `git ${args[0]} failed`);
    return String(r.stdout).trim();
  };
  ok(['init', '-q', '-b', 'main']);
  const commit = (content) => {
    writeFileSync(join(dir, 'moving.txt'), content);
    ok(['add', 'moving.txt']);
    ok(['commit', '-qm', content]);
    return ok(['rev-parse', 'HEAD']);
  };
  const ref = 'lane/held';
  const base = commit('base');
  ok(['update-ref', 'refs/remotes/origin/main', base]);
  const a = commit('audited A');
  ok(['update-ref', `refs/remotes/origin/${ref}`, a]);
  const options = { git, headSha: base, mainRef: 'origin/main', overlays: [{ ref, pr: 42 }],
    edgeResolve: false, auditedTip: () => false };
  const adopted = await planRebuild(options);
  const b = commit('unaudited B');
  ok(['update-ref', `refs/remotes/origin/${ref}`, b]);
  ok(['update-ref', 'refs/remotes/origin/main', a]);
  try {
    const plan = await planRebuild({ ...options, headSha: adopted.finalSha, git: (args, opts) => {
      if (args[0] === 'commit-tree' && args.at(-1).includes('(held at audited head)')) {
        throw new Error('injected hold-marker write failure');
      }
      return git(args, opts);
    } });
    if (plan.ok || plan.reason !== 'pinned-overlay-hold-marker-failed'
      || !plan.applied?.some(row => row.ref === ref && row.sha === a && row.pinnedFrom === b)
      || !plan.detail?.error?.includes('injected hold-marker write failure')) {
      violations.push({ invariant: 'hold-write-failed-open', detail: JSON.stringify(plan) });
    }
    const result = matchReadyCandidate({
      plan, prevHead: adopted.finalSha, nowMs: 2000, maxAgeMs: 10000,
      ready: { kind: 'candidate', passedAt: new Date(1000).toISOString(), prevHead: adopted.finalSha,
        adopt: { ...plan, applied: [{ ref, sha: b, pinnedFrom: 'later-tip' }] } },
      treeOf: () => 'tree', stillWanted: () => true, verifyBuilt: () => true,
    });
    if (result.adopt) violations.push({ invariant: 'failed-hold-adopted-unpinned-tip', detail: JSON.stringify(result) });
  } catch (error) {
    violations.push({ invariant: 'hold-write-error-not-reported-in-plan', detail: String(error) });
  }
}

export default {
  id: 'ready-candidate-audit-revoked',
  title: 'pending candidates recheck their own audit evidence even when the live alert names a later tip',
  card: 'PR #6732 / R918',
  fixedBy: { sha: 'lane/overlay-pin-audited-sha', where: 'lane/overlay-pin-audited-sha', paths: ['scripts/lib/daemon-rebuild/adopt.mjs', 'scripts/lib/daemon-rebuild/plan.mjs'] },
  fixPresent(root) {
    try { return readFileSync(join(root, 'scripts/lib/daemon-rebuild/adopt.mjs'), 'utf8').includes('const revokedExact = revokedAudit(ready.adopt)')
      && readFileSync(join(root, 'scripts/lib/daemon-rebuild/plan.mjs'), 'utf8').includes('pinned-overlay-hold-marker-failed'); }
    catch { return false; }
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-ready-audit-'));
    const violations = [];
    try {
      const path = join(dir, 'ready.jsonl');
      const platform = join(dir, 'platform.json');
      writeFileSync(platform, '{}');
      const env = { WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only', WE_FIX_READY_PATH: path, WE_PLATFORM_PREFERENCES_FILE: platform };
      const ref = 'lane/moving';
      const row = (sha, tests = 'green') => JSON.stringify({ ref, sha, tests, audit: 'NOT WEAKENED' }) + '\n';
      const built = { finalSha: 'build-B', mainSha: 'M2', inputsKey: 'B', applied: [{ ref, sha: 'B' }] };
      const ready = { kind: 'candidate', prevHead: 'adopted-A-on-M1', passedAt: new Date(1000).toISOString(), tree: 'tree-B', adopt: built };
      for (const match of ['exact', 'same-tree', 'superseded', 'fallback', 'fallback-main-moved']) {
        writeFileSync(path, row('A') + row('B'));
        const gateBeforeRevocation = makeAuditedTipGate(env);
        if (!gateBeforeRevocation(ref, 'B')) throw new Error('B must have green evidence before revocation');
        const plan = { ...built, finalSha: match === 'exact' ? built.finalSha : 'live-build', inputsKey: 'live', auditAdopted: [ref], alerts: [] };
        if (match === 'superseded' || match.startsWith('fallback')) {
          plan.applied = [{ ref, sha: 'A', pinnedFrom: 'C' }];
          plan.alerts = [{ kind: 'overlay-unaudited-tip', detail: { ref, newTip: 'C' } }];
        }
        const candidate = match.startsWith('fallback')
          ? { ...ready, kind: 'fallback', forInputsKey: match === 'fallback' ? 'live' : 'older', dropRefs: [] }
          : ready;
        const options = {
          ready: candidate, plan, prevHead: ready.prevHead, nowMs: 2000, maxAgeMs: 10000,
          treeOf: () => match === 'same-tree' ? 'tree-B' : 'tree-A', stillWanted: () => true,
          verifyBuilt: () => true, liveApplied: [],
        };
        const green = matchReadyCandidate({ ...options, auditedTip: makeAuditedTipGate(env) });
        if (green.match !== match) throw new Error(`fixture did not reach ${match}: ${JSON.stringify(green)}`);
        appendFileSync(path, row('B', 'red'));
        const result = matchReadyCandidate({ ...options, auditedTip: makeAuditedTipGate(env) });
        if (result.adopt || result.reason !== 'ready-audit-revoked') {
          violations.push({ invariant: 'revoked-tip-adopted', detail: `${match}: ${JSON.stringify(result)}` });
        }
      }
      await checkHoldWriteFailure(dir, violations);
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};
