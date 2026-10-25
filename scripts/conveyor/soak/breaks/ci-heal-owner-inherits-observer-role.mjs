/**
 * Live 2026-10-21: health-watch runs as the read-only `observer` GitHub App role (WE_GITHUB_APP_ROLE=observer in its
 * process env). When main CI went red, main-ci-red-io dispatched a ci-heal owner session, and that session inherited
 * `observer` on every identity channel, so it could not open its repair PR. A first overlay swapped process.env to
 * `worker` across the dispatch, which leaked worker rights to concurrent health-watch work (Codex audit P1).
 *
 * Replay: health-watch env is observer; two owner dispatches overlap while unrelated observer work runs. Every
 * dispatched session must read `worker` from its durable settings.local.json, its `--settings` argv and its spawn /
 * wrapper env, while process.env and the concurrent observer read stay `observer` throughout.
 * The real sink plumbing and the real gh-shim settings writer run; only OS effects and this host's App config are
 * injected (no real `claude` process, no real lane, no write outside a temp dir).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROLE = 'WE_GITHUB_APP_ROLE';

export default {
  id: 'ci-heal-owner-inherits-observer-role',
  title: 'main-red ci-heal owner session dispatched by health-watch inherited the read-only observer App role and could not open its repair PR',
  card: 'PR #5807 (replaces the lane/ci-heal-role overlay)',
  fixedBy: { sha: '7f513b0ba', where: 'lane/grad-ci-heal-role-2', paths: ['scripts/conveyor/main-ci-red-io.mjs', 'scripts/operations/dispatch-lane-io.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/main-ci-red-io.mjs'), 'utf8').includes('export const ownerSpawnEnv'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const load = (p) => import(pathToFileURL(join(root, p)).href);
    const io = await load('scripts/operations/dispatch-lane-io.mjs');
    const gh = await load('scripts/lib/gh-app-shim.mjs');
    const owner = await load('scripts/conveyor/main-ci-red-io.mjs');
    const { DISPATCH_EFFECT } = await load('scripts/operations/dispatch-lane.mjs');
    const { dispatchModesFromEnv } = await load('scripts/operations/dispatch-provider-registry.mjs');
    const tmp = mkdtempSync(join(tmpdir(), 'soak-ci-heal-role-'));
    mkdirSync(join(tmp, 'bin')); writeFileSync(join(tmp, 'bin', 'gh'), '');
    const prior = Object.prototype.hasOwnProperty.call(process.env, ROLE) ? process.env[ROLE] : undefined;
    process.env[ROLE] = 'observer';
    const seen = []; const violations = [];
    let release; const gate = new Promise((r) => { release = r; });
    let n = 0;
    const sinkOptions = (wrapped) => ({
      root: tmp, reserveLane: () => ({ reserved: false }), releaseLane: () => {},
      mintSessionId: () => `22222222-2222-4222-8222-${String(++n).padStart(12, '0')}`,
      sessionCwdFor: (id) => join(tmp, 'sessions', id), ensureSessionCwd: (c) => { mkdirSync(c, { recursive: true }); return c; },
      grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
      // The default resolver (`resolveDispatchSettingsEnv`) with this host's App config injected: two roles, a real gh.
      resolveSettingsEnv: (cwd, o) => ({ ...(gh.buildGhShimSettingsEnv({
        cwd, env: o?.env ?? process.env, pathEnv: join(tmp, 'bin'), dir: join(tmp, 'shim'), cachePath: join(tmp, 'cache.json'),
        ghThrottleCliPath: join(tmp, 'gh-throttle.mjs'),
        identity: { anyConfigured: true, roles: { worker: { appId: '1', installations: { o: 1 } }, observer: { appId: '2', installations: { o: 2 } } } },
      }) || {}), ...io.DISPATCH_BASH_TIMEOUT_ENV }),
      provider: async (request) => {
        await gate;
        const rec = { file: JSON.parse(readFileSync(join(request.cwd, '.claude', 'settings.local.json'), 'utf8')).env?.[ROLE] };
        seen.push(rec);
        const settingsOf = (argv) => JSON.parse(argv[argv.indexOf('--settings') + 1]).env?.[ROLE];
        return io.defaultClaudeProvider(request, {
          spawnAgent: (argv, opts) => io.defaultSpawnAgent(argv, opts, {
            exec: (_c, args, options) => { rec.argv = settingsOf(args); rec.spawn = options.env[ROLE]; return 'backgrounded 22222222-2222-4222-8222-000000000000'; },
            grantTrust: () => {},
          }),
          wrapKind: () => wrapped,
          launchWrapped: (l) => { rec.argv = settingsOf(l.bgArgv); rec.wrapper = l.env[ROLE]; return { wrapperPid: 1, handle: 'pid:1' }; },
        });
      },
    });
    // On a tree without the fix, defaultDispatchOwner takes no sink options (it would really spawn), so replay the
    // exact sink call it makes there — same modes and args, no explicit env — with the same injected OS effects.
    // The fixed tree exports `ownerSpawnEnv` alongside the sink-options seam.
    const dispatch = (wrapped) => (typeof owner.ownerSpawnEnv === 'function'
      ? owner.defaultDispatchOwner({ prompt: 'p', sessionSlug: 'ci-heal-main' }, sinkOptions(wrapped))
      : io.createDispatchSinks({ root: io.REPO_ROOT, modes: { ...dispatchModesFromEnv(), 'ci-heal': 'agent' }, extraArgs: [], ...sinkOptions(wrapped) })[DISPATCH_EFFECT]({
        launchKind: 'ci-heal', prompt: 'p', sessionSlug: 'ci-heal-main', lane: null, scope: [], pr: null, reason: 'main-red', repo: 'we', probationWorker: null, routing: null,
      }));
    try {
      const both = Promise.all([dispatch(false), dispatch(true)]);
      await new Promise((r) => setTimeout(r, 0));
      const concurrent = [process.env[ROLE], io.workerSpawnEnv()[ROLE]];
      if (concurrent.some((r) => r !== 'observer')) violations.push(`concurrent health-watch work saw ${concurrent.join('/')} mid-dispatch, not observer`);
      release(); await both;
      if (seen.length !== 2) violations.push(`expected 2 dispatched sessions, saw ${seen.length}`);
      seen.forEach((rec, i) => {
        for (const [channel, role] of Object.entries(rec)) if (role !== 'worker') violations.push(`session ${i + 1} ${channel} role is ${role}, not worker`);
        const channels = Object.keys(rec).sort().join(',');
        if (channels !== 'argv,file,spawn' && channels !== 'argv,file,wrapper') violations.push(`session ${i + 1} delivered only ${channels}`);
      });
      if (process.env[ROLE] !== 'observer') violations.push(`health-watch process.env left as ${process.env[ROLE]}`);
    } finally {
      release();
      if (prior === undefined) delete process.env[ROLE]; else process.env[ROLE] = prior;
      rmSync(tmp, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
