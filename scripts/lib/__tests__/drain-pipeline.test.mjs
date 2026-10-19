// @vitest-environment node
// Real subprocess cancellation requires Node's AbortSignal, not happy-dom's browser shim.
import { describe, it, expect, vi } from 'vitest';
import * as throttle from '../drain-gh-async.mjs';
import * as batching from '../merge-queue-adaptive-batching.mjs';
import * as heavy from '../../readiness/heavy-admission.mjs';
import * as hostLoad from '../host-load.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolvePipelineSettings, preparePipeline, projectPrepared, startPipelineShadow, setupPipelineShadow, finishPipelineShadow, createPipelineReadAdapters, awaitPipelineShadow, pipelineProcessRead, replayPipelineReader, admitPipelineRead, readPipelineRedTeam } from '../drain-pipeline.mjs';
import { classifyPr, revalidateForMerge, planLabelDrain } from '../../merge-ai-prs.mjs';
import { queueFileOverlap } from '../queue-file-overlap.mjs';
import { planCoupleCascadeStep } from '../couple-cascade.mjs';

const key = p => `${p.repo ?? 'cwd'}#${p.num}`;
const rows = [
  { num: 1, decision: 'skip', reviewHeld: true, item: 1, blockedBy: [] },
  { num: 2, decision: 'skip', reason: 'required check pending', item: 2, blockedBy: [] },
  { num: 3, decision: 'merge', item: 3, blockedBy: [] },
  { num: 4, decision: 'merge', item: 4, blockedBy: [] },
  { num: 5, decision: 'merge', item: 5, blockedBy: [1] },
].map(p => ({ ...p, listedHeadSha: `head-${p.num}` }));
const classify = p => p.reviewHeld ? 'held' : p.decision === 'merge' ? 'candidate' : 'waiting';
const prepare = async p => ({ decision: 'merge', headSha: p.listedHeadSha });
const readHead = async p => p.listedHeadSha;
// SAME production dependency/coupling planner on both paths; queue-overlap verdict is supplied by its reader.
const priority = planLabelDrain(rows).ready;
const queueGuard = async p => {
  const overlap = queueFileOverlap({ candidateFiles: [`file-${p.num}`], queuedEntries: [{ num: 99, files: ['file-4'] }], includeCards: true });
  return { allowed: !overlap.overlap, reason: overlap.overlap ? 'queue file overlap' : null };
};
const settings = () => resolvePipelineSettings({ tool: {}, platform: {}, env: {} });

describe('drain pipeline shadow', () => {
  it.each(['adapter construction', 'shadow construction'])('contains %s errors and returns a usable no-op shadow', async phase => {
    const log = vi.fn();
    const shadow = setupPipelineShadow(() => {
      if (phase === 'adapter construction') return startPipelineShadow({ ...createPipelineReadAdapters({ prs: [() => {}] }) });
      return startPipelineShadow({ settings: settings(), now: () => { throw Error('broken clock\nsecond line'); } });
    }, { log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^\[drain-daemon\] \d{4}-.* drain-pipeline\(shadow\): setup failed: [^\r\n]+$/);
    await expect(shadow.done).resolves.toBeUndefined();
    expect(() => shadow.finish({ actual: [] })).not.toThrow();
    await expect(awaitPipelineShadow(shadow)).resolves.toBeUndefined();
  });

  it('contains finish argument, synchronous finish, asynchronous finish and await failures', async () => {
    const log = vi.fn();
    const error = () => { throw Error('shadow failure'); };
    const cases = [
      [{ finish: vi.fn() }, error],
      [{ finish: error }, () => ({})],
      [{ finish: async () => { throw Error('async finish'); } }, () => ({})],
    ];
    for (const [shadow, facts] of cases) {
      expect(() => finishPipelineShadow(shadow, facts, { log })).not.toThrow();
    }
    await Promise.resolve();
    expect(log).toHaveBeenCalledTimes(3);
    for (const shadow of [{ done: Promise.reject(Error('rejected work')) }, { get done() { error(); } }]) {
      await expect(awaitPipelineShadow(shadow, { log })).resolves.toBeUndefined();
    }
    expect(log).toHaveBeenCalledTimes(5);
    const brokenLog = () => { throw Error('broken logger'); };
    expect(() => setupPipelineShadow(error, { log: brokenLog })).not.toThrow();
    expect(() => finishPipelineShadow({ finish: error }, () => ({}), { log: brokenLog })).not.toThrow();
    await expect(awaitPipelineShadow({ get done() { error(); } }, { log: brokenLog })).resolves.toBeUndefined();
  });

  it('declares every external hook identifier before constructing the live shadow', () => {
    const path = fileURLToPath(new URL('../../merge-ai-prs.mjs', import.meta.url));
    const program = ts.createProgram([path], { allowJs: true, noResolve: true, noLib: true });
    const source = program.getSourceFile(path);
    const checker = program.getTypeChecker();
    let hook;
    const find = node => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'pipelineShadow') hook = node;
      ts.forEachChild(node, find);
    };
    find(source);
    expect(hook).toBeDefined();
    const checked = new Set();
    const inspect = node => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || (ts.isPropertyAssignment(parent) && parent.name === node);
        if (!propertyName) {
          const symbol = ts.isShorthandPropertyAssignment(parent)
            ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
          const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
          if (!declaration) expect(['Date', 'Set', 'Number']).toContain(node.text);
          else if (declaration.pos < hook.pos || declaration.end > hook.end) {
            expect(declaration.end, `${node.text} must be initialized before the hook`).toBeLessThan(hook.pos);
            checked.add(node.text);
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(hook.initializer);
    expect([...checked]).toEqual(expect.arrayContaining(['repoKeyOfSlug', 'repoKeyOfVerdict',
      'UNKNOWN_RETRY', 'queueRequiredChecksOf', 'defaultBranchOf', 'mergeStrategy', 'verdicts']));
  });

  it('uses the production classifier and fresh-head decision unchanged across worker widths', async () => {
    const prs = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, headRefOid: `head-${i}`, body: 'Reviewable fix.',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [{ name: 'ready-to-merge' }, ...(i % 3 === 0 ? [{ name: 'review:changes' }] : [])],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: i % 4 ? 'SUCCESS' : 'FAILURE' }] }));
    const input = prs.map(pr => ({ ...classifyPr(pr), listedHeadSha: pr.headRefOid }));
    const read = async workers => preparePipeline({ prs: input, classify, workers, prepare: async p =>
      revalidateForMerge(prs.find(pr => pr.number === p.num), { expectedHeadSha: p.listedHeadSha }) });
    const serial = await read(1); const parallel = await read(4);
    expect(parallel.rows.map(({ pr, classification, prep }) => ({ pr, classification, prep })))
      .toEqual(serial.rows.map(({ pr, classification, prep }) => ({ pr, classification, prep })));
    expect(new Set(parallel.rows.map(r => r.classification))).toEqual(new Set(['held', 'waiting', 'candidate']));
  });

  it('matches serial decisions for held, waiting, candidate, overlap and coupled dependencies', async () => {
    const serial = await preparePipeline({ prs: rows, classify, prepare, workers: 1 });
    const pooled = await preparePipeline({ prs: rows, classify, prepare, workers: 4 });
    expect(pooled.rows.map(r => r.classification)).toEqual(['held', 'waiting', 'candidate', 'candidate', 'candidate']);
    const project = result => projectPrepared({ prepared: result.rows, ordered: priority, readHead, queueGuard });
    expect(await project(pooled)).toEqual(await project(serial));
    expect((await project(pooled)).wouldEnqueue).toEqual(['cwd#3']);
  });

  it('retains the production couple hold when the carrier is not landing', async () => {
    const carrier = { ...rows[0], num: 10, hasManifest: true, crossRepo: true };
    const impl = { ...rows[2], num: 11, repo: 'example/impl', coupleCarrier: { num: 10, repo: null } };
    const input = [carrier, impl];
    const step = planCoupleCascadeStep(planLabelDrain(input).ready, { candidates: input });
    expect(step.held.map(r => r.num)).toContain(11);
    for (const workers of [1, 4]) {
      const result = await preparePipeline({ prs: input, classify, prepare, workers });
      expect((await projectPrepared({ prepared: result.rows, ordered: step.ordered, readHead, queueGuard })).wouldEnqueue).toEqual([]);
    }
  });

  it('refuses a changed or missing head before serial projection', async () => {
    const prepared = await preparePipeline({ prs: rows, classify, prepare });
    for (const head of ['changed', null]) {
      const result = await projectPrepared({ prepared: prepared.rows, ordered: priority, readHead: async () => head, queueGuard });
      expect(result.wouldEnqueue).toEqual([]);
      expect(result.decisions.every(r => r.reason === 'head changed since prep')).toBe(true);
    }
  });

  it.each([1, 2, 4])('never exceeds %i workers and preserves priority despite out-of-order completion', async workers => {
    let active = 0; let peak = 0;
    const result = await preparePipeline({ prs: rows, classify, workers, prepare: p => admitPipelineRead(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 6 - p.num));
      active--;
      return prepare(p);
    }, { hostAdmission: () => ({ admitted: true }) }) });
    expect(peak).toBeLessThanOrEqual(workers);
    expect(result.rows.map(r => key(r.pr))).toEqual(rows.map(key));
  });

  it('has no writer capability in shadow, compares real outcomes, logs one record and source', async () => {
    const writers = { enqueue: vi.fn(), git: vi.fn(), writeFile: vi.fn(), stamp: vi.fn(), number: vi.fn(), withLock: vi.fn() };
    const log = vi.fn();
    const shadow = startPipelineShadow({ settings: settings(), prs: rows, classify, prepare, readHead,
      queueGuard, ordered: priority, log, ...writers });
    await shadow.done;
    await shadow.finish({ actual: [rows[2]], timings: { mergeCascade: 99 }, serialReadyMs: 200 });
    await shadow.finish({ actual: [] });
    for (const writer of Object.values(writers)) expect(writer).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0];
    expect(line).toMatch(/^\[drain-daemon\] .* drain-pipeline\(shadow\): /);
    const record = JSON.parse(line.slice(line.indexOf(': {') + 2));
    expect(record).toMatchObject({ samePrs: true, wouldEnqueue: ['cwd#3'], mergeCascadeMs: 99,
      settings: { mode: 'shadow', source: 'standard', workers: 4 } });
    expect(record.prepDurations).toHaveLength(3);
    expect(record.timeToReady).toMatchObject({ serialMs: 200 });
  });

  it('contains failed reads, failed loggers, and hung preparation; cancels scheduling at deadline', async () => {
    const log = vi.fn(); let started = 0;
    const shadow = startPipelineShadow({ settings: settings(), prs: rows, classify,
      workers: 1, timeoutMs: 10, prepare: async () => { started++; return new Promise(() => {}); },
      readHead, queueGuard, ordered: priority, log });
    await expect(shadow.done).resolves.toMatchObject({ ok: false, error: 'time box exceeded' });
    shadow.finish({ actual: [] });
    expect(started).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    const failed = startPipelineShadow({ settings: settings(), prs: rows, classify: () => { throw Error('read failed'); },
      prepare, log: () => { throw Error('log failed'); } });
    await expect(failed.done).resolves.toMatchObject({ ok: false });
    expect(() => failed.finish({ actual: [] })).not.toThrow();
  });

  it('off performs no work; on remains inert; finish never waits for preparation', async () => {
    const read = vi.fn();
    for (const mode of ['off', 'on']) {
      const shadow = startPipelineShadow({ settings: resolvePipelineSettings({ env: { WE_DRAIN_PIPELINE: mode }, platform: {}, tool: {} }), prepare: read, log: vi.fn() });
      await shadow.done; shadow.finish({ actual: [] });
    }
    expect(read).not.toHaveBeenCalled();
    const log = vi.fn();
    const pending = startPipelineShadow({ settings: settings(), prs: rows, classify, prepare: () => new Promise(() => {}), timeoutMs: 10, log });
    expect(pending.finish({ actual: [] })).toBeUndefined();
    await pending.done;
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logs unavailable live preparation honestly instead of reporting agreement', async () => {
    const log = vi.fn();
    const shadow = startPipelineShadow({ settings: settings(), prs: rows, log });
    await shadow.done; shadow.finish({ actual: [rows[2]], timings: {} });
    expect(log.mock.calls[0][0]).toContain('"samePrs":null');
    expect(log.mock.calls[0][0]).toContain('read-only preparation adapter unavailable');
  });

  it('resolves defaults and independent overrides with sources and invalid-value fallback', () => {
    expect(settings()).toMatchObject({ mode: 'shadow', workers: 4, source: 'standard' });
    expect(resolvePipelineSettings({ tool: { pipeline: 'off', 'pipeline.workers': 2 }, platform: {}, env: {} }))
      .toMatchObject({ mode: 'off', workers: 2, source: 'tool', workersSource: 'tool' });
    expect(resolvePipelineSettings({ tool: { pipeline: { mode: 'shadow', workers: 2 } }, platform: {}, env: { WE_DRAIN_PIPELINE: 'off' } }))
      .toMatchObject({ mode: 'off', workers: 2, source: 'env' });
    expect(resolvePipelineSettings({ tool: { pipeline: 'invalid', 'pipeline.workers': 0 }, platform: { pipeline: 'off' }, env: {} }))
      .toMatchObject({ mode: 'off', workers: 4, source: 'platform' });
  });
});


describe('live read-only adapters', () => {
  it('prepares through admission and the production throttle only, without writers', async () => {
    const writers = { enqueue: vi.fn(), writeState: vi.fn(), git: vi.fn(), comment: vi.fn() };
    let admitted = false;
    const exec = vi.spyOn(throttle, 'execDrainAsync').mockImplementation(async (file, args) => {
      expect(admitted).toBe(true);
      expect(file).toBe('gh');
      return { stdout: JSON.stringify(args.includes('--slurp') ? [[]] : { number: 3, headRefOid: 'head-3', labels: ['ready-to-merge'] }) };
    });
    const revalidate = vi.fn(async ({ read }) => ({ decision: 'merge', headSha: (await read()).headRefOid }));
    const adapter = createPipelineReadAdapters({ localSlug: 'o/r', ...writers,
      admit: async (run) => { admitted = true; try { return await run(); } finally { admitted = false; } },
      resolveRequiredCheck: async p => p, revalidateWithUnknownRetry: revalidate,
      planLabelDrain, prs: rows, optionsOf: () => ({}), enqueues: () => true,
      readRedTeam: vi.fn(() => null), readSafety: () => ({ value: { waitForRedTeamBeforeEnqueue: true } }),
      readState: () => ({ pending: [] }),
    });
    const prepared = await adapter.prepare(rows[2], {});
    expect(prepared).toMatchObject({ decision: 'merge', headSha: 'head-3' });
    expect(exec).toHaveBeenCalled(); expect(revalidate).toHaveBeenCalledOnce();
    for (const writer of Object.values(writers)) expect(writer).not.toHaveBeenCalled();
    exec.mockRestore();
  });

  it('runs real queue overlap against prior shadow admissions and refuses unknown files', async () => {
    const batchingSettings = vi.spyOn(batching, 'resolveBatchingSettings').mockReturnValue({ enabled: false });
    try {
      const prs = [3, 4].map(num => ({ num, decision: 'merge', blockedBy: [], listedFilesComplete: true, listedFiles: ['shared.mjs'] }));
      const exec = vi.fn(async () => ({ stdout: JSON.stringify({ data: {
        repository: { mergeQueue: { entries: { pageInfo: { hasNextPage: false }, nodes: [] } } },
      } }) }));
      const adapter = createPipelineReadAdapters({ prs, localSlug: 'o/r', exec, planLabelDrain,
        admit: run => run() });
      const prepared = { safety: { queueFileOverlapIncludesCards: true }, unknown: [] };
      expect(await adapter.queueGuard(prs[0], { prepared, admitted: [] })).toEqual({ allowed: true });
      expect(await adapter.queueGuard(prs[1], { prepared, admitted: ['cwd#3'] }))
        .toMatchObject({ allowed: false, reason: 'queue file overlap' });
      expect(await adapter.queueGuard({ ...prs[0], listedFilesComplete: false }, { prepared, admitted: [] }))
        .toMatchObject({ allowed: false, reason: expect.stringContaining('unknown:') });
    } finally { batchingSettings.mockRestore(); }
  });

  it('refuses an unknown queue guard and records its reason', async () => {
    const prepared = await preparePipeline({ prs: [rows[2]], prepare });
    const projection = await projectPrepared({ prepared: prepared.rows, ordered: [rows[2]], readHead,
      queueGuard: async () => ({ allowed: null, reason: 'unknown: batching state unreadable' }) });
    expect(projection.wouldEnqueue).toEqual([]);
    expect(projection.decisions[0].reason).toContain('unknown: batching');
  });

  it('emits before the bounded end-of-pass wait returns, even for hung reads or rejected done', async () => {
    const log = vi.fn();
    const shadow = startPipelineShadow({ settings: settings(), prs: [rows[2]], prepare: () => new Promise(() => {}), log });
    shadow.finish({ actual: [] });
    await expect(awaitPipelineShadow(shadow, { graceMs: 5 })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('end-of-pass grace exceeded');
    await expect(awaitPipelineShadow({ done: Promise.reject(Error('bad')) }, { graceMs: 5 })).resolves.toBeUndefined();
  });

  it('measures shadow readiness from the same pass start as serial readiness', async () => {
    const shadow = startPipelineShadow({ settings: settings(), prs: [], prepare, readHead, queueGuard, ordered: [],
      passElapsedMs: 90, now: () => 10, log: vi.fn() });
    expect((await shadow.done).readyMs).toBe(90);
  });

  it('aborts an actual pending process read within the final grace', async () => {
    const exec = promisify(execFile);
    let pid;
    const wrapper = vi.spyOn(throttle, 'execDrainAsync').mockImplementation((_file, _args, options) => {
      const pending = exec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
      pid = pending.child.pid;
      return pending;
    });
    try {
      const log = vi.fn();
      const shadow = startPipelineShadow({ settings: settings(), prs: [rows[2]], log,
        prepare: (_pr, { signal }) => pipelineProcessRead('gh', ['pr', 'view', '3'], { signal }) });
      shadow.finish({ actual: [] });
      await awaitPipelineShadow(shadow, { graceMs: 20 });
      expect(log).toHaveBeenCalledTimes(1);
      expect(pid).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 50));
      let probeError;
      try { process.kill(pid, 0); } catch (error) { probeError = error; }
      expect(probeError?.code).toBe('ESRCH');
    } finally {
      if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      wrapper.mockRestore();
    }
  });

  it('rejects writer commands before the process/throttle boundary', async () => {
    const exec = vi.fn();
    await expect(replayPipelineReader(read => read('gh', ['pr', 'comment', '3', '--body', 'x']), exec))
      .rejects.toThrow('non-read');
    await expect(pipelineProcessRead('git', ['fetch'])).rejects.toThrow('non-read');
    expect(exec).not.toHaveBeenCalled();
  });

  it('uses the shared host check without acquiring or releasing heavy slots', async () => {
    const acquire = vi.spyOn(heavy, 'acquireSlotBlocking');
    const release = vi.spyOn(heavy, 'releaseOwnedSlot');
    const host = vi.spyOn(hostLoad, 'hostLoadAdmission').mockReturnValue({ admitted: true });
    const run = vi.fn(async () => 'read result');
    vi.stubEnv('WE_HEAVY_ADMISSION_HELD', '1');
    vi.stubEnv('WE_HEAVY_ADMISSION', 'off');
    try {
      expect(await admitPipelineRead(run)).toBe('read result');
      expect(host).toHaveBeenCalledWith({ interactive: false });
      expect(acquire).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); host.mockRestore(); acquire.mockRestore(); release.mockRestore(); }
  });

  it('does not read while the host is overloaded and reads after it clears', async () => {
    let admitted = false;
    const hostAdmission = vi.fn(() => ({ admitted }));
    const run = vi.fn(async () => 'read result');
    const pending = admitPipelineRead(run, { hostAdmission });
    expect(hostAdmission).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    // Remain overloaded through a complete poll; there is no ceiling bypass.
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(hostAdmission.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run).not.toHaveBeenCalled();
    admitted = true;
    expect(await pending).toBe('read result');
    expect(run).toHaveBeenCalledOnce();
  });

  it('aborts overloaded host waits at the shadow time box without a read', async () => {
    const hostAdmission = vi.fn(() => ({ admitted: false }));
    const run = vi.fn();
    const shadow = startPipelineShadow({ settings: settings(), prs: [rows[2]], timeoutMs: 20, log: vi.fn(),
      prepare: (_pr, { signal }) => admitPipelineRead(run, { signal, hostAdmission }) });
    expect(await shadow.done).toMatchObject({ ok: false, error: 'time box exceeded' });
    expect(hostAdmission).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(admitPipelineRead(run, { signal: controller.signal, hostAdmission })).rejects.toThrow();
    expect(hostAdmission).toHaveBeenCalledOnce();
  });

  it('executes the real evidence subprocess without creating or migrating files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drain-shadow-evidence-'));
    const controller = new AbortController();
    try {
      const reason = await readPipelineRedTeam({ repo: 'o/r', pr: 3, head: 'a'.repeat(40),
        comments: [], requestPending: true }, { signal: controller.signal,
        env: { ...process.env, OPERATION_RUNS_DIR: join(root, 'runs'), WE_SHARED_RUNS_DIR: join(root, 'runs'),
          WE_COORDINATION_ROOT: join(root, 'coord'), CONVEYOR_STATE_ROOT: root } });
      expect(reason).toBe('post-accept red team has no recorded result on the live head');
      expect(readdirSync(root, { recursive: true })).toEqual([]);
    } finally { controller.abort(); rmSync(root, { recursive: true, force: true }); }
  });

  it('resolves grace defaults, cascade, bounds and invalid fallback independently', () => {
    expect(settings()).toMatchObject({ graceMs: 60000, graceSource: 'standard' });
    expect(resolvePipelineSettings({ tool: { 'pipeline.graceMs': 120000 }, platform: {}, env: {} }))
      .toMatchObject({ graceMs: 120000, graceSource: 'tool' });
    expect(resolvePipelineSettings({ tool: { pipeline: { graceMs: 10 } }, platform: {}, env: { WE_DRAIN_PIPELINE_GRACE_MS: '240000' } }))
      .toMatchObject({ graceMs: 240000, graceSource: 'env' });
    for (const graceMs of [0, 600000])
      expect(resolvePipelineSettings({ tool: {}, platform: { pipeline: { graceMs } }, env: {} }))
        .toMatchObject({ graceMs, graceSource: 'platform' });
    for (const graceMs of [-1, 1.5, Infinity, 600001, 'bad']) {
      expect(resolvePipelineSettings({ tool: { 'pipeline.graceMs': graceMs }, platform: {}, env: {} }).graceMs).toBe(60000);
      const resolved = resolvePipelineSettings({ tool: { 'pipeline.graceMs': 12 }, platform: {},
        env: { WE_DRAIN_PIPELINE_GRACE_MS: String(graceMs) } });
      expect(resolved).toMatchObject({ graceMs: 12, graceSource: 'tool' });
      expect(resolved.invalid).toHaveLength(1);
    }
  });

  it('awaits configured grace beyond 5s and retains finished prep on grace abort', async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const shadow = startPipelineShadow({ settings: { ...settings(), graceMs: 20000 },
        prs: [rows[2], rows[3]], workers: 1, readHead, queueGuard, ordered: priority, log,
        prepare: async p => {
          if (p.num === 4) return new Promise(() => {});
          await new Promise(resolve => setTimeout(resolve, 6000));
          return prepare(p);
        } });
      shadow.finish({ actual: [rows[2]], serialReadyMs: 10 });
      let returned = false;
      const wait = awaitPipelineShadow(shadow).then(() => { returned = true; });
      await vi.advanceTimersByTimeAsync(19999);
      expect(returned).toBe(false);
      expect(log).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await wait;
      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0][0];
      expect(line).not.toMatch(/[\r\n]/);
      const record = JSON.parse(line.slice(line.indexOf(': {') + 2));
      expect(record).toMatchObject({ complete: false, error: 'end-of-pass grace exceeded',
        settings: { graceMs: 20000 }, serialReadyMs: 10 });
      expect(record.preparations[0]).toMatchObject({ pr: 'cwd#3', classification: 'candidate', decision: 'merge', prepMs: expect.any(Number) });
      expect(record.preparations[1]).toMatchObject({ pr: 'cwd#4', classification: 'candidate', decision: null, prepMs: null });
    } finally { vi.useRealTimers(); }
  });

  it.each([0, 60000, 240000])('bounds the final await at configured grace %i', async graceMs => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const wait = awaitPipelineShadow({ done: new Promise(() => {}), graceMs, cancel });
      if (graceMs > 0) {
        await vi.advanceTimersByTimeAsync(graceMs - 1);
        expect(cancel).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(graceMs === 0 ? 0 : 1);
      await wait;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith('end-of-pass grace exceeded');
    } finally { vi.useRealTimers(); }
  });

  it('allows preparation to finish within configured grace beyond the former 5s cap', async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const shadow = startPipelineShadow({ settings: { ...settings(), graceMs: 12000 },
        prs: [rows[2]], ordered: [rows[2]], readHead, queueGuard, log,
        prepare: async p => { await new Promise(resolve => setTimeout(resolve, 8000)); return prepare(p); } });
      shadow.finish({ actual: [rows[2]] });
      const wait = awaitPipelineShadow(shadow);
      await vi.advanceTimersByTimeAsync(8000);
      await wait;
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('"complete":true');
    } finally { vi.useRealTimers(); }
  });

  it('resolves bounded timeout settings independently', () => {
    expect(settings()).toMatchObject({ timeoutMs: 240000, timeoutSource: 'standard' });
    expect(resolvePipelineSettings({ tool: { 'pipeline.timeoutMs': 120000 }, platform: {}, env: {} }))
      .toMatchObject({ timeoutMs: 120000, timeoutSource: 'tool' });
    expect(resolvePipelineSettings({ tool: { pipeline: { timeoutMs: 10 } }, platform: {}, env: { WE_DRAIN_PIPELINE_TIMEOUT_MS: '50' } }))
      .toMatchObject({ timeoutMs: 50, timeoutSource: 'env' });
    for (const timeoutMs of [0, -1, 1.5, Infinity, 600001])
      expect(resolvePipelineSettings({ tool: { 'pipeline.timeoutMs': timeoutMs }, platform: {}, env: {} }).timeoutMs).toBe(240000);
  });
});
