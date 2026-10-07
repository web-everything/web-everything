/**
 * @file dispatch-abort.test.mjs — the stop-then-close-out composition and the trust-grant, both mechanized
 *   from #3383's 2026-08-31 live-fire session (see `../../../../scripts/operations/dispatch-abort.mjs`'s own header for the incident).
 *
 * WHAT THIS FILE COVERS:
 *   - `stopSession` shells `claude stop <id>`, never `kill` — the exact primitive whose absence let a stopped
 *     agent come back under a new pid and double-dispatch onto a lane. An already-gone handle (`claude stop`'s
 *     own `No job matching …` exit) is reported, not thrown; any OTHER failure still throws, and the exec
 *     options (including the timeout) are asserted in full, not just `encoding` (PR #1211 review F5's lesson).
 *   - `trustCheckout` grants trust through the SAME `withTrustedDirs` primitive the bootstrap step uses, is a
 *     no-op when already trusted, and never touches an unreadable config.
 *   - `abortDispatch` ALWAYS attempts the stop when the run has a handle (no redundant liveness pre-check —
 *     see the source's own doc for why an earlier cut that pre-checked failed OPEN on a bad listing), then
 *     closes the run out — so `wake.mjs`'s own `assertHandleNotLive` passes without `force: true` in the
 *     common case, and `force` still threads through for the case it doesn't.
 *   - the lane hint names the lane from the effect's own payload, and says nothing when there wasn't one.
 *   - the CLI's `--trust` refuses an empty value rather than silently trusting the CWD.
 */

import { describe, it, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { advanceWhileRunning, runStatus, startRun } from '../../../../scripts/operations/engine.mjs';
import { applyPendingEffects } from '../../../../scripts/operations/effect-executor.mjs';
import { createFileRunStore } from '../../../../scripts/operations/run-store.mjs';
import { createRegistry } from '../../../../scripts/operations/registry.mjs';
import { DISPATCH_LANE_OP, dispatchLaneOperation } from '../../../../scripts/operations/dispatch-lane.mjs';
import { createDispatchSinks } from '../../../../scripts/operations/dispatch-lane-io.mjs';
import { abortDispatch, stopSession, trustCheckout, requireTrustDir, STOP_EXEC_OPTS } from '../../../../scripts/operations/dispatch-abort.mjs';

const RUN_ID = 'run-dispatch-abort';
const KEY = `${RUN_ID}#2#0`;
const HANDLE = 'aaaaaaaa-1111-2222-3333-444444444444';
const PRIMARY = '/primary/webeverything';
const BRIEF = 'build #{{ITEM_NUM}} at {{ITEM_SPEC_PATH}} in lane {{LANE}} as {{SESSION_SLUG}} scoped {{SCOPE}}';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-dispatch-abort-runs-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Park a real in-flight dispatch on disk, its handle minted, its lane recorded on the effect payload. */
async function parkOneDispatch() {
  const registry = createRegistry();
  registry.register(dispatchLaneOperation({
    readTick: () => ({
      resolvedNum: '3412',
      launch: { num: '3412', lane: 5 },
      suppressed: null,
      item: { num: '3412', slug: 'example', specPath: 'backlog/3412-example.md', scope: ['we:scripts/x.mjs'] },
      briefTemplate: BRIEF,
      nextState: { tick: 1, buildGuards: [{ num: '3412', lane: 5, spawnedTick: 0 }] },
      statusLine: 'conveyor · 1 building',
      notes: [],
      bookkeepingSource: 'file',
      observedAt: new Date().toISOString(),
      // #4174 — WE_ROOT joined BRIEF_REQUIRED_BY_KIND.build; a real `readTick` always carries `repoTokens`.
      repoTokens: { WE_ROOT: PRIMARY },
    }),
  }));
  const store = createFileRunStore(dir);
  let run = advanceWhileRunning(startRun({ op: DISPATCH_LANE_OP, id: RUN_ID, input: { num: '3412' }, registry }), { registry });
  expect(runStatus(run, { registry })).toBe('awaiting-effect');
  const sinks = createDispatchSinks({ root: PRIMARY, spawnAgent: () => '', mintSessionId: () => HANDLE });
  run = (await applyPendingEffects(run, { sinks, store })).run;
  expect(run.effects[0].status).toBe('in-flight');
  return { store };
}

describe('stopSession', () => {
  it('shells `claude stop <id>`, never `kill`, with the FULL exec options (not just encoding)', () => {
    const exec = mock(() => 'stopped aaaaaaaa');
    const res = stopSession({ handle: HANDLE, exec });
    expect(exec).toHaveBeenCalledWith('claude', ['stop', HANDLE], STOP_EXEC_OPTS);
    expect(STOP_EXEC_OPTS.timeout).toBe(30_000); // the literal PR #1211 review F5 found silently deleted once
    expect(res).toEqual({ stopped: true, alreadyGone: false, output: 'stopped aaaaaaaa' });
  });

  it('refuses with no handle', () => {
    expect(() => stopSession({ exec: mock() })).toThrow(/needs a handle/);
  });

  it('treats an already-gone handle as benign, not an error', () => {
    const exec = mock(() => {
      const e = new Error("Command failed: claude stop aaaaaaaa");
      e.stderr = "No job matching 'aaaaaaaa'. Run 'claude agents' to list running sessions.\n";
      throw e;
    });
    const res = stopSession({ handle: HANDLE, exec });
    expect(res).toEqual({ stopped: true, alreadyGone: true, output: expect.stringMatching(/No job matching/) });
  });

  it('surfaces any OTHER `claude stop` failure rather than swallowing it', () => {
    const exec = mock(() => { const e = new Error('spawnSync claude ENOENT'); throw e; });
    expect(() => stopSession({ handle: HANDLE, exec })).toThrow(/claude stop .* failed/);
  });

  it('recognizes an already-gone handle even when other text precedes it on stderr', () => {
    // Matched against the FULL stderr, not just its first line — a prior cut only checked the first line,
    // which would misclassify this as a hard failure.
    const exec = mock(() => {
      const e = new Error('Command failed');
      e.stderr = `warning: some unrelated CLI banner\nNo job matching '${HANDLE}'. Run 'claude agents' to list running sessions.\n`;
      throw e;
    });
    const res = stopSession({ handle: HANDLE, exec });
    expect(res.alreadyGone).toBe(true);
  });
});

describe('requireTrustDir', () => {
  it('refuses an empty --trust value rather than letting it fall through to resolve(cwd)', () => {
    // The exact regression the jury review of PR #1737 flagged as untestable in its prior shape: this guard
    // used to live only inside the `IS_CLI` block, which a unit test can never make true.
    expect(() => requireTrustDir('')).toThrow(/--trust needs a directory/);
    expect(() => requireTrustDir(undefined)).toThrow(/--trust needs a directory/);
  });

  it('passes a real directory through unchanged', () => {
    expect(requireTrustDir('/scratch/wev-2')).toBe('/scratch/wev-2');
  });
});

describe('trustCheckout', () => {
  it('grants trust via withTrustedDirs when the dir is not yet trusted', () => {
    const writeConfig = mock();
    const line = trustCheckout({
      dir: '/scratch/wev-2',
      readConfig: () => ({ projects: {} }),
      writeConfig,
    });
    expect(line).toMatch(/trusted \/scratch\/wev-2/);
    expect(writeConfig).toHaveBeenCalledWith({
      projects: { '/scratch/wev-2': { hasTrustDialogAccepted: true } },
    });
  });

  it('is a no-op when already trusted', () => {
    const writeConfig = mock();
    const line = trustCheckout({
      dir: '/scratch/wev-2',
      readConfig: () => ({ projects: { '/scratch/wev-2': { hasTrustDialogAccepted: true } } }),
      writeConfig,
    });
    expect(line).toMatch(/already trusted/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('refuses to guess when the config cannot be read', () => {
    const writeConfig = mock();
    const line = trustCheckout({ dir: '/scratch/wev-2', readConfig: () => null, writeConfig });
    expect(line).toMatch(/could not read/);
    expect(writeConfig).not.toHaveBeenCalled();
  });
});

describe('abortDispatch', () => {
  it('stops the handle, then closes out — no force needed once the (single) listing agrees it is gone', async () => {
    const { store } = await parkOneDispatch();
    const exec = mock(() => 'stopped');
    // ONE read only — inside closeOutEntry's own assertHandleNotLive, called AFTER the stop. There is no
    // separate pre-check read any more (see the source's own doc for why that was removed).
    const listAgents = mock(() => []);

    const line = abortDispatch({ runId: RUN_ID, key: KEY, store, listAgents, exec });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('claude', ['stop', HANDLE], expect.anything());
    // The single-read invariant the removal of the pre-check exists to guarantee — enforced, not just
    // described in the comment above (the jury review of PR #1737 flagged that gap).
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(line).toMatch(new RegExp(`stopped ${HANDLE}`));
    expect(line).toMatch(/closed out as `failed`/);
    expect(line).toMatch(/Lane 5 may still be leased/);

    const after = store.read(RUN_ID);
    expect(after.effects[0].status).toBe('failed');
  });

  it('still calls `claude stop` even when the handle was already gone — cheap, and closes the fail-open gap', async () => {
    const { store } = await parkOneDispatch();
    const exec = mock(() => {
      const e = new Error('Command failed');
      e.stderr = `No job matching '${HANDLE}'. Run 'claude agents' to list running sessions.\n`;
      throw e;
    });
    const listAgents = mock(() => []);

    const line = abortDispatch({ runId: RUN_ID, key: KEY, store, listAgents, exec });

    expect(exec).toHaveBeenCalledTimes(1); // attempted, not skipped — no pre-check decided it wasn't worth trying
    expect(line).toMatch(/was already gone — nothing to stop/);
    expect(line).toMatch(/closed out as `failed`/);
  });

  it('propagates assertHandleNotLive\'s refusal when the listing still shows it live after the stop', async () => {
    const { store } = await parkOneDispatch();
    const exec = mock(() => 'stopped');
    // The stop call happened but, per this test, the listing still reports it live — closeOutEntry must
    // still refuse rather than close out a possibly-live agent.
    const listAgents = mock(() => [{ sessionId: HANDLE, name: 'prepare-3412' }]);

    expect(() => abortDispatch({ runId: RUN_ID, key: KEY, store, listAgents, exec }))
      .toThrow(/STILL LISTED/);
    expect(exec).toHaveBeenCalledTimes(1); // the stop was attempted exactly once, not retried in a loop
  });

  it('force threads through to closeOutEntry, getting past a listing assertHandleNotLive would otherwise refuse on', async () => {
    const { store } = await parkOneDispatch();
    const exec = mock(() => 'stopped');
    const listAgents = mock(() => [{ sessionId: HANDLE, name: 'prepare-3412' }]);

    const line = abortDispatch({ runId: RUN_ID, key: KEY, store, listAgents, exec, force: true });
    expect(line).toMatch(/closed out as `failed`.*--force: liveness not checked/);
  });

  it('reports no lane hint when the dispatch never had one', async () => {
    const { store } = await parkOneDispatch();
    const run = store.read(RUN_ID);
    // Strip the lane the way a non-build launch kind's payload might lack one.
    run.effects[0].payload = { ...run.effects[0].payload, lane: undefined };
    store.write(run);
    const listAgents = mock(() => []);

    const line = abortDispatch({ runId: RUN_ID, key: KEY, store, listAgents, exec: mock() });
    expect(line).not.toMatch(/Lane/);
  });

  it('refuses with no runId/key, same message shape as wake.mjs', () => {
    expect(() => abortDispatch({ store: createFileRunStore(dir) })).toThrow(/needs both runId and key/);
  });
});
