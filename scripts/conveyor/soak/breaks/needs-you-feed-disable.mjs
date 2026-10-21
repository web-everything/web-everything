/** PR #5374: disabling a pinned producer must revoke its ownership and retire its process. */
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnKeepAlive } from '../../../lib/test-keepalive.mjs';
import { ensureNeedsYouFeedJob, superviseNeedsYouFeed } from '../../needs-you-feed-job.mjs';
import { createJobStore, selfHandle } from '../../../lib/daemon-jobs-runtime.mjs';
import { markLaunching, markClaimed } from '../../../lib/daemon-jobs.mjs';
import { runOnce, resolveSettings, replay } from '../../../operations/needs-you-feed.mjs';

const SOURCE = 'scripts/conveyor/needs-you-feed-job.mjs';
export default {
  id: 'needs-you-feed-disable',
  title: 'disabling the attention feed stops the pinned producer and fences an in-flight publication',
  card: 'PR #5374 / card 359',
  fixedBy: { sha: 'HEAD', where: 'lane/needs-you-feed', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('retireDisabledFeedJobs'); },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-feed-disable-'));
    const violations = [];
    let child;
    try {
      const jobsDir = join(dir, 'jobs'); mkdirSync(jobsDir);
      const store = createJobStore(jobsDir), at = new Date().toISOString();
      const path = join(dir, 'events.jsonl');
      const settings = resolveSettings({ env: { WE_NEEDS_YOU_FEED: path }, file: {} });
      const { record } = ensureNeedsYouFeedJob({ store, codeSha: 'a'.repeat(40), input: { settings } });
      child = spawnKeepAlive({ prelude: "process.once('SIGTERM',()=>process.exit(0));", postlude: "process.send('ready');",
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      await once(child, 'message');
      // This scenario owns the child; inject the start observation so it also runs where ps is sandboxed.
      const identity = selfHandle({ pid: child.pid, readStart: () => 'Thu Oct 15 12:00:00 2026' });
      store.update(record.id, r => markLaunching(r, { at }));
      store.update(record.id, r => markClaimed(r, { at, ...identity }));
      const owns = () => store.read(record.id)?.job.status === 'running' && store.read(record.id)?.job.handle === identity.handle;
      let resume, entered;
      const paused = new Promise(done => { resume = done; });
      const collecting = new Promise(done => { entered = done; });
      const poll = runOnce({ checkoutRoot: dir, settings: { ...settings, allowPrimary: { value: true, source: 'test' } }, owns, log: () => {},
        exec: async () => { entered(); await paused; return JSON.stringify({ ready: [{ repo: 'owner/repo', number: 12, head: 'abc' }] }); } });
      await collecting;
      const retire = r => {
        if (r.job.handle !== identity.handle) throw Error('retiring a different process');
        child.kill('SIGTERM');
      };
      await superviseNeedsYouFeed({ dir: store.dir, checkoutRoot: dir, settings: { ...settings, enabled: { value: false, source: 'settings' } },
        retire, log: () => {}, reattach: async () => { violations.push('disabled supervisor launched jobs'); } });
      resume(); await poll;
      if (owns()) violations.push('disabled producer still owns its running job');
      if (replay({ path }).length) violations.push('in-flight poll published after disable');
      if (store.list().records.length !== 1) violations.push('disable enqueued a replacement');
      await Promise.race([once(child, 'exit'), new Promise(done => setTimeout(done, 500))]);
      if (child.exitCode === null) violations.push('disabled producer process still alive');
      return { violations };
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
