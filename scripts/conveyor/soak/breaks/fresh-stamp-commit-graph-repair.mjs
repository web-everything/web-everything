/** PR #6251: a fresh healthy stamp hid later graph corruption from the tick, while every
 * read-only rebuild job deferred the heal back to that tick. Replay the job/tick handoff
 * against real Git in private temporary clones, including an unavailable heal lock.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/lib/lane-repair.mjs';
const INTERVAL = 10 * 60_000;
const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', '-c', 'commit.gpgsign=false', ...args,
], { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export default {
  id: 'fresh-stamp-commit-graph-repair',
  title: 'a tick heals graph corruption despite a fresh stamp so read-only rebuild jobs can advance the clone',
  card: 'PR #6251',
  fixedBy: {
    sha: '1736f71d43,283f8cc6c2,68a01b3ca5',
    where: 'lane/rebuild-mutation-due-loop', paths: [SOURCE],
  },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('const graphBroken =')
      && source.includes('commit-graph still unreadable after heal attempt')
      && source.includes('!damagedThrottled(dir, deepIntervalMs, now, mode)');
  },
  async run({ root = ROOT, log } = {}) {
    const { repairCloneRefs, verifyCommitGraph } = await import(pathToFileURL(join(root, SOURCE)).href);
    const { rebuildClone } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-rebuild.mjs')).href);
    const base = mkdtempSync(join(tmpdir(), 'soak-fresh-stamp-graph-'));
    const violations = [];
    const check = (ok, detail) => { if (!ok) violations.push(detail); };
    try {
      const origin = join(base, 'origin.git'), seed = join(base, 'seed'), clone = join(base, 'clone');
      git(base, 'init', '--bare', '-q', '-b', 'main', origin);
      git(base, 'clone', '-q', origin, seed);
      writeFileSync(join(seed, 'tracked.txt'), 'initial\n');
      git(seed, 'add', 'tracked.txt');
      git(seed, 'commit', '-qm', 'initial main');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      git(base, 'clone', '-q', origin, clone);
      const initialHead = git(clone, 'rev-parse', 'HEAD');
      const graph = join(clone, '.git/objects/info/commit-graph');
      const stamp = join(clone, '.git/.clone-repair-deep-checked');
      const corrupt = () => {
        git(clone, 'commit-graph', 'write', '--reachable');
        chmodSync(graph, 0o644);
        const bytes = readFileSync(graph);
        bytes[bytes.length - 30] ^= 0xff;
        writeFileSync(graph, bytes);
        if (verifyCommitGraph(clone).ok) throw Error('setup: planted graph corruption did not fail verification');
        return bytes;
      };
      if (!repairCloneRefs(clone).ok || !existsSync(stamp)) throw Error('setup: missing healthy deep-check stamp');
      const healthyStamp = readFileSync(stamp, 'utf8');
      writeFileSync(join(seed, 'tracked.txt'), 'new main\n');
      git(seed, 'add', 'tracked.txt');
      git(seed, 'commit', '-qm', 'main advances while daemon stays behind');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      const main = git(seed, 'rev-parse', 'HEAD');
      const damagedBytes = corrupt();
      let smokes = 0;
      const options = {
        root: clone, mainOnly: true, asJob: false, versions: null, skipCheck: null,
        env: { ...process.env, WE_DAEMON_STATE_DIR: join(base, 'state'),
          WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'), WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'),
          WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0' },
        lockOpts: { waitMs: 1000, pollMs: 10 },
        emitEvent: async () => {}, prState: async () => 'OPEN',
        log: { error: (message) => log?.(message) },
        runSmoke: async () => { smokes++; return { verdict: 'pass', attempts: 1, smoke: { results: [] } }; },
      };
      const deferred = await rebuildClone({ ...options, readyOnly: true });
      check(deferred.reason === 'readonly-job-mutation-due'
        && deferred.mutation === 'clone-commit-graph-repair', 'job did not report the deferred graph repair');
      check(readFileSync(graph).equals(damagedBytes) && readFileSync(stamp, 'utf8') === healthyStamp
        && git(clone, 'rev-parse', 'HEAD') === initialHead, 'read-only job mutated the damaged clone');

      // No manual clone movement: only the production tick and job paths may advance it.
      if (Date.now() - Number(healthyStamp) >= INTERVAL) throw Error('setup: healthy stamp expired before the healing tick');
      const healingTick = await rebuildClone({ ...options, adoptOnly: true });
      check(verifyCommitGraph(clone).ok, 'tick left the graph corrupt behind its fresh stamp');
      check(healingTick.reason === 'needs-build' && git(clone, 'rev-parse', 'HEAD') === initialHead,
        `healing tick did not hand off a build (${healingTick.reason})`);
      const job = await rebuildClone({ ...options, readyOnly: true });
      check(job.readyRecorded === true && job.target === main && job.moved === false
        && git(clone, 'rev-parse', 'HEAD') === initialHead, `job failed to record a candidate without adoption (${job.reason})`);
      const adopted = await rebuildClone({ ...options, adoptOnly: true });
      check(adopted.moved === true && git(clone, 'rev-parse', 'HEAD') === main,
        `tick failed to adopt current main (${adopted.reason})`);
      check(git(clone, 'rev-list', '--count', 'HEAD..origin/main') === '0', 'daemon clone remained behind main');
      const settled = await rebuildClone({ ...options, readyOnly: true });
      check(settled.reason === 'up-to-date' && settled.moved === false,
        `a later job did not stay current (${settled.reason})`);
      check(smokes === 1, `expected one job smoke, observed ${smokes}`);

      // A locked heal must report damage and throttle retries, preserving the healthy stamp.
      corrupt();
      const beforeDenied = readFileSync(stamp, 'utf8');
      const lock = join(clone, '.git/.commit-graph-heal.lock');
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      const messages = [];
      const first = repairCloneRefs(clone, { log: (message) => messages.push(message) });
      const count = messages.length;
      const retry = repairCloneRefs(clone, { log: (message) => messages.push(message) });
      check(first.ok === false && retry.ok === false
        && retry.problems.some((p) => p.includes('commit-graph still unreadable')),
        'unavailable heal lock was stamped healthy instead of reporting damage');
      check(messages.length === count && readFileSync(stamp, 'utf8') === beforeDenied,
        'damaged-clone retry repeated a heal or refreshed the healthy stamp');
      rmSync(lock, { recursive: true });
      const recovered = repairCloneRefs(clone, { now: Date.now() + INTERVAL + 1 });
      check(recovered.ok === true && verifyCommitGraph(clone).ok, 'repair did not recover after the throttle expired');
    } finally { rmSync(base, { recursive: true, force: true }); }
    return { violations };
  },
  judge: (report) => report.violations,
};
