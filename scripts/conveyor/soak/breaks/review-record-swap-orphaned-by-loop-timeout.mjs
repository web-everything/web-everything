/** A killed loop leaves its label grandchild alive; recovery observes it without posting again. */
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, watch, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strandedRecord, appliedComment, STRANDED_HEAD } from '../../../operations/__fixtures__/stranded-record.fixture.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/operations/effect-executor.mjs';
export default {
  id: 'review-record-swap-orphaned-by-loop-timeout',
  title: 'a late orphan label swap is reconciled without a second send',
  card: 'REDTEAM-HOLD-APPLIED-EFFECT',
  fixedBy: { sha: 'HEAD', where: SOURCE, paths: [SOURCE, 'scripts/operations/review-pr-io.mjs'] },
  fixPresent(root) {
    // Behaviour probe, independent of source spellings or feature-marker strings.
    const code = `
      const { applyPendingEffects } = await import(process.argv[1]);
      const { createMemoryRunStore, newRunRecord } = await import(process.argv[2]);
      const r = newRunRecord({ id: 'probe', op: 'review-pr', input: {} });
      r.cursor = 12; r.pending = { kind: 'effect', step: 'record', stepIndex: 12 };
      r.effects = [{ key: 'probe#12#0', stepIndex: 12, step: 'record', index: 0,
        type: 'swap', payload: {}, status: 'pending', idempotent: false, attempts: 1, unknownAttempts: 1 }];
      const store = createMemoryRunStore(); store.write(r); let calls = 0;
      const sink = async () => { calls++; };
      sink.provablyApplied = async () => ({ applied: true, evidence: { commentId: 'IC_probe' } });
      try { await applyPendingEffects(r, { store, sinks: { swap: sink } }); } catch {}
      const e = store.read(r.id).effects[0];
      process.stdout.write(JSON.stringify(e.status === 'applied' && e.result?.reconciled === true && calls === 0 && e.attempts === 1));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code,
      pathToFileURL(join(root, SOURCE)).href,
      pathToFileURL(join(root, 'scripts/operations/run-store.mjs')).href], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !result.error && result.status === 0 && result.stdout === 'true';
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { applyPendingEffects } = await load(SOURCE);
    const { createMemoryRunStore } = await load('scripts/operations/run-store.mjs');
    const { createReviewPrSinks } = await load('scripts/operations/review-pr-io.mjs');
    const run = strandedRecord(); run.strandedRecordEffect = true;
    const store = createMemoryRunStore(); store.write(run);
    let orphanPosted = false, sends = 0, checks = 0;
    const dir = mkdtempSync(join(tmpdir(), 'record-swap-orphan-'));
    const loop = fork(fileURLToPath(new URL('../../../operations/__fixtures__/record-swap-orphan.fixture.mjs', import.meta.url)),
      ['loop', dir, JSON.stringify(appliedComment(run))], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let orphanPid = null;
    try {
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('orphan fixture did not start')), 10_000);
        loop.once('message', value => { clearTimeout(timer); resolve(value); });
        loop.once('error', error => { clearTimeout(timer); reject(error); });
      });
      orphanPid = ready.orphanPid;
      const exited = once(loop, 'exit'); loop.kill('SIGKILL'); await exited;
    const neverSend = () => { throw Error('duplicate label send'); };
    const readComments = () => { checks++; return existsSync(join(dir, 'comment.json')) ? [JSON.parse(readFileSync(join(dir, 'comment.json'), 'utf8'))] : []; };
    const original = createReviewPrSinks({ root: dir, cwd: dir, runStore: store, runNode: neverSend, postComment: neverSend,
      env: { WE_REVIEW_START_EARLY: 'on' }, readPublishHead: () => STRANDED_HEAD,
      publishGate: () => ({ allowed: true, headSha: STRANDED_HEAD }), out: () => {},
      labelProvider: { readPrState: () => ({ state: 'OPEN', headRefOid: STRANDED_HEAD,
        labels: [{ name: 'review:accepted' }] }), readComments, setLabels: neverSend },
      readCompleteComments: readComments,
    })['review.label-swap'];
    const sink = (...args) => { sends++; return original(...args); };
    sink.provablyApplied = original.provablyApplied;
    // Deliberately hostile fallback: it must not authorize re-sending in pinned recovery.
    sink.provablyNotApplied = () => true;
    const options = { store, sinks: { 'review.label-swap': sink }, strandedRecordEffect: true, resumeOnly: true };
    const violations = [];
    try { await applyPendingEffects(store.read(run.id), options); } catch { /* expected refusal */ }
    if (store.read(run.id).effects[0].status !== 'pending') violations.push('failed first check did not leave pending');
    if (sends !== 0) violations.push('first check re-sent the label effect');
    // The already-running grandchild posts after the failed check, before the next sweep.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { watcher.close(); reject(Error('surviving grandchild did not publish')); }, 10_000);
      const watcher = watch(dir, () => {
        if (!existsSync(join(dir, 'comment.json'))) return;
        clearTimeout(timer); watcher.close(); resolve();
      });
      writeFileSync(join(dir, 'publish'), 'post after failed evidence check');
    });
    orphanPosted = true;
    try { await applyPendingEffects(store.read(run.id), options); } catch { /* diagnosed below */ }
    const entry = store.read(run.id).effects[0];
    if (entry.status !== 'applied' || entry.result?.reconciled !== true) violations.push('next sweep did not reconcile the late orphan');
    if (entry.attempts !== 1 || entry.unknownAttempts !== 1) violations.push('reconciliation changed attempt counters');
    if (sends !== 0) violations.push('recovery sent a second comment');
    if (checks !== 2) violations.push('both sweeps must read complete applied evidence');
    log?.(`orphan posted=${orphanPosted}, sends=${sends}, checks=${checks}, status=${entry.status}`);
    return { violations, sends, checks, entry };
    } finally {
      if (loop.exitCode === null && loop.signalCode === null) { const exited = once(loop, 'exit'); loop.kill('SIGKILL'); await exited; }
      if (orphanPid) { try { process.kill(orphanPid, 'SIGKILL'); } catch { /* already exited */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge: report => report.violations,
};
