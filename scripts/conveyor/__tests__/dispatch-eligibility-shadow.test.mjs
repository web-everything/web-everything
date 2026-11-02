// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Deliberately missing in slice 3 step 1: collection must fail here until implementation.
import { resolveShadowMode, runEligibilityShadow, createBoundedShadowLog, eligibilityShadowDeps } from '../dispatch-eligibility-shadow.mjs';
import { runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';
import { detectStacks, PR_STACK_DEFAULTS } from '../pr-stack.mjs';
import { eligibility } from '../dispatch-eligibility.mjs';
import { buildEligibilityFacts } from '../dispatch-eligibility-facts.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { liveResultGateState, redTeamGateMarker } from '../../lib/red-team-gate.mjs';

const head = 'a'.repeat(40);
const at = '2026-11-02T12:00:00.000Z';
const now = () => new Date(at);
const locals = () => ({ referral: { state: 'none' }, scope: 'present', claim: { claimed: false },
  pause: { paused: false }, sameHead: { spent: false }, rounds: { attempts: 0, cap: 2 } });
const entry = (kind = 'fix', prNumber = 6001) => ({ kind, prNumber, why: 'existing path decision', nested: { scope: ['scripts/example.mjs'] } });
const pr = (number = 6001, overrides = {}) => ({ number, headRefOid: head, headRefName: 'lane/shadow-fixture',
  state: 'OPEN', isDraft: false, labels: [], comments: [], commentsComplete: true,
  commits: [], statusCheckRollup: [], mergeStateStatus: 'CLEAN', ...overrides });
const bot = body => ({ author: { login: 'web-everything', type: 'Bot' }, body });
function sentBackPr(number = 6001, overrides = {}) {
  const result = bot(renderRedTeamComment({ pr: number, rev: head, provider: 'codex', model: 'm',
    recheckStatus: 'ok', foldedVerdict: 'changes', findings: [{ summary: 'Break', category: 'edge-case',
      impactIfUnfixed: 'broken', file: 'scripts/example.mjs', line: 1, confirmedByRecheck: true }] }));
  const resultId = liveResultGateState([result], number, head).resultId;
  return pr(number, { comments: [result, bot(`${redTeamGateMarker(number, head, 'sent-back', resultId)}\ngate`)], ...overrides });
}
const gateFor = (p, kind, local = locals()) => eligibility(p, buildEligibilityFacts({ pr: p, comments: p.comments,
  commentsComplete: p.commentsComplete === true, population: kind, locals: local }));
const run = options => runEligibilityShadow({ mode: 'shadow', now, readLocals: locals, ...options });

afterEach(() => vi.restoreAllMocks());

describe('runEligibilityShadow observational contract', () => {
  it.each([
    ['fix', [entry()]],
    ['ci-heal', [entry('ci-heal')]],
    ['review', [entry('review')]],
    ['mixed', [entry(), entry('ci-heal', 6002), entry('review', 6003), entry('restack', 6004)]],
    ['empty', []],
  ])('property: %s dispatch, entries and PRs are unchanged in shadow and off modes', (_name, dispatch) => {
    const prs = [pr(), sentBackPr(6002), pr(6003), pr(6004)];
    const original = structuredClone({ dispatch, prs });
    const outputs = [];
    for (const mode of ['shadow', 'off']) {
      const input = structuredClone(original);
      const entries = [...input.dispatch];
      const snapshots = input.prs.map(p => structuredClone(p));
      const result = run({ ...input, mode, appendLine: vi.fn() });
      expect(result.checked).toBe(mode === 'off' ? 0 : dispatch.filter(e => ['fix', 'ci-heal'].includes(e.kind)).length);
      expect(input).toEqual(original);
      entries.forEach((e, i) => expect(input.dispatch[i]).toBe(e));
      expect(input.prs).toEqual(snapshots);
      outputs.push(input);
    }
    expect(outputs[0]).toEqual(outputs[1]);
  });

  it.each([undefined, 'idle-restack'])('one hold disagreement writes exactly one JSON line (pathId=%s)', pathId => {
    const p = sentBackPr(6001, { isDraft: true });
    expect(gateFor(p, 'fix')).toEqual({ hold: 'draft' });
    const appendLine = vi.fn();
    expect(run({ dispatch: [entry()], prs: [p], appendLine, ...(pathId ? { pathId } : {}) }))
      .toEqual({ checked: 1, disagreements: 1 });
    expect(appendLine).toHaveBeenCalledTimes(1);
    const line = appendLine.mock.calls[0][0];
    expect(typeof line).toBe('string');
    expect(line.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({ at, pathId: pathId ?? 'reconcile-core', pr: 6001, head,
      path: 'dispatch', gate: 'hold', reasons: ['draft'] });
  });

  it.each(['fix', 'ci-heal'])('%s agreement writes no line using real facts and eligibility', kind => {
    const p = sentBackPr();
    expect(gateFor(p, kind)).toMatchObject({ dispatch: true, population: kind });
    const appendLine = vi.fn();
    expect(run({ dispatch: [entry(kind)], prs: [p], appendLine })).toEqual({ checked: 1, disagreements: 0 });
    expect(appendLine).not.toHaveBeenCalled();
  });

  it.each([
    ['incomplete thread', { commentsComplete: false }, locals, 'thread'],
    ['unread red-team evidence', {}, locals, 'redTeam'],
    ['unread local evidence', {}, () => undefined, 'referral'],
  ])('fails closed and logs unknown for %s', (_name, overrides, readLocals, reason) => {
    const appendLine = vi.fn();
    expect(run({ dispatch: [entry()], prs: [pr(6001, overrides)], appendLine, readLocals }))
      .toEqual({ checked: 1, disagreements: 1 });
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(JSON.parse(appendLine.mock.calls[0][0])).toEqual({ at, pathId: 'reconcile-core', pr: 6001, head,
      path: 'dispatch', gate: 'unknown', reasons: [reason] });
  });

  it('catches a throwing comments getter, reports once, continues the tick and preserves dispatch', () => {
    const boom = new Error('comments unavailable');
    const broken = pr();
    Object.defineProperty(broken, 'comments', { get() { throw boom; }, configurable: true });
    const dispatch = [entry(), entry('ci-heal', 6002)];
    const before = structuredClone(dispatch);
    const appendLine = vi.fn();
    const onError = vi.fn();
    const readLocals = vi.fn(locals);
    let result;
    expect(() => { result = run({ dispatch, prs: [broken, pr(6002)], appendLine, onError, readLocals }); }).not.toThrow();
    expect(result.checked).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(readLocals.mock.calls.some(([, p]) => p.number === 6002)).toBe(true);
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(JSON.parse(appendLine.mock.calls[0][0]).pr).toBe(6002);
    expect(dispatch).toEqual(before);
  });

  it.each(['readLocals', 'appendLine'])('contains %s failure and still checks the next entry', failingDep => {
    const dispatch = [entry(), entry('ci-heal', 6002)];
    const prs = [pr(), pr(6002)];
    const before = structuredClone({ dispatch, prs });
    const onError = vi.fn();
    const appendLine = vi.fn();
    const readLocals = vi.fn(locals);
    const dependency = failingDep === 'appendLine' ? appendLine : readLocals;
    dependency.mockImplementationOnce(() => { throw new Error(`${failingDep} unavailable`); });
    expect(() => run({ dispatch, prs, onError, appendLine, readLocals })).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(readLocals).toHaveBeenCalledWith(dispatch[1], prs[1]);
    expect(JSON.parse(appendLine.mock.calls.at(-1)[0]).pr).toBe(6002);
    expect({ dispatch, prs }).toEqual(before);
  });

  it('warns once when no onError is injected and continues after a local read error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readLocals = vi.fn(locals).mockImplementationOnce(() => { throw new Error('local read failed'); });
    const appendLine = vi.fn();
    run({ dispatch: [entry(), entry('fix', 6002)], prs: [pr(), pr(6002)], readLocals, appendLine });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(JSON.parse(appendLine.mock.calls[0][0]).pr).toBe(6002);
  });

  it('off mode writes nothing and never reads PRs, locals or the clock', () => {
    const forbidden = vi.fn(() => { throw new Error('off mode touched a dependency'); });
    const p = pr();
    Object.defineProperty(p, 'comments', { get: forbidden });
    expect(run({ dispatch: [entry()], prs: [p], mode: 'off', appendLine: forbidden,
      readLocals: forbidden, now: forbidden, onError: forbidden })).toEqual({ checked: 0, disagreements: 0 });
    expect(forbidden).not.toHaveBeenCalled();
  });
});

describe('resolveShadowMode', () => {
  it('resolves dispatch.eligibility.mode through platform, tool, and environment', () => {
    const layers = { platform: { mode: 'off' }, tool: {}, hermetic: true };
    expect(resolveShadowMode({}, layers)).toEqual({ mode: 'off', source: 'platform' });
    layers.tool = { mode: 'shadow' };
    expect(resolveShadowMode({}, layers)).toEqual({ mode: 'shadow', source: 'tool' });
    expect(resolveShadowMode({ WE_DISPATCH_ELIGIBILITY_MODE: 'off' }, layers)).toEqual({ mode: 'off', source: 'env' });
  });
  it('default local adapter supplies only entry rounds and leaves other evidence unread', () => {
    const deps = eligibilityShadowDeps({ hermetic: true });
    expect(deps.readLocals({ attempts: 1, cap: 2 })).toEqual({ rounds: { attempts: 1, cap: 2 } });
    const p = sentBackPr();
    expect(gateFor(p, 'fix', deps.readLocals({}))).toEqual({ unknown: 'referral' });
  });
  it('defaults to shadow with setting provenance', () => {
    expect(resolveShadowMode({})).toEqual({ mode: 'shadow', source: expect.stringMatching(/standard|default/) });
  });
  it.each(['off', 'shadow'])('resolves explicit environment %s and names its source', mode => {
    expect(resolveShadowMode({ WE_DISPATCH_ELIGIBILITY_MODE: mode }))
      .toEqual({ mode, source: expect.stringMatching(/env|WE_DISPATCH_ELIGIBILITY_MODE/) });
  });
  it('unknown mode falls back to shadow and names the fallback', () => {
    expect(resolveShadowMode({ WE_DISPATCH_ELIGIBILITY_MODE: 'garbage' }))
      .toEqual({ mode: 'shadow', source: expect.stringMatching(/fallback/i) });
  });
});

// Synchronous in-memory fs: all log IO stays here, never in HOME or on disk.
function memoryFs() {
  const files = new Map();
  const missing = file => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  return { files, fs: {
    existsSync: file => files.has(file),
    mkdirSync: vi.fn(),
    statSync: file => { if (!files.has(file)) throw missing(file); return { size: Buffer.byteLength(files.get(file)) }; },
    appendFileSync: (file, data) => files.set(file, (files.get(file) ?? '') + String(data)),
    writeFileSync: (file, data) => files.set(file, String(data)),
    renameSync: (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
    unlinkSync: file => { if (!files.delete(file)) throw missing(file); },
  } };
}

describe('createBoundedShadowLog', () => {
  it('rejects an oversized line with an operator-visible size error and leaves the log bounded', () => {
    const { files, fs } = memoryFs();
    const appendLine = createBoundedShadowLog({ file: 'shadow/events.jsonl', maxBytes: 32, keep: 2, fs });
    appendLine('{}');
    const before = new Map(files);
    // Refuse rather than silently truncate the JSON evidence; runEligibilityShadow contains/reports this error.
    expect(() => appendLine(JSON.stringify({ text: 'x'.repeat(64) }))).toThrow(/maxBytes|too large|oversiz|limit/i);
    expect(files).toEqual(before);
  });

  it('rotates before exceeding maxBytes, preserves newest lines and keeps at most keep generations', () => {
    const { files, fs } = memoryFs();
    const file = 'shadow/events.jsonl';
    const line = n => JSON.stringify({ n, text: 'é' });
    const maxBytes = Buffer.byteLength(`${line(0)}\n`);
    const appendLine = createBoundedShadowLog({ file, maxBytes, keep: 2, fs });
    appendLine(line(0));
    expect(files.get(file)).toBe(`${line(0)}\n`);
    expect(files.has(`${file}.1`)).toBe(false);
    for (let n = 1; n < 8; n++) {
      appendLine(line(n));
      expect(files.size).toBeLessThanOrEqual(3); // active file plus two retained generations
      for (const bytes of files.values()) expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(maxBytes);
    }
    expect(files.get(file)).toBe(`${line(7)}\n`);
    expect(files.get(`${file}.1`)).toBe(`${line(6)}\n`);
    expect(files.get(`${file}.2`)).toBe(`${line(5)}\n`);
    expect(files.has(`${file}.3`)).toBe(false);
  });
});

describe('shadow wiring in existing dispatch paths', () => {
  it('idle-restack observes the planned fix and contains logger failure without changing dispatch', () => {
    const bottom = { pr: 6001, headRefName: 'lane/shadow-bottom', headRefOid: head };
    const top = { pr: 6002, headRefName: 'lane/shadow-top', headRefOid: 'b'.repeat(40) };
    // A held launch leaves the process's restack-used memory untouched between observations.
    const dispatch = vi.fn(() => ({ held: true, reason: 'fixture', heldBy: 'fixture' }));
    const execute = shadowDeps => {
      const stacks = detectStacks([bottom, top], {
        isAncestor: (a, b) => a === bottom.headRefOid && b === top.headRefOid,
      });
      stacks.pairs[0].bottomHead = 'c'.repeat(40);
      stacks.pairs[0].inSync = false;
      return runReconcileFixDispatch({ root: '.', repo: 'we', shadowDeps,
        checkStaleness: () => ({ stale: false }),
        reconcile: () => ({ dispatch: [], refusals: [{ kind: 'nothing-owed', prNumber: top.pr }] }),
        prStack: () => stacks, prStackSettings: PR_STACK_DEFAULTS,
        readPrForRestack: () => ({ ...top, prNumber: top.pr, kind: 'fix', labels: [], body: '',
          isCrossRepository: false, attempts: 1, cap: 2 }),
        readLaneTips: () => new Map([[top.headRefName, top.headRefOid]]),
        findItemFn: () => null, loadItems: () => [], pickFreeLanes: () => [1],
        dispatch, fetchItemlessDiffPaths: () => ['scripts/example.mjs'],
        resolveFallbackScope: () => ['we:scripts/example.mjs'],
        resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'we' }),
        listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null,
      });
    };
    const baseline = execute({ mode: 'off' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const planned = structuredClone(dispatch.mock.calls[0][0]);
    expect(planned).toMatchObject({ pr: top.pr, restack: { idle: true } });
    const appendLine = vi.fn();
    const readLocals = vi.fn(locals);
    const onError = vi.fn();
    const deps = { mode: 'shadow', now, appendLine, readLocals, onError };
    expect(execute(deps)).toEqual(baseline);
    expect(dispatch.mock.calls[1][0]).toEqual(planned);
    expect(readLocals).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fix', prNumber: top.pr, attempts: 1, cap: 2 }),
      expect.objectContaining({ number: top.pr }));
    expect(JSON.parse(appendLine.mock.calls[0][0])).toMatchObject({ pathId: 'reconcile-fix-dispatch-idle-restack',
      pr: top.pr, gate: 'unknown', reasons: ['thread'] });
    appendLine.mockImplementation(() => { throw new Error('log unavailable'); });
    expect(execute(deps)).toEqual(baseline);
    expect(dispatch.mock.calls[2][0]).toEqual(planned);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it('planReconcile imports and calls runEligibilityShadow', () => {
    const source = readFileSync(new URL('../reconcile-core.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\brunEligibilityShadow\b[^}]*\}\s*from\s*['"]\.\/dispatch-eligibility-shadow\.mjs['"]/);
    const body = source.slice(source.indexOf('export function planReconcile('), source.indexOf('return { dispatch: timedDispatch, refusals, notes };'));
    expect(body).toMatch(/\brunEligibilityShadow\s*\(/);
  });

  it('idle-restack path imports and calls runEligibilityShadow with a distinct pathId', () => {
    const source = readFileSync(new URL('../reconcile-fix-dispatch.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\brunEligibilityShadow\b[^}]*\}\s*from\s*['"]\.\/dispatch-eligibility-shadow\.mjs['"]/);
    const idlePath = source.slice(source.indexOf('for (const { top } of planIdleRestacks('));
    expect(idlePath).toMatch(/\brunEligibilityShadow\s*\(/);
    expect(idlePath).toMatch(/pathId:\s*['"][^'"]*idle-restack[^'"]*['"]/);
  });

  it('planReconcile output is identical when injected shadow logging or facts throw', () => {
    const input = { prs: [sentBackPr(6001, { isDraft: true, statusCheckRollup: [{ name: 'test',
      status: 'COMPLETED', conclusion: 'FAILURE' }] })], agents: [], durableCounts: {},
    requiredChecks: ['test'], now: Date.parse(at), fixTiming: { joinCiAndReview: false } };
    const baseline = planReconcile(structuredClone(input));
    expect(baseline.dispatch.some(e => ['fix', 'ci-heal'].includes(e.kind))).toBe(true);
    // Pin the new optional injection seam as shadowDeps; production defaults belong to the later implementation.
    for (const name of ['appendLine', 'readLocals']) {
      const boom = vi.fn(() => { throw new Error(`shadow ${name} failed`); });
      const shadowDeps = { mode: 'shadow', now, appendLine: vi.fn(), readLocals: locals, onError: vi.fn(), [name]: boom };
      expect(planReconcile({ ...structuredClone(input), shadowDeps })).toEqual(baseline);
      expect(boom).toHaveBeenCalled();
      expect(shadowDeps.onError).toHaveBeenCalledTimes(1);
    }
  });
});
