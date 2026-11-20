import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import { requestHotPatch, readHotPatch, recordVerifyResult, recordHotPatchPr, hotPatchPath } from '../hot-patch.mjs';
import { main } from '../../hot-patch.mjs';
import { smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';
import { writeRebuildState, readReadyCandidate } from '../daemon-rebuild/state.mjs';
import { acquireRead, releaseRead } from '../daemon-clone-lock.mjs';
import { readForceWatch, watchPath } from '../daemon-force-adopt.mjs';

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
  let ci = 'green';
  env.WE_HOT_PATCH = JSON.stringify({ verifyRepo: 'owner/repo' });
  const marker = ({ result = 'green' } = {}) => { ci = result; };
  const runGh = () => {
    if (ci === 'unreadable') throw Error('offline');
    return JSON.stringify(ci === 'missing' ? [] : [{ id: 1, name: 'test', head_sha: sha,
      app: { id: 15368, slug: 'github-actions' }, status: ci === 'pending' ? 'in_progress' : 'completed',
      conclusion: ci === 'red' ? 'failure' : 'success' }]);
  };
  try {
    expect((await requestHotPatch({ root, env, sha, branch: 'lane/hot', daemon: 'review', kind: 'incident',
      files: ['scripts/tool.mjs'] })).ok).toBe(true);
    await fn({ root, env, sha, good, home, marker, git, runGh });
  } finally { rmSync(home, { recursive: true, force: true }); }
};

for (const evidence of ['green', 'pending', 'red-ci', 'missing-ci', 'unreadable-ci',
  'red-ledger', 'missing-ledger', 'unreadable-ledger', 'rollbackPending', 'unreadable-watch', 'pending-without-watch']) {
  test(`final adoption lock rechecks ${evidence} after approval and retains refused candidate`, fixture(async ({ root, env, sha, good, home, marker, git, runGh }) => {
    marker();
    writeRebuildState(root, { adopted: { head: good, mainSha: good, inputsKey: 'base', applied: [] } }, env);
    const reader = { owner: 'race-reader', lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT };
    let entered = false, changed = false;
    const finalLockOpts = { owner: 'race-writer', lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 1000 };
    try {
      const result = await smokeAndAdopt({
        root, env, stEnv: env, log: { error() {} },
        run: (args, opts) => spawnSync('git', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, ...opts }), stateOpts: { env }, now: Date.now,
        plan: { finalSha: sha, mainSha: good, inputsKey: 'patch', applied: [{ ref: 'lane/hot', sha }] },
        prevHead: good, lease: { token: 'race', path: join(home, 'candidate') }, overlaysBefore: [], prepAlerts: [],
        runGh, dispatchSmoke: { settings: { dispatchSmoke: 'off' } }, finalLockOpts,
        finalizeLockOpts: { ...finalLockOpts,
          now: () => {
            if (!entered) {
              // Approval has armed a real watch; occupy the final clone lock before it can be taken.
              expect(readForceWatch(root, env)?.hotPatchSha).toBe(sha);
              expect(acquireRead(root, reader).ok).toBe(true);
              entered = true;
            }
            return Date.now();
          },
          sleep: async () => {
            expect(changed).toBe(false);
            changed = true;
            if (evidence === 'red-ci') marker({ result: 'red' });
            if (evidence === 'missing-ci') marker({ result: 'missing' });
            if (evidence === 'unreadable-ci') marker({ result: 'unreadable' });
            if (evidence === 'pending') marker({ result: 'pending' });
            if (evidence === 'red-ledger') {
              const hot = readHotPatch(root, env); hot.owed.verify = 'red';
              writeFileSync(hotPatchPath(root, env), JSON.stringify(hot));
            }
            if (evidence === 'missing-ledger') rmSync(hotPatchPath(root, env));
            if (evidence === 'unreadable-ledger') writeFileSync(hotPatchPath(root, env), '{bad');
            if (evidence === 'rollbackPending') writeFileSync(watchPath(root, env),
              JSON.stringify({ ...readForceWatch(root, env), rollbackPending: 'verify-red' }));
            if (evidence === 'unreadable-watch') writeFileSync(watchPath(root, env), '{bad');
            if (evidence === 'pending-without-watch') { marker({ result: 'pending' }); rmSync(watchPath(root, env)); }
            releaseRead(root, reader);
          },
        },
        runSmoke: async () => ({ verdict: 'pass', smoke: { results: [] } }),
      });
      expect(entered && changed, JSON.stringify(result)).toBe(true);
      if (['green', 'pending'].includes(evidence)) {
        expect(result.adopted).toBe(true); expect(git(['rev-parse', 'HEAD'])).toBe(sha);
      } else {
        expect(result.reason).toBe('hot-patch-adoption-refused');
        expect(result.moved).toBe(false); expect(git(['rev-parse', 'HEAD'])).toBe(good);
        expect(readReadyCandidate(root, env)?.adopt.finalSha).toBe(sha);
      }
    } finally { releaseRead(root, reader); }
  }));
}

for (const evidence of ['missing', 'unreadable']) {
  test(`caller green cannot bypass ${evidence} CI`, fixture(async ({ root, env, sha, marker, runGh }) => {
    marker({ result: evidence });
    const before = readFileSync(hotPatchPath(root, env), 'utf8');
    expect((await recordVerifyResult({ root, env, sha, result: 'green', runGh })).ok).toBe(false);
    expect(readFileSync(hotPatchPath(root, env), 'utf8')).toBe(before);
    expect(await main(['verify-result', '--daemon', root, '--sha', sha, '--result=green'],
      { env, runGh, stdout: () => {}, stderr: () => {} })).toBe(1);
  }));
}
test('CI red overrides caller green and later CI green cannot clear durable red', fixture(async ({ root, env, sha, marker, runGh }) => {
  marker({ result: 'red' });
  expect((await recordVerifyResult({ root, env, sha, result: 'green', runGh })).ok).toBe(true);
  marker();
  expect((await recordVerifyResult({ root, env, sha, runGh })).ok).toBe(true);
  expect(readHotPatch(root, env)).toMatchObject({ owed: { verify: 'red' }, rollbackPending: 'verify-red' });
}));
test('CLI green comes from CI without a caller result', fixture(async ({ root, env, sha, runGh }) => {
  expect(await main(['verify-result', '--daemon', root, '--sha', sha],
    { env, runGh, stdout: () => {}, stderr: () => {} })).toBe(0);
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

for (const local of ['green', 'red']) {
  for (const ci of ['green', 'red', 'pending', 'missing']) {
    test(`caller ${local} is ignored when CI is ${ci}`, fixture(async ({ root, env, sha, marker, runGh }) => {
      marker({ result: ci });
      const result = await recordVerifyResult({ root, env, sha, result: local, runGh });
      expect(result.ok).toBe(ci !== 'missing');
      const record = readHotPatch(root, env);
      expect(record.owed.verify).toBe(ci === 'missing' ? 'pending' : ci);
      expect(Boolean(record.rollbackPending)).toBe(ci === 'red');
    }));
  }
}
