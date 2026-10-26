/** PR #5934: parent comment reads and suspended acts must retain authoritative permission. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore } from '../../../lib/daemon-jobs-runtime.mjs';
import { defineJobKind, markClaimed, markLaunching } from '../../../lib/daemon-jobs.mjs';
import { createRecordingFacts, enqueueItemTask, runItemTask } from '../../../lib/daemon-item-tasks.mjs';

const SOURCE = 'scripts/lib/daemon-item-tasks.mjs';
const identity = { repo: 'owner/repo', item: 5754 };
const declaration = { name: 'label', inputs: ['pull'], fences: ['pull'], appliedProbe: 'live-label', precondition: 'none' };
const liveThread = { source: 'live-thread', complete: true };
const facts = thread => createRecordingFacts({
  load: () => ({ identity, observedAt: 1000, complete: true, source: 'live-pr', thread,
    data: { pull: { comments: [] } } }),
  expectedIdentity: identity, now: 1100, snapshotMaxAgeMs: 200,
});

async function scenario(boundary) {
  const dir = mkdtempSync(join(tmpdir(), 'item-task-authority-'));
  try {
    const store = createJobStore(join(dir, 'jobs'));
    const queued = enqueueItemTask({ store, kindDef: defineJobKind({ kind: 'fix', entry: 'job.mjs' }),
      ...identity, seq: 1, codeSha: 'abc', acting: true, resourceKind: 'build', policyOptions: { platform: null, env: {} } });
    const at = '2026-10-25T21:00:00.000Z', handle = 'soak:1:start';
    const running = store.update(queued.id, r => markClaimed(markLaunching(r, { at }),
      { at, handle, host: 'soak', pid: 1, procStart: 'start' }));
    const claimPath = join(dir, 'claim.txt'), receiptPath = join(dir, 'receipt.json');
    let enteredAct, resumeAct;
    const entered = new Promise(resolve => { enteredAct = resolve; });
    const resumed = new Promise(resolve => { resumeAct = resolve; });
    const pending = runItemTask({
      task: running.job.task, attempt: running.job.attempts, handle,
      record: { read: () => store.read(queued.id), update: fn => store.update(queued.id, fn) },
      read: () => facts(boundary === 'planning' ? { source: 'cached-thread', complete: false } : liveThread),
      plan: f => { f.read('pull').comments; return [declaration]; },
      claim: {
        acquire: () => { writeFileSync(claimPath, 'ours'); return 'ours'; },
        assert: token => readFileSync(claimPath, 'utf8') === token,
        release: token => { if (readFileSync(claimPath, 'utf8') === token) rmSync(claimPath); },
      },
      effects: {
        probe: ({ gh }) => gh.read(() => ({ applied: false })),
        fence: ({ gh }) => gh.read(() => facts(boundary === 'fencing' ? { source: 'cached-thread', complete: false } : liveThread)),
        act: async ({ gh }) => {
          if (boundary === 'write') { enteredAct(); await resumed; }
          return gh.write(() => { writeFileSync(receiptPath, '{"label":"ready"}'); return { receipt: 'written' }; });
        },
      },
      budgets: { read: 2, write: 1 },
    });
    if (boundary === 'write') {
      await Promise.race([entered, pending.then(() => { throw Error('task finished before the act suspension'); })]);
      writeFileSync(claimPath, 'revoked');
      resumeAct();
    }
    const result = await pending;
    const expected = boundary === 'write' ? 'superseded' : 'deferred-read';
    const violations = [];
    if (result.outcome !== expected) violations.push(`${boundary}: outcome ${result.outcome}, expected ${expected}`);
    if (existsSync(receiptPath) || result.gh.write !== 0) violations.push(`${boundary}: unauthorized remote write executed`);
    const saved = store.read(queued.id);
    if (saved.job.task.failureCount !== 0) violations.push(`${boundary}: failure charged for denied authority`);
    if (boundary === 'write' && Object.values(saved.job.task.execution.effects)[0]?.status !== 'intent') {
      violations.push('write: durable intent lost before reconciliation');
    }
    return violations;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default {
  id: 'item-task-authority-lost-before-write',
  title: 'PR #5934: incomplete parent comment facts and revoked item claims cannot authorize a write',
  card: 'we:backlog/5754',
  fixedBy: { sha: 'HEAD', where: 'lane/5754-task-core-2', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('containsComments(value)') && source.includes("if (kind === 'write') await assertClaim();");
  },
  async run() {
    const violations = [];
    for (const boundary of ['planning', 'fencing', 'write']) violations.push(...await scenario(boundary));
    return { violations };
  },
  judge: report => report.violations,
};
