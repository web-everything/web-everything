import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLandingHolderBlockedState } from '../landing-holder-blocked-state.mjs';
import { runReconcileFixDispatch, planFixDispatchClaimStatus } from '../reconcile-fix-dispatch.mjs';
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const hold = { pr: 80, holder: 90, since: '2026-11-25T12:00:00.000Z' };
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'landing-blocked-')); dirs.push(dir);
  const path = join(dir, 'state.json'), log = vi.fn();
  return { path, log, store: createLandingHolderBlockedState({ repo: 'owner/repo', env: { WE_LANDING_HOLDER_BLOCKED_STATE: path }, log }) };
}
describe('landing holder blocked state', () => {
  it('round trips and prunes cleared pairs on write', () => {
    const { store } = fixture(); store.write([hold, { ...hold, pr: 81 }]);
    expect(store.read()).toEqual(new Map([['80:90', hold.since], ['81:90', hold.since]]));
    store.write([hold]); expect(store.read()).toEqual(new Map([['80:90', hold.since]]));
    store.write([]); expect(store.read()).toEqual(new Map());
  });
  it('missing or corrupt history restarts the clock and logs one line', () => {
    const { store, path, log } = fixture(); expect(store.read()).toEqual(new Map()); expect(log).toHaveBeenCalledTimes(1);
    log.mockClear(); fs.writeFileSync(path, '{bad'); expect(store.read()).toEqual(new Map()); expect(log).toHaveBeenCalledTimes(1);
    log.mockClear(); fs.writeFileSync(path, JSON.stringify({ '80:90': 'bad' })); expect(store.read()).toEqual(new Map()); expect(log).toHaveBeenCalledTimes(1);
  });
  it('writes a temporary sibling then atomically renames it', () => {
    const { path } = fixture(), calls = [];
    const io = { ...fs, writeFileSync: (p, ...args) => { calls.push(['write', p]); fs.writeFileSync(p, ...args); }, renameSync: (from, to) => { calls.push(['rename', from, to]); fs.renameSync(from, to); } };
    const store = createLandingHolderBlockedState({ repo: 'owner/repo', env: { WE_LANDING_HOLDER_BLOCKED_STATE: path }, io });
    store.write([hold]); expect(calls).toEqual([['write', expect.stringMatching(new RegExp('state\\.json\\..+\\.tmp$'))], ['rename', calls[0][1], path]]);
    expect(fs.existsSync(calls[0][1])).toBe(false);
  });
  it('uses the repo-specific default path', () => {
    expect(createLandingHolderBlockedState({ repo: 'owner/repo', env: {} }).path).toMatch(/\.claude\/conveyor\/landing-holder-blocked-owner_repo\.json$/);
  });
  it('dry-run and claim-status never write blocked state', () => {
    const state = { read: vi.fn(() => new Map()), write: vi.fn() };
    const reconcile = () => ({ dispatch: [], refusals: [], openPrFiles: [] });
    const options = { reconcile, loadItems: () => [], checkStaleness: () => ({ fresh: true, behind: 0 }), landingBlockedState: state };
    runReconcileFixDispatch({ ...options, dryRun: true, listFixClaims: () => [], listBuildClaims: () => [], pickFreeLanes: () => [], priorityShadow: null, stepLog: () => {} });
    planFixDispatchClaimStatus(options); expect(state.write).not.toHaveBeenCalled();
  });
  it('live shell reads before filtering and writes even an empty held set to prune history', () => {
    const state = { read: vi.fn(() => new Map()), write: vi.fn() };
    runReconcileFixDispatch({ reconcile: () => ({ dispatch: [], refusals: [], openPrFiles: [] }), loadItems: () => [], checkStaleness: () => ({ fresh: true, behind: 0 }), landingBlockedState: state, dryRun: false, listFixClaims: () => [], listBuildClaims: () => [], pickFreeLanes: () => [], priorityShadow: null, stepLog: () => {} });
    expect(state.read).toHaveBeenCalledOnce(); expect(state.write).toHaveBeenCalledWith([]);
  });
});
