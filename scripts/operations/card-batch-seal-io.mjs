/** Durable batch publication and resumable sealing under the admission lock (#4703). */
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireLease, atomicRecord, cardBatchStateDir, sealJobEnv, tokenOf } from './card-batch-io.mjs';
import { planPublish, planSeal, renderBatchBody } from './card-batch-seal.mjs';
import { CARD_BATCH_KINDS } from '../lib/card-batch-policy.mjs';
import { effectiveCardBatchPolicy, loadVerifyRetryMinutes, resolveVerifyRetryMinutes } from '../lib/card-batch-settings.mjs';
import { readSettings } from '../lib/settings-files.mjs';
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

/** Valid env override → declared setting → on by default. */
export function resolveAdoptDescendantHead({ env = process.env, read = readSettings } = {}) {
  const override = env.WE_CARD_BATCH_ADOPT_DESCENDANT_HEAD;
  if (override === 'on' || override === 'off') return override;
  try {
    const value = read()?.cardBatch?.adoptDescendantHead;
    return value === 'off' ? 'off' : 'on';
  } catch { return 'on'; }
}

/** Call after admission. All commands, including lane acquisition, pass through the injected runner. */
export async function publishBatch(input, opts = {}) {
  const { stateDir = CARD_BATCH_STATE_DIR, exec = batchExec, clock = Date.now, remote = 'origin',
    policy = effectiveCardBatchPolicy(), leaseMs = 3 * 60 * 60_000, crashAt, verifyRetryMinutes } = opts;
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
    // A capacity pause is honoured by every caller until `sealDueBatches` re-arms it (that is where the free-slot check lives).
    if (state.verifyRetryAfter) return { action: 'deferred', state };
    const restoreProtection = async () => {
      if (!state.restoreProtection) return;
      await gh(['pr', 'edit', String(state.pr), '--repo', repo, '--add-label', HOLD_LABEL]);
      const view = JSON.parse(await gh(['pr', 'view', String(state.pr), '--repo', repo, '--json', 'isDraft']));
      if (!view.isDraft) await gh(['pr', 'ready', String(state.pr), '--repo', repo, '--undo']);
      state.holdApplied = true;
      delete state.restoreProtection;
      save();
    };
    // Pending protection recovery must run even if a subsequent push is no longer adoptable.
    await restoreProtection();
    const advertised = String(await run('git', ['ls-remote', '--refs', remote, `refs/heads/${state.batchRef}`]))
      .trim().split(/\s+/)[0];
    if (advertised && advertised !== state.headSha && resolveAdoptDescendantHead(opts) === 'on') {
      await run('git', ['fetch', '--no-tags', remote, `refs/heads/${state.batchRef}`]);
      let descendant = true;
      try { await run('git', ['merge-base', '--is-ancestor', state.headSha, advertised]); }
      catch (error) { if (error.status !== 1) throw error; descendant = false; }
      if (descendant) {
        const messages = String(await run('git', ['log', '--format=%B', `${state.headSha}..${advertised}`]));
        // Card-Batch: is admission's MARKER; only its reconcile path may recover coordinator commits.
        if (messages.split('\n').some(line => line.startsWith('Card-Batch: '))) descendant = false;
      }
      if (descendant) {
        // Inspect every commit (including merge parents), not just the net diff: a reverted verifier edit
        // must not cross this boundary. NUL framing preserves paths; only regular top-level cards are safe.
        const changes = String(await run('git', ['log', '--format=', '--raw', '-z', '--no-renames',
          '--diff-merges=separate', `${state.headSha}..${advertised}`])).split('\0');
        if (changes.pop() !== '') descendant = false;
        for (let i = 0; descendant && i < changes.length; i += 2) {
          const header = changes[i].trim();
          const path = changes[i + 1];
          if (!/^:(?:000000|100644) (?:000000|100644) [0-9a-f]+ [0-9a-f]+ [AMD]$/.test(header)
            || !/^backlog\/[a-z0-9]+-[a-z0-9-]+\.md$/.test(path ?? '')) descendant = false;
        }
      }
      if (descendant) {
        const from = state.headSha;
        state.adoptedHeads = [...(state.adoptedHeads ?? []), { from, to: advertised, at: new Date(now()).toISOString() }];
        state.headSha = advertised;
        delete state.verificationMarker;
        delete state.verifyUnrun;
        // Persist protection recovery before any remote effect, including success followed by a local crash.
        if (state.pr) { state.holdApplied = false; state.restoreProtection = true; }
        if (state.sealedAt) state.seal = { ...state.seal, step: 'record-sealed' };
        save();
        process.stderr.write(`card-batch adopted head ${state.batchRef}: ${from}→${advertised}\n`);
      }
    }
    await restoreProtection();
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
          // Capacity, not a verdict: keep the batch and re-arm after a pause (`sealDueBatches` resets the count).
          const retryAt = now();
          const retryMinutes = resolveVerifyRetryMinutes({ now: retryAt,
            platform: { batchVerifyRetryMinutes: loadVerifyRetryMinutes({ now: retryAt }) },
            repo: { batchVerifyRetryMinutes: verifyRetryMinutes } });
          state.verifyRetryAfter = new Date(retryAt + retryMinutes * 60_000).toISOString();
          state.verifyUnrunReason = `verify did not run ${state.verifyUnrun} times: ${detail}`.slice(0, 500);
          save();
          return { action: 'deferred', state };
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

/** Probe through admission itself so crashed/expired holders can be reclaimed without an unrelated job. */
const defaultHeavyQueue = async ({ now }) => {
  const { admissionLockRoot, resolveCap, resolveFastSlots, tryAcquireSlot, releaseOwnedSlot } = await import('../readiness/heavy-admission.mjs');
  const lockRoot = admissionLockRoot(ROOT);
  const cap = resolveCap();
  const fastSlots = resolveFastSlots();
  const owner = `card-batch-capacity:${process.pid}:${randomUUID()}`;
  const slots = Array.from({ length: cap + fastSlots }, (_, i) => i);
  const acquired = tryAcquireSlot({ lockRoot, cap, owner, nowMs: now, nowIso: new Date(now).toISOString(), pid: process.pid, slots });
  if (!acquired.ok) return { freeCount: 0 };
  try { return { freeCount: 1 }; }
  finally { releaseOwnedSlot({ lockRoot, cap, owner, fastSlots }); }
};
/** An unreadable admission pool counts as full (retry next tick). The worker acquires its own slot. */
async function heavyQueueFree(read, now) {
  try { return (await read({ now }))?.freeCount > 0; } catch { return false; }
}
/** Clear the unrun count and pause under the batch lease so a running worker is never raced. */
function rearmVerify(path, now, seen) {
  const lockPath = `${path}.lock`;
  const lease = acquireLease(lockPath, `rearm:${process.pid}:${randomUUID()}`, now, 60_000);
  if (!lease) return false;
  try {
    const state = readState(path);
    // Revalidate under the lease: a worker may have renewed the pause (or replaced the batch) since the scan.
    if (state.batchRef !== seen.batchRef || state.verifyRetryAfter !== seen.verifyRetryAfter || state.sealFailure) return false;
    delete state.verifyUnrun; delete state.verifyRetryAfter; delete state.verifyUnrunReason;
    atomicRecord(path, state);
    return true;
  } finally { if (tokenOf(lockPath) === lease.token) rmSync(lockPath, { force: true }); }
}

/** Tick only scans and launches; the detached worker owns verification and the admission lease. */
export async function sealDueBatches({ now = Date.now(), stateDir = CARD_BATCH_STATE_DIR,
  policy = effectiveCardBatchPolicy(), spawn = spawnChild, readHeavyQueue = defaultHeavyQueue } = {}) {
  let files;
  try { files = readdirSync(stateDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const jobs = [];
  const errors = [];
  if (files.includes('sealed')) {
    // A broken archive must not stop the active batches below from launching; its error joins the aggregate.
    try { jobs.push(...await sealDueBatches({ now, stateDir: join(stateDir, 'sealed'), policy, spawn, readHeavyQueue })); }
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
      if (state.verifyRetryAfter && !state.sealFailure) {
        // Verify could not run (capacity): wait out the pause, then re-arm only when the heavy queue has a free slot.
        if (now < Date.parse(state.verifyRetryAfter) || !(await heavyQueueFree(readHeavyQueue, now))) continue;
        if (!rearmVerify(path, now, state)) continue;
      }
      // Any seal reason launches (count beats age in shouldSeal); the lease serialises the worker against inline sealing.
      // A PR whose hold was never confirmed relaunches too, so the unheld-draft window closes without waiting for a seal.
      // `now` was sampled at tick start; a batch admitted since has openedAt after it. Its age is zero, not an error.
      const opened = typeof state.openedAt === 'number' ? state.openedAt : Date.parse(state.openedAt);
      const at = Number.isFinite(opened) ? Math.max(now, opened) : now;
      if (!kind || (!state.sealedAt && !planPublish({ state, kind, policy, now: at }).reason && !holdPending(state))) continue;
      const child = spawn(process.execPath, [join(ROOT, 'scripts/operations/card-batch-seal-job.mjs'), `--state=${path}`],
        { cwd: ROOT, detached: true, stdio: 'ignore', env: sealJobEnv() });
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
