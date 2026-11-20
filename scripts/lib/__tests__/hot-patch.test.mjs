/** Tier-1 request contract: local Git evidence, injected effects, no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOT_PATCH_ALLOWLIST, hotPatchLedgerPath, readHotPatch, requestHotPatch } from '../hot-patch.mjs';
import { forceBlockedReason } from '../daemon-force-adopt.mjs';
import { cloneKey } from '../daemon-overlays.mjs';

const at = 1700000000000;
// Ported from origin/lane/hot-patch-s2: real origin + clone; no old settings/watch machinery.
const fixture = fn => async () => {
  const home = mkdtempSync(join(tmpdir(), 'hot-patch-'));
  const origin = join(home, 'origin'), root = join(home, 'clone');
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (args, cwd = root) => {
    const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', ...args], { cwd, env: cleanEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const path = HOT_PATCH_ALLOWLIST[0];
  assert.equal(typeof path, 'string');
  git(['init', '-q', '-b', 'main', origin], home);
  mkdirSync(dirname(join(origin, path)), { recursive: true });
  writeFileSync(join(origin, path), '// base\n');
  writeFileSync(join(origin, 'README.md'), 'base\n');
  git(['add', '.'], origin); git(['commit', '-qm', 'base'], origin);
  git(['clone', '-q', origin, root], home);
  git(['remote', 'set-url', 'origin', 'https://github.com/web-everything/web-everything.git']);
  const good = git(['rev-parse', 'HEAD']);
  git(['checkout', '-qb', 'lane/repair']);
  writeFileSync(join(root, path), '// patch\n');
  git(['add', '.']); git(['commit', '-qm', 'patch']);
  const sha = git(['rev-parse', 'HEAD']);
  const env = { ...cleanEnv, HOME: home, WE_DAEMON_STATE_DIR: join(home, 'state'),
    WE_DAEMON_OVERLAY_DIR: join(home, 'overlays'), WE_DAEMON_CLONE_LOCK_ROOT: join(home, 'locks'),
    WE_DAEMON_EVENTS: join(home, 'events.jsonl'), WE_POLICY_CASCADE_LOG: '0' };
  mkdirSync(env.WE_DAEMON_STATE_DIR);
  const preGood = { head: good, inputsKey: 'c'.repeat(40), mainSha: good, applied: [] };
  const overlay = { ref: 'lane/repair', pr: 42, pinned: true, reason: 'R1100 hot-patch',
    addedAt: new Date(at).toISOString(), addedBy: null, expectedSha: sha };
  const calls = [], effects = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    // Objects are already in the clone. Never contact a remote in a test.
    if (cmd === 'git' && args.includes('fetch')) return { status: 0, stdout: '', stderr: '' };
    assert.equal(cmd, 'git', 'all non-Git effects must use injected seams');
    return spawnSync(cmd, args, { ...opts, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  };
  const request = { root, pr: 42, sha, branch: 'lane/repair', env, run, now: () => at, startTimeOf: () => at,
    ghJson: async () => ({ baseRefName: 'main', state: 'OPEN', headRefOid: sha, headRefName: 'lane/repair' }),
    lock: async (...args) => { effects.push('lock'); return args.findLast(a => typeof a === 'function')(() => true); },
    readRebuildState: () => ({ adopted: preGood }),
    addOverlay: async (...args) => { calls.push({ cmd: 'addOverlay', args }); assert(existsSync(hotPatchLedgerPath(env)), 'ledger armed before overlay'); effects.push('overlay'); return overlay; },
    writeRebuildRequest: async () => { effects.push('rebuild'); } };
  const save = record => writeFileSync(hotPatchLedgerPath(env), JSON.stringify(record));
  try { await fn({ home, root, env, git, sha, good, path, request, preGood, overlay, calls, effects, save }); }
  finally { rmSync(home, { recursive: true, force: true }); }
};
const refused = async request => assert.rejects(() => requestHotPatch(request), /^Error: hot-patch refused:/);

test('allowlist is frozen, exact, and cannot authorize its own implementation', () => {
  assert(Object.isFrozen(HOT_PATCH_ALLOWLIST));
  assert(HOT_PATCH_ALLOWLIST.length > 0);
  assert(!HOT_PATCH_ALLOWLIST.includes('scripts/lib/hot-patch.mjs'));
  for (const path of HOT_PATCH_ALLOWLIST) assert(!/[\*?]|(^|\/)\.\.(\/|$)/.test(path));
});
for (const path of ['README.md', 'scripts/lib/hot-patch.mjs']) {
  test(`refuses non-allowlisted diff: ${path}`, fixture(async f => {
    f.git(['reset', '--hard', f.good]);
    mkdirSync(dirname(join(f.root, path)), { recursive: true });
    writeFileSync(join(f.root, path), '// forbidden\n');
    f.git(['add', '.']); f.git(['commit', '-qm', 'forbidden']);
    const sha = f.git(['rev-parse', 'HEAD']);
    await refused({ ...f.request, sha, ghJson: async () => ({ baseRefName: 'main', state: 'OPEN', headRefOid: sha, headRefName: 'lane/repair' }) });
    assert(!f.effects.includes('overlay'));
  }));
}
test('rename from a non-listed path refuses; diff uses --no-renames', fixture(async f => {
  f.git(['reset', '--hard', f.good]);
  f.git(['rm', f.path]); mkdirSync(join(f.root, dirname(f.path)), { recursive: true }); f.git(['mv', 'README.md', f.path]);
  f.git(['commit', '-qam', 'rename']);
  const sha = f.git(['rev-parse', 'HEAD']);
  await refused({ ...f.request, sha, ghJson: async () => ({ baseRefName: 'main', state: 'OPEN', headRefOid: sha, headRefName: 'lane/repair' }) });
  assert(f.calls.some(c => c.args.includes('diff') && c.args.includes('--no-renames')));
}));
test('one non-merge commit whose parent is reachable from target origin/main succeeds', fixture(async f => {
  let rebuilds = 0;
  const result = await requestHotPatch({ ...f.request, writeRebuildRequest: async (root, options) => {
    rebuilds++;
    assert.equal(root, f.root);
    assert.equal(options.ref, f.request.branch);
    assert.equal(readHotPatch(f.env).sha, f.sha);
    assert.deepEqual(readHotPatch(f.env).overlay, f.overlay);
    await f.request.writeRebuildRequest(root, options);
  } });
  assert.equal(result.ok, true);
  assert.equal(rebuilds, 1, 'successful admission must issue exactly one rebuild request');
  assert.deepEqual(readHotPatch(f.env).preGood, f.preGood);
  assert.equal(readHotPatch(f.env).sha, f.sha);
  assert.deepEqual(f.effects, ['lock', 'overlay', 'rebuild']);
  assert(f.calls.every(c => !/--allow-no-pr|\"allowNoPr\":true/.test(JSON.stringify(c.args))));
}));
test('two commits above origin/main refuse', fixture(async f => {
  writeFileSync(join(f.root, f.path), '// second\n'); f.git(['commit', '-qam', 'second']);
  const sha = f.git(['rev-parse', 'HEAD']);
  await refused({ ...f.request, sha, ghJson: async () => ({ baseRefName: 'main', state: 'OPEN', headRefOid: sha, headRefName: 'lane/repair' }) });
}));
test('merge commit refuses even with a parent reachable from origin/main', fixture(async f => {
  f.git(['checkout', '-qb', 'side', f.good]); writeFileSync(join(f.root, 'side'), 'side');
  f.git(['add', '.']); f.git(['commit', '-qm', 'side']);
  f.git(['checkout', 'lane/repair']); f.git(['merge', '--no-ff', 'side', '-m', 'merge']);
  const sha = f.git(['rev-parse', 'HEAD']);
  await refused({ ...f.request, sha, ghJson: async () => ({ baseRefName: 'main', state: 'OPEN', headRefOid: sha, headRefName: 'lane/repair' }) });
}));
for (const change of [{ pr: undefined }, { state: 'CLOSED' }, { state: 'MERGED' },
  { headRefOid: 'd'.repeat(40) }, { headRefName: 'lane/other' }]) {
  test(`PR evidence refuses ${JSON.stringify(change)}`, fixture(async f => {
    await refused({ ...f.request, ...(Object.hasOwn(change, 'pr') ? change : {}),
      ghJson: async () => ({ baseRefName: 'main', state: 'OPEN', headRefOid: f.sha, headRefName: 'lane/repair', ...change }) });
    assert(!f.effects.includes('overlay'));
  }));
}
test('any existing global ledger refuses, including one for another clone', fixture(async f => {
  const original = JSON.stringify({ sha: f.sha, pr: 42, branch: 'lane/repair', root: join(f.home, 'other-clone'),
    requestPid: process.pid, requestStart: 1, loadedAt: new Date(at).toISOString(), overlay: f.overlay, preGood: f.preGood });
  writeFileSync(hotPatchLedgerPath(f.env), original);
  await refused(f.request);
  assert.equal(readFileSync(hotPatchLedgerPath(f.env), 'utf8'), original);
}));
test('open force-watch on target refuses', fixture(async f => {
  writeFileSync(join(f.env.WE_DAEMON_STATE_DIR, `${cloneKey(f.root)}.force-watch.json`), JSON.stringify({ sha: f.sha, ticksLeft: 5 }));
  await refused(f.request); assert(!f.effects.includes('overlay'));
}));
test('wx refuses a ledger appearing inside the write lock without overwriting or deleting it', fixture(async f => {
  const original = '{"owner":"concurrent"}';
  await refused({ ...f.request, lock: async (...args) => {
    writeFileSync(hotPatchLedgerPath(f.env), original, { flag: 'wx' });
    return args.findLast(a => typeof a === 'function')(() => true);
  } });
  assert.equal(readFileSync(hotPatchLedgerPath(f.env), 'utf8'), original);
  assert(!f.effects.includes('overlay'));
}));
test('recorded overlay is re-read before requesting rebuild', fixture(async f => {
  await refused({ ...f.request, addOverlay: async () => {
    f.save({ ...readHotPatch(f.env), sha: 'd'.repeat(40) });
    return f.overlay;
  } });
  assert(!f.effects.includes('rebuild'));
}));
for (const preGood of [null, { head: 'short' }, { head: 'z'.repeat(40) }]) {
  test(`missing or non-40-hex preGood refuses ${JSON.stringify(preGood)}`, fixture(async f => {
    await refused({ ...f.request, readRebuildState: () => ({ adopted: preGood && { ...f.preGood, ...preGood } }) });
  }));
}
test('preGood containing the patch refuses even when its head differs', fixture(async f => {
  writeFileSync(join(f.root, f.path), '// later\n'); f.git(['commit', '-qam', 'later']);
  const head = f.git(['rev-parse', 'HEAD']);
  await refused({ ...f.request, readRebuildState: () => ({ adopted: { ...f.preGood, head } }) });
}));
test('overlay add failure removes our armed ledger in finally and writes no rebuild request', fixture(async f => {
  await assert.rejects(() => requestHotPatch({ ...f.request, addOverlay: async () => {
    assert.equal(readHotPatch(f.env).sha, f.sha); throw Error('overlay failed');
  } }), /overlay failed/);
  assert.equal(readHotPatch(f.env), null); assert(!f.effects.includes('rebuild'));
}));
test('hostile Git environment is stripped and replacement objects disabled for actual Git reads', fixture(async f => {
  const hostile = { GIT_DIR: '/invalid', GIT_WORK_TREE: '/invalid', GIT_INDEX_FILE: '/invalid',
    GIT_OBJECT_DIRECTORY: '/invalid', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/invalid',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.diff', GIT_CONFIG_VALUE_0: '!false', GIT_CONFIG_GLOBAL: '/invalid' };
  await requestHotPatch({ ...f.request, env: { ...f.env, ...hostile } });
  assert(f.calls.length > 0);
  for (const c of f.calls.filter(c => c.cmd === 'git')) {
    for (const key of Object.keys(hostile)) assert.equal(c.opts.env[key], undefined, key);
    assert(c.args.includes('--no-replace-objects'));
  }
}));
test('legacy grafts refuse rather than accepting rewritten ancestry', fixture(async f => {
  writeFileSync(join(f.root, '.git/info/grafts'), `${f.sha}\n`);
  await refused(f.request); assert(!f.effects.includes('overlay'));
}));

test('leading-whitespace path refuses exact NUL-delimited allowlist comparison', fixture(async f => {
  f.git(['reset', '--hard', f.good]);
  const path = ` ${f.path}`;
  mkdirSync(dirname(join(f.root, path)), { recursive: true });
  writeFileSync(join(f.root, path), '// forbidden whitespace path\n');
  f.git(['add', '.']); f.git(['commit', '-qm', 'whitespace']);
  const sha = f.git(['rev-parse', 'HEAD']);
  await assert.rejects(() => requestHotPatch({ ...f.request, sha,
    ghJson: async () => ({ state: 'OPEN', baseRefName: 'main', headRefOid: sha, headRefName: 'lane/repair' }) }), /exact allowlist/);
  assert(!f.effects.includes('overlay'));
}));
for (const baseRefName of ['release', undefined]) test(`non-main or missing base refuses: ${baseRefName}`, fixture(async f => {
  await refused({ ...f.request, ghJson: async args => {
    assert(args.at(-1).includes('baseRefName'));
    return { state: 'OPEN', baseRefName, headRefOid: f.sha, headRefName: 'lane/repair' };
  } });
  assert(!f.effects.includes('overlay'));
}));
for (const origin of ['https://github.com/other/web-everything.git', 'https://github.com.evil/web-everything/web-everything'])
  test(`noncanonical origin refuses: ${origin}`, fixture(async f => {
    f.git(['remote', 'set-url', 'origin', origin]);
    await assert.rejects(() => requestHotPatch(f.request), /canonical.*origin/);
    assert(!f.effects.includes('overlay'));
  }));
test('corrupt force-watch refuses admission with watch-unreadable', fixture(async f => {
  writeFileSync(join(f.env.WE_DAEMON_STATE_DIR, `${cloneKey(f.root)}.force-watch.json`), '{bad');
  await assert.rejects(() => requestHotPatch(f.request), /watch-unreadable/);
  assert(!f.effects.includes('overlay'));
}));
test('force-watch becoming corrupt during registration refuses rebuild', fixture(async f => {
  await assert.rejects(() => requestHotPatch({ ...f.request, addOverlay: async () => {
    writeFileSync(join(f.env.WE_DAEMON_STATE_DIR, `${cloneKey(f.root)}.force-watch.json`), '{bad');
    return f.overlay;
  } }), /watch-unreadable/);
  assert(!f.effects.includes('rebuild'));
}));
test('lost request write lock preserves armed intent and does not persist registration or rebuild', fixture(async f => {
  let held = true;
  await assert.rejects(() => requestHotPatch({ ...f.request,
    lock: async (_root, fn) => fn(() => held),
    addOverlay: async () => { held = false; return f.overlay; },
  }), /write lock lost/);
  const record = readHotPatch(f.env);
  assert.equal(record.overlay, null);
  assert.equal(record.overlayIntent.expectedSha, f.sha);
  assert(!f.effects.includes('rebuild'));
}));
test('lock lost before reservation makes no ledger or overlay mutation', fixture(async f => {
  await assert.rejects(() => requestHotPatch({ ...f.request, lock: async (_root, fn) => fn(() => false) }), /write lock lost/);
  assert.equal(readHotPatch(f.env), null);
  assert(!f.effects.includes('overlay'));
}));
test('intended overlay identity is durable before registration starts', fixture(async f => {
  await requestHotPatch({ ...f.request, addOverlay: async () => {
    const r = readHotPatch(f.env);
    assert.equal(r.overlay, null);
    assert.deepEqual(r.overlayIntent, { ...f.overlay, expectedSha: f.sha });
    return f.overlay;
  } });
}));

test('force-watch opening during registration still blocks our verified reservation from rebuilding', fixture(async f => {
  await assert.rejects(() => requestHotPatch({ ...f.request, addOverlay: async () => {
    writeFileSync(join(f.env.WE_DAEMON_STATE_DIR, `${cloneKey(f.root)}.force-watch.json`),
      JSON.stringify({ sha: f.sha, ticksLeft: 5 }));
    return f.overlay;
  } }), /force-watch blocked during registration: watch-already-open/);
  assert(!f.effects.includes('rebuild'));
  assert.equal(readHotPatch(f.env), null);
}));

test('R3.3 hostile GH_REPO cannot redirect admission and is stripped from child env', fixture(async f => {
  const ghCalls = [];
  await requestHotPatch({ ...f.request, env: { ...f.env, GH_REPO: 'evil/fork', GH_HOST: 'evil.test', GH_ENTERPRISE_TOKEN: 'fixture' },
    ghJson: async args => { ghCalls.push(args); return { baseRefName: 'main', state: 'OPEN', headRefOid: f.sha, headRefName: 'lane/repair' }; } });
  assert.equal(ghCalls.length, 1);
  assert.equal(ghCalls[0][ghCalls[0].indexOf('--repo') + 1], 'web-everything/web-everything');
  for (const call of f.calls.filter(c => c.opts)) {
    for (const key of ['GH_REPO', 'GH_HOST', 'GH_ENTERPRISE_TOKEN']) assert.equal(call.opts.env[key], undefined, key);
  }
}));
test('R3.9 request refuses a durably rejected SHA before overlay registration', fixture(async f => {
  const patch = spawnSync('git', ['show', f.sha], { cwd: f.root, encoding: 'utf8' });
  assert.equal(patch.status, 0);
  const id = spawnSync('git', ['patch-id', '--stable'], { cwd: f.root, input: patch.stdout, encoding: 'utf8' });
  assert.equal(id.status, 0);
  writeFileSync(join(f.env.WE_DAEMON_STATE_DIR, 'hot-patch-rejected.json'), JSON.stringify([{
    sha: f.sha, patchId: id.stdout.split(/\s+/)[0], pr: 42, reason: 'ci-red', at: new Date(at).toISOString(),
  }]));
  await assert.rejects(() => requestHotPatch(f.request), /hot-patch refused:.*reject/i);
  assert(!f.effects.includes('overlay'));
  assert(!f.effects.includes('rebuild'));
}));

test('guard seam exempts only our verified ledger during overlay registration', fixture(async f => {
  const result = await requestHotPatch({ ...f.request, addOverlay: async (...args) => {
    assert.equal(readHotPatch(f.env).sha, f.sha);
    assert.equal(forceBlockedReason(f.root, f.env), 'hot-patch-open');
    return f.request.addOverlay(...args);
  } });
  assert.equal(result.ok, true);
  assert(f.effects.includes('rebuild'));
}));
