/** Real Git replay of a running overlay conflicting with newly published main. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone, readRebuildState } from '../../../lib/daemon-rebuild.mjs';
import { runOverlayMainSync } from '../../../lib/daemon-rebuild/overlay-main-sync.mjs';
import { addOverlay, readOverlays, overlayFilePath } from '../../../lib/daemon-overlays.mjs';
import { writeRebuildState, alertsFilePath } from '../../../lib/daemon-rebuild/state.mjs';
import { SMOKE_CHECKS } from '../../../lib/daemon-live-smoke.mjs';

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
