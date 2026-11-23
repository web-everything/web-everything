/** Real Git replay of a running overlay conflicting with newly published main. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone, readRebuildState } from '../../../lib/daemon-rebuild.mjs';
import { runOverlayMainSync } from '../../../lib/daemon-rebuild/overlay-main-sync.mjs';
import { addOverlay, readOverlays, overlayFilePath } from '../../../lib/daemon-overlays.mjs';
import { writeRebuildState, alertsFilePath, readReadyCandidate } from '../../../lib/daemon-rebuild/state.mjs';
import { SMOKE_CHECKS } from '../../../lib/daemon-live-smoke.mjs';
import { smokeAndAdopt, smokePassIdentity } from '../../../lib/daemon-rebuild/smoke.mjs';
import { finalizeRebuild, matchReadyCandidate } from '../../../lib/daemon-rebuild/adopt.mjs';
import { planRebuild } from '../../../lib/daemon-rebuild/plan.mjs';

/** Real smoke/ready/adopt/state/planner wiring with synthetic Git; never writes a Git repository. */
export async function probeOmissionEvidence({ mainOnly = false, readyOnly = false, cached = false, match = 'exact', failReset = false, fallback = false,
  containing = null, stackMode = 'independent', continuity = 'recorded', auditedBase = false, auditedChild = false,
  reverse = false, ancestryError = false, keepIndependentBase = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rebuild-omission-evidence-'));
  const root = join(base, 'clone');
  mkdirSync(root);
  const env = { PATH: process.env.PATH, WE_DAEMON_STATE_DIR: join(base, 'state'),
    WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'), WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'),
    WE_DAEMON_EVENTS: join(base, 'events.jsonl'), WE_NEEDS_YOU_FEED: join(base, 'needs.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing'), WE_DAEMON_OVERLAY_FOLLOW_TIP: 'follow' };
  const previous = 'a'.repeat(40), main = 'b'.repeat(40), tip = 'c'.repeat(40), tree = 'd'.repeat(40);
  const replacement = 'e'.repeat(40), next = 'f'.repeat(40), ref = 'lane/docs';
  const childRef = 'lane/top', child = '2'.repeat(40), ancestors = new Map();
  let head = previous, branch = tip;
  const ok = (stdout = '') => ({ status: 0, stdout });
  const run = args => {
    if (args[0] === 'rev-parse') {
      const rev = args.at(-1);
      if (rev === 'MERGE_HEAD') return { status: 1, stdout: '' };
      if (rev.endsWith('^{tree}')) return ok(tree);
      if (rev === 'HEAD') return ok(head);
      if (rev === 'origin/main^{commit}') return ok(main);
      if (rev === `refs/remotes/origin/${ref}^{commit}`) return ok(branch);
      if (rev === `refs/remotes/origin/${childRef}^{commit}`) return ok(containing === 'same-tip' ? replacement : child);
      if (rev === 'refs/remotes/origin/lane/bad^{commit}') return ok(next);
      return ok(rev.replace(/\^\{commit\}$/, ''));
    }
    if (args[0] === 'merge-base') {
      if (ancestryError && args[1] === '--is-ancestor' && args[2] === replacement && args[3] === child) {
        return { status: 128, stdout: '' };
      }
      return args[1] === '--is-ancestor'
        ? { status: args[2] === args[3] || ancestors.get(args[3])?.has(args[2]) ? 0 : 1, stdout: '' } : ok(main);
    }
    if (args[0] === 'diff') return ok(args.includes('--') ? '' : 'README.md\n');
    if (args[0] === 'reset') {
      if (failReset && args.at(-1) !== previous) return { status: 1, stdout: '' };
      head = args.at(-1); return ok();
    }
    if (args[0] === 'show') return { status: 1, stdout: '' };
    if (args[0] === 'merge-tree') return ok('1'.repeat(40));
    if (args[0] === 'cherry') return ok(`+ ${branch}\n`);
    if (args[0] === 'commit-tree') {
      const parents = args.filter((_, i) => args[i - 1] === '-p');
      ancestors.set(next, new Set(parents.flatMap(p => [p, ...(ancestors.get(p) ?? [])])));
      return ok(next);
    }
    if (['worktree', 'ls-tree', 'ls-files', 'status', 'rev-list', 'log', 'config'].includes(args[0])) return ok();
    if (args[0] === 'cat-file') return ok();
    throw new Error(`unexpected synthetic Git call: ${JSON.stringify(args)}`);
  };
  const now = () => 1_790_000_000_000;
  const aside = { eligible: true, ref, sha: tip, mainSha: main, reason: 'main-sync-conflict', files: ['README.md'] };
  try {
    addOverlay(root, { ref }, { env });
    const identity = smokePassIdentity(run, main, 'clone');
    writeRebuildState(root, { setAside: null, adopted: { head: previous, mainSha: previous,
      applied: [{ ref, sha: tip, pr: null }], inputsKey: 'previous', at: new Date(now()).toISOString() },
      smokePassed: cached ? [{ ...identity, passedAt: new Date(now()).toISOString() }] : [] }, env);
    const plan = await planRebuild({ git: run, headSha: previous, mainRef: 'origin/main', mainOnly: true });
    if (!mainOnly) plan.decisions = [{ ref, sha: tip, pr: null, action: 'skip', reason: 'main-sync-conflict', setAside: aside }];
    if (fallback) {
      addOverlay(root, { ref: 'lane/bad' }, { env });
      plan.finalSha = next;
      plan.applied = [{ ref: 'lane/bad', sha: next, pr: null }];
    }
    const checks = [];
    const lease = { token: 'omission-probe', path: join(base, 'candidate') };
    const options = { root, env, stEnv: env, run, now, plan, prevHead: previous, lease,
      finalLockOpts: { lockRoot: join(base, 'locks'), waitMs: 100 },
      overlaysBefore: [{ ref }, ...(fallback ? [{ ref: 'lane/bad' }] : [])], prepAlerts: [], mainOnly, readyOnly, log: { error() {} },
      dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: async () => ({ ok: true }), match: () => [] },
      runSmoke: async opts => {
        checks.push({ changedFiles: opts.changedFiles, reuseCode: opts.reuseCode, reuseRows: opts.reuseRows });
        if (fallback && checks.length === 1) return { verdict: 'code', smoke: { results: [
          { name: 'dispatch-dry-run', ok: false, detail: 'broken overlay' },
        ] } };
        return { verdict: 'pass', smoke: { results: SMOKE_CHECKS.map(({ name, kind }) => ({ name, ok: true,
          ...(kind === 'code' && (opts.changedFiles !== null || opts.reuseCode) ? { skipped: true } : {}) })) } };
      } };
    let result = await smokeAndAdopt(options);
    const beforeAdopt = readRebuildState(root, env).setAside;
    const ready = readReadyCandidate(root, env);
    let readyMatch = null;
    if (readyOnly && ready) {
      const livePlan = match === 'exact' ? plan : { ...plan, finalSha: next, inputsKey: 'next' };
      const matched = matchReadyCandidate({ ready, plan: livePlan, prevHead: previous,
        treeOf: () => match === 'same-tree' ? tree : next, stillWanted: () => true,
        verifyBuilt: () => true, liveApplied: [], nowMs: now(), maxAgeMs: 60_000 });
      readyMatch = matched.match;
      if (matched.adopt) result = await finalizeRebuild({ ...options, plan: matched.adopt,
        strictAdopt: ready.strictAdopt, freshSmoke: ready.freshSmoke === ready.adopt.finalSha ? matched.adopt.finalSha : null });
    }
    const state = readRebuildState(root, env);
    branch = replacement;
    const overlays = [{ ref }];
    if (containing) {
      ancestors.set(replacement, new Set([main]));
      ancestors.set(child, new Set(containing === 'unrelated' ? [main] : [main, replacement]));
      addOverlay(root, { ref: childRef }, { env });
      overlays.push({ ref: childRef });
      if (reverse) overlays.reverse();
    }
    let audits = 0;
    const auditedTip = (auditRef, sha) => {
      audits++;
      return (auditedBase && auditRef === ref && sha === replacement) || (auditedChild && auditRef === childRef);
    };
    const repaired = await planRebuild({ git: run, headSha: head, mainRef: 'origin/main', overlays, stackMode,
      edgeResolve: false, setAside: continuity === 'unknown' ? null : state.setAside === undefined ? null : state.setAside ?? {},
      auditedTip, keepIndependent: new Set(keepIndependentBase ? [ref] : []) });
    let repairResult = null;
    if (containing) {
      await options.runSmoke({ changedFiles: null, reuseCode: false, reuseRows: [] });
      repairResult = await finalizeRebuild({ ...options, plan: repaired, prevHead: head, overlaysBefore: overlays,
        auditedTip, strictAdopt: true, freshSmoke: repaired.finalSha });
    }
    return { adopted: result.adopted === true, reason: result.reason, checks, readyMatch,
      beforeAdopt, aside: state.setAside?.[ref] ?? null, recordedDecisions: ready?.adopt?.decisions,
      onTarget: head === (match === 'same-tree' ? next : main), unchanged: head === previous,
      audits, held: repaired.decisions.some(d => d.reason === 'unaudited-tip-held'), applied: repaired.applied.length,
      childHeld: repaired.decisions.some(d => d.ref === childRef && d.reason === 'unaudited-tip-held'),
      repairAdopted: repairResult?.adopted === true, carriesRepair: ancestors.get(head)?.has(replacement) ?? false,
      appliedRefs: repaired.applied.map(o => o.ref) };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

export async function createSetAsideFixture({ pinned = false, guard = false, audited = false, sibling = false, pr = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rebuild-set-aside-'));
  const root = join(base, 'clone'), author = join(base, 'author'), origin = join(base, 'origin.git');
  const env = { ...process.env, WE_DAEMON_STATE_DIR: join(base, 'state'),
    WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'), WE_DAEMON_EVENTS: join(base, 'events.jsonl'),
    WE_NEEDS_YOU_FEED: join(base, 'needs-you.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing'), WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'),
    WE_DAEMON_OVERLAY_FOLLOW_TIP: audited ? 'audited-only' : 'follow', WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
    WE_DAEMON_OVERLAY_EDGE_RESOLVE: '1', WE_DAEMON_AUTO_REBASE: '0' };
  const git = (cwd, args) => {
    const r = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
    if (r.status !== 0) throw new Error(`fixture git ${args[0]}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (cwd, path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), value); };
  const commit = (cwd, message) => { git(cwd, ['add', '-A']); git(cwd, ['commit', '-qm', message]); };
  const ref = 'lane/set-aside', file = guard ? 'scripts/lib/daemon-rebuild.mjs' : 'worker.mjs';
  const rebuild = (options = {}) => rebuildClone({ root, env, prState: async () => 'OPEN', prBaseChain: async () => null,
    runSmoke: async () => ({ verdict: 'pass', attempts: 1,
      smoke: { results: SMOKE_CHECKS.map(({ name }) => ({ name, ok: true })) } }), log: { error() {} }, ...options });
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  try {
    git(base, ['init', '--bare', '-q', origin]);
    mkdirSync(root); git(root, ['init', '-q', '-b', 'main']);
    write(root, file, 'export const value = 0;\n'); commit(root, 'base');
    git(root, ['remote', 'add', 'origin', origin]); git(root, ['push', '-qu', 'origin', 'main']);
    git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(base, ['clone', '-q', origin, author]);
    git(author, ['checkout', '-qb', ref]); write(author, file, 'export const value = 1;\n'); commit(author, 'overlay');
    git(author, ['push', '-q', 'origin', ref]);
    addOverlay(root, { ref, pinned, pr }, { env });
    // This fixture explicitly starts with no prior omissions. Missing state is strict.
    writeRebuildState(root, { setAside: null }, env);
    const initial = await rebuild();
    if (!initial.adopted) throw new Error(`initial adoption: ${initial.reason}`);
    git(author, ['checkout', '-q', 'main']); write(author, file, 'export const value = 2;\n'); commit(author, 'new main');
    git(author, ['push', '-q', 'origin', 'main']);
    const main = git(author, ['rev-parse', 'HEAD']);
    const tip = git(author, ['rev-parse', ref]);
    if (sibling) {
      git(author, ['checkout', '-qb', 'lane/sibling']);
      write(author, file, 'export const value = 4;\n'); commit(author, 'sibling');
      git(author, ['push', '-q', 'origin', 'lane/sibling']);
      addOverlay(root, { ref: 'lane/sibling' }, { env });
    }
    git(root, ['fetch', '-q', 'origin']);
    try { await runOverlayMainSync({ root, ref, env }); throw new Error('expected sync conflict'); }
    catch (error) { if (!/merge conflicts/.test(error.message)) throw error; }
    return { root, env, ref, file, main, tip, rebuild, cleanup,
      git: args => spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 }),
      head: () => git(root, ['rev-parse', 'HEAD']),
      state: () => readRebuildState(root, env), overlays: () => readOverlays(root, { env }),
      alerts: () => existsSync(alertsFilePath(root, env)) ? readFileSync(alertsFilePath(root, env), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
      async repair(options = {}) {
        git(author, ['checkout', '-q', '-B', ref, 'main']);
        write(author, file, 'export const value = 3;\n'); commit(author, 'rebased overlay');
        git(author, ['push', '-q', '--force', 'origin', ref]);
        return rebuild(options);
      },
    };
  } catch (error) { cleanup(); throw error; }
}

export async function probeRebuildSetAside() {
  const f = await createSetAsideFixture();
  try {
    const before = f.alerts().length;
    const first = await f.rebuild(), state = f.state(), head = f.head();
    await f.rebuild();
    const rebuildAlerts = f.alerts().slice(before).filter(e => e.detail?.ref === f.ref
      && /conflict|set-aside/.test(e.kind));
    const alerts = rebuildAlerts.filter(e => e.kind === 'overlay-main-sync-set-aside');
    const repaired = await f.repair();
    return { adopted: first.adopted === true, onMain: head === f.main, aside: state.setAside?.[f.ref],
      alerts: alerts.length, rebuildAlerts: rebuildAlerts.length, alertMessage: alerts[0]?.detail?.message,
      registered: f.overlays().some(o => o.ref === f.ref),
      events: readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map(JSON.parse).filter(e => e.kind === 'overlay-main-sync-set-aside').length, repaired: repaired.adopted === true,
      reapplied: f.state().adopted?.applied.some(o => o.ref === f.ref), cleared: !f.state().setAside?.[f.ref] };
  } finally { f.cleanup(); }
}
