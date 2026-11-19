import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { urgentLedger, urgentKeyPath, urgentSignature } from '../../operations/urgent-verify-marker.mjs';
import { requestHotPatch, readHotPatch, recordVerifyResult, hotPatchPath } from '../hot-patch.mjs';
import { main } from '../../hot-patch.mjs';

const fixture = fn => async () => {
  const home = mkdtempSync(join(tmpdir(), 'hot-patch-round3-'));
  const root = join(home, 'repo'); mkdirSync(root);
  const git = args => {
    const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test',
      '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', timeout: 5000 });
    expect(r.status, r.stderr).toBe(0); return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']); git(['commit', '--allow-empty', '-qm', 'base']);
  const good = git(['rev-parse', 'HEAD']);
  git(['checkout', '-qb', 'lane/hot']); git(['commit', '--allow-empty', '-qm', 'patch']);
  const sha = git(['rev-parse', 'HEAD']); git(['reset', '--hard', good]);
  const env = { ...process.env, HOME: home, WE_DAEMON_STATE_DIR: join(home, 'state'),
    WE_DAEMON_OVERLAY_DIR: join(home, 'overlays'), WE_DAEMON_CLONE_LOCK_ROOT: join(home, 'locks'),
    WE_DAEMON_EVENTS: join(home, 'events.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(home, 'preferences.json'),
    WE_POLICY_CASCADE_LOG: '0' };
  const marker = (change = {}) => {
    const record = { sha, suite: 'full', shards: 1, result: 'green', startedAt: '2026-11-19T10:00:00Z',
      finishedAt: '2026-11-19T10:01:00Z', host: 'test-host', ...change };
    const key = Buffer.alloc(32, 7);
    mkdirSync(dirname(urgentKeyPath(home)), { recursive: true }); writeFileSync(urgentKeyPath(home), key);
    mkdirSync(dirname(urgentLedger(home)), { recursive: true });
    writeFileSync(urgentLedger(home), JSON.stringify({ ...record, sig: urgentSignature(record, key) }) + '\n');
  };
  try {
    expect((await requestHotPatch({ root, env, sha, branch: 'lane/hot', daemon: 'review', kind: 'incident',
      files: ['scripts/tool.mjs'] })).ok).toBe(true);
    await fn({ root, env, sha, good, home, marker, git });
  } finally { rmSync(home, { recursive: true, force: true }); }
};

for (const evidence of ['missing', 'unreadable', 'wrong-sha', 'unknown-result', 'bad-host', 'bad-finish', 'forged']) {
  test(`caller green cannot bypass ${evidence} verify marker`, fixture(async ({ root, env, sha, home, marker }) => {
    if (evidence !== 'missing') marker(evidence === 'wrong-sha' ? { sha: 'a'.repeat(40) }
      : evidence === 'unknown-result' ? { result: 'pending' }
        : evidence === 'bad-host' ? { host: '' } : evidence === 'bad-finish' ? { finishedAt: 'bad' } : {});
    if (evidence === 'unreadable') writeFileSync(urgentLedger(home), '{bad\n');
    if (evidence === 'forged') writeFileSync(urgentKeyPath(home), Buffer.alloc(32, 8));
    const before = readFileSync(hotPatchPath(root, env), 'utf8');
    expect((await recordVerifyResult({ root, env, sha, result: 'green' })).ok).toBe(false);
    expect(readFileSync(hotPatchPath(root, env), 'utf8')).toBe(before);
    expect(await main(['verify-result', '--daemon', root, '--sha', sha, '--result=green'],
      { env, stdout: () => {}, stderr: () => {} })).toBe(1);
  }));
}
test('red marker overrides caller green and makes rollback durable', fixture(async ({ root, env, sha, marker }) => {
  marker({ result: 'red' });
  expect((await recordVerifyResult({ root, env, sha, result: 'green' })).ok).toBe(true);
  expect(readHotPatch(root, env)).toMatchObject({ owed: { verify: 'red' }, rollbackPending: 'verify-red' });
}));
test('green comes from the signed marker without a caller result', fixture(async ({ root, env, sha, marker }) => {
  marker(); expect((await recordVerifyResult({ root, env, sha })).ok).toBe(true);
  expect(readHotPatch(root, env).owed.verify).toBe('green');
}));
