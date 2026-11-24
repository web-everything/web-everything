import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
function probe(root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url))) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { mkdtempSync, rmSync } from 'node:fs';
    import { timeoutFixture } from './scripts/lib/__tests__/fixtures/mq-timeout.mjs';
    const root = mkdtempSync(process.env.TMPDIR + '/mq-timeout-soak-');
    try {
      const f = timeoutFixture(root), held = f.guard().hold, first = await f.retry();
      const enqueued = first.retry && f.enqueue(first.sameHeadAdmission);
      const second = await timeoutFixture(root).retry();
      if (second.retry) f.enqueue(second.sameHeadAdmission);
      // Replay the first callback too: an already-queued result must not mutate again.
      if (first.retry) f.enqueue(first.sameHeadAdmission);
      console.log(JSON.stringify({ violations: held && first.retry && enqueued.ok && !second.retry && f.mutations() === 1
        ? [] : ['timeout retry did not enqueue exactly once'] }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  `], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  try { if (child.status === 0) return JSON.parse(child.stdout); } catch {}
  return { violations: ['timeout retry probe unavailable'] };
}
export default { id: 'mq-timeout-same-head', title: 'pure Vitest timeout heals a held MQ head once across drain passes',
  card: 'same-head timeout recovery', fixedBy: { sha: '77885e4db6feec698e901b0a928a87e9f9120647', where: 'lane/drain-mq-flake-narrow', paths: ['scripts/lib/drain-mq-failure-recovery.mjs', 'scripts/lib/drain-mq-failure-recovery-io.mjs'] },
  fixPresent(root) {
    return spawnSync('git', ['merge-base', '--is-ancestor', this.fixedBy.sha, 'HEAD'],
      { cwd: root, stdio: 'ignore', timeout: 30000 }).status === 0;
  }, async run() { return probe(); }, judge: report => report.violations,
};
