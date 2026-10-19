/**
 * Shadow-only pipeline orchestration. No production writer capability is accepted.
 * Production decisions are supplied by their owners; this module never invents a hold rule.
 * Unknown side-effecting gates refuse; list agreement is not proof of serial-path parity.
 */
import { mapWithConcurrency } from './drain-concurrency.mjs';
import { resolveCascade, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { execDrainAsync } from './drain-gh-async.mjs';
import { fileURLToPath } from 'node:url';
import { savedRedTeamRunsDir } from './saved-red-team-provenance.mjs';
import { classifyGhRead, isGhGraphqlReadQuery } from './gh-throttle.mjs';
import { hostLoadAdmission } from './host-load.mjs';
import { readDrainRedTeamEvidence } from './drain-red-team-evidence.mjs';
import { readDrainQueueSafety, redTeamEnqueueHold, sendBackReason } from './drain-queue-safety.mjs';
import { readQueueState, queueStatePath } from './drain-merge-strategy.mjs';
import { planCoupleCascadeStep, candKey, isImplHalf, isCoupleCarrier } from './couple-cascade.mjs';
import { completeListedFiles, readQueueEntryFiles, queueFileOverlap } from './queue-file-overlap.mjs';
import { resolveBatchingSettings, readQueueFacts, batchingStatePath, initialBatchingState, admitEnqueue } from './merge-queue-adaptive-batching.mjs';

const identity = p => `${p.repo ?? 'cwd'}#${p.num}`;
const bucket = p => p.reviewHeld ? 'held' : p.decision === 'merge' && !p.prestagePendingCi ? 'candidate' : 'waiting';
const errorText = e => String(e?.message ?? e).replace(/[\r\n]+/g, ' ').slice(0, 300);
const normalize = block => ({ mode: typeof block?.pipeline === 'string' ? block.pipeline : block?.pipeline?.mode,
  workers: block?.['pipeline.workers'] ?? block?.pipeline?.workers,
  timeoutMs: block?.['pipeline.timeoutMs'] ?? block?.pipeline?.timeoutMs,
  graceMs: block?.['pipeline.graceMs'] ?? block?.pipeline?.graceMs });

/** Scalar drain.pipeline and literal pipeline.workers leaf share the existing cascade. */
export function resolvePipelineSettings({ tool, platform, env = process.env } = {}) {
  const r = resolveCascade({ standard: { mode: 'shadow', workers: 4, timeoutMs: 240000, graceMs: 60000 },
    tool: normalize(tool ?? readSettings().drain), platform: normalize(platform ?? platformPreference('drain', { env })),
    envValues: { mode: env.WE_DRAIN_PIPELINE, workers: env.WE_DRAIN_PIPELINE_WORKERS === undefined ? undefined : Number(env.WE_DRAIN_PIPELINE_WORKERS),
      timeoutMs: env.WE_DRAIN_PIPELINE_TIMEOUT_MS === undefined ? undefined : Number(env.WE_DRAIN_PIPELINE_TIMEOUT_MS),
      graceMs: env.WE_DRAIN_PIPELINE_GRACE_MS === undefined ? undefined : Number(env.WE_DRAIN_PIPELINE_GRACE_MS) },
    valid: { mode: v => ['off', 'shadow', 'on'].includes(v), workers: v => Number.isSafeInteger(v) && v > 0,
      timeoutMs: v => Number.isSafeInteger(v) && v > 0 && v <= 600000,
      graceMs: v => Number.isSafeInteger(v) && v >= 0 && v <= 600000 },
  });
  return { ...r.value, source: r.sources.mode, workersSource: r.sources.workers, timeoutSource: r.sources.timeoutMs, graceSource: r.sources.graceMs, invalid: r.invalid };
}

/** Stage 2 runs over ALL rows before stage 3 starts. prepare must be an admitted, abortable read-only callback. */
export async function preparePipeline({ prs = [], classify = bucket, prepare, workers = 4, signal, onRows = () => {}, now = performance.now.bind(performance) } = {}) {
  const rows = prs.map(pr => ({ pr: structuredClone(pr), classification: classify(pr), prep: null, prepMs: null }));
  onRows(rows);
  const candidates = rows.filter(r => r.classification === 'candidate');
  if (typeof prepare !== 'function') return { ok: false, error: 'read-only preparation adapter unavailable', rows, wallMs: null };
  const started = now();
  await mapWithConcurrency(candidates, workers, async row => {
    if (signal?.aborted) return;
    const start = now();
    try { row.prep = await prepare(row.pr, { signal }); }
    catch (e) { row.error = errorText(e); }
    finally { row.prepMs = now() - start; }
  });
  const incomplete = candidates.some(r => r.error || !['merge', 'skip'].includes(r.prep?.decision));
  return { ok: !incomplete, ...(incomplete ? { error: 'one or more prep reads failed' } : {}), rows, wallMs: now() - started };
}

/**
 * Serial stage-4 PROJECTION, never a committer. Order and queue decisions belong to production.
 * No supplied queue guard means unknown, never clearance. Unknown heads also fail closed.
 */
export async function projectPrepared({ prepared = [], ordered = [], readHead, queueGuard, signal } = {}) {
  const byKey = new Map(prepared.map(r => [identity(r.pr), r]));
  const wouldEnqueue = []; const decisions = [];
  if (typeof readHead !== 'function' || typeof queueGuard !== 'function')
    return { ok: false, wouldEnqueue, decisions, error: 'read-only commit projection adapter unavailable' };
  const orderedRows = typeof ordered === 'function' ? await ordered({ signal }) : ordered;
  for (const pr of orderedRows) {
    if (signal?.aborted) break;
    const row = byKey.get(identity(pr));
    if (row?.classification !== 'candidate' || row.prep?.decision !== 'merge') continue;
    let reason = null;
    try {
      const head = await readHead(row.pr, { signal });
      if (!row.prep.headSha || !head || head !== row.prep.headSha) reason = 'head changed since prep';
      else {
        // Queue file-overlap, coupling and batching run serially, against the prior projected admissions.
        const guard = await queueGuard(row.pr, { prepared: row.prep, admitted: [...wouldEnqueue], signal });
        if (guard?.allowed !== true) reason = guard?.reason ?? 'queue guard refused';
      }
    } catch (e) { reason = `unknown: queue/head read failed: ${errorText(e)}`; }
    if (!signal?.aborted && !reason) wouldEnqueue.push(identity(pr));
    decisions.push({ pr: identity(pr), allowed: !reason && !signal?.aborted, reason });
  }
  return { ok: true, wouldEnqueue, decisions };
}

// Keep argument evaluation inside the boundary: adapters and their inputs can throw too.
function logShadowFailure(phase, error, log = line => process.stderr.write(`${line}\n`)) {
  try { log(`[drain-daemon] ${new Date().toISOString()} drain-pipeline(shadow): ${phase} failed: ${errorText(error)}`); }
  catch { /* Even a broken diagnostic sink must not fail the real drain. */ }
}

export function setupPipelineShadow(build, { log } = {}) {
  try { return build(); }
  catch (error) {
    logShadowFailure('setup', error, log);
    return { done: Promise.resolve(), finish() {} };
  }
}

export function finishPipelineShadow(shadow, facts, { log } = {}) {
  try {
    // Attach immediately in case a future finish implementation becomes asynchronous.
    Promise.resolve(shadow.finish(facts())).catch(error => logShadowFailure('finish', error, log));
  } catch (error) { logShadowFailure('finish', error, log); }
}

/**
 * Start alongside the real pass. finish() records its outcomes without awaiting shadow.
 * One record is emitted after both completion and finish, including on failure or timeout.
 * Abort-aware reads must stop on signal: racing a promise cannot stop synchronous IO.
 */
export function startPipelineShadow(options = {}) {
  let settings;
  try { settings = options.settings ?? resolvePipelineSettings(); }
  catch (e) { settings = { mode: 'shadow', workers: 4, timeoutMs: 240000, graceMs: 60000, source: 'unreadable', error: errorText(e) }; }
  const { log = line => process.stderr.write(`${line}\n`), now = performance.now.bind(performance), timeoutMs = settings.timeoutMs ?? 240000 } = options;
  let result; let actual; let emitted = false;
  const controller = new AbortController();
  const emit = () => {
    if (emitted || !actual || !result) return;
    emitted = true;
    try {
      const real = [...new Set((actual.actual ?? []).map(identity))];
      const predicted = result.ok ? result.wouldEnqueue : null;
      const onlyShadow = predicted?.filter(k => !real.includes(k)) ?? null;
      const onlyActual = predicted ? real.filter(k => !predicted.includes(k)) : null;
      const serialMs = Number.isFinite(actual.serialReadyMs) ? actual.serialReadyMs : null;
      const shadowMs = result.ok ? result.readyMs : null;
      const record = { settings, workers: options.workers ?? settings.workers, decisions: result.decisions ?? [],
        preparations: (result.rows ?? []).map(r => ({ pr: identity(r.pr), classification: r.classification,
          decision: r.prep?.decision ?? (r.classification !== 'candidate' ? r.pr.decision : null),
          reason: r.prep?.reason ?? r.error ?? (r.classification !== 'candidate' ? r.pr.reason : null) ?? null,
          prepMs: r.prepMs, unknown: r.prep?.unknown ?? [] })), complete: result.ok, error: result.error ?? null,
        wouldEnqueue: predicted, actual: real, samePrs: predicted ? !onlyShadow.length && !onlyActual.length : null,
        diff: { onlyShadow, onlyActual }, prepDurations: (result.rows ?? []).filter(r => r.prepMs !== null).map(r => ({ pr: identity(r.pr), ms: r.prepMs })),
        prepWallMs: result.wallMs ?? null, serialReadyMs: serialMs, mergeCascadeMs: actual.timings?.mergeCascade ?? null,
        timeToReady: { shadowMs, serialMs, savedMs: shadowMs !== null && serialMs !== null ? serialMs - shadowMs : null } };
      log(`[drain-daemon] ${new Date().toISOString()} drain-pipeline(${settings.mode}): ${JSON.stringify(record)}`);
    } catch { /* Logging is never allowed to fail the drain. */ }
  };
  const finish = facts => { actual ??= facts; emit(); };
  if (settings.mode !== 'shadow') {
    result = { ok: false, error: settings.mode === 'on' ? 'on is inert: production committer not implemented' : 'disabled' };
    return { done: Promise.resolve(result), finish, graceMs: settings.graceMs ?? 60000 };
  }
  let timer;
  const started = now();
  let prepRows = []; let prepWallMs = null; let settleTimeout;
  const cancel = reason => {
    if (result) return;
    controller.abort();
    result = { ok: false, error: reason, rows: prepRows, wallMs: prepWallMs ?? now() - started };
    clearTimeout(timer); settleTimeout(result); emit();
  };
  const work = Promise.resolve().then(async () => {
    const prep = await preparePipeline({ ...options, workers: options.workers ?? settings.workers, signal: controller.signal, now, onRows: rows => { prepRows = rows; } });
    prepWallMs = prep.wallMs;
    if (!prep.ok) return prep;
    const projected = await projectPrepared({ ...options, prepared: prep.rows, signal: controller.signal });
    return { ...prep, ...projected, readyMs: (options.passElapsedMs ?? 0) + now() - started };
  }).catch(e => ({ ok: false, error: errorText(e), rows: prepRows, wallMs: prepWallMs }));
  const timeout = new Promise(resolve => {
    settleTimeout = resolve;
    timer = setTimeout(() => cancel('time box exceeded'), Math.max(1, Math.min(timeoutMs, 600000)));
    timer.unref?.();
  });
  const done = Promise.race([work, timeout]).then(value => {
    clearTimeout(timer); result ??= value; emit(); return result;
  }).catch(e => { result = { ok: false, error: errorText(e) }; emit(); return result; });
  return { done, finish, cancel, graceMs: settings.graceMs ?? 60000 };
}

/** Shadow reads wait for host admission without competing for heavy slots; the shadow owns the time box. */
export async function admitPipelineRead(run, { signal, hostAdmission = hostLoadAdmission } = {}) {
  for (;;) {
    signal?.throwIfAborted();
    const host = hostAdmission({ interactive: false });
    if (host.admitted) {
      signal?.throwIfAborted();
      return await run();
    }
    await delay(2000, undefined, { signal });
  }
}

/**
 * Adapt a synchronous production READER to async throttled IO without duplicating its parsing/rules.
 * Replay only this reader's captured gh responses; never cache between calls or across heads.
 * Some readers catch IO errors internally, so a pending read is checked after return as well as throw.
 */
export async function replayPipelineReader(reader, exec, { signal } = {}) {
  const captured = new Map();
  for (;;) {
    signal?.throwIfAborted();
    let pending; let value; let failure;
    const read = (file, args, opts = {}) => {
      if (!isPipelineRead(file, args))
        throw Error('unknown: shadow reader attempted a non-read command');
      const key = JSON.stringify([args, opts]);
      if (!captured.has(key)) { pending = { key, file, args, opts }; throw Error('async read required'); }
      const response = captured.get(key);
      if (response.error) throw response.error;
      return response.stdout;
    };
    try { value = reader(read); } catch (e) { failure = e; }
    if (!pending) { if (failure) throw failure; return value; }
    try { captured.set(pending.key, await exec(pending.file, pending.args, { ...pending.opts, signal })); }
    catch (error) { captured.set(pending.key, { error }); }
  }
}

/** Cancel the throttle CLI AND its gh child, so neither pipes nor a live API read outlast the pass.
 * The detached process group belongs only to this read. The ordinary drain executor is unchanged.
 */
const pipelineModule = fileURLToPath(import.meta.url);
const isPipelineRead = (file, args) => file === 'gh'
  ? classifyGhRead(args) || isGhGraphqlReadQuery(args)
  : file === process.execPath && args.length === 2 && args[0] === pipelineModule && args[1] === '--shadow-evidence';

export function pipelineProcessRead(file, args, options = {}) {
  if (!isPipelineRead(file, args))
    return Promise.reject(Error('shadow refuses non-read command'));
  const { signal, input, ...execOptions } = options;
  signal?.throwIfAborted();
  const grouped = !!signal && process.platform !== 'win32';
  const pending = execDrainAsync(file, args, { ...execOptions, signal, ...(grouped ? { detached: true } : {}) });
  const child = pending.child;
  const abort = () => {
    if (grouped && child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (input !== undefined) {
    child?.stdin?.on('error', () => {}); // Cancellation can close the pipe before the input drains.
    child?.stdin?.end(input);
  }
  return pending.finally(() => signal?.removeEventListener('abort', abort));
}

/** Only read capabilities cross this boundary. No strategy/enqueue object or writer is accepted. */
export function createPipelineReadAdapters({ prs = [], localSlug, optionsOf, enqueues,
  resolveRequiredCheck, revalidateWithUnknownRetry, planLabelDrain,
  unknownRetry, plannerOptions = {}, coupleOptions = {}, exec = pipelineProcessRead, admit = admitPipelineRead,
  readRedTeam = readPipelineRedTeam, readSafety = readDrainQueueSafety,
  readState = () => readQueueState(queueStatePath()),
} = {}) {
  const candidates = structuredClone(prs);
  const slug = p => p.repo || localSlug;
  const readJson = async (p, fields, signal) => JSON.parse((await exec('gh', ['pr', 'view', String(p.num),
    '--repo', slug(p), '--json', fields], { encoding: 'utf8', signal, timeout: 120000 })).stdout);
  const projectedBatching = new Map();
  return {
    ordered: () => {
      const ready = planLabelDrain(candidates, plannerOptions).ready;
      return [...ready, ...candidates.filter(c => !ready.some(r => identity(r) === identity(c)))];
    },
    prepare: async (p, { signal } = {}) => {
      if (!enqueues(p.repo)) return { decision: 'skip', reason: 'outside enqueue strategy' };
      return admit(async () => {
        const opts = optionsOf(p);
        const verdict = await revalidateWithUnknownRetry({ opts, setting: unknownRetry,
          sleep: ms => delay(ms, undefined, { signal }),
          read: async () => resolveRequiredCheck(await readJson(p,
            'number,title,body,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,labels,commits', signal),
            { repo: slug(p), requiredCheck: opts.requiredCheck,
              exec: (file, args, options) => exec(file, args, { ...options, signal }) }),
        });
        if (verdict.decision !== 'merge') return verdict;
        const live = await readJson(p, 'headRefOid,labels,reviews', signal);
        if (live.headRefOid !== verdict.headSha || !Array.isArray(live.labels)) throw Error('live state unreadable');
        const sentBack = sendBackReason(live.labels);
        const safety = readSafety().value;
        // Same complete comment pages and evidence evaluator as enqueue; no request, label or pending-state writes.
        const pages = JSON.parse((await exec('gh', ['api', '--paginate', '--slurp',
          `repos/${slug(p)}/issues/${p.num}/comments`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120000, signal })).stdout);
        if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw Error('red-team comments unreadable');
        const state = readState();
        if (state.unreadable) throw Error('queue state unreadable');
        const pending = state.redTeamPending?.[`${p.repo || 'cwd'}#${p.num}`];
        const reason = sentBack || (safety.waitForRedTeamBeforeEnqueue ? await readRedTeam({
          repo: slug(p), pr: p.num, head: verdict.headSha, comments: pages.flat(),
          requestPending: pending?.headSha === verdict.headSha && pending.requestedAt != null,
        }, { signal }) : null);
        return { ...verdict, ...(reason ? { decision: 'skip', reason } : {}), safety,
          unknown: ['pinned workflow surface: readPinnedChangedFiles fetches git; unknown => refuse',
            'branch preparation and acceptance restamp require writers; unknown => refuse'] };
      }, { signal });
    },
    readHead: (p, { signal } = {}) => admit(async () => (await readJson(p, 'headRefOid', signal)).headRefOid, { signal }),
    queueGuard: (p, { prepared, admitted, signal } = {}) => admit(async () => {
      const refuse = reason => ({ allowed: false, reason });
      if (!Array.isArray(prepared?.unknown) || !prepared?.safety)
        return refuse('unknown: preparation guard coverage unavailable => refuse');
      const admittedRows = candidates.filter(c => admitted.includes(identity(c)));
      // Planner receives only prior shadow admissions as landed; production rows are never mutated.
      const remaining = candidates.filter(c => !admitted.includes(identity(c)));
      const plan = planLabelDrain(remaining, { ...plannerOptions, landedThisPass: new Set(admittedRows.map(c => c.item).filter(x => x != null)) });
      const coupled = planCoupleCascadeStep(plan.ready, { ...coupleOptions, candidates, mergedKeys: new Set(admittedRows.map(candKey)) });
      if (!coupled.ordered.some(c => identity(c) === identity(p))) return refuse('dependency/coupling planner refused');
      // A couple preflight also reads sibling live state/freshness; the pure grouping alone cannot clear it.
      if (isImplHalf(p) || isCoupleCarrier(p)) return refuse('unknown: live couple preflight unavailable read-only => refuse');
      const files = p.listedFilesComplete === true ? completeListedFiles(p.listedFiles) : null;
      if (!files) return refuse('unknown: candidate files incomplete => refuse');
      const queue = await replayPipelineReader(exec => readQueueEntryFiles({ repo: slug(p), exec }), exec, { signal });
      if (queue.error) return refuse(`unknown: queue files ${queue.error || 'incomplete'} => refuse`);
      const overlap = queueFileOverlap({ candidateFiles: files, includeCards: prepared.safety.queueFileOverlapIncludesCards,
        queuedEntries: [...queue.entries.filter(e => e.num !== p.num), ...admittedRows.filter(c => slug(c) === slug(p))
          .map(c => ({ num: c.num, files: c.listedFilesComplete ? completeListedFiles(c.listedFiles) : null }))] });
      if (overlap.unknown.length) return refuse('unknown: queued file lists => refuse');
      if (overlap.overlap) return refuse('queue file overlap');
      const settings = resolveBatchingSettings();
      if (settings.enabled) {
        const facts = await replayPipelineReader(exec => readQueueFacts({ repo: slug(p), exec }), exec, { signal });
        if (facts.error) return refuse(`unknown: batching queue ${facts.error} => refuse`);
        let state = projectedBatching.get(slug(p));
        if (!state) {
          try { state = JSON.parse(readFileSync(batchingStatePath(), 'utf8')); }
          catch (e) { if (e.code === 'ENOENT') state = initialBatchingState(); else return refuse('unknown: batching state unreadable => refuse'); }
        }
        const result = admitEnqueue({ state, num: p.num, nowMs: Date.now(), settings,
          inQueue: new Set([...facts.inQueue, ...admittedRows.filter(c => slug(c) === slug(p)).map(c => c.num)]) });
        if (!result.admit) return refuse(result.reason);
        // Commit projected state only if every guard clears.
        if (!prepared.unknown?.length) projectedBatching.set(slug(p), result.state);
      }
      if (prepared.unknown?.length) return refuse(`unknown: ${prepared.unknown.join('; ')}`);
      return { allowed: true };
    }, { signal }),
  };
}

/** Only this bounded end-of-pass grace lets the shadow lengthen the real pass. */
export async function awaitPipelineShadow(shadow, { graceMs = shadow.graceMs ?? 60000, log } = {}) {
  let timer;
  try {
    await Promise.race([shadow.done, new Promise(resolve => {
      timer = setTimeout(() => { try { shadow.cancel?.('end-of-pass grace exceeded'); } catch {} resolve(); }, Math.max(0, Math.min(graceMs, 600000)));
    })]);
  } catch (error) { logShadowFailure('await', error, log); }
  finally { clearTimeout(timer); }
}


/** Local evidence IO can be slow too: keep it off the real drain's event loop and inside its read slot. */
export async function readPipelineRedTeam(input, { signal, env } = {}) {
  const result = await pipelineProcessRead(process.execPath, [pipelineModule, '--shadow-evidence'], {
    input: JSON.stringify(input), signal, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  const reply = JSON.parse(result.stdout);
  if (!(reply?.reason === null || typeof reply?.reason === 'string')) throw Error('unknown: red-team reader reply');
  return reply.reason;
}

// Private read-only subprocess entry. No enqueue strategy, migration, request, label or git writer is invoked.
if (process.argv[1] === pipelineModule && process.argv[2] === '--shadow-evidence') {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const evidence = readDrainRedTeamEvidence({ repo: input.repo, pr: input.pr, head: input.head,
      runsDir: savedRedTeamRunsDir(process.env) });
    process.stdout.write(JSON.stringify({ reason: redTeamEnqueueHold({ ...evidence, ...input }) }));
  } catch (error) {
    process.stderr.write(`shadow evidence read failed: ${errorText(error)}\n`);
    process.exitCode = 1;
  }
}
