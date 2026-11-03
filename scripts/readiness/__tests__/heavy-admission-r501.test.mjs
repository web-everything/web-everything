// @vitest-environment node
/** R501: needs-git local routing and the remote-success record that forgeShare reads. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { main, decideRemote, runWithRemoteDecision, resolveAdmissionPolicy } from '../heavy-admission.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const mk = () => { const r = mkdtempSync(join(process.env.TMPDIR, 'r501-')); roots.push(r); return r; };
const policy = resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always', loadPerCoreThreshold: 3, clientPath: null,
  maxConcurrent: 8, backoffMs: 120000, backoffFailures: 3, maxLoadPerCore: 0.8, minFreeRamPct: 15 } } });
const healthy = async () => ({ sampledAtET: (await import('../forge-exec-run.mjs')).easternTimestamp(Date.now()), cores: 8, loadPerCore: 0.1, memFreePct: 90, activeRuns: 0, recent: [] });

describe('R501 needs-git route', () => {
  it('decideRemote keeps a git-spawning test file local with the needs-git reason', () => {
    const cwd = mk();
    writeFileSync(join(cwd, 'git.test.mjs'), "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['ls-files']);\n");
    writeFileSync(join(cwd, 'plain.test.mjs'), "import { it } from 'vitest';\n");
    const run = f => decideRemote({ policy, loadPerCore: 4, cwd, argv: ['npx', 'vitest', 'run', f] });
    expect(run('git.test.mjs')).toMatchObject({ remote: false, needsGit: true, reason: expect.stringContaining('needs-git') });
    expect(run('plain.test.mjs')).toMatchObject({ remote: true });
  });

  it('runWithRemoteDecision logs a needs-git fallback row and never calls Forge', async () => {
    const cwd = mk(); const lockRoot = join(cwd, 'heavy');
    writeFileSync(join(cwd, 'git.test.mjs'), "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['ls-files']);\n");
    const remoteExec = vi.fn();
    const out = await runWithRemoteDecision({ argv: ['npx', 'vitest', 'run', 'git.test.mjs'], policy, cwd, env: {}, lockRoot,
      loadPerCore: () => 4, remoteExec, readTelemetry: healthy, log: () => {} });
    expect(out).toEqual({ handled: false });
    expect(remoteExec).not.toHaveBeenCalled();
    const row = JSON.parse(readFileSync(join(lockRoot, 'remote-fallbacks.jsonl'), 'utf8').trim());
    expect(row.reason).toBe('needs-git');
  });
});

describe('R501 needs-git vs host overload', () => {
  it('a below-threshold git-spawning run is not sent remote by the host-overload override', async () => {
    const cwd = mk(); const lockRoot = join(cwd, 'heavy');
    writeFileSync(join(cwd, 'git.test.mjs'), "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['ls-files']);\n");
    const remoteExec = vi.fn();
    const p = resolveAdmissionPolicy({ platform: { remote: { ...policy.settings.remote, mode: 'above-threshold' } } });
    const out = await runWithRemoteDecision({ argv: ['npx', 'vitest', 'run', 'git.test.mjs'], policy: p, cwd, env: {}, lockRoot,
      loadPerCore: () => 1, hostOverloaded: () => true, remoteExec, readTelemetry: healthy, log: () => {} });
    expect(out).toEqual({ handled: false });
    expect(remoteExec).not.toHaveBeenCalled();
  });
});

describe('R501 remote success record', () => {
  it('main appends a remote-runs row when Forge handled the run', async () => {
    const root = mk(); const pool = join(root, 'pool'); mkdirSync(pool);
    const prefs = join(root, 'preferences.json');
    writeFileSync(prefs, JSON.stringify({ heavyAdmission: { remote: { enabled: true, mode: 'always' } } }));
    const exited = new Error('test exit');
    vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const [k, v] of Object.entries({ LANE_POOL_ROOT: pool, WE_PLATFORM_PREFERENCES: prefs, CI: '', WE_HEAVY_ADMISSION: 'on',
      WE_HEAVY_ADMISSION_HELD: '', WE_FORGE_GATE_DISPATCH: '', WE_HEAVY_ADMISSION_RUN_WAIT_MS: '0',
      WE_VERIFY_REMOTE_REPORT: join(root, 'report.jsonl') })) vi.stubEnv(k, v);
    const remoteExec = vi.fn(async () => ({ mode: 'remote', code: 0, receiptId: 'rcpt-1' }));
    await expect(main(['run', `--repo=${root}`, '--', 'npm', 'run', 'test:unit', '--', 'plain.test.mjs'], { remoteExec, readTelemetry: healthy })).rejects.toBe(exited);
    const found = [];
    const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'remote-runs.jsonl') found.push(p); } };
    walk(root);
    expect(found).toHaveLength(1);
    expect(JSON.parse(readFileSync(found[0], 'utf8').trim())).toMatchObject({ receiptId: 'rcpt-1', kind: expect.any(String) });
  });
});
