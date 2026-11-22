import { test as nodeTest } from 'node:test';
const test = process.env.VITEST ? (await import('vitest')).it : nodeTest;
import assert from 'node:assert/strict';
import { checkOverlays } from '../daemon-overlay-audit-check.mjs';
test('old registrations with unresolved tips fail closed and registered sha wins', () => {
  const sha = 'a'.repeat(40);
  const result = checkOverlays({ states: [{ clone: '/fixture/clone', overlays: [
    { ref: 'lane/old', addedAt: '2026-11-10T00:00:00Z' },
    { ref: 'lane/pinned', sha, addedAt: '2026-11-10T00:00:00Z' },
  ] }], evidence: { auditRecords: [], waivers: [] }, resolveSha: () => null, now: new Date('2026-11-22T00:00:00Z') });
  assert.equal(result.length, 2);
  assert.equal(result[0].ok, false);
  assert.equal(result[0].sha, null);
  assert.equal(result[1].sha, sha);
  assert.equal(result[1].ageDays, 12);
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL as NodeURL } from 'node:url';
const cli = fileURLToPath(new NodeURL('../daemon-overlay-audit-check.mjs', import.meta.url));
test('CLI temp HOME smoke: legacy file, JSON, corruption and zero writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-check-'));
  const dir = join(home, '.claude/daemon-overlays');
  const sha = 'a'.repeat(40);
  const run = args => spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, WE_DAEMON_OVERLAY_DIR: dir }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
  });
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '0123456789abcdef.json');
    const body = JSON.stringify({ clone: join(home, 'clone'), overlays: [{ ref: 'lane/old', sha, addedAt: '2026-11-10T00:00:00-05:00' }] });
    writeFileSync(file, body);
    let result = run([]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /UNAUDITED clone lane\/old .*added=2026-11-10T05:00:00.000Z age=\d+d missing=/);
    result = run(['--json', `--overlay-dir=${dir}`]);
    assert.equal(JSON.parse(result.stdout)[0].ok, false);
    assert.equal(readFileSync(file, 'utf8'), body);
    assert.deepEqual(readdirSync(dir), ['0123456789abcdef.json']);
    const ledger = join(home, 'workspace/.operations/coordination');
    mkdirSync(ledger, { recursive: true });
    writeFileSync(join(ledger, 'audits.jsonl'), JSON.stringify({ head: sha, base: 'b'.repeat(40), verdict: 'NOT WEAKENED' }) + '\n');
    result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK 1 overlays audited/);
    writeFileSync(join(dir, 'fedcba9876543210.json'), '{broken');
    result = run(['--json']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UNREADABLE .*fedcba9876543210.json/);
    assert.equal(JSON.parse(result.stdout).length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI resolves old registrations from local refs and leaves Git refs untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-local-ref-'));
  const clone = join(home, 'clone'), dir = join(home, 'states');
  const env = { ...process.env, HOME: home, WE_DAEMON_OVERLAY_DIR: dir, GIT_CONFIG_NOSYSTEM: '1' };
  const git = args => {
    const result = spawnSync('git', ['-C', clone, '-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(clone); mkdirSync(dir);
    git(['init', '-q']); git(['commit', '--allow-empty', '-qm', 'local fixture']);
    const sha = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/lane/old', sha]);
    const before = git(['show-ref']);
    writeFileSync(join(dir, '0123456789abcdef.json'), JSON.stringify({ clone, overlays: [{ ref: 'lane/old', addedAt: '2026-11-10T00:00:00Z' }] }));
    const result = spawnSync(process.execPath, [cli, '--json'], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout)[0].sha, sha);
    assert.equal(git(['show-ref']), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
