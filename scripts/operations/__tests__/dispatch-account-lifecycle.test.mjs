import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultListAgents, revokeDispatchTrust } from '../dispatch-lane-io.mjs';
import { markWorkerEnv } from '../session-role.mjs';
import { stopSession } from '../dispatch-abort.mjs';
import { acquireFixDispatchClaim, fixDispatchSessionName, refreshLiveFixDispatchClaims } from '../../conveyor/fix-dispatch-claim.mjs';

describe('account switch lifecycle', () => {
  const options = () => ({ map: { accounts: { b: { configDir: '/b' } }, daemons: {}, routing: { accountB: false } },
    statSync: () => ({ isDirectory: () => true, isFile: () => true, size: 2 }), accessSync: () => {} });

  it('an unmapped observer retains explicit A, default A and provisioned B after rollback', () => {
    const env = { HOME: '/home-a', CLAUDE_CONFIG_DIR: '/explicit-a', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
    const rows = defaultListAgents({ env, accountOptions: options(),
      exec: (_cmd, _args, opts) => JSON.stringify([{ sessionId: opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME }]) });
    expect(rows.map(row => row.sessionId)).toEqual(['/explicit-a', '/home-a', '/b']);
  });

  it.each(['timeout', 'malformed', 'wrong-shape'])('never returns a partial listing when B has a %s failure', (failure) => {
    const env = { HOME: '/a', WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
    const calls = [];
    expect(() => defaultListAgents({ env, accountOptions: options(), exec: (_cmd, _args, opts) => {
      calls.push(opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME);
      if (!opts.env.CLAUDE_CONFIG_DIR) return '[{"sessionId":"a"}]';
      if (failure === 'timeout') throw new Error('timed out');
      return failure === 'malformed' ? '{' : '{}';
    } })).toThrow();
    expect(calls).toEqual(['/a', '/b']);
  });

  it('a wrong-profile no-job response cannot hide a stop failure in B', () => {
    const calls = [];
    expect(() => stopSession({ handle: 'b-session', env: { HOME: '/a' }, accountOptions: options(),
      exec: (_cmd, _args, opts) => {
        calls.push(opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME);
        throw Object.assign(new Error('failed'), { stderr: opts.env.CLAUDE_CONFIG_DIR ? 'permission denied' : 'No job matching' });
      },
    })).toThrow(/permission denied/);
    expect(calls).toEqual(['/a', '/b']);
  });

  it.each(['missing-login', 'empty-login'])('a broken B profile (%s) cannot block the reaper from revoking A trust', (broken) => {
    const dir = mkdtempSync(join(tmpdir(), 'account-revoke-'));
    const home = join(dir, 'home');
    const b = join(dir, 'b');
    const cwd = join(dir, 'scratch');
    const saved = Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'WE_DISPATCH_TRUST_PATH', 'XPC_SERVICE_NAME'].map(k => [k, process.env[k]]));
    try {
      mkdirSync(home);
      mkdirSync(b);
      if (broken === 'empty-login') writeFileSync(join(b, '.claude.json'), '');
      const trusted = JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } }, keep: 1 });
      writeFileSync(join(home, '.claude.json'), trusted);
      process.env.HOME = home;
      for (const k of ['CLAUDE_CONFIG_DIR', 'WE_DISPATCH_TRUST_PATH', 'XPC_SERVICE_NAME']) delete process.env[k];
      const map = { accounts: { b: { configDir: b } }, daemons: {}, routing: { accountB: false } };
      expect(revokeDispatchTrust([cwd], { accountOptions: { map } }).revoked).toEqual([cwd]);
      const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      expect(after.projects[cwd]).toBeUndefined();
      expect(after.keep).toBe(1);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps A and B discoverable, renews both claims and stops both through enable and rollback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'account-lifecycle-'));
    const b = join(dir, 'b');
    mkdirSync(b);
    writeFileSync(join(b, '.claude.json'), '{}');
    const label = 'com.we.fix-dispatch-daemon';
    const env = { HOME: dir, XPC_SERVICE_NAME: label, WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' };
    const map = { accounts: { b: { configDir: b } }, daemons: { [label]: 'b' }, routing: { accountB: false } };
    const accountOptions = { map };
    const jobs = new Map([[dir, []], [b, []]]);
    const stopped = [];
    const exec = (_cmd, argv, opts) => {
      const profile = opts.env.CLAUDE_CONFIG_DIR || opts.env.HOME;
      const rows = jobs.get(profile);
      if (argv[0] === 'agents') return JSON.stringify(rows);
      if (!rows.some(row => row.sessionId === argv[1])) throw Object.assign(new Error('gone'), { stderr: 'No job matching' });
      stopped.push([profile, argv[1]]);
      jobs.set(profile, rows.filter(row => row.sessionId !== argv[1]));
      return 'stopped';
    };
    // Rows carry the claim's real session name: claim renewal matches the minted name, never the session id.
    const launch = (id, pr) => {
      const selected = markWorkerEnv(env, accountOptions);
      const name = fixDispatchSessionName({ repo: 'we', pr, kind: 'fix' });
      jobs.get(selected.CLAUDE_CONFIG_DIR || selected.HOME).push({ sessionId: id, name, state: 'working' });
    };
    try {
      launch('a', 6832);
      map.routing.accountB = true;
      launch('b', 6833);
      for (const enabled of [true, false]) {
        map.routing.accountB = enabled;
        expect(defaultListAgents({ env, exec, accountOptions }).map(row => row.sessionId).sort()).toEqual(['a', 'b']);
        const lockRoot = join(dir, String(enabled));
        for (const [i, id] of ['a', 'b'].entries()) acquireFixDispatchClaim({ repo: 'we', pr: 6832 + i, owner: id, sessionId: id, lockRoot, nowMs: 1_000 });
        const result = refreshLiveFixDispatchClaims({ lockRoot, nowMs: 541_000, nowIso: () => new Date(541_000).toISOString(),
          listAgentsAll: () => defaultListAgents({ env, exec, accountOptions, all: true }), hungInfoFor: () => null,
          awaitingVerifyFor: () => null, idleRelease: { enabled: false } });
        expect(result.refreshed).toHaveLength(2);
        for (const i of [0, 1]) expect(acquireFixDispatchClaim({ repo: 'we', pr: 6832 + i, owner: 'duplicate', lockRoot, nowMs: 661_000 }).ok).toBe(false);
      }
      stopSession({ handle: 'b', env, exec, accountOptions }); // rollback must still reach B
      map.routing.accountB = true;
      stopSession({ handle: 'a', env, exec, accountOptions }); // enable must still reach A
      expect(stopped).toEqual([[b, 'b'], [dir, 'a']]);
      expect([...jobs.values()].flat()).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
