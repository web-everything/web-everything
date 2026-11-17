/** A parked overlay must acknowledge NEEDS-YOU only after the feed accepts it. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { addOverlay, overlayFilePath } from '../../../lib/daemon-overlays.mjs';
import { alertsFilePath } from '../../../lib/daemon-rebuild/state.mjs';
import { replay } from '../../../operations/needs-you-feed.mjs';
import * as sync from '../../../lib/daemon-rebuild/overlay-main-sync.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs';
const FILE = 'worker.test.mjs';

export async function scenario(retryPath, implementation = sync) {
  // Older replay trees predate the marked-inventory protocol.
  const { runOverlayMainSync, kickOverlayMainSync, VITEST_INVENTORY_MARK = '' } = implementation;
  const dir = mkdtempSync(join(tmpdir(), 'soak-main-sync-park-alert-pending-'));
  const root = join(dir, 'daemon'), origin = join(dir, 'origin.git'), ref = 'lane/park-alert-pending';
  const blocker = join(dir, 'feed-unavailable');
  const env = { ...process.env, TMPDIR: dir, WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
    WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl'),
    WE_NEEDS_YOU_FEED: join(blocker, 'needs-you.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(dir, 'missing') };
  const git = (args, opts = {}) => spawnSync('git',
    ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args],
    { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts });
  const ok = args => {
    const result = git(args);
    if (result.status !== 0) throw new Error(`park-alert-pending scenario Git failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const violations = [], events = [];
  let testCalls = 0, pushes = 0, spawns = 0;
  try {
    mkdirSync(root); mkdirSync(join(root, 'node_modules'));
    ok(['init', '-q', '-b', 'main']);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(root, 'worker.mjs'), 'export default 0;\n');
    ok(['add', '.']); ok(['commit', '-qm', 'base']);
    ok(['checkout', '-qb', ref]);
    writeFileSync(join(root, FILE), "import './worker.mjs';\n");
    ok(['add', '.']); ok(['commit', '-qm', 'overlay test']);
    const tip = ok(['rev-parse', 'HEAD']);
    ok(['checkout', '-q', 'main']);
    writeFileSync(join(root, 'main.mjs'), 'export default 1;\n');
    ok(['add', '.']); ok(['commit', '-qm', 'main advanced']);
    const main = ok(['rev-parse', 'HEAD']);
    ok(['clone', '-q', '--bare', root, origin]);
    ok(['remote', 'add', 'origin', origin]);
    ok(['update-ref', 'refs/remotes/origin/main', main]);
    ok(['update-ref', `refs/remotes/origin/${ref}`, tip]);
    addOverlay(root, { ref, pr: 123 }, { env });
    writeFileSync(blocker, 'feed parent is unavailable\n');
    const deps = {
      git: (args, opts) => {
        // Both heads exist locally; the replay never fetches or publishes.
        if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'push') { pushes++; throw new Error('unexpected push'); }
        return git(args, opts);
      },
      appendDaemonEvent: event => { events.push(event); },
      testListRunner: (_command, _args, { cwd }) => ({ status: 0,
        stdout: `\n${VITEST_INVENTORY_MARK}${JSON.stringify([join(realpathSync(cwd), FILE)])}\n`, stderr: '' }),
      testRunner: async () => {
        testCalls++;
        return { status: 1, stdout: '', stderr: 'persistent overlay test failure' };
      },
    };
    const state = () => JSON.parse(readFileSync(`${overlayFilePath(root, env)}.main-sync.state`, 'utf8'));
    const alerts = () => readFileSync(alertsFilePath(root, env), 'utf8').trim().split('\n').map(JSON.parse);
    for (let pass = 0; pass < 3; pass++) {
      let failure;
      try { await runOverlayMainSync({ root, ref, env, deps }); }
      catch (error) { failure = error; }
      if (failure?.step !== 'tests') violations.push(`pass ${pass + 1} did not reproduce the tests-step failure`);
    }
    if (state().parkedTip[ref] !== tip || state().failureCount[ref] !== 3) violations.push('three failures did not park the overlay tip');
    const checkPending = () => {
      if (Object.hasOwn(state().failureAlertedAt, ref)) violations.push('failed feed publication acknowledged the park alert');
      if (!Object.hasOwn(state().firstFailureAt, ref)) violations.push('pending park alert lost its failure streak');
      if (existsSync(env.WE_NEEDS_YOU_FEED)) violations.push('unavailable feed unexpectedly received a publication');
      if (alerts().length !== 1) violations.push('pending publication did not retain exactly one local diagnostic');
    };
    checkPending();
    // A persisted park without its streak timestamp must still deliver exactly once.
    const malformed = state();
    delete malformed.firstFailureAt[ref];
    const stateFile = `${overlayFilePath(root, env)}.main-sync.state`;
    for (const file of [stateFile, stateFile.replace(/\.state$/, '.json')])
      writeFileSync(file, JSON.stringify(malformed));
    const eventCount = events.length;
    const retry = async () => {
      const result = retryPath === 'scheduler'
        ? kickOverlayMainSync({ root, ref, env, mode: 'on', git: deps.git, deps,
          spawnFn: () => { spawns++; throw new Error('parked overlay spawned a worker'); } })
        : await runOverlayMainSync({ root, ref, env, deps });
      if (retryPath === 'scheduler' ? result.started.length !== 0 || !result.skipped.includes(ref)
        : !result.skipped || result.reason !== 'parked') violations.push('retry did not retain the parked stop');
    };
    await retry();
    checkPending();
    unlinkSync(blocker);
    await retry();
    const delivered = replay({ path: env.WE_NEEDS_YOU_FEED });
    if (delivered.length !== 1 || delivered[0]?.kind !== 'overlay-main-sync-parked'
      || delivered[0]?.head !== `${ref}@${tip}`
      || delivered[0]?.ref !== ref || delivered[0]?.pr !== 123
      || !delivered[0]?.reason.includes('parked after 3 failures')) violations.push('recovered feed did not receive exactly one NEEDS-YOU for the parked overlay');
    const acknowledgedAt = state().failureAlertedAt[ref];
    if (!Number.isFinite(acknowledgedAt)) violations.push('successful delivery did not acknowledge the park alert');
    await retry();
    if (JSON.stringify(replay({ path: env.WE_NEEDS_YOU_FEED })) !== JSON.stringify(delivered)) violations.push('later pass duplicated or changed the delivered NEEDS-YOU');
    if (state().failureAlertedAt[ref] !== acknowledgedAt) violations.push('later pass changed the delivery acknowledgement');
    if (alerts().length !== 1) violations.push('feed retry duplicated the local diagnostic');
    if (testCalls !== 3 || pushes || spawns) violations.push('parked retry ran tests, published code or spawned a worker');
    if (events.length !== eventCount || events.filter(event => event.kind === 'overlay-main-sync-failed').length !== 3
      || events.filter(event => event.kind === 'overlay-main-sync-parked').length !== 1) violations.push('parked retries changed failure or parking events');
    return violations.map(violation => `${retryPath}: ${violation}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'overlay-main-sync-park-alert-pending',
  title: 'parked overlay retains a failed feed publication and delivers exactly one NEEDS-YOU on recovery',
  card: 'overlay main-sync park alert pending delivery fix',
  fixedBy: { sha: 'fffd2a5ac424b29465d9b956874c9453affa8efc', where: 'main', paths: [SOURCE] },
  fixPresent(root) {
    // The harness requires a synchronous detector. Probe the requested tree's
    // implementation in a bounded child instead of inspecting its source text.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { scenario } = await import(process.argv[1]);
      const implementation = await import(process.argv[2]);
      const violations = [...await scenario('scheduler', implementation), ...await scenario('worker', implementation)];
      process.exitCode = violations.length ? 1 : 0;
    `, import.meta.url, pathToFileURL(join(root, SOURCE)).href],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    return !result.error && result.status === 0;
  },
  async run() {
    return { violations: [...await scenario('scheduler'), ...await scenario('worker')] };
  },
  judge(report) { return report.violations; },
};
