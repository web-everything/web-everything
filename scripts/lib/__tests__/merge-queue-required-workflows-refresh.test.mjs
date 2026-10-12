// @vitest-environment node
// required-workflows refusal (ruleset 24930207).
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as q from '../merge-queue-enqueue.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';
const HEAD = 'a'.repeat(40), NEXT = 'b'.repeat(40), KEY = 'owner/repo#42';
const LIVE = `gh: Pull request Required workflows 'CI, CI, Merge gate, Merge gate, Soak replay gate, Soak replay gate' are not satisfied Required status check "merge-gate" is expected.`;
function execFor(graphql = false) {
  return (cmd, args) => {
    if (cmd === 'git') return args[0] === 'diff' ? 'src/a.js\0' : '';
    if (args[1] === 'comment') return '';
    if (args[1] === 'view') return JSON.stringify({ id: 'PR_ID', headRefOid: HEAD });
    if (args[1] === 'graphql') {
      if (graphql) return JSON.stringify({ errors: [{ message: LIVE, type: 'UNPROCESSABLE', code: 'RULESET' }] });
      throw Object.assign(new Error('gh failed'), { stderr: LIVE });
    }
    throw new Error(`unexpected ${cmd} ${args}`);
  };
}
function temporary(fn) { const dir = mkdtempSync(join(tmpdir(), 'required-workflows-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
describe('required-workflows refusal (ruleset 24930207)', () => {
  it('classifies only the GitHub message shape', () => {
    for (const s of [LIVE, "Required workflow 'CI' is not satisfied"]) expect(q.isRequiredWorkflowsUnsatisfiedError(s)).toBe(true);
    for (const s of ['already in the merge queue', 'Required status check "test" is expected', 'random required workflows', '']) expect(q.isRequiredWorkflowsUnsatisfiedError(s)).toBe(false);
  });
  it.each([false, true])('classifies enqueue failures (GraphQL=%s)', (graphql) => {
    const out = q.enqueuePr({ repo: 'owner/repo', num: 42, headSha: HEAD, cwd: '/clone', exec: execFor(graphql) });
    expect(out).toMatchObject({ ok: false, reason: 'required-workflows-unsatisfied', error: LIVE });
    if (graphql) expect(out).toMatchObject({ type: 'UNPROCESSABLE', code: 'RULESET' });
  });
  it('strategy preserves its diagnostic, code and pinned head', () => {
    const s = createDrainMergeStrategy({ localSlug: 'owner/repo', isLocalRepo: () => true, exec: execFor(), readFile: () => '{"pending":[],"followedUp":[]}', statePath: '/unused', log: { write() {} }, resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }), note: null } });
    try { s.enqueue({ num: 42 }, HEAD, { comments: [] }); expect.fail('must throw'); }
    catch (e) { expect(e.code).toBe('required-workflows-unsatisfied'); expect(e.headSha).toBe(HEAD); expect(e.message).toBe(`github-merge-queue enqueue FAILED (${LIVE}) — NOT merged directly; retried next pass`); }
  });
  it('decides off, fresh, already refreshed and repeated refusal', () => {
    const base = { key: KEY, headSha: HEAD, state: {}, setting: 'on' };
    expect(q.decideRequiredWorkflowsRefresh({ ...base, setting: 'off' }).action).toBe('off');
    expect(q.decideRequiredWorkflowsRefresh(base).action).toBe('refresh');
    const state = { [KEY]: { fromHead: HEAD, newHead: NEXT } };
    expect(q.decideRequiredWorkflowsRefresh({ ...base, state })).toMatchObject({ action: 'skip', reason: expect.stringContaining(HEAD.slice(0, 9)) });
    expect(q.decideRequiredWorkflowsRefresh({ ...base, state, headSha: NEXT })).toMatchObject({ action: 'skip', reason: expect.stringMatching(/person/) });
  });
  it('resolves env > file > default with sources', () => temporary((dir) => {
    const file = join(dir, 'settings.json');
    expect(q.resolveRequiredWorkflowsRefresh({ env: {}, file })).toEqual({ value: 'on', source: 'default' });
    writeFileSync(file, '{"requiredWorkflowsRefresh":"off"}');
    expect(q.resolveRequiredWorkflowsRefresh({ env: {}, file })).toEqual({ value: 'off', source: 'settings' });
    expect(q.resolveRequiredWorkflowsRefresh({ env: { WE_DRAIN_REQUIRED_WORKFLOWS_REFRESH: 'on' }, file })).toEqual({ value: 'on', source: 'env' });
  }));
  it('reads tolerantly and atomically bounds state to the newest 500 entries', () => temporary((dir) => {
    const path = q.requiredWorkflowsRefreshStatePath({ WE_COORDINATION_ROOT: dir });
    expect(path).toBe(join(dir, 'drain-required-workflows-refresh.json'));
    expect(q.readRequiredWorkflowsRefreshState(path)).toEqual({});
    writeFileSync(path, 'bad'); expect(q.readRequiredWorkflowsRefreshState(path)).toEqual({});
    const state = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, { at: new Date(i * 1000).toISOString() }]));
    writeFileSync(path, JSON.stringify(state));
    q.recordRequiredWorkflowsRefresh(path, KEY, { fromHead: HEAD, newHead: NEXT, action: 'rebased', at: new Date(600000).toISOString() });
    const out = q.readRequiredWorkflowsRefreshState(path);
    expect(Object.keys(out)).toHaveLength(500); expect(out.k0).toBeUndefined(); expect(out[KEY].newHead).toBe(NEXT);
    expect(readdirSync(dir)).toEqual(['drain-required-workflows-refresh.json']);
  }));
  it('refreshes once, restamps the new head, and stops both old-head and new-head loops', async () => {
    let state = {}; const record = vi.fn((_path, key, entry) => { state[key] = entry; });
    const refreshStalePr = vi.fn(async () => ({ ok: true, action: 'rebased', newCommit: NEXT }));
    const restampAcceptance = vi.fn(() => ({ ok: true }));
    const opts = { c: { num: 42, repo: 'owner/repo', headRef: 'lane/test' }, key: KEY, headSha: HEAD, setting: 'on', statePath: '/unused', cloneDir: '/clone', cwd: undefined, tag: '#', readState: () => state, record, refreshStalePr, needsAcceptanceRestamp: () => true, restampAcceptance };
    const first = await q.handleRequiredWorkflowsRefusal(opts);
    expect(first).toMatchObject({ handled: true, reason: expect.stringContaining(`refresh rebased ${NEXT.slice(0, 9)}`) });
    expect(refreshStalePr).toHaveBeenCalledWith({ laneRef: 'lane/test', root: '/clone', repo: 'owner/repo', runId: null, expectedHead: HEAD });
    expect(restampAcceptance).toHaveBeenCalledWith({ pr: 42, repo: 'owner/repo', newHead: NEXT, cwd: undefined });
    expect(record).toHaveBeenCalledTimes(1);
    expect((await q.handleRequiredWorkflowsRefusal(opts)).line).toContain('⏸');
    expect((await q.handleRequiredWorkflowsRefusal({ ...opts, headSha: NEXT })).reason).toContain('person');
    expect(refreshStalePr).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('does not record a failed refresh (throws=%s)', async (throws) => {
    const record = vi.fn();
    const out = await q.handleRequiredWorkflowsRefusal({ c: { num: 42 }, key: KEY, headSha: HEAD, setting: 'on', statePath: '/unused', cloneDir: '/clone', readState: () => ({}), record, refreshStalePr: async () => { if (throws) throw new Error('no run'); return { ok: false, action: 'current-no-run', error: 'no run' }; } });
    expect(out.reason).toContain('refresh FAILED: no run'); expect(record).not.toHaveBeenCalled();
  });
  it('reports restamp failures in both JSON reason and the existing warning without losing the refresh record', async () => {
    const record = vi.fn(), warn = vi.fn();
    const out = await q.handleRequiredWorkflowsRefusal({ c: { num: 42 }, key: KEY, headSha: HEAD, setting: 'on', statePath: '/unused', cloneDir: '/clone', readState: () => ({}), record, warn,
      refreshStalePr: async () => ({ ok: true, action: 'rebased', newCommit: NEXT }), needsAcceptanceRestamp: () => true, restampAcceptance: () => ({ ok: false, reason: 'hold' }) });
    expect(record).toHaveBeenCalledWith('/unused', KEY, expect.objectContaining({ fromHead: HEAD, newHead: NEXT, action: 'rebased' }));
    expect(out.reason).toContain('acceptance re-stamp failed: hold');
    expect(warn).toHaveBeenCalledWith('  ⚠ #42 acceptance re-stamp failed (hold) — it may re-park');
  });
  it('wires recovery after already-merged recovery and before generic failure, with JSON skip reasons', () => {
    const cli = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
    const start = cli.indexOf('if (e?.code === REQUIRED_WORKFLOWS_UNSATISFIED)');
    const block = cli.slice(start, cli.indexOf('// #xngv3vn — a REAL merge failure', start));
    expect(cli.lastIndexOf('if (isPrAlreadyMerged(c.repo, c.num))', start)).toBeGreaterThan(cli.lastIndexOf('} catch (e)', start));
    expect(block).toContain('headSha: e.headSha || c.headSha');
    expect(block).toContain('revalidationAborted.push({ num: c.num, repo: c.repo, reason: recovery.reason })');
    expect(block).toContain("c.decision = 'skip'"); expect(block).toContain('continue;');
    expect(block).not.toContain('failedMerges.push');
  });
  it('off never refreshes', async () => {
    const refreshStalePr = vi.fn();
    expect(await q.handleRequiredWorkflowsRefusal({ setting: 'off', refreshStalePr, readState: () => ({}) })).toMatchObject({ handled: false });
    expect(refreshStalePr).not.toHaveBeenCalled();
  });
});
