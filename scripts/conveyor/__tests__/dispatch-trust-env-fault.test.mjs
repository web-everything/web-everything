/**
 * @file dispatch-trust-env-fault.test.mjs — #3850: `claude --bg` refused fresh dispatch scratch dirs with
 *   "Workspace not trusted" (151 times in the fix-dispatch log). Two causes, both covered here:
 *   1. the trust grant locked on `~/.claude.json.lock`, which Claude Code's own config lock (a DIRECTORY) also
 *      uses — while it existed the grant timed out and was silently skipped;
 *   2. each dispatch trusted only its own brand-new dir, so every spawn depended on a fresh write landing.
 *   The fix trusts the scratch ROOT once (inherited by every session dir), on a lock of its own, and the fix
 *   dispatcher reports a trust refusal as a healed environment fault, not a dispatch failure.
 *   No real `~/.claude.json` is touched: every trust file is a throwaway under tmpdir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  grantDispatchTrust, dispatchTrustTargets, isTrustedIn, dispatchTrustLockPath, DISPATCH_TRUST_ROOT_ENV,
} from '../../operations/dispatch-lane-io.mjs';
import { dispatchFix, classifyEnvFaultRefusals, DISPATCH_ENV_FAULT_PREFIX } from '../reconcile-fix-dispatch.mjs';

let dir;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'we-trust-envfault-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('#3850 — trust the dispatch scratch ROOT, once', () => {
  it('a cwd under the scratch root resolves to the root; anything else to itself', () => {
    expect(dispatchTrustTargets('/ws/.operations/dispatch/abc', { env: {}, scratchRoot: '/ws/.operations/dispatch' }))
      .toEqual(['/ws/.operations/dispatch']);
    expect(dispatchTrustTargets('/ws/.lanes/x/lane-3', { env: {}, scratchRoot: '/ws/.operations/dispatch' }))
      .toEqual(['/ws/.lanes/x/lane-3']);
    // a sibling whose name merely starts with the root's is NOT under it
    expect(dispatchTrustTargets('/ws/.operations/dispatch-other/a', { env: {}, scratchRoot: '/ws/.operations/dispatch' }))
      .toEqual(['/ws/.operations/dispatch-other/a']);
  });

  it(`${DISPATCH_TRUST_ROOT_ENV}=off restores the per-session-dir grant`, () => {
    expect(dispatchTrustTargets('/ws/.operations/dispatch/abc', { env: { [DISPATCH_TRUST_ROOT_ENV]: 'off' }, scratchRoot: '/ws/.operations/dispatch' }))
      .toEqual(['/ws/.operations/dispatch/abc']);
  });

  it('isTrustedIn walks ancestors, like the CLI does for a non-git cwd', () => {
    const cfg = { projects: { '/ws/.operations/dispatch': { hasTrustDialogAccepted: true } } };
    expect(isTrustedIn(cfg, '/ws/.operations/dispatch/abc')).toBe(true);
    expect(isTrustedIn(cfg, '/ws/.operations/other')).toBe(false);
    expect(isTrustedIn({ projects: { '/ws/.operations/dispatch': { hasTrustDialogAccepted: false } } }, '/ws/.operations/dispatch/x')).toBe(false);
  });

  it('grants the root (not the session dir), and a second dispatch writes nothing at all', () => {
    const trustFile = join(dir, 'trust-root.json');
    const root = join(dir, 'dispatch');
    writeFileSync(trustFile, JSON.stringify({ projects: { '/other': { hasTrustDialogAccepted: true } } }));
    grantDispatchTrust(join(root, 'sess-1'), { trustPath: trustFile, env: {}, scratchRoot: root });
    const after1 = readFileSync(trustFile, 'utf8');
    const j = JSON.parse(after1);
    expect(j.projects[root]).toEqual({ hasTrustDialogAccepted: true });
    expect(j.projects[join(root, 'sess-1')]).toBeUndefined();
    expect(j.projects['/other']).toEqual({ hasTrustDialogAccepted: true });
    rmSync(`${trustFile}.bak`, { force: true });
    grantDispatchTrust(join(root, 'sess-2'), { trustPath: trustFile, env: {}, scratchRoot: root });
    expect(readFileSync(trustFile, 'utf8')).toBe(after1);
    expect(existsSync(`${trustFile}.bak`)).toBe(false); // no backup = no write happened
  });

  it('LIVE ROOT CAUSE — a Claude Code config lock DIRECTORY at `<trust>.lock` no longer blocks the grant', () => {
    const trustFile = join(dir, 'trust-cli-lock.json');
    writeFileSync(trustFile, JSON.stringify({ projects: {} }));
    mkdirSync(`${trustFile}.lock`); // what the CLI holds while it writes ~/.claude.json
    grantDispatchTrust(join(dir, 'd2', 'sess'), { trustPath: trustFile, env: {}, scratchRoot: join(dir, 'd2') });
    expect(JSON.parse(readFileSync(trustFile, 'utf8')).projects[join(dir, 'd2')]).toEqual({ hasTrustDialogAccepted: true });
    expect(existsSync(`${trustFile}.lock`)).toBe(true); // the CLI's lock is never stolen
    expect(dispatchTrustLockPath(trustFile)).not.toBe(`${trustFile}.lock`);
  });
});

const BRIEF = '# fix brief for {{PR_NUM}} (item {{ITEM_NUM}})\nacquire: --lane={{LANE}} --session={{SESSION_SLUG}} --scope={{SCOPE}} --base={{LANE_REF}}';

describe('#3850 — a trust refusal is a healed environment fault, not a dispatch failure', () => {
  const planned = { itemNum: null, pr: 3850, laneRef: 'lane/prepare-org-move-xvgqv8h', scope: ['we:x'], lane: 4 };
  const refusal = () => {
    const e = new Error('Command failed: claude --bg …');
    e.status = 1;
    e.stderr = 'Workspace not trusted. Run `claude` in /ws/.operations/dispatch/3e7c5b54 once and accept the trust prompt, then retry.\n';
    return e;
  };

  it('re-grants trust and throws a dispatch-env-fault, never the raw spawn error', () => {
    const healed = [];
    let thrown;
    try {
      dispatchFix(planned, {
        root: '/repo', readBrief: () => BRIEF, mintSessionId: () => 'sid', readFixClaim: () => null,
        ensureSessionCwd: (d) => d, sessionCwdFor: (s) => `/ws/.operations/dispatch/${s}`,
        spawnAgent: () => { throw refusal(); }, healTrust: (d) => healed.push(d),
      });
    } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(thrown.message.startsWith(DISPATCH_ENV_FAULT_PREFIX)).toBe(true);
    expect(thrown.message).toMatch(/workspace not trusted/i); // the health smell still counts it
    expect(thrown.stderr).toBeUndefined();
    expect(healed).toEqual(['/ws/.operations/dispatch/_']);
  });

  it('any other spawn failure is rethrown untouched, with no heal', () => {
    const healed = [];
    const boom = Object.assign(new Error('Command failed'), { status: 2, stderr: 'some other CLI error' });
    expect(() => dispatchFix(planned, {
      root: '/repo', readBrief: () => BRIEF, mintSessionId: () => 'sid', readFixClaim: () => null,
      ensureSessionCwd: (d) => d, sessionCwdFor: (s) => `/ws/.operations/dispatch/${s}`,
      spawnAgent: () => { throw boom; }, healTrust: (d) => healed.push(d),
    })).toThrow(boom);
    expect(healed).toEqual([]);
  });

  it('classifyEnvFaultRefusals re-kinds only the healed env fault', () => {
    expect(classifyEnvFaultRefusals([
      { pr: 1, kind: 'dispatch-failed', why: `${DISPATCH_ENV_FAULT_PREFIX} workspace not trusted …` },
      { pr: 2, kind: 'dispatch-failed', why: 'claude --bg failed (exit 2): boom' },
      { pr: 3, kind: 'scope-overlap', why: `${DISPATCH_ENV_FAULT_PREFIX} never re-kinds another kind` },
    ]).map((r) => r.kind)).toEqual(['dispatch-env-fault', 'dispatch-failed', 'scope-overlap']);
  });
});
