/** Durable batch publication and resumable sealing under the admission lock (#4703). */
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireLease, atomicRecord, cardBatchStateDir, tokenOf } from './card-batch-io.mjs';
import { planPublish, planSeal, renderBatchBody } from './card-batch-seal.mjs';
import { CARD_BATCH_KINDS } from '../lib/card-batch-policy.mjs';
import { effectiveCardBatchPolicy } from '../lib/card-batch-settings.mjs';
import { readVerifyMarker, VERIFY_FILENAME } from '../lib/lane-verify.mjs';
import { extractSubmitResult } from './open-pr.mjs';
import { parseRunJsonTail } from './land-prevention-card.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CARD_BATCH_STATE_DIR = cardBatchStateDir();
export const HOLD_LABEL = 'review-status:draft-withdrawn';
/** Unrun verifies tolerated before the batch is held for a person; keeps a permanently broken verify from looping forever. */
export const VERIFY_UNRUN_CAP = 3;
const refuse = reason => ({ action: 'refuse', reason });
export const batchExec = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 30_000, ...options,
});
const readState = path => JSON.parse(readFileSync(path, 'utf8'));
/** Hold already lifted once the seal has passed `remove-hold`; re-asserting it then would undo a verified seal. */
const holdReleased = state => ['remove-hold', 'ready', 'label-on-green'].includes(state.seal?.step);
const holdPending = state => Boolean(state.pr) && !state.holdApplied && !holdReleased(state);
const kindOf = (state, path) => state.kind ?? CARD_BATCH_KINDS.find(kind => path.endsWith(`-${kind}.json`));

/** Call after admission. All commands, including lane acquisition, pass through the injected runner. */
export async function publishBatch(input, opts = {}) {
  const { stateDir = CARD_BATCH_STATE_DIR, exec = batchExec, clock = Date.now, remote = 'origin',
    policy = effectiveCardBatchPolicy(), leaseMs = 3 * 60 * 60_000, crashAt } = opts;
  const now = () => new Date(clock()).getTime();
  const statePath = resolve(input.statePath ?? join(stateDir, `${input.source.repo.replaceAll('/', '-')}-${input.kind}.json`));
  mkdirSync(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  const lease = acquireLease(lockPath, `seal:${process.pid}:${randomUUID()}`, now(), leaseMs);
  if (!lease) return refuse('lease-held');
  let acquired;
  let bodyPath;
  let gitDir;
  let cwd = input.laneDir ?? ROOT;
  const run = (command, args, extra = {}) => exec(command, args, { cwd, ...extra });
  const gh = args => opts.gh ? opts.gh(args, { cwd }) : run('gh', args);
  const held = () => tokenOf(lockPath) === lease.token && now() < lease.expiresAt;
  const checkpoint = step => { if (crashAt === step) throw new Error(`card batch crash: ${step}`); };
  try {
    let state = readState(statePath);
    // A terminal generation is archived before its active slot becomes a sequence-only successor seed.
    if (!state.batchRef && state.lastSealedState) {
      state = readState(state.lastSealedState);
      return { action: state.sealFailure ? 'held' : 'sealed', state };
    }
    const kind = input.kind ?? kindOf(state, statePath);
    const repo = state.repo ?? state.members[0]?.source.repo;
    const check = async () => {
      if (!held()) return 'lease-held';
      const advertised = String(await run('git', ['ls-remote', '--refs', remote, `refs/heads/${state.batchRef}`])).trim().split(/\s+/)[0];
      return advertised === state.headSha ? null : 'head-mismatch';
    };
    const save = () => {
      if (!held()) throw new Error('lease-held');
      state.lease = { owner: lease.owner, expiresAt: lease.expiresAt };
      atomicRecord(statePath, state);
    };
    const retire = () => {
      if (basename(dirname(statePath)) === 'sealed') return;
      if (!held()) throw new Error('lease-held');
      const archiveDir = join(dirname(statePath), 'sealed');
      mkdirSync(archiveDir, { recursive: true });
      const archivePath = join(archiveDir, `${repo.replaceAll('/', '-')}-${state.seq}-${kind}.json`);
      atomicRecord(archivePath, { ...state, kind, repo });
      atomicRecord(statePath, { seq: state.seq, lastSealedState: archivePath });
    };
    if (state.sealFailure) { retire(); return { action: 'held', state }; }
    if (state.seal?.step === 'label-on-green') { retire(); return { action: 'sealed', state }; }
    let mismatch = await check();
    if (mismatch) return refuse(mismatch);
    const plan = planPublish({ state, kind, policy, now: now() });
    bodyPath = `${statePath}.${lease.token}.body.md`;
    writeFileSync(bodyPath, renderBatchBody(state));
    const acquireCheckout = async () => {
      const acquire = pin => run('node', [join(ROOT, 'scripts/lane-pool.mjs'), 'acquire',
        '--purpose=card-batch-seal', '--ttl-minutes=180', ...(pin ? [`--lane=${pin}`] : []), '--json'], { timeout: 3 * 60_000 });
      // The remembered lane is a preference, not a requirement: once released it may be leased by anyone (live
      // 2026-10-10: lane-2 went to a fix worker and every retry failed). The verify receipt is restored from
      // state below, so any lane serves.
      try { acquired = parseRunJsonTail(await acquire(state.sealLane)); }
      catch (error) { if (!state.sealLane) throw error; acquired = parseRunJsonTail(await acquire(null)); }
      if (!acquired?.path || acquired.lane == null || !acquired.holder) throw new Error('lane acquisition failed');
      cwd = acquired.path;
      await run('git', ['fetch', '--no-tags', remote, `refs/heads/${state.batchRef}`]);
      if (String(await run('git', ['rev-parse', 'FETCH_HEAD'])).trim() !== state.headSha) throw new Error('head-mismatch');
      await run('git', ['checkout', '--detach', state.headSha], { env: { ...process.env, LANE_SESSION: acquired.holder } });
      gitDir = String(await run('git', ['rev-parse', '--absolute-git-dir'])).trim();
      if (state.verificationMarker?.sha === state.headSha && state.verificationMarker.status === 'green') {
        // Preserve the actual verify receipt across release/reacquire; never synthesize a green marker.
        atomicRecord(join(gitDir, VERIFY_FILENAME), state.verificationMarker);
      }
      state.sealLane = acquired.lane;
      save();
    };
    if (!state.pr || state.sealedAt || input.reason || plan.reason) {
      try { await acquireCheckout(); }
      catch (error) { if (error.message === 'head-mismatch') return refuse('head-mismatch'); throw error; }
    }
    const open = async mode => {
      const args = [join(cwd, 'scripts/operations/run.mjs'), 'open-pr', `--ref=${state.batchRef}`,
        `--sha=${state.headSha}`, `--bodyFile=${bodyPath}`, `--mode=${mode}`, '--json'];
      if (mode === 'label-on-green') args.push('--requireVerified=true');
      let report;
      // The held draft is opened BEFORE any verify (verify runs once, on the sealed head, and label-on-green then
      // demands that green marker). pr-land requires a marker by default, so the draft open opts out explicitly;
      // live 2026-10-10 the first real batch draft was refused `unverified` without this.
      const env = mode === 'park' ? { env: { ...process.env, WE_REQUIRE_VERIFIED: '0' } } : {};
      try { report = parseRunJsonTail(await run('node', args, { timeout: 45 * 60_000, ...env })); }
      catch (error) { report = parseRunJsonTail(error.stdout); if (!report) throw error; }
      const submit = extractSubmitResult(report);
      if (submit.outcome !== 'opened' || !submit.pr) throw new Error(submit.reason ?? 'open-pr unrun');
      if (state.pr && Number(submit.pr) !== Number(state.pr)) throw new Error('open-pr returned a different PR');
      return submit.pr;
    };
    mismatch = await check();
    if (mismatch) return refuse(mismatch);
    const opened = !state.pr;
    if (opened) {
      const pr = await open('park');
      // Record the PR before labelling, so a crash or label failure leaves a retry that re-asserts the hold.
      state = { ...state, pr, kind, repo };
      save();
    }
    if (!state.holdApplied && !holdReleased(state)) {
      // Park's review label alone does not hold green drafts. Adding a label is idempotent, so retry is safe.
      await gh(['pr', 'edit', String(state.pr), '--repo', repo, '--add-label', HOLD_LABEL]);
      state.holdApplied = true;
      save();
      checkpoint('open-draft');
    }
    if (!opened && !state.sealedAt) await gh(['pr', 'edit', String(state.pr), '--repo', repo, '--body-file', bodyPath]);
    const reason = input.reason ?? plan.reason;
    if (!reason && !state.sealedAt) return { action: plan.action, state };
    const sealPlan = planSeal({ state, reason });
    for (const step of sealPlan.steps) {
      mismatch = await check();
      if (mismatch) return refuse(mismatch);
      if (step === 'record-sealed') {
        state.sealedAt = new Date(now()).toISOString();
      } else if (step === 'verify') {
        let verified;
        try { verified = parseRunJsonTail(await run('node', [join(cwd, 'scripts/operations/run.mjs'), 'verify',
          `--checkout=${cwd}`, '--mode=run', '--json'], { timeout: 70 * 60_000 })); }
        catch (error) { verified = parseRunJsonTail(error.stdout); }
        // Only a verdict that names a real failure is terminal. A timeout, spawn error, missing verdict, or a verdict
        // whose checks did not run (ok:false with failed:0 — see assessChecks) is unknown progress: retried, bounded.
        const verdict = verified?.verdict;
        const unrun = !verdict || (!(verdict.failed > 0) && !verdict.ok && (verdict.unrun > 0 || verdict.emptySuite
          || (verdict.blocking ?? []).some(item => item?.why === 'did-not-run')));
        if (unrun) {
          state.verifyUnrun = (state.verifyUnrun ?? 0) + 1;
          const detail = JSON.stringify(verdict?.blocking ?? verified?.error ?? 'no verdict');
          if (state.verifyUnrun < VERIFY_UNRUN_CAP) { save(); throw new Error(`verify unrun: ${detail}`); }
          state.sealFailure = { reason: `verify did not run ${state.verifyUnrun} times: ${detail}`, at: new Date(now()).toISOString() };
          save();
          retire();
          return { action: 'held', state };
        }
        if (!verdict.ok) {
          state.sealFailure = { reason: JSON.stringify(verdict.blocking ?? 'verify red'), at: new Date(now()).toISOString() };
          save();
          retire();
          return { action: 'held', state };
        }
        const marker = readVerifyMarker(gitDir);
        if (marker?.sha !== state.headSha || marker.status !== 'green') throw new Error('verify receipt missing or mismatched');
        state.verificationMarker = marker;
      } else if (step === 'remove-hold') {
        await gh(['pr', 'edit', String(state.pr), '--repo', repo, '--remove-label', HOLD_LABEL]);
      } else if (step === 'ready') {
        // Query makes retry after a remote success/local crash safe: ready is not idempotent on GitHub.
        const view = JSON.parse(await gh(['pr', 'view', String(state.pr), '--repo', repo, '--json', 'isDraft']));
        if (view.isDraft) await gh(['pr', 'ready', String(state.pr), '--repo', repo]);
      } else if (step === 'label-on-green') {
        await open('label-on-green');
      }
      state.seal = { reason: sealPlan.reason, step };
      save();
      checkpoint(step);
    }
    retire();
    return { action: 'sealed', state };
  } finally {
    try {
      if (acquired?.lane != null) await exec('node', [join(ROOT, 'scripts/lane-pool.mjs'), 'release',
        `--lane=${acquired.lane}`, `--session=${acquired.holder}`], { cwd: ROOT, timeout: 3 * 60_000 });
    } finally {
      if (bodyPath) rmSync(bodyPath, { force: true });
      if (tokenOf(lockPath) === lease.token) rmSync(lockPath, { force: true });
    }
  }
}

/** Tick only scans and launches; the detached worker owns verification and the admission lease. */
export async function sealDueBatches({ now = Date.now(), stateDir = CARD_BATCH_STATE_DIR,
  policy = effectiveCardBatchPolicy(), spawn = spawnChild } = {}) {
  let files;
  try { files = readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const jobs = [];
  const errors = [];
  if (files.includes('sealed')) {
    // A broken archive must not stop the active batches below from launching; its error joins the aggregate.
    try { jobs.push(...await sealDueBatches({ now, stateDir: join(stateDir, 'sealed'), policy, spawn })); }
    catch (error) { jobs.push(...(error.launched ?? [])); errors.push(error); }
  }
  for (const file of files.filter(file => file.endsWith('.json'))) {
    // One unreadable or throwing state must not stop later batches from launching; the first error is rethrown after the scan.
    try {
      const path = resolve(stateDir, file);
      const state = readState(path);
      if (!state.batchRef) continue;
      if (basename(stateDir) === 'sealed' && (state.sealFailure || state.seal?.step === 'label-on-green')) continue;
      const kind = kindOf(state, path);
      // Any seal reason launches (count beats age in shouldSeal); the lease serialises the worker against inline sealing.
      // A PR whose hold was never confirmed relaunches too, so the unheld-draft window closes without waiting for a seal.
      // `now` was sampled at tick start; a batch admitted since has openedAt after it. Its age is zero, not an error.
      const opened = typeof state.openedAt === 'number' ? state.openedAt : Date.parse(state.openedAt);
      const at = Number.isFinite(opened) ? Math.max(now, opened) : now;
      if (!kind || (!state.sealedAt && !planPublish({ state, kind, policy, now: at }).reason && !holdPending(state))) continue;
      const child = spawn(process.execPath, [join(ROOT, 'scripts/operations/card-batch-seal-job.mjs'), `--state=${path}`],
        { cwd: ROOT, detached: true, stdio: 'ignore' });
      // Wait only for OS launch, never child completion/verification. Launch failures reach probeErrors.
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
        child.unref();
      });
      jobs.push(path);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw Object.assign(errors[0], { launched: jobs });
  return jobs;
}
