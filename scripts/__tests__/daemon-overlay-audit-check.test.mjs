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

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL as NodeURL } from 'node:url';
const cli = fileURLToPath(new NodeURL('../daemon-overlay-audit-check.mjs', import.meta.url));

test('CLI loads relative audit evidence for each clone and reports unaudited adopted edges', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-clone-evidence-'));
  const dir = join(home, 'states'), bin = join(home, 'bin');
  const caller = join(home, 'caller'), first = join(home, 'first'), second = join(home, 'second');
  const sha = 'a'.repeat(40), base = 'b'.repeat(40), edge = 'c'.repeat(40);
  const pass = head => JSON.stringify({ head, base, verdict: 'NOT WEAKENED', questionHash: QUESTION_HASH,
    at: '2026-11-10T00:00:00Z', findings: [] }) + '\n';
  try {
    [dir, bin, caller, first, second].forEach(path => mkdirSync(path));
    const git = join(bin, 'git');
    writeFileSync(git, `#!${process.execPath}\nif (process.argv.includes('rev-parse')) process.stdout.write('${sha}\\n');\n`);
    chmodSync(git, 0o755);
    // Redirect only the trusted audit-path setting; the CLI still reads real per-clone ledgers.
    const preload = join(home, 'relative-settings.mjs');
    writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => String(path).endsWith('/scripts/settings/prototype-load.json')
  ? JSON.stringify({ auditRecordPath: 'audits.jsonl' }) : read(path, ...args);
syncBuiltinESMExports();\n`);
    writeFileSync(join(caller, 'audits.jsonl'), pass(sha));
    writeFileSync(join(first, 'audits.jsonl'), pass(sha));
    writeFileSync(join(second, 'audits.jsonl'), '');
    const firstState = join(dir, '0123456789abcdef.json'), secondState = join(dir, 'fedcba9876543210.json');
    writeFileSync(firstState, JSON.stringify({ clone: first, overlays: [{ ref: 'lane/fix' }] }));
    writeFileSync(secondState, JSON.stringify({ clone: second, overlays: [{ ref: 'lane/fix' }] }));
    const run = (json = true) => spawnSync(process.execPath, ['--import', preload, cli, ...(json ? ['--json'] : []), `--overlay-dir=${dir}`], {
      cwd: caller, env: { ...process.env, HOME: home, PATH: bin }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    });
    const isolated = run();
    assert.equal(isolated.status, 1, isolated.stdout);
    assert.deepEqual(JSON.parse(isolated.stdout).map(row => row.ok), [true, false]);
    writeFileSync(join(second, 'audits.jsonl'), pass(sha));
    writeFileSync(firstState, JSON.stringify({ clone: first, overlays: [{ ref: 'lane/fix', edgeResolution: { sha: edge } }] }));
    const adopted = run();
    assert.equal(adopted.status, 1, adopted.stdout);
    const row = JSON.parse(adopted.stdout)[0];
    assert.equal(row.ok, false);
    assert.equal(row.edgeSha, edge);
    assert.equal(row.edgeOk, false);
    assert.match(run(false).stdout, new RegExp(`edge-sha=${edge}`));
    writeFileSync(join(first, 'audits.jsonl'), pass(sha) + pass(edge));
    assert.equal(run().status, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an audited ref tip never hides missing or malformed edge evidence', () => {
  const sha = 'a'.repeat(40), edge = 'c'.repeat(40);
  const audit = head => ({ head, base: 'b'.repeat(40), verdict: 'NOT WEAKENED', questionHash: QUESTION_HASH,
    at: '2026-11-10T00:00:00Z', findings: [] });
  const check = (edgeResolution, records = [audit(sha)], resolved = sha) => checkOverlays({
    states: [{ clone: '/fixture', overlays: [{ ref: 'lane/fix', edgeResolution }] }],
    evidence: { auditRecords: records }, resolveSha: () => resolved, covers: () => true,
  })[0];
  for (const value of [{ sha: edge }, null, {}, [], 'bad', { sha: [sha] }, { sha: sha + '\n' }])
    assert.equal(check(value).ok, false, JSON.stringify(value));
  assert.equal(check({ sha: edge }, [audit(sha), audit(edge)]).ok, true);
  assert.equal(check({ sha: sha.toUpperCase() }).ok, true);
  assert.equal(check({ sha: edge }, [audit(edge)], null).ok, false, 'gone ref remains unaudited');
});

test('clone evidence loader failures cannot reuse another clones passing snapshot', () => {
  const sha = 'a'.repeat(40), calls = [];
  const rows = checkOverlays({ states: ['/first', '/second'].map(clone => ({ clone, overlays: [{ ref: 'lane/fix' }] })),
    evidence: clone => {
      calls.push(clone);
      if (clone === '/second') throw Error('unreadable');
      return { auditRecords: [{ head: sha, base: 'b'.repeat(40), verdict: 'NOT WEAKENED', questionHash: QUESTION_HASH,
        at: '2026-11-10T00:00:00Z', findings: [] }] };
    }, resolveSha: () => sha, covers: () => true,
  });
  assert.deepEqual(calls, ['/first', '/second']);
  assert.deepEqual(rows.map(row => row.ok), [true, false]);
});

test('edge waivers bind to the registered ref and exact edge SHA', () => {
  const sha = 'a'.repeat(40), edge = 'c'.repeat(40);
  const waiver = { ref: 'lane/fix', sha: edge, ruling: 'R12', findings: ['accepted'], actor: 'operator', quote: 'approved', at: '2026-11-10T00:00:00Z' };
  const audit = { base: 'b'.repeat(40), questionHash: QUESTION_HASH, at: waiver.at };
  const check = patch => checkOverlays({ states: [{ clone: '/fixture', overlays: [{ ref: waiver.ref, edgeResolution: { sha: edge } }] }],
    evidence: { waivers: [{ ...waiver, ...patch }], auditRecords: [
      { ...audit, head: sha, verdict: 'NOT WEAKENED', findings: [] },
      { ...audit, head: edge, verdict: 'WEAKENED', findings: waiver.findings },
    ] }, resolveSha: () => sha, covers: () => true,
  })[0];
  assert.equal(check({}).kind, 'waiver');
  assert.equal(check({ ref: 'lane/other' }).ok, false);
  assert.equal(check({ sha }).ok, false);
});

test('CLI treats a missing inventory directory as empty', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-missing-'));
  try {
    const result = spawnSync(process.execPath, [cli, '--json', `--overlay-dir=${join(home, 'missing')}`], {
      env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.doesNotMatch(result.stderr, /UNREADABLE/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('CLI refuses an inventory directory that is a regular file', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-not-directory-'));
  try {
    const file = join(home, 'file');
    writeFileSync(file, 'unchanged');
    for (const flags of [[], ['--json']]) {
      const result = spawnSync(process.execPath, [cli, ...flags, `--overlay-dir=${file}`], {
        env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(flags.length ? result.stderr : result.stdout, /UNREADABLE/);
      assert.doesNotMatch(result.stdout, /OK/);
      if (flags.length) assert.deepEqual(JSON.parse(result.stdout), []);
    }
    assert.equal(readFileSync(file, 'utf8'), 'unchanged');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('CLI executes through symlinked file and checkout paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-symlink-'));
  try {
    const link = join(home, 'check.mjs'), checkout = join(home, 'scripts');
    symlinkSync(cli, link);
    symlinkSync(fileURLToPath(new NodeURL('../', import.meta.url)), checkout, 'dir');
    for (const entry of [link, join(checkout, 'daemon-overlay-audit-check.mjs')]) {
      const result = spawnSync(process.execPath, [entry, '--bogus'], {
        env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
      });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /usage:/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI resolves the registered clone despite inherited Git repository overrides', () => {
  const home = mkdtempSync(join(tmpdir(), 'overlay-foreign-repo-'));
  const clone = join(home, 'clone'), foreign = join(home, 'foreign'), dir = join(home, 'states');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), HOME: home };
  const git = (cwd, args) => {
    const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args],
      { env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(clone); mkdirSync(foreign); mkdirSync(dir);
    const tips = [clone, foreign].map(repo => {
      git(repo, ['init', '-q']); git(repo, ['commit', '--allow-empty', '-qm', repo === clone ? 'registered' : 'foreign']);
      const sha = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['update-ref', 'refs/remotes/origin/lane/fix', sha]);
      return sha;
    });
    assert.notEqual(tips[0], tips[1]);
    writeFileSync(join(dir, '0123456789abcdef.json'), JSON.stringify({ clone, overlays: [{ ref: 'lane/fix' }] }));
    const before = [clone, foreign].map(repo => git(repo, ['show-ref']));
    const result = spawnSync(process.execPath, [cli, '--json', `--overlay-dir=${dir}`], {
      env: { ...env, GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_COMMON_DIR: join(foreign, '.git') },
      encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].sha, tips[0]);
    assert.deepEqual([clone, foreign].map(repo => git(repo, ['show-ref'])), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
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
      { clone: 'clone', overlays: [{ ref: '--bad' }] },
      ...[null, {}, [], 'bad', { sha: [] }, { sha: 'a'.repeat(40) + '\n' }]
        .map(edgeResolution => ({ clone: 'clone', overlays: [{ ref: 'lane/fix', edgeResolution }] }))]) {
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
