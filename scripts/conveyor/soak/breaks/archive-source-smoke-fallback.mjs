/** PR #6023: replay deleted retired sources through the real smoke/adopt ladder, with in-memory Git. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoRetireOverlays } from '../../../lib/daemon-overlay-auto-retire.mjs';
import { migrateRegistrationIds, readOverlays, writeOverlays } from '../../../lib/daemon-overlays.mjs';
import { planRebuild } from '../../../lib/daemon-rebuild/plan.mjs';
import { smokeAndAdopt } from '../../../lib/daemon-rebuild/smoke.mjs';
import { readReadyCandidate } from '../../../lib/daemon-rebuild/state.mjs';

/** No subprocesses or Git writes: only registration/state sidecars live in a disposable directory. */
export async function archiveSmokeProbe({
  carried = false, attributed = false, mode = 'shadow', unavailable = false, nested = false, readyOnly = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archive-smoke-'));
  const env = {
    WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'), WE_DAEMON_EVENTS: join(root, 'events.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(root, 'preferences.json'),
    WE_DAEMON_OVERLAY_AUTO_RETIRE: 'on', WE_DAEMON_CLOSURE_SCOPE: mode,
    WE_REBUILD_SMOKE_REUSE_ENABLED: '0',
  };
  const objects = new Map();
  const trees = new Map();
  const hash = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');
  const treeOf = files => {
    const sorted = [...files].sort();
    const id = hash(sorted);
    trees.set(id, sorted);
    return id;
  };
  const commit = (parents, files) => {
    const tree = treeOf(files);
    const id = hash({ parents, tree });
    objects.set(id, { parents, files: trees.get(tree), tree });
    return id;
  };
  const base = commit([], ['base']);
  const lower = commit([base], ['base', 'lower']);
  const top = commit([lower], ['base', 'lower', 'broken.mjs']);
  const healthy = commit([base], ['base', 'healthy.mjs']);
  // Main initially lacks lower, so real auto-retirement archives lower into top.
  let main = base;
  let head = lower;
  let candidate;
  let checkingSmoke = false;
  const refs = new Map([['refs/remotes/origin/lower', lower], ['refs/remotes/origin/top', top],
    ['refs/remotes/origin/healthy', healthy]]);
  const resolve = ref => ref === 'HEAD' ? head : ref === 'origin/main' ? main : refs.get(ref) ?? (objects.has(ref) ? ref : null);
  const ancestor = (a, b) => a === b || (objects.get(b)?.parents ?? []).some(parent => ancestor(a, parent));
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const missing = () => ({ status: 1, stdout: '', stderr: 'missing' });
  const run = args => {
    const [cmd, ...rest] = args;
    if (cmd === 'rev-parse') {
      const rev = rest.at(-1);
      const sha = resolve(rev.replace(/\^\{(?:commit|tree)\}$/, ''));
      return sha ? ok(rev.endsWith('^{tree}') ? objects.get(sha).tree : sha) : missing();
    }
    if (cmd === 'for-each-ref') return ok(refs.has(rest.at(-1)) ? `${rest.at(-1)} ${refs.get(rest.at(-1))}` : '');
    if (cmd === 'merge-base') {
      const [a, b] = rest.slice(-2).map(resolve);
      if (checkingSmoke && unavailable && a === lower) return { status: 128, stderr: 'archive unavailable' };
      if (!a || !b) return missing();
      return rest[0] === '--is-ancestor' ? { ...ok(), status: ancestor(a, b) ? 0 : 1 } : ok(base);
    }
    if (cmd === 'merge-tree') {
      const [a, b] = rest.slice(-2).map(resolve);
      return a && b ? ok(treeOf(new Set([...objects.get(a).files, ...objects.get(b).files]))) : missing();
    }
    if (cmd === 'commit-tree') {
      const parents = rest.flatMap((arg, i) => arg === '-p' ? [rest[i + 1]] : []);
      return ok(commit(parents, trees.get(rest[0])));
    }
    if (cmd === 'diff') {
      if (rest.includes('--')) return ok(); // none of these fixture files touches the pinned mechanism
      const [a, b] = rest.filter(arg => !arg.startsWith('-')).map(resolve);
      return a && b ? ok(objects.get(b).files.filter(file => !objects.get(a).files.includes(file)).join('\n')) : ok();
    }
    if (cmd === 'log') return ok(rest.includes('--format=%ct') ? '1' : '');
    if (cmd === 'cherry') return ok(`+ ${rest.at(-1)}`);
    if (cmd === 'worktree') {
      if (rest[0] === 'add') candidate = rest.at(-1);
      return ok();
    }
    if (cmd === 'reset') { head = rest.at(-1); return ok(); }
    if (cmd === 'symbolic-ref') return ok('refs/heads/main');
    if (['status', 'ls-files', 'reflog', 'rev-list'].includes(cmd)) return ok();
    return missing();
  };
  try {
    const overlays = [{ ref: 'lower', sha: lower }, { ref: 'top', sha: top }, ...(attributed ? [{ ref: 'healthy', sha: healthy }] : [])];
    writeOverlays(root, overlays, { env });
    const retirement = await autoRetireOverlays({ root, env, overlays, git: run,
      refEvidence: new Map(overlays.map(o => [o.ref, 'refreshed'])), appendDaemonEvent: () => {} });
    if (!retirement.retired.some(row => row.ref === 'lower')) throw new Error('fixture did not retire lower');
    refs.delete('refs/remotes/origin/lower');
    if (carried) main = commit(carried === 'tree' ? [base] : [lower], ['base', 'lower', 'main']);
    // Production prepare stamps registration ids before planning; removals are CAS-bound to them.
    migrateRegistrationIds(root, { env });
    const overlaysBefore = readOverlays(root, { env });
    if (nested) {
      const carrier = overlaysBefore.find(o => o.ref === 'top');
      // The outer archive is already carried by main; only its nested source is uncovered.
      carrier.retiredSources = [{ sha: base, entry: { ref: 'middle', retiredSources: carrier.retiredSources } }];
      writeOverlays(root, overlaysBefore, { env });
    }
    const plan = await planRebuild({ git: run, headSha: head, mainRef: 'origin/main', overlays: overlaysBefore, env, closureScopeMode: mode });
    if (!plan.ok || !plan.applied.some(o => o.ref === 'top')) throw new Error(`fixture plan failed: ${JSON.stringify(plan)}`);
    const ids = new Map(overlaysBefore.map(o => [o.ref, o.registrationId]));
    plan.applied = plan.applied.map(row => ({ ...row, registrationId: ids.get(row.ref) }));
    checkingSmoke = true;
    const smoked = [];
    const result = await smokeAndAdopt({ root, env, stEnv: env, run, plan, prevHead: lower,
      overlaysBefore, prepAlerts: [], mainOnly: false, now: Date.now, log: {}, readyOnly,
      lease: { token: 'archive-probe', path: join(root, 'candidate') },
      finalLockOpts: { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 1000, pollMs: 5 },
      dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: async () => ({ ok: true }), match: () => [] },
      runSmoke: async () => {
        smoked.push(candidate);
        const bad = objects.get(candidate).files.includes('broken.mjs');
        return { verdict: bad ? 'code' : 'pass', smoke: { results: bad
          ? [{ name: 'daemon-entries-boot', ok: false, mayBeTransient: false,
            detail: 'code failure', entries: [{ files: ['broken.mjs'] }] }] : [] } };
      },
    });
    return { adopted: !!result.adopted, moved: result.moved, reason: result.reason, alerts: result.alerts,
      refs: readOverlays(root, { env }).map(o => o.ref), headUnchanged: head === lower,
      lowerCarried: objects.get(head).files.includes('lower'), ready: !!readReadyCandidate(root, env),
      smoked: smoked.length, lowerDeleted: !refs.has('refs/remotes/origin/lower') };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export default {
  id: 'archive-source-smoke-fallback', title: 'smoke fallbacks preserve deleted retired sources', card: 'PR #6023',
  fixedBy: { sha: 'pr-6023-archive-smoke', where: 'lane/r171-closure-scope', paths: ['scripts/lib/daemon-rebuild/smoke.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/lib/daemon-rebuild/smoke.mjs'), 'utf8').includes('archive-source-uncovered:'); },
  async run() {
    const probes = [];
    const violations = [];
    for (const options of [{}, { attributed: true }, { nested: true }, { unavailable: true }, { readyOnly: true }, { mode: 'off' }]) {
      const probe = await archiveSmokeProbe(options);
      probes.push({ options, ...probe });
      if (probe.adopted || !probe.headUnchanged || !probe.refs.includes('top') || probe.ready
        || !probe.alerts.some(a => a.kind === 'overlay-source-unavailable')) {
        violations.push({ invariant: 'archived-source-lost', detail: JSON.stringify({ options, ...probe }) });
      }
    }
    return { probes, violations };
  },
  judge(report) { return report.violations.map(row => `[${row.invariant}] ${row.detail}`); },
};
