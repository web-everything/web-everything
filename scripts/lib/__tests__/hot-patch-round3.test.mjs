import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { urgentLedger, urgentKeyPath, urgentSignature } from '../../operations/urgent-verify-marker.mjs';
import { requestHotPatch, readHotPatch, recordVerifyResult, recordHotPatchPr, hotPatchPath } from '../hot-patch.mjs';
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

for (const inMergeQueue of [false, true]) {
  for (const evidence of ['wrong-branch', 'wrong-sha', 'short-sha', 'nonhex-sha', 'missing-state',
    'unknown-state', 'failed', 'error', 'throws', 'invalid-json', 'null', 'oversized']) {
    test(`PR linkage refuses ${evidence}, queued=${inMergeQueue}, without changing ledger or overlays`,
      fixture(async ({ root, env, sha }) => {
        const before = readFileSync(hotPatchPath(root, env), 'utf8');
        // Observe the actual overlay directory as well as the ledger; refusal must precede registration edits.
        const { readdirSync } = await import('node:fs');
        const snapshot = () => readdirSync(env.WE_DAEMON_OVERLAY_DIR).map(name =>
          [name, readFileSync(join(env.WE_DAEMON_OVERLAY_DIR, name), 'utf8')]);
        const overlaysBefore = snapshot();
        const data = { headRefName: 'lane/hot', headRefOid: sha, state: 'OPEN' };
        if (evidence === 'wrong-branch') data.headRefName = 'lane/other';
        if (evidence === 'wrong-sha') data.headRefOid = 'a'.repeat(40);
        if (evidence === 'short-sha') data.headRefOid = sha.slice(0, 7);
        if (evidence === 'nonhex-sha') data.headRefOid = 'z'.repeat(40);
        if (evidence === 'missing-state') delete data.state;
        if (evidence === 'unknown-state') data.state = 'UNKNOWN';
        const run = () => {
          if (evidence === 'throws') throw new Error('unavailable');
          return { status: evidence === 'failed' ? 1 : 0, error: evidence === 'error' ? new Error('failed') : undefined, stdout: evidence === 'invalid-json' ? '{bad'
            : evidence === 'null' ? 'null' : evidence === 'oversized' ? ' '.repeat(65537) : JSON.stringify(data) };
        };
        expect(recordHotPatchPr({ root, env, sha, pr: 42, inMergeQueue, run }).ok).toBe(false);
        expect(readFileSync(hotPatchPath(root, env), 'utf8')).toBe(before);
        expect(snapshot()).toEqual(overlaysBefore);
      }));
  }
}
for (const state of ['OPEN', 'CLOSED', 'MERGED']) {
  test(`PR linkage verifies branch and full SHA case-insensitively for ${state}`, fixture(async ({ root, env, sha }) => {
    const run = (cmd, args, options) => {
      expect(cmd).toBe('gh');
      expect(args).toEqual(['pr', 'view', '42', '--json', 'headRefName,headRefOid,state']);
      expect(options).toMatchObject({ cwd: root, env, encoding: 'utf8' });
      expect(options.timeout).toBeGreaterThan(0); expect(options.maxBuffer).toBeGreaterThan(0);
      return { status: 0, stdout: JSON.stringify({ headRefName: 'lane/hot', headRefOid: sha.toUpperCase(), state }) };
    };
    expect(recordHotPatchPr({ root, env, sha, pr: 42, inMergeQueue: true, run }).ok).toBe(true);
    expect(readHotPatch(root, env)).toMatchObject({ owed: { pr: 42 }, prVerifiedSha: sha, inMergeQueue: true });
  }));
}
test('merged PR closure requires prior linkage verified for the current SHA, including historical records', async () => {
  const source = readFileSync(join(process.cwd(), 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8');
  const block = source.match(/    if \(hot\?\.owed\.pr[^]*?await closeHotPatch[^]*?\n    }/)[0];
  const invoke = new Function('hot', 'plan', 'closeHotPatch', 'root', 'stEnv', `return (async () => { ${block} })()`);
  const sha = 'a'.repeat(40);
  for (const [pr, verified, expected] of [[42, sha, 1], [42, undefined, 0], [42, 'b'.repeat(40), 0], [null, sha, 0]]) {
    let closed = 0;
    await invoke({ branch: 'lane/hot', sha, owed: { pr }, prVerifiedSha: verified },
      { decisions: [{ ref: 'lane/hot', pr: 42, reason: 'pr-merged' }] }, () => { closed++; }, '', {});
    expect(closed).toBe(expected);
  }
});

import { classifyHotPatch } from '../hot-patch.mjs';
import { hotPatchDefaults, neverPatchFloor, resolveHotPatchSettings } from '../hot-patch-settings.mjs';

const root = process.cwd();
const lib = resolve(root, 'scripts/lib');
const repoPath = path => relative(root, path).split(sep).join('/');
const requiredFloor = [
  'scripts/lib/daemon-live-smoke.mjs',
  'scripts/lib/daemon-rebuild/audited-tip.mjs',
  'scripts/lib/daemon-rebuild/evidence-readers.mjs',
];

test('round3: the immutable module floor is derived from the JSON list', () => {
  const json = JSON.parse(readFileSync(resolve(lib, 'hot-patch-settings.json'), 'utf8'));
  expect(neverPatchFloor).toEqual(json.neverPatchPaths);
  expect(neverPatchFloor).toBe(hotPatchDefaults.neverPatchPaths);
  expect(Object.isFrozen(neverPatchFloor)).toBe(true);
  expect(Object.isFrozen(hotPatchDefaults)).toBe(true);
});

test('round3: gate dependencies belong to the exported JSON floor', () => {
  for (const path of requiredFloor) {
    expect(hotPatchDefaults.neverPatchPaths).toContain(path);
    expect(classifyHotPatch({ files: [path], kind: 'incident' }).ok, path).toBe(false);
  }
});

test('round3: settings can extend but cannot remove the JSON floor', () => {
  const settings = resolveHotPatchSettings({
    env: { WE_POLICY_CASCADE_LOG: '0' },
    tool: { neverPatchPaths: ['extra/**'] },
  });
  expect(settings.neverPatchPaths).toEqual(expect.arrayContaining([
    ...hotPatchDefaults.neverPatchPaths, 'extra/**',
  ]));
  for (const path of requiredFloor) {
    expect(classifyHotPatch({ files: [path], kind: 'incident',
      settings: { ...hotPatchDefaults, neverPatchPaths: [] } }).ok, path).toBe(false);
  }
});

// Protect dependencies by default; any exception here must carry a one-line reason.
const allowedHotPatchable = [];

test('round3: every transitive static relative gate import inside scripts/lib is protected', () => {
  const pending = [
    'daemon-rebuild/smoke.mjs', 'daemon-rebuild/prepare.mjs',
    'daemon-rebuild/adopt.mjs', 'daemon-force-adopt.mjs',
  ].map(path => resolve(lib, path));
  const reached = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (reached.has(path)) continue;
    reached.add(path);
    // Reading errors deliberately fail the gate rather than silently omitting evidence.
    const source = readFileSync(path, 'utf8');
    const imports = /(?:^|[;\n])\s*(?:import\s+(?:(?:[^'";]+?)\s+from\s+)?|export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s*)['"]([^'"]+)['"]/g;
    for (const [, specifier] of source.matchAll(imports)) {
      if (!specifier.startsWith('.')) continue;
      const dependency = resolve(dirname(path), specifier);
      if (dependency.startsWith(lib + sep)) pending.push(dependency);
    }
  }
  const unprotected = [...reached].map(repoPath).filter(path =>
    !allowedHotPatchable.includes(path) &&
    classifyHotPatch({ files: [path], kind: 'incident' }).ok);
  expect(unprotected.sort()).toEqual([]);
});
