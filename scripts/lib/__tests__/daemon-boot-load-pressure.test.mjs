import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRead, acquireWrite, releaseRead, releaseWrite } from '../daemon-clone-lock.mjs';
import { overlaySafetySettings, runDaemonLoadOverlay, runRealDispatchSmoke } from '../daemon-load-overlay.mjs';

const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'boot-pressure-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const log = { error: vi.fn() };
const settings = (extra = {}) => ({ ...overlaySafetySettings({}, { readSettings: () => null }), ...extra });

function smokeFixture(action, extra = {}) {
  const home = temp();
  const spawn = vi.fn((_node, args, opts) => {
    const [, , slug, , , sessionId, prompt] = args;
    const [, marker, nonce] = prompt.match(/process\.argv\[2\]\)" '([^']+)' '([^']+)'/);
    action?.({ marker, nonce, sessionId, home, store: opts.env.OPERATION_COMPLETIONS_DIR, slug, attempt: spawn.mock.calls.length });
    return { status: 0, stdout: JSON.stringify({ wrapperPid: null }), stderr: '' };
  });
  return { spawn, args: { tree: '.', env: {}, settings: settings({ smokeTimeoutMs: 0 }), spawn,
    home, diagnosticsDir: join(home, 'diagnostics'), probeAlive: () => false, log, hostBusy: () => false, ...extra } };
}
const complete = ({ marker, nonce, store, slug }) => {
  writeFileSync(marker, nonce);
  writeFileSync(join(store, `${slug}.json`), JSON.stringify({ status: 'done' }));
};

describe('reader boundary admission', () => {
  it('wakes on the real reader lease release before the fallback poll', async () => {
    const root = temp(); const lockRoot = temp();
    expect(acquireRead(root, { owner: 'reader', lockRoot }).ok).toBe(true);
    const start = Date.now();
    const waiting = acquireWrite(root, { owner: 'writer', lockRoot, waitMs: 800, pollMs: 2000 });
    const timer = setTimeout(() => releaseRead(root, { owner: 'reader', lockRoot }), 25);
    try {
      expect(await waiting).toEqual({ ok: true });
      expect(Date.now() - start).toBeLessThan(600);
    } finally { clearTimeout(timer); releaseWrite(root, { owner: 'writer', lockRoot }); }
  });

  it('keeps a timed-out registration pending for the next reader tick boundary', async () => {
    const rebuild = vi.fn(async () => ({ adopted: false, moved: false, reason: 'tick-in-progress', heldBy: 'reader' }));
    const removeOverlayFn = vi.fn();
    const result = await runDaemonLoadOverlay({ clone: temp(), ref: 'lane/test', pr: 1, versions: null,
      addOverlayFn: vi.fn(), rebuild, removeOverlayFn, settings: settings({ dispatchSmoke: 'off', tickWaitMs: 20 }),
      installed: () => ({ inHead: false }), clock: () => 0, log });
    expect(result).toMatchObject({ registered: true, adopted: false, pending: true, reason: 'tick-boundary-scheduled', heldBy: 'reader' });
    expect(rebuild.mock.calls[0][0].admissionWaitMs).toBe(20);
    expect(removeOverlayFn).not.toHaveBeenCalled();
  });

  it('resolves new wait bounds through the tool and env cascade with sources', () => {
    const readSettings = () => ({ overlaySmoke: { tickWaitMs: 400, quietWaitMs: 500 } });
    expect(overlaySafetySettings({}, { readSettings })).toMatchObject({ tickWaitMs: 400, tickWaitMsSource: 'tool', quietWaitMs: 500, quietWaitMsSource: 'tool' });
    expect(overlaySafetySettings({ WE_OVERLAY_TICK_WAIT_MS: '300', WE_OVERLAY_SMOKE_QUIET_WAIT_MS: '200' }, { readSettings }))
      .toMatchObject({ tickWaitMs: 300, tickWaitMsSource: 'env', quietWaitMs: 200, quietWaitMsSource: 'env' });
  });
});

describe('dispatch smoke under load', () => {
  it('uses the load-scaled budget in the running smoke, and logs the source', async () => {
    let time = 0; let proof;
    const output = { error: vi.fn() };
    const { args } = smokeFixture((p) => { proof = p; }, {
      settings: settings({ smokeTimeoutMs: 100, dispatchLaunchRetries: 0 }),
      clock: () => time, sleep: async () => { time += 150; complete(proof); }, pollMs: 150,
      load: () => 48, cores: () => 12, shadow: () => ({ verdict: 'admit' }), log: output,
    });
    const result = await runRealDispatchSmoke(args);
    expect(result).toMatchObject({ ok: true, timeoutMs: 400 });
    expect(output.error.mock.calls.flat().join('\n')).toMatch(/loadScaledBudgets.*400.*source/);
  });

  it('retries a harness with no startup evidence once, with fresh scratch stores', async () => {
    const { spawn, args } = smokeFixture((p) => { if (p.attempt === 2) complete(p); });
    expect(await runRealDispatchSmoke(args)).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][2].env.OPERATION_COMPLETIONS_DIR).not.toBe(spawn.mock.calls[1][2].env.OPERATION_COMPLETIONS_DIR);
  });

  it('retries an overload-only timeout after the next quiet window', async () => {
    let time = 0;
    const hostBusy = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    const sleep = vi.fn(async ms => { time += ms; });
    const { spawn, args } = smokeFixture((p) => {
      if (p.attempt === 1) writeFileSync(p.marker, p.nonce); else complete(p);
    }, { hostBusy, clock: () => time, sleep, settings: settings({ smokeTimeoutMs: 0, quietWaitMs: 5000 }) });
    expect(await runRealDispatchSmoke(args)).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
  });

  it('exhausted quiet-window wait stays a retryable failure, never a pass', async () => {
    let time = 0;
    const { spawn, args } = smokeFixture((p) => writeFileSync(p.marker, p.nonce), {
      hostBusy: () => true, clock: () => time, sleep: async ms => { time += ms; },
      settings: settings({ smokeTimeoutMs: 0, quietWaitMs: 20 }),
    });
    expect(await runRealDispatchSmoke(args)).toMatchObject({ ok: false, reason: 'timeout', retryable: true });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'denied'])('never retries or passes a real %s completion even on an overloaded host', async (status) => {
    const { spawn, args } = smokeFixture((p) => {
      writeFileSync(p.marker, p.nonce);
      writeFileSync(join(p.store, `${p.slug}.json`), JSON.stringify({ status, denied: status === 'denied' }));
    }, { hostBusy: () => true });
    const result = await runRealDispatchSmoke(args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(status === 'denied' ? 'commands-denied' : 'command-failed');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['{broken', 'null'])('unreadable completion %s fails closed without an overload retry', async (text) => {
    const { spawn, args } = smokeFixture(p => {
      writeFileSync(p.marker, p.nonce);
      writeFileSync(join(p.store, `${p.slug}.json`), text);
    }, { hostBusy: () => true });
    expect(await runRealDispatchSmoke(args)).toMatchObject({ ok: false, reason: 'smoke-unreadable' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['commands-denied', 'command-failed', 'smoke-unreadable'])('removes and recovers from definite %s', async reason => {
    const removeOverlayFn = vi.fn();
    const rebuild = vi.fn().mockImplementationOnce(async ({ runSmoke }) => {
      await runSmoke({ root: '/candidate', env: {} });
    }).mockResolvedValueOnce({ adopted: true, head: 'recovered' });
    const result = await runDaemonLoadOverlay({ clone: temp(), ref: 'lane/test', pr: 1, versions: null,
      addOverlayFn: vi.fn(), rebuild, removeOverlayFn, appendEventFn: vi.fn(), settings: settings(), log,
      baseSmoke: async () => ({ verdict: 'pass' }), inspect: () => ({ inTree: true, required: true }),
      installed: () => ({ inHead: false }), dispatchSmoke: async () => ({ ok: false, reason }),
    });
    expect(result).toMatchObject({ registered: false, adopted: false, rolledBack: true, rollback: { adopted: true } });
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('does not launder a failed Bash command in a readable transcript into an overload retry', async () => {
    const { spawn, args } = smokeFixture(p => {
      const dir = join(p.home, '.claude', 'projects', 'test');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${p.sessionId}.jsonl`), JSON.stringify({ message: { content: [
        { type: 'tool_result', is_error: true, content: 'exit code 1' },
      ] } }));
    }, { hostBusy: () => true, settings: settings({ smokeTimeoutMs: 0, quietWaitMs: 0 }) });
    expect(await runRealDispatchSmoke(args)).toMatchObject({ ok: false, reason: 'command-failed' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('never passes when the wrapper replaces a done record with an incomplete record', async () => {
    let proof;
    const { args } = smokeFixture(p => { proof = p; complete(p); }, { probeAlive: () => {
      writeFileSync(join(proof.store, `${proof.slug}.json`), JSON.stringify({ status: 'started' }));
      return false;
    } });
    // Force final wrapper observation after the initial pass.
    args.spawn.mockImplementationOnce((_node, argv, opts) => {
      const [, , slug, , , , prompt] = argv;
      const [, marker, nonce] = prompt.match(/process\.argv\[2\]\)" '([^']+)' '([^']+)'/);
      proof = { marker, nonce, slug, store: opts.env.OPERATION_COMPLETIONS_DIR };
      complete(proof);
      return { status: 0, stdout: JSON.stringify({ wrapperPid: 12345 }), stderr: '' };
    });
    expect((await runRealDispatchSmoke(args)).ok).toBe(false);
  });

  it('holds an overload timeout without removing the overlay or reporting adoption', async () => {
    const removeOverlayFn = vi.fn();
    const rebuild = vi.fn(async ({ runSmoke }) => { await runSmoke({ root: '/candidate', env: {} }); return { adopted: true }; });
    const result = await runDaemonLoadOverlay({ clone: temp(), ref: 'lane/test', pr: 1, versions: null,
      addOverlayFn: vi.fn(), rebuild, removeOverlayFn, settings: settings(), log,
      baseSmoke: async () => ({ verdict: 'pass' }), inspect: () => ({ inTree: true, required: true }),
      installed: () => ({ inHead: false }), dispatchSmoke: async () => ({ ok: false, reason: 'timeout', retryable: true }),
    });
    expect(result).toMatchObject({ registered: true, adopted: false, pending: true, reason: 'dispatch-smoke-deferred' });
    expect(removeOverlayFn).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
});
