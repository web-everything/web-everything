/** PR #6033: reused refs cannot inherit a historical pin; duplicate refs refuse stably. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const treeRoot = () => process.env.SOAK_TREE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function replay() {
  const load = file => import(pathToFileURL(join(treeRoot(), 'scripts/lib', file)).href);
  const { rebuildClone } = await load('daemon-rebuild.mjs');
  const { addOverlay, readOverlays, overlayFilePath } = await load('daemon-overlays.mjs');
  const { readRebuildState } = await load('daemon-rebuild/state.mjs');
  const base = mkdtempSync(join(tmpdir(), 'registration-history-'));
  const root = join(base, 'clone');
  mkdirSync(root);
  const env = {
    PATH: process.env.PATH, HOME: base, TMPDIR: base,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'no-gitconfig'),
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'), WE_DAEMON_EVENTS: join(base, 'events'),
    WE_PLATFORM_PREFERENCES_FILE: join(base, 'preferences.json'),
    WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_OVERLAY_AUTO_RETIRE: 'off',
    WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0', WE_DAEMON_OVERLAY_STACK_MODE: 'independent',
    WE_DAEMON_REBUILD_SKIP_UNRELATED: '0', WE_DAEMON_CLOSURE_SCOPE: 'off',
  };
  const git = (args, options = {}) => spawnSync('git', args, {
    cwd: root, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, ...options,
  });
  const ok = args => {
    const result = git(args);
    if (result.status !== 0) throw new Error(`fixture git ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (file, content) => {
    writeFileSync(join(root, file), content);
    ok(['add', file]);
    ok(['commit', '-qm', file]);
    return ok(['rev-parse', 'HEAD']);
  };
  const ref = 'lane/reused';
  let smokeCalls = 0;
  const tick = () => rebuildClone({
    root, env, log: {}, entries: [], asJob: false, versions: null, skipCheck: null,
    prState: async () => 'OPEN', prBaseChain: async () => [], lockOpts: { waitMs: 1500, pollMs: 10 },
    dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: async () => ({ ok: true }), match: () => false },
    runSmoke: async () => { smokeCalls++; return { verdict: 'pass', smoke: { results: [] } }; },
    run: (args, opts) => {
      // Fetch results are injected; all commits and rebuild/adoption work are local.
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'ls-remote') return { status: 2, stdout: '', stderr: '' };
      return git(args, opts);
    },
  });
  const violations = [];
  const check = (condition, message) => { if (!condition) violations.push(message); };
  try {
    ok(['init', '-q', '-b', 'main']);
    const initial = commit('README.md', 'base\n');
    const b = commit('overlay.txt', 'B\n');
    ok(['update-ref', `refs/remotes/origin/${ref}`, b]);
    const x = addOverlay(root, { ref, pr: 17 }, { env })[0];
    ok(['reset', '--hard', initial]);
    const main = commit('README.md', 'main advances\n');
    ok(['update-ref', 'refs/remotes/origin/main', main]);
    const first = await tick();
    check(first.adopted, `initial B was not adopted: ${first.reason}`);
    const running = ok(['rev-parse', 'HEAD']);
    ok(['reset', '--hard', initial]);
    commit('overlay.txt', 'rewritten C\n');
    const c = commit('README.md', 'C conflicts\n');
    ok(['update-ref', `refs/remotes/origin/${ref}`, c]);
    ok(['reset', '--hard', running]);
    const y = addOverlay(root, { ref, pr: 17 }, { env })[0];
    check(x.registrationId !== y.registrationId, 'replacement did not change registration');
    const calls = smokeCalls;
    for (let count = 0; count < 2; count++) {
      const result = await tick();
      const applied = readRebuildState(root, env).adopted?.applied ?? [];
      check(!applied.some(row => row.sha === b && row.registrationId === y.registrationId), 'B was rebound from X to Y');
      check(!result.alerts?.some(event => event.kind === 'overlay-pinned'), 'replacement inherited historical pin');
      check(ok(['rev-parse', 'HEAD']) === running, 'conflicting replacement changed running build');
      check(smokeCalls === calls, 'unbound historical pin reached smoke');
    }
    const file = overlayFilePath(root, env);
    const registry = JSON.parse(readFileSync(file, 'utf8'));
    registry.overlays.push({ ...readOverlays(root, { env })[0], registrationId: x.registrationId });
    writeFileSync(file, JSON.stringify(registry));
    const before = readFileSync(file, 'utf8');
    for (let count = 0; count < 2; count++) {
      const result = await tick();
      check(result.reason === 'overlay-registration-duplicate', `duplicate refused as ${result.reason}`);
      check(!result.alerts?.some(event => event.kind === 'overlay-registration-changed'), 'duplicate masqueraded as writer race');
      check(readFileSync(file, 'utf8') === before, 'duplicate registry was mutated');
      check(smokeCalls === calls, 'duplicate registry reached smoke');
    }
    return { violations };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

export default {
  id: 'overlay-registration-history',
  title: 'historical pins stay with their registration and duplicate refs refuse across ticks',
  card: 'PR #6033',
  fixedBy: { sha: '6033-registration-history', where: 'lane/overlay-generation-s1-r2',
    paths: ['scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/lib/daemon-rebuild/plan.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/plan.mjs'), 'utf8').includes('pinRegistrationMatches')
      && readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8').includes('overlay-registration-duplicate');
  },
  run: replay,
  judge: report => report.violations,
};
