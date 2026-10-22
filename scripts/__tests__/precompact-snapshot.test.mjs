import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { buildSnapshot, pushSnapshot, renderSnapshot, resolveSnapshotConfig, writeSnapshotAtomic } from '../precompact-snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'precompact-test-'));
  temporary.push(dir);
  const env = { ...process.env, PATH: '', PRECOMPACT_SNAPSHOT_PATH: join(dir, 'handoff/session-snapshot.json'),
    PRECOMPACT_HANDOFF_PATH: join(dir, 'handoff.md'), RULINGS_DIGEST_PATH: join(dir, 'rulings.md'),
    FIX_READY_STORE: join(dir, 'ready.jsonl'), HEALTH_WATCH_SELF_SYNC_DIR: join(dir, 'sync'), LANE_POOL_ROOT: join(dir, 'pool') };
  mkdirSync(env.HEALTH_WATCH_SELF_SYNC_DIR);
  mkdirSync(env.LANE_POOL_ROOT);
  writeFileSync(env.PRECOMPACT_HANDOFF_PATH, '- [ ] ask\n');
  writeFileSync(env.RULINGS_DIGEST_PATH, 'R4 | standing | D | quote | Remember mem:owed\nR5 | standing | D | q | Old mem:owed retired:manual\n');
  writeFileSync(env.FIX_READY_STORE, '');
  const run = (input = { session_id: 'session-123', trigger: 'manual' }) => spawnSync(process.execPath,
    [join(root, 'scripts/precompact-snapshot.mjs')], { cwd: root, env, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  const snapshot = () => JSON.parse(readFileSync(env.PRECOMPACT_SNAPSHOT_PATH, 'utf8')).snapshots.at(-1);
  return { dir, env, run, snapshot };
}

describe('pre-compaction snapshot', () => {
  it('caps UTF-8 JSON at 4 KB, dropping longest lists and oldest asks without mutating inputs', () => {
    const asks = Array.from({ length: 30 }, (_, n) => `${n}: ${'é'.repeat(180)}`);
    const snapshot = buildSnapshot({ at: '2026-10-22T14:30:00Z', pendingAsks: asks,
      agents: [{ name: 'worker', status: 'running' }] });
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(4096);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.atEt).toBe('2026-10-22 10:30');
    expect(snapshot.pendingAsks.at(-1)).toBe(asks.at(-1));
    expect(snapshot.pendingAsks[0]).not.toBe(asks[0]);
    expect(snapshot.agents).toHaveLength(1);
    expect(asks).toHaveLength(30);
  });

  it('keeps the last three snapshots, newest last, and recovers malformed history', () => {
    let history = '{bad';
    for (let n = 1; n <= 5; n++) history = JSON.stringify(pushSnapshot(history, { sessionId: n }, 3));
    expect(JSON.parse(history).snapshots.map((s) => s.sessionId)).toEqual([3, 4, 5]);
  });

  it('atomically replaces valid JSON and leaves no temporary files', () => {
    const { env } = fixture();
    writeSnapshotAtomic(env.PRECOMPACT_SNAPSHOT_PATH, { snapshots: [{ sessionId: 'first' }] });
    writeSnapshotAtomic(env.PRECOMPACT_SNAPSHOT_PATH, { snapshots: [{ sessionId: 'second' }] });
    expect(JSON.parse(readFileSync(env.PRECOMPACT_SNAPSHOT_PATH, 'utf8')).snapshots[0].sessionId).toBe('second');
    expect(readdirSync(dirname(env.PRECOMPACT_SNAPSHOT_PATH))).toEqual(['session-snapshot.json']);
  });

  it('retains sessions A and B from concurrent hook processes', async () => {
    const { env } = fixture();
    const run = (session_id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'scripts/precompact-snapshot.mjs')], { cwd: root, env });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data; });
      child.stdout.resume();
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
      child.stdin.end(JSON.stringify({ session_id, trigger: 'manual' }));
    });
    for (const result of await Promise.all([run('A'), run('B')])) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('writing without lock');
    }
    const history = JSON.parse(readFileSync(env.PRECOMPACT_SNAPSHOT_PATH, 'utf8'));
    expect(history.snapshots.map((snapshot) => snapshot.sessionId).sort()).toEqual(['A', 'B']);
    expect(existsSync(`${env.PRECOMPACT_SNAPSHOT_PATH}.lock`)).toBe(false);
  });

  it('removes locks older than 30 seconds', () => {
    const f = fixture();
    const lock = `${f.env.PRECOMPACT_SNAPSHOT_PATH}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 31000);
    utimesSync(lock, old, old);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('writing without lock');
    expect(f.snapshot().sessionId).toBe('session-123');
    expect(existsSync(lock)).toBe(false);
  });

  it('warns and writes after timing out without removing the held lock', () => {
    const f = fixture();
    const lock = `${f.env.PRECOMPACT_SNAPSHOT_PATH}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, 'held');
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('history lock unavailable (timed out waiting for');
    expect(result.stderr).toContain('writing without lock');
    expect(f.snapshot().sessionId).toBe('session-123');
    expect(readFileSync(lock, 'utf8')).toBe('held');
  });

  it.each([
    ['pendingAsks', 'PRECOMPACT_HANDOFF_PATH'], ['readyNotLoaded', 'FIX_READY_STORE'],
    ['memOwed', 'RULINGS_DIGEST_PATH'], ['leases', 'LANE_POOL_ROOT'], ['agents', 'PATH'],
  ])('isolates failing %s, exits 0 and still writes a snapshot', (source, key) => {
    const f = fixture();
    f.env[key] = key === 'PATH' ? '' : join(f.dir, 'missing');
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(f.snapshot()[source]).toEqual([]);
    expect(f.snapshot().errors.some((error) => error.startsWith(`${source}:`))).toBe(true);
    if (source !== 'memOwed') expect(f.snapshot().memOwed).toEqual([{ id: 'R4', rule: 'Remember' }]);
  });

  it('handles invalid stdin and failed writes without failing the hook', () => {
    const f = fixture();
    expect(f.run('{bad').status).toBe(0);
    f.env.PRECOMPACT_SNAPSHOT_PATH = f.env.PRECOMPACT_HANDOFF_PATH + '/impossible.json';
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('precompact snapshot:');
  });

  it('keeps the last 20 matching asks, trims them and cuts each to 200 characters', () => {
    const f = fixture();
    writeFileSync(f.env.PRECOMPACT_HANDOFF_PATH, Array.from({ length: 30 }, (_, n) =>
      `  ${n % 2 ? 'Needs your call' : '- [ ]'} ${n} ${'x'.repeat(250)}\nordinary line`).join('\n'));
    expect(f.run().status).toBe(0);
    // Use short lines for the last-20 assertion independently of the overall byte cap.
    expect(f.snapshot().pendingAsks.every((ask) => ask.length <= 200 && ask === ask.trim())).toBe(true);
    writeFileSync(f.env.PRECOMPACT_HANDOFF_PATH, Array.from({ length: 30 }, (_, n) => `  - [ ] ask ${n}\nignore`).join('\n'));
    expect(f.run().status).toBe(0);
    expect(f.snapshot().pendingAsks).toEqual(Array.from({ length: 20 }, (_, n) => `- [ ] ask ${n + 10}`));
  });

  it('excludes adopted SHA prefixes in either direction and latest records with loadSkipQuote', () => {
    const f = fixture();
    const records = [
      { ref: 'short', sha: 'abcdef1' }, { ref: 'long', sha: '1234567890abcdef' },
      { ref: 'skip', sha: 'aaaaaaa' }, { ref: 'skip', sha: 'bbbbbbb', loadSkipQuote: 'Deferred' },
      { ref: 'latest', sha: 'ccccccc' }, { ref: 'latest', sha: 'dddddddddddd', at: 'today' },
      { ref: 'too-short', sha: '1234560' },
    ];
    writeFileSync(f.env.FIX_READY_STORE, records.map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(f.env.HEALTH_WATCH_SELF_SYNC_DIR, 'test.rebuild.json'), JSON.stringify({
      adopted: { applied: [{ sha: 'ABCDEF123456' }, { sha: '1234567' }, { sha: '123456' }] },
      inProgress: { applied: [{ sha: 'dddddddddddd' }] },
    }));
    expect(f.run().status).toBe(0);
    expect(f.snapshot().readyNotLoaded).toEqual([
      { ref: 'latest', sha: 'dddddddddd', at: 'today' }, { ref: 'too-short', sha: '1234560' },
    ]);
  });

  it.each(['array', 'object'])('collects in-flight agents from the real CLI %s shape and lease markers without git or lane-pool commands', (shape) => {
    const f = fixture();
    const bin = join(f.dir, 'bin');
    mkdirSync(bin);
    const command = join(bin, 'claude');
    const captured = JSON.parse(readFileSync(join(root, 'scripts/operations/__fixtures__/claude-agents-payload.json'), 'utf8'));
    const waiting = captured.find((agent) => agent.status === 'waiting');
    expect(waiting).toMatchObject({ pid: expect.any(Number), cwd: expect.any(String), kind: 'background',
      startedAt: expect.any(Number), sessionId: expect.any(String), name: expect.any(String), status: 'waiting' });
    const agents = [...captured, ...['idle', 'completed', 'done', 'exited', 'stopped', 'failed'].map((status) =>
      ({ ...waiting, name: `inactive-${status}`, status }))];
    const payload = shape === 'array' ? agents : { agents };
    writeFileSync(command, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
    chmodSync(command, 0o700);
    f.env.PATH = bin;
    const since = new Date().toISOString();
    const lane = join(f.env.LANE_POOL_ROOT, 'web-everything', 'lane-1', '.git');
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, '.lane-lease'), JSON.stringify({ holder: 'owner', purpose: 'fix', acquiredAt: since, ttlMinutes: 240 }));
    const stale = join(f.env.LANE_POOL_ROOT, 'web-everything', 'lane-2', '.git');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, '.lane-lease'), JSON.stringify({ holder: 'old', purpose: 'gone', acquiredAt: '2000-01-01T00:00:00.000Z', ttlMinutes: 1 }));
    expect(f.run().status).toBe(0);
    expect(f.snapshot().agents).toEqual(captured.map((agent) => ({ name: agent.name,
      status: agent.status ?? agent.state ?? 'unknown', kind: agent.kind, sessionId: agent.sessionId.slice(0, 8) })));
    expect(f.snapshot().leases).toEqual([{ lane: 'web-everything/lane-1', holder: 'owner', purpose: 'fix', since }]);
  });

  it('renders compact nonempty sections, none, and a byte-limited truncation line', () => {
    const snapshot = buildSnapshot({ agents: [{ name: 'worker', status: 'running' }], leases: [{ lane: 'lane-1', purpose: 'fix' }],
      readyNotLoaded: [{ ref: 'lane/fix', sha: 'abcdef1234' }], memOwed: [{ id: 'R4', rule: 'Remember' }], pendingAsks: ['- [ ] Decide'] });
    const text = renderSnapshot(snapshot);
    for (const expected of ['worker(running)', 'lane-1 fix', 'lane/fix@abcdef1234', 'mem owed: R4', '  - - [ ] Decide']) expect(text).toContain(expected);
    expect(renderSnapshot(buildSnapshot({}))).toContain('(none)');
    const capped = renderSnapshot(snapshot, { maxBytes: 120 });
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(120);
    expect(capped).toMatch(/\n… snapshot truncated$/);
  });

  it('renders unavailable collectors instead of none when all sections are empty', () => {
    const f = fixture();
    writeFileSync(f.env.PRECOMPACT_HANDOFF_PATH, '');
    writeFileSync(f.env.RULINGS_DIGEST_PATH, '');
    expect(f.run().status).toBe(0);
    const text = renderSnapshot(f.snapshot());
    expect(text).toContain('- unavailable: agents (ENOENT)');
    expect(text).not.toContain('(none)');
    const errors = renderSnapshot(buildSnapshot({ errors: ['leases: EACCES', 'memOwed: SyntaxError'] }));
    expect(errors).toContain('- unavailable: leases (EACCES)');
    expect(errors).toContain('- unavailable: memOwed (SyntaxError)');
    expect(errors).not.toContain('(none)');
  });

  it('expands settings paths, honors env overrides, and registers manual|auto', () => {
    const settings = { settings: { precompactSnapshot: { snapshotPath: '~/snap.json', handoffPath: '~/ask.md', maxBytes: 3000, keep: 2 }, fixNotLoaded: { storePath: '~/ready.jsonl' } } };
    expect(resolveSnapshotConfig({ settings, env: {} })).toMatchObject({ snapshotPath: join(homedir(), 'snap.json'),
      handoffPath: join(homedir(), 'ask.md'), storePath: join(homedir(), 'ready.jsonl'), maxBytes: 3000, keep: 2 });
    expect(resolveSnapshotConfig({ settings, env: { PRECOMPACT_SNAPSHOT_PATH: '~/override' } }).snapshotPath).toBe(join(homedir(), 'override'));
    const entries = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks.PreCompact;
    expect(entries).toContainEqual({ matcher: 'manual|auto', hooks: [{ type: 'command', command: 'node scripts/precompact-snapshot.mjs' }] });
  });
});
