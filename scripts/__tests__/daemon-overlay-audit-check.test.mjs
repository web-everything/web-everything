import { test as nodeTest } from 'node:test';
const test = process.env.VITEST ? (await import('vitest')).it : nodeTest;
import assert from 'node:assert/strict';
import { checkOverlays } from '../daemon-overlay-audit-check.mjs';
test('gone refs fail closed even with a stored SHA', () => {
  const sha = 'a'.repeat(40);
  const result = checkOverlays({ states: [{ clone: '/fixture/clone', overlays: [
    { ref: 'lane/old', addedAt: '2026-11-10T00:00:00Z' },
    { ref: 'lane/pinned', sha, addedAt: '2026-11-10T00:00:00Z' },
  ] }], evidence: { auditRecords: [], waivers: [] }, resolveSha: () => null, now: new Date('2026-11-22T00:00:00Z') });
  assert.equal(result.length, 2);
  assert.equal(result[0].ok, false);
  assert.equal(result[0].sha, null);
  assert.equal(result[1].sha, null);
  assert.equal(result[1].ageDays, 12);
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs';
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
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /UNAUDITED/);
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
    const base = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/main', base]);
    git(['commit', '--allow-empty', '-qm', 'overlay']);
    const sha = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/lane/old', sha]);
    const before = git(['show-ref']);
    writeFileSync(join(dir, '0123456789abcdef.json'), JSON.stringify({ clone, overlays: [{ ref: 'lane/old', addedAt: '2026-11-10T00:00:00Z' }] }));
    const result = spawnSync(process.execPath, [cli, '--json'], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout)[0].sha, sha);
    assert.equal(git(['show-ref']), before);
    const ledger = join(home, 'workspace/.operations/coordination');
    mkdirSync(ledger, { recursive: true });
    writeFileSync(join(ledger, 'audits.jsonl'), JSON.stringify({ head: sha, base, verdict: 'NOT WEAKENED', questionHash: QUESTION_HASH, at: '2026-11-10T00:00:00Z', findings: [] }) + '\n');
    const run = () => spawnSync(process.execPath, [cli], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    const green = run();
    assert.equal(green.status, 0, green.stderr);
    assert.match(green.stdout, /OK 1 overlays audited/);
    writeFileSync(join(dir, '0123456789abcdef.json'), JSON.stringify({ clone, overlays: [{ ref: 'lane/old', sha, addedAt: '2026-11-10T00:00:00Z' }] }));
    git(['commit', '--allow-empty', '-qm', 'moved']);
    const current = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/lane/old', current]);
    const moved = run();
    assert.equal(moved.status, 1, moved.stderr);
    assert.ok(moved.stdout.includes(`sha=${current} moved-from=${sha}`), moved.stdout);
    git(['update-ref', '-d', 'refs/remotes/origin/lane/old']);
    const gone = run();
    assert.equal(gone.status, 1, gone.stderr);
    assert.ok(gone.stdout.includes(`sha=unresolved moved-from=${sha}`), gone.stdout);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('moved refs evaluate current tip instead of historical green evidence', () => {
  const stored = 'a'.repeat(40), current = 'c'.repeat(40);
  const result = checkOverlays({ states: [{ clone: '/fixture/clone', overlays: [{ ref: 'lane/fix', sha: stored }] }],
    evidence: { auditRecords: [{ head: stored, base: 'b'.repeat(40), verdict: 'NOT WEAKENED' }], waivers: [] },
    resolveSha: () => current });
  assert.equal(result[0].ok, false);
  assert.equal(result[0].sha, current);
  assert.equal(result[0].movedFrom, stored);
});

import { QUESTION_HASH } from '../operations/codex-audit.mjs';

test('inventory binds waivers to each overlay ref, even for an identical SHA', () => {
  const sha = 'a'.repeat(40);
  const waiver = { ref: 'lane/approved', sha, ruling: 'R12', findings: ['accepted'], actor: 'operator', quote: 'approved', at: '2026-11-10T00:00:00Z' };
  const results = checkOverlays({ states: [{ clone: '/fixture/clone', overlays: [{ ref: waiver.ref, sha }, { ref: 'lane/other', sha }] }],
    resolveSha: () => sha, covers: () => true,
    evidence: { waivers: [waiver], auditRecords: [{ head: sha, base: 'b'.repeat(40), questionHash: QUESTION_HASH, at: waiver.at, verdict: 'WEAKENED', findings: waiver.findings }] } });
  assert.equal(results[0].kind, 'waiver');
  assert.equal(results[1].ok, false);
});

test('CLI rejects malformed inventory shapes instead of crashing or reporting audited', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-invalid-'));
  const dir = join(home, 'states');
  try {
    mkdirSync(dir);
    const file = join(dir, '0123456789abcdef.json');
    for (const state of [null, { clone: 'clone', overlays: {} }, { overlays: [] },
      { clone: 'clone', overlays: [null] }, { clone: 'clone', overlays: [{ ref: 'lane/fix', sha: [] }] },
      { clone: 'clone', overlays: [{ ref: '--bad' }] }]) {
      const body = JSON.stringify(state);
      writeFileSync(file, body);
      const result = spawnSync(process.execPath, [cli, '--json', `--overlay-dir=${dir}`], {
        env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /UNREADABLE/);
      assert.deepEqual(JSON.parse(result.stdout), []);
      assert.equal(readFileSync(file, 'utf8'), body);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI only resolves local refs and ancestry, with lazy fetch and optional locks disabled', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-readonly-'));
  const dir = join(home, 'states'), bin = join(home, 'bin'), log = join(home, 'calls.jsonl');
  const sha = 'a'.repeat(40), base = 'b'.repeat(40);
  try {
    mkdirSync(dir); mkdirSync(bin);
    const git = join(bin, 'git');
    writeFileSync(git, `#!${process.execPath}\n` +
      `const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({ args, lazy: process.env.GIT_NO_LAZY_FETCH, locks: process.env.GIT_OPTIONAL_LOCKS }) + '\\n');\n` +
      `if (args.includes('rev-parse')) process.stdout.write('${sha}\\n');\n`);
    chmodSync(git, 0o755);
    writeFileSync(join(dir, '0123456789abcdef.json'), JSON.stringify({ clone: home, overlays: [{ ref: 'lane/fix' }] }));
    const ledger = join(home, 'workspace/.operations/coordination');
    mkdirSync(ledger, { recursive: true });
    writeFileSync(join(ledger, 'audits.jsonl'), JSON.stringify({ head: sha, base, verdict: 'NOT WEAKENED',
      questionHash: QUESTION_HASH, at: '2026-11-10T00:00:00Z', findings: [] }) + '\n');
    const result = spawnSync(process.execPath, [cli, '--json', `--overlay-dir=${dir}`], {
      env: { ...process.env, HOME: home, PATH: bin, PROBE_LOG: log }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].kind, 'audit');
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [
      { args: ['-C', home, 'rev-parse', '--verify', 'refs/remotes/origin/lane/fix'], lazy: '1', locks: '0' },
      { args: ['merge-base', '--is-ancestor', base, 'origin/main'], lazy: '1', locks: '0' },
    ]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('inventory loads evidence for each clone instead of borrowing the caller pass', () => {
  const sha = 'a'.repeat(40), base = 'b'.repeat(40), seen = [];
  const pass = { head: sha, base, verdict: 'NOT WEAKENED', findings: [], questionHash: QUESTION_HASH, at: '2026-11-10T00:00:00Z' };
  const results = checkOverlays({ states: ['/caller', '/candidate'].map(clone => ({ clone, overlays: [{ ref: 'lane/fix' }] })),
    evidence: { auditRecords: [pass] }, evidenceForClone: clone => {
      seen.push(clone);
      return { auditRecords: [{ ...pass, ...(clone === '/candidate' ? { verdict: 'WEAKENED', findings: ['unsafe'] } : {}) }] };
    }, resolveSha: () => sha, covers: () => true });
  assert.deepEqual(seen, ['/caller', '/candidate']);
  assert.deepEqual(results.map(r => r.ok), [true, false]);
});

test('inventory requires evidence for the approved edge SHA as well as the branch tip', () => {
  const sha = 'a'.repeat(40), edgeSha = 'c'.repeat(40);
  const pass = { head: sha, base: 'b'.repeat(40), verdict: 'NOT WEAKENED', findings: [], questionHash: QUESTION_HASH, at: '2026-11-10T00:00:00Z' };
  const check = auditRecords => checkOverlays({ states: [{ clone: '/clone', overlays: [{ ref: 'lane/fix', edgeResolution: { sha: edgeSha } }] }],
    evidence: { auditRecords }, resolveSha: () => sha, covers: () => true })[0];
  assert.equal(check([pass]).edgeSha, edgeSha);
  assert.equal(check([pass]).ok, false);
  assert.equal(check([pass, { ...pass, head: edgeSha }]).ok, true);
});

test('inventory flags a tip differing from the admitted audited SHA even with green tip evidence', () => {
  const auditedSha = 'a'.repeat(40), tip = 'c'.repeat(40);
  const pass = { head: tip, base: 'b'.repeat(40), verdict: 'NOT WEAKENED', findings: [], questionHash: QUESTION_HASH, at: '2026-11-10T00:00:00Z' };
  const check = sha => checkOverlays({ states: [{ clone: '/clone', overlays: [{ ref: 'lane/fix', auditedSha }] }],
    evidence: { auditRecords: [pass, { ...pass, head: auditedSha }] }, resolveSha: () => sha, covers: () => true })[0];
  assert.equal(check(tip).ok, false);
  assert.equal(check(auditedSha).ok, true);
});
