import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Exercise the real rebuildClone IO shell with controlled phase outcomes. Git,
// remote PR reads and live smoke are deliberately outside this event contract.
vi.mock('../daemon-rebuild/prepare.mjs', () => ({ prepareRebuild: vi.fn() }));
vi.mock('../daemon-rebuild/smoke.mjs', () => ({ smokeAndAdopt: vi.fn() }));

import * as rebuild from '../daemon-rebuild/rebuild.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';
import { finalizeRebuild } from '../daemon-rebuild/adopt.mjs';
import { writeRebuildState } from '../daemon-rebuild/state.mjs';

const sha = 'b'.repeat(40);
const { FAILURE_REASONS, rebuildClone } = rebuild;
const prevHead = 'a'.repeat(40);
let scratch;
let options;

beforeEach(() => {
  vi.resetAllMocks();
  scratch = mkdtempSync(join(tmpdir(), 'we-rebuild-events-'));
  const root = join(scratch, 'review-daemon');
  mkdirSync(root);
  options = {
    root,
    env: {
      WE_DAEMON_STATE_DIR: join(scratch, 'state'),
      WE_DAEMON_CLONE_LOCK_ROOT: join(scratch, 'locks'),
      WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays'),
      WE_DAEMON_EVENTS: join(scratch, 'events.jsonl'),
    },
    versions: null, asJob: false, skipCheck: null,
    lockOpts: { waitMs: 20, pollMs: 1 },
    log: { error: vi.fn(), log: vi.fn() },
    // Any accidental real Git, smoke or PR read fails the fixture.
    run: vi.fn(() => { throw new Error('unexpected git'); }),
    runSmoke: vi.fn(() => { throw new Error('unexpected live smoke'); }),
    prState: vi.fn(() => { throw new Error('unexpected PR read'); }),
    emitEvent: vi.fn(),
  };
  prepareRebuild.mockReturnValue({
    terminal: false, plan: { finalSha: sha }, prevHead,
    lease: { token: 'events-test' }, overlays: [], alerts: [],
  });
});
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function terminal(result) {
  prepareRebuild.mockReturnValue({ terminal: true, result, alerts: [] });
}

function expectEvent(kind, detail) {
  expect(options.emitEvent).toHaveBeenCalledTimes(1);
  expect(options.emitEvent.mock.calls[0][0]).toEqual(expect.objectContaining({
    kind, daemon: basename(options.root), detail,
  }));
}

describe('rebuildClone coordination events', () => {
  it('emits rebuild-adopted once with the adopted SHA after a new-head swap', async () => {
    const result = { moved: true, adopted: true, head: sha, prevHead, plan: { finalSha: sha }, alerts: [] };
    smokeAndAdopt.mockResolvedValue(result);
    expect(await rebuildClone(options)).toEqual(result);
    expectEvent('rebuild-adopted', { sha });
  });

  it('reports closure-scope provenance in rebuild-adopted', async () => {
    const result = { moved: true, adopted: true, head: sha,
      plan: { applied: [{ ref: 'lane/a', resolvedVia: 'closure-scope', excluded: ['unused.mjs'] }] } };
    smokeAndAdopt.mockResolvedValue(result);
    await rebuildClone(options);
    expectEvent('rebuild-adopted', { sha, resolvedVia: 'closure-scope' });
  });

  it('passes the caller entries through to preparation', async () => {
    terminal({ moved: false, reason: 'up-to-date' });
    await rebuildClone({ ...options, entries: ['scripts/caller.mjs'] });
    expect(prepareRebuild).toHaveBeenCalledWith(expect.objectContaining({ entries: ['scripts/caller.mjs'] }));
  });

  it('also emits once for a ready candidate adopted during prepare', async () => {
    const result = { moved: true, adopted: true, reason: 'ready-adopted', head: sha };
    terminal(result);
    expect(await rebuildClone(options)).toEqual({ ...result, alerts: [] });
    expect(smokeAndAdopt).not.toHaveBeenCalled();
    expectEvent('rebuild-adopted', { sha });
  });

  it.each(['quarantined', 'established-overlay-conflict', 'still-rejected',
    'overlay-source-unavailable', 'overlay-source-unverifiable',
    'overlay-state-malformed', 'overlay-state-malformed: invalid registration',
    'error: build unavailable', 'established-overlay-conflict: lane/example'])(
    'emits rebuild-failed once for a prepare refusal: %s', async (reason) => {
      terminal({ moved: false, reason });
      expect(await rebuildClone(options)).toEqual({ moved: false, reason, alerts: [] });
      expect(smokeAndAdopt).not.toHaveBeenCalled();
      expectEvent('rebuild-failed', { reason });
    },
  );

  it('emits exactly one failure event for every declared failure reason', async () => {
    expect(rebuild.REBUILD_FAILURE_REASONS).toBeInstanceOf(Array);
    for (const reason of rebuild.REBUILD_FAILURE_REASONS) {
      options.emitEvent.mockClear();
      terminal({ moved: false, reason });
      await rebuildClone(options);
      expectEvent('rebuild-failed', { reason });
    }
  });

  it.each(['smoke-threw', 'dispatch-smoke-failed', 'smoke-reused-env-failed'])(
    'emits rebuild-failed once for a smoke refusal: %s', async (reason) => {
      const result = { moved: false, reason, plan: { finalSha: sha }, alerts: [] };
      smokeAndAdopt.mockResolvedValue(result);
      expect(await rebuildClone(options)).toEqual(result);
      expectEvent('rebuild-failed', { reason });
    },
  );

  it.each(['up-to-date', 'ready-pending', 'needs-build', 'no-op', 'already-adopted', 'closure-opaque'])(
    'emits nothing for a no-op result: %s', async (reason) => {
      terminal({ moved: false, reason });
      expect(await rebuildClone(options)).toEqual({ moved: false, reason, alerts: [] });
      expect(options.emitEvent).not.toHaveBeenCalled();
    },
  );

  it('emits nothing when adopt-only returns needs-build', async () => {
    expect(await rebuildClone({ ...options, adoptOnly: true })).toMatchObject({ moved: false, reason: 'needs-build' });
    expect(smokeAndAdopt).not.toHaveBeenCalled();
    expect(options.emitEvent).not.toHaveBeenCalled();
  });

  it.each(['xxx-pending', 'reader-priority', 'tick-in-progress', 'disabled', 'smoke-backoff', 'switch-busy'])(
    'does not invent a failure for an unknown or waiting result: %s', async reason => {
      terminal({ moved: false, reason });
      await rebuildClone(options);
      expect(options.emitEvent).not.toHaveBeenCalled();
    },
  );

  it.each(['already-adopted', 'recovered-adopted', 'ready-adopted', 'skipped-unrelated'])(
    'does not announce an adoption completed by an earlier tick: %s', async (reason) => {
      const result = { moved: false, adopted: true, reason, head: sha };
      terminal(result);
      expect(await rebuildClone(options)).toEqual({ ...result, alerts: [] });
      expect(options.emitEvent).not.toHaveBeenCalled();
      // The smoke finalizer also returns already-adopted after a sibling wins.
      prepareRebuild.mockReturnValue({
        terminal: false, plan: { finalSha: sha }, prevHead, lease: { token: 'sibling' }, alerts: [],
      });
      smokeAndAdopt.mockResolvedValue(result);
      expect(await rebuildClone(options)).toEqual(result);
      expect(options.emitEvent).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', 'abc', 'z'.repeat(40)])('does not emit an adoption without a valid head: %j', async head => {
    terminal({ moved: true, adopted: true, head });
    await rebuildClone(options);
    expect(options.emitEvent).not.toHaveBeenCalled();
  });

  it.each([
    'tick-in-progress', 'reader-priority', 'concurrent-mover', 'smoke-backoff', 'held-after-rollback',
    'disabled', 'dirty', 'dirty-tree', 'local-commits', 'index-locked', 'switch-busy',
    'smoke-env-load', 'future-benign-reason',
  ])('does not announce a failure for a hold or unknown reason: %s', async (reason) => {
    terminal({ moved: false, reason });
    await rebuildClone(options);
    expect(options.emitEvent).not.toHaveBeenCalled();
  });

  it('inherits the isolated event sink when callers inject an env without an event path', async () => {
    const path = join(scratch, 'ambient-events.jsonl');
    vi.stubEnv('WE_DAEMON_EVENTS', path);
    delete options.env.WE_DAEMON_EVENTS;
    terminal({ moved: true, adopted: true, head: sha });
    try {
      await rebuildClone(options);
      expect(options.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rebuild-adopted' }), {
        env: expect.objectContaining({ WE_DAEMON_EVENTS: path }),
      });
    } finally { vi.unstubAllEnvs(); }
  });

  it('writes through the default emitter to the test sink with no caller event override', async () => {
    const path = process.env.WE_DAEMON_EVENTS;
    expect(path.startsWith(process.env.TMPDIR)).toBe(true);
    delete options.env.WE_DAEMON_EVENTS;
    delete options.emitEvent;
    terminal({ moved: true, adopted: true, head: sha });
    await rebuildClone(options);
    const events = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ kind: 'rebuild-adopted', detail: { sha } });
  });

  it('accepts a full SHA-256 adoption head', async () => {
    const head = 'c'.repeat(64);
    terminal({ moved: true, adopted: true, head });
    await rebuildClone(options);
    expectEvent('rebuild-adopted', { sha: head });
  });

  it('passes real already-adopted and recovered-adopted helper results through the wrapper without events', async () => {
    const run = vi.fn((args) => {
      if (args[0] === 'rev-parse') return { status: args.includes('MERGE_HEAD') ? 1 : 0, stdout: sha };
      if (['ls-files', 'status', 'rev-list'].includes(args[0])) return { status: 0, stdout: '' };
      throw new Error(`unexpected git: ${args.join(' ')}`);
    });
    const already = await finalizeRebuild({
      ...options, run, now: () => Date.now(), lease: { token: 'contract' }, prevHead,
      plan: { finalSha: sha, mainSha: sha, inputsKey: 'contract', applied: [] },
    });
    expect(already).toMatchObject({ moved: false, adopted: true, reason: 'already-adopted', head: sha });
    smokeAndAdopt.mockResolvedValue(already);
    expect(await rebuildClone(options)).toEqual(already);
    expect(options.emitEvent).not.toHaveBeenCalled();

    writeRebuildState(options.root, {
      inProgress: { target: sha, prevHead, verified: true, startedAt: '2000-01-01T00:00:00Z' },
    }, options.env);
    const real = await vi.importActual('../daemon-rebuild/prepare.mjs');
    const recovered = await real.prepareRebuild({
      ...options, env: { ...options.env, WE_DAEMON_AUTO_REBASE: '0' }, run, now: () => Date.now(),
    });
    expect(recovered.result).toMatchObject({ moved: false, adopted: true, reason: 'recovered-adopted', head: sha });
    prepareRebuild.mockReturnValue(recovered);
    expect(await rebuildClone(options)).toEqual({ ...recovered.result, alerts: recovered.alerts });
    expect(options.emitEvent).not.toHaveBeenCalled();
  });

  it.each([...FAILURE_REASONS, 'error: build threw', 'worktree-add-failed: unavailable'])(
    'emits a failure for the explicit failure reason %s', async (reason) => {
      terminal({ moved: false, reason });
      await rebuildClone(options);
      expectEvent('rebuild-failed', { reason });
    },
  );

  it('classifies every declared reason in daemon-rebuild and daemon-version-runtime as idle or failure', () => {
    // Idle here means no failure event when moved=false. This also inventories
    // nested planning/diagnostic reasons, which must not imply a failed rebuild.
    const idle = new Set([
      'adopted', 'already-adopted', 'already-head', 'already-on-main', 'applied', 'applied-',
      'applied-pinned', 'applied-retry', 'applied-stack-fallback', 'auto-rebase of ',
      'branch-not-allowlisted', 'clone-recloned', 'conflict', 'deps-job-running', 'deps-job-spaced',
      'deps-job-started', 'detached-off-main', 'detached-or-unreadable-head', 'detached-with-changes',
      'diff-unknown', 'dirty', 'disabled', 'dispatch-smoke', 'executable-or-runtime-file-change',
      'expired', 'fallback-inputs-moved', 'fallback-not-allowed', 'fallback-plain-main',
      'harness-broken-adopted-not-worse', 'held-after-rollback', 'imported-change', 'in-main',
      'index-locked', 'local-commits', 'manifest-or-config-change', 'merge-in-progress',
      'needs-build', 'no-change', 'no-local-main', 'no-lockfile', 'no-result', 'non-store-changes',
      'none', 'none of ', 'not-on-main', 'not-state-files', 'operation-in-progress', 'origin/main ',
      'other-base', 'overlay-no-longer-wanted', 'overlay-registration-changed', 'overlay-set-aside', 'pinned-conflict-skipped',
      'pinned-contained-in-applied', 'pinned-overlay-conflict-skipped', 'pr-closed', 'pr-merged',
      'ready-adopted', 'ready-pending', 'ready-recorded', 'rebuild-in-progress', 'rebuild-job-running',
      'rebuild-job-spaced', 'rebuild-job-started', 'recovered-adopted', 'ref-gone', 'ref-unresolved',
      'rejected-since', 'root-changed-during-smoke', 'skipped-unrelated', 'smoke-backoff',
      'smoke-env-load', 'smoke-harness-broken-backoff', 'smoke-load-confirm-passed', 'stack-base-moved',
      'stack-contained', 'state-file-busy', 'superseded-live-set-unknown', 'superseded-omits-live-overlay',
      'swapped', 'switch-busy', 'touches-dispatch-path', 'unknown', 'unsafe-ref', 'untracked-collision',
      'unverified-build', 'up-to-date', 'scoped-noop', 'fixpoint-exhausted',
      'entries-unreadable', 'closure-incomplete', 'closure-too-large', 'closure-opaque', 'scope-unreadable',
    ]);
    const reasons = new Set();
    function collect(expression) {
      if (!expression) return;
      if (ts.isStringLiteralLike(expression)) reasons.add(expression.text);
      else if (ts.isTemplateExpression(expression)) reasons.add(expression.head.text);
      else if (ts.isConditionalExpression(expression)) { collect(expression.whenTrue); collect(expression.whenFalse); }
      else if (ts.isBinaryExpression(expression)) { collect(expression.left); collect(expression.right); }
      else if (ts.isParenthesizedExpression(expression)) collect(expression.expression);
    }
    // Resolve filesystem paths directly: Vite rewrites new URL(..., import.meta.url)
    // as an asset URL, which cannot be passed to Node's filesystem APIs.
    const libDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const dir = join(libDir, 'daemon-rebuild');
    const files = readdirSync(dir).filter((name) => name.endsWith('.mjs')).map((name) => join(dir, name));
    files.push(join(libDir, 'daemon-version-runtime.mjs'));
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      function visit(node) {
        if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) && node.name?.getText(source) === 'reason') collect(node.initializer);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && (node.left.getText(source) === 'reason' || node.left.getText(source).endsWith('.reason'))) collect(node.right);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(reasons.size).toBeGreaterThan(100);
    for (const reason of reasons) {
      const key = reason.split(':', 1)[0];
      expect(Number(idle.has(key)) + Number(FAILURE_REASONS.has(key)), `unclassified or ambiguous reason: ${reason}`).toBe(1);
    }
  });

  it('rebuildClone writes coordination events when emitEvent is omitted', async () => {
    const { emitEvent, ...productionOptions } = options;
    terminal({ moved: true, adopted: true, head: sha });
    await rebuildClone(productionOptions);
    terminal({ moved: false, reason: 'fetch-failed' });
    await rebuildClone(productionOptions);
    const records = readFileSync(options.env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
    expect(records).toEqual([
      { at: expect.any(String), repo: 'web-everything', daemon: basename(options.root), kind: 'rebuild-adopted', detail: { sha } },
      { at: expect.any(String), repo: 'web-everything', daemon: basename(options.root), kind: 'rebuild-failed', detail: { reason: 'fetch-failed' } },
    ]);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it.each([true, false])('a throwing emitter preserves the complete result (moved=%s)', async (moved) => {
    const result = moved
      ? { moved: true, adopted: true, head: sha, prevHead, alerts: [] }
      : { moved: false, reason: 'dispatch-smoke-failed', alerts: [] };
    smokeAndAdopt.mockResolvedValue(result);
    options.emitEvent.mockImplementation(() => { throw new Error('event sink unavailable'); });
    expect(await rebuildClone(options)).toEqual(result);
    expect(options.emitEvent).toHaveBeenCalledTimes(1);
  });
});
