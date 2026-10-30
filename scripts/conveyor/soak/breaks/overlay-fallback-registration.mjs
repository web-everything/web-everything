/** PR #6033: fallback adoption must retain the identity of a mechanism overlay. */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const treeRoot = () => process.env.SOAK_TREE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export async function replayFallbackRegistration({ selective = false, recovery = false, replace = false } = {}) {
  const load = file => import(pathToFileURL(join(treeRoot(), 'scripts/lib', file)).href);
  const { rebuildClone, readRebuildState } = await load('daemon-rebuild.mjs');
  const { addOverlay, readOverlays } = await load('daemon-overlays.mjs');
  const { readReadyCandidate } = await load('daemon-rebuild/state.mjs');
  const base = mkdtempSync(join(tmpdir(), 'fallback-registration-'));
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
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  const violations = [];
  const check = (condition, message) => { if (!condition) violations.push(message); };
  try {
    ok(['init', '-q', '-b', 'main']);
    write('README.md', 'base\n');
    ok(['add', '.']);
    ok(['commit', '-qm', 'base']);
    const main = ok(['rev-parse', 'HEAD']);
    ok(['update-ref', 'refs/remotes/origin/main', main]);
    const mechanism = 'scripts/lib/daemon-rebuild.mjs';
    const retained = 'lane/mechanism';
    const register = (ref, file, content) => {
      write(file, content);
      ok(['add', '.']);
      ok(['commit', '-qm', ref]);
      const sha = ok(['rev-parse', 'HEAD']);
      ok(['update-ref', `refs/remotes/origin/${ref}`, sha]);
      ok(['reset', '--hard', main]);
      return { ...addOverlay(root, { ref }, { env }).find(row => row.ref === ref), sha };
    };
    const original = register(retained, mechanism, '// retained mechanism\n');
    register('lane/bad', 'bad.mjs', 'throw new Error("bad");\n');
    if (selective) register('lane/good', 'good.mjs', 'export const good = true;\n');
    const registrations = new Map(readOverlays(root, { env }).map(row => [row.ref, row.registrationId]));
    let unavailable = false;
    let smokeCalls = 0;
    let replacement;
    const runSmoke = async ({ root: candidate }) => {
      smokeCalls++;
      if (existsSync(join(candidate, 'bad.mjs'))) return {
        verdict: 'code', smoke: { results: [{ name: 'boot', ok: false, detail: 'broken', entries: [{ files: ['bad.mjs'] }] }] },
      };
      if (replace && !replacement) replacement = addOverlay(root, { ref: retained }, { env }).find(row => row.ref === retained);
      return { verdict: 'pass', smoke: { results: [] } };
    };
    const rebuild = options => rebuildClone({
      root, env, log: {}, entries: [], asJob: false, versions: null, skipCheck: null,
      prState: async () => 'OPEN', lockOpts: { waitMs: 1500, pollMs: 10 },
      dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: async () => ({ ok: true }), match: () => false },
      runSmoke,
      run: (args, opts) => {
        // Remote IO is injected: these fixtures never fetch or push to a server.
        if (args[0] === 'fetch') return { status: unavailable && args.some(a => a.includes(`heads/${retained}:`)) ? 1 : 0, stdout: '', stderr: '' };
        if (args[0] === 'ls-remote') return { status: 1, stdout: '', stderr: 'offline' };
        return git(args, opts);
      }, ...options,
    });
    const first = await rebuild({ readyOnly: recovery });
    check(first.reason === (selective ? 'overlay-set-aside' : 'fallback-plain-main'), `wrong fallback: ${first.reason}`);
    if (recovery) {
      check(ok(['rev-parse', 'HEAD']) === main, 'ready-only moved HEAD');
      const saved = readReadyCandidate(root, env);
      check(saved?.adopt?.applied?.find(a => a.ref === retained)?.registrationId === original.registrationId, 'saved fallback lost registration ID');
      const calls = smokeCalls;
      const resumed = await rebuild({});
      check(resumed.adopted, `ready adoption failed: ${resumed.reason}`);
      check(smokeCalls === calls, 'ready recovery re-smoked instead of adopting saved evidence');
    } else check(first.adopted, `fallback not adopted: ${first.reason}`);
    const adopted = readRebuildState(root, env).adopted;
    const row = adopted?.applied?.find(a => a.ref === retained);
    for (const applied of adopted?.applied ?? []) {
      const expected = replace && applied.ref === retained ? undefined : registrations.get(applied.ref);
      check(applied.registrationId === expected, `adopted ID mismatch: ${applied.ref}`);
    }
    check(row?.sha === original.sha, 'retained mechanism sha missing');
    check(row?.registrationId === (replace ? undefined : original.registrationId), 'retained registration ID lost or rebound');
    check(readFileSync(join(root, mechanism), 'utf8') === '// retained mechanism\n', 'fallback lost mechanism content');
    check(readOverlays(root, { env }).some(a => a.ref === retained && a.registrationId === (replacement ?? original).registrationId), 'retained registration removed');
    if (!replace) {
      const lastGood = ok(['rev-parse', 'HEAD']);
      // Main moves independently while only the mechanism ref becomes unavailable.
      ok(['reset', '--hard', main]);
      write('README.md', 'next main\n');
      ok(['add', '.']);
      ok(['commit', '-qm', 'advance main']);
      ok(['update-ref', 'refs/remotes/origin/main', ok(['rev-parse', 'HEAD'])]);
      ok(['reset', '--hard', lastGood]);
      unavailable = true;
      const calls = smokeCalls;
      const outage = await rebuild({});
      check(outage.reason === 'pinned-overlay-unavailable', `outage did not hold: ${outage.reason}`);
      check(ok(['rev-parse', 'HEAD']) === lastGood, 'outage changed HEAD');
      check(existsSync(join(root, mechanism)) && readFileSync(join(root, mechanism), 'utf8') === '// retained mechanism\n', 'outage lost mechanism content');
      check(smokeCalls === calls, 'outage smoked a build without the pinned mechanism');
    }
    return { violations };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

export default {
  id: 'overlay-fallback-registration',
  title: 'fallback adoption preserves retained mechanism registration evidence across refresh failure',
  card: 'PR #6033',
  fixedBy: { sha: '6033-fallback-registration', where: 'lane/overlay-generation-s1-r2', paths: ['scripts/lib/daemon-rebuild/smoke.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/smoke.mjs'), 'utf8').includes('replanWithRegistrationIds');
  },
  async run() {
    const violations = [];
    for (const selective of [false, true]) for (const recovery of [false, true]) {
      const result = await replayFallbackRegistration({ selective, recovery });
      violations.push(...result.violations.map(v => `${selective ? 'selective' : 'plain'} ${recovery ? 'recovered' : 'direct'}: ${v}`));
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
