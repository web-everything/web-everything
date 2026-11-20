// @vitest-environment node
/**
 * S1 tier-1 contract (tests first; no T2/hot-patch or live/deploy work).
 * verifyUrgentMarker({sha, ledgerText, mainPlan, pinnedPublicKeyPem,
 *   buildManifestDigest: async sha => digest}) -> {ok:true,evidence}|{ok:false,detail}.
 * mainPlan is argv[][]; argvDigest = SHA256(JSON.stringify(argv)); planDigest is
 * SHA256(JSON.stringify(mainPlan)). Receipt wire shape: {...fields, signature}.
 * Signed fields ONLY: runName, nonce, manifestDigest, argvDigest, code,
 * siblingShas, phase. Canonical JSON sorts object keys recursively (arrays retain order).
 * buildTreeManifest({gitDir,sha}) -> {digest,files}; files is a repo-relative path[].
 * urgentVerify({sha}, deps) -> {ok,detail?,fallback?,marker?}.
 * createUrgentDeps({cwd,mainCwd,home,pinnedPublicKeyPem,forgeSubmit,spawnSync})
 * deps.plan({sha}) -> argv[][] derives main's plan/shards/quarantine in-process; forgeSubmit({sha,nonce,manifestDigest,argv})
 * -> signed receipt. Transport rejection/crash, changed evidence and invalid receipts
 * leave the ledger byte-for-byte unchanged. append performs verify/write/re-read.
 * mainCwd is the trusted main checkout, cwd is untrusted input data only.
 * Checklist 4's prototype-load loaded-tree recheck belongs to its consumer; here
 * exercise the producer's pre/post manifest checks and ledger re-read boundary.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs';
import cp from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, generateKeyPairSync, sign, verify} from 'node:crypto';
import * as markerAPI from '../urgent-verify-marker.mjs';
import {createUrgentDeps, urgentVerify} from '../urgent-verify.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const realSpawnSync = cp.spawnSync;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
}
const signedFields = ({runName, nonce, manifestDigest, argvDigest, code, siblingShas, phase}) =>
  ({runName, nonce, manifestDigest, argvDigest, code, siblingShas, phase});
const mainPlan = [['npm', 'run', 'test:unit', '--', 'scripts/a.test.mjs'],
  ['npm', 'run', 'test:unit', '--', 'scripts/b.test.mjs'], ['npm', 'run', 'check:standards']];
let root, repo, sha, otherSha, pinned, attacker, siblingSha;
const env = () => ({PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-global-config'),
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1'});
function git(...args) {
  const result = realSpawnSync('git', ['-c', 'user.name=Receipt Test', '-c',
    'user.email=receipt@example.invalid', ...args], {cwd: repo, env: env(), encoding: 'utf8',
    timeout: 5000, maxBuffer: 8 * 1024 * 1024});
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
}
function put(path, text) {
  fs.mkdirSync(dirname(path), {recursive: true}); fs.writeFileSync(path, text);
}
const publicPem = pair => pair.publicKey.export({type: 'spki', format: 'pem'});
// Independent object-store oracle for the injected digest reader, never worktree data.
// Verifier tests intentionally do not depend on the not-yet-written manifest module.
const treeDigest = target => hash(git('ls-tree', '-r', '--full-tree', target));
function receipt(argv, overrides = {}, key = pinned.privateKey) {
  const fields = {runName: `r-${'1'.repeat(32)}`, nonce: '2'.repeat(32),
    manifestDigest: treeDigest(sha), argvDigest: hash(JSON.stringify(argv)), code: 0,
    siblingShas: {frontierui: siblingSha ?? otherSha}, phase: 'test', ...overrides};
  return {...fields, signature: sign(null, Buffer.from(canonical(signedFields(fields))), key).toString('base64')};
}
function green(overrides = {}) {
  return {sha, nonce: '2'.repeat(32), planDigest: hash(JSON.stringify(mainPlan)),
    receipts: mainPlan.map(argv => receipt(argv)), ...overrides};
}
const lines = (...records) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
async function check(ledgerText, overrides = {}) {
  return markerAPI.verifyUrgentMarker({sha, ledgerText, mainPlan, pinnedPublicKeyPem: publicPem(pinned),
    buildManifestDigest: async target => treeDigest(target), ...overrides});
}
async function refused(text, overrides) {
  expect(await check(text, overrides)).toMatchObject({ok: false, detail: expect.any(String)});
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'uv-forge-signed-')));
  repo = join(root, 'repo'); fs.mkdirSync(repo);
  git('init', '-q');
  put(join(repo, 'a.txt'), 'original\n');
  git('add', '.'); git('commit', '-qm', 'first'); sha = git('rev-parse', 'HEAD');
  put(join(repo, 'a.txt'), 'different tree\n');
  git('add', '.'); git('commit', '-qm', 'second'); otherSha = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', sha);
  siblingSha = undefined;
  pinned = generateKeyPairSync('ed25519'); attacker = generateKeyPairSync('ed25519');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(root, {recursive: true, force: true}); });

describe('Forge-signed urgent marker verifier', () => {
  it('positive control: accepts a complete pinned receipt set and returns evidence', async () => {
    const record = green();
    expect(await check(lines(record))).toMatchObject({ok: true, evidence: expect.any(Object)});
  });
  it('T1 / checklist 1,10: checkout copies its Studio key file and forges another SHA; refused', async () => {
    const home = join(root, 'studio');
    const keyPath = markerAPI.urgentKeyPath(home);
    // A key planted/copied by checkout code is attacker material, never the Forge key.
    put(keyPath, attacker.privateKey.export({type: 'pkcs8', format: 'pem'}));
    fs.copyFileSync(keyPath, join(repo, 'copied-studio-key.pem'));
    const stolen = fs.readFileSync(join(repo, 'copied-studio-key.pem'));
    const forged = green({sha: otherSha, receipts: mainPlan.map(argv =>
      receipt(argv, {manifestDigest: treeDigest(otherSha)}, stolen))});
    await refused(lines(forged), {sha: otherSha});
  });
  it.each(['marker', 'tree'])('T3 / checklist 1: refuses non-pinned signer even with key supplied by %s', async where => {
    put(join(repo, 'public-key.pem'), publicPem(attacker));
    git('add', '.'); git('commit', '-qm', 'attacker key'); sha = git('rev-parse', 'HEAD');
    const record = green({pinnedPublicKeyPem: where === 'tree'
      ? git('show', `${sha}:public-key.pem`) : publicPem(attacker), host: 'forge'});
    record.receipts = mainPlan.map(argv => receipt(argv, {}, attacker.privateKey));
    await refused(lines(record));
  });
  it.each(['missing step', 'duplicate step', 'extra step'])('T4 / checklist 2,12: refuses %s', async kind => {
    const record = green();
    if (kind === 'missing step') record.receipts.pop();
    if (kind === 'duplicate step') record.receipts[1] = record.receipts[0];
    if (kind === 'extra step') record.receipts.push(receipt(['npm', 'run', 'unplanned']));
    await refused(lines(record));
  });
  it('T4 / checklist 12: a tree dropping CI shards and rewriting package/quarantine cannot shorten main plan', async () => {
    put(join(repo, '.github/workflows/ci.yml'), 'jobs: {}\n');
    put(join(repo, 'package.json'), '{"scripts":{"test:unit":"true"}}');
    put(join(repo, 'scripts/ci/quarantine-skip.mjs'), 'process.stdout.write("--exclude=**/*");');
    git('add', '.'); git('commit', '-qm', 'drop every shard'); sha = git('rev-parse', 'HEAD');
    await refused(lines(green({receipts: [receipt(mainPlan[0])]})));
  });
  it.each(['mixed nonce', 'other tree', 'replay'])('T5 / checklist 5,6: refuses %s', async kind => {
    const record = green();
    record.receipts[1] = receipt(mainPlan[1], kind === 'mixed nonce'
      ? {nonce: '9'.repeat(32)} : {manifestDigest: treeDigest(otherSha)});
    if (kind === 'replay') record.sha = otherSha;
    await refused(lines(record), kind === 'replay' ? {sha: otherSha} : {});
  });
  it.each([7, '0', null])('checklist 2: refuses signed nonzero or nonnumeric exit %s', async code => {
    const record = green(); record.receipts[0] = receipt(mainPlan[0], {code});
    await refused(lines(record));
  });
  it.each(['', null, '{broken json\n'])('checklist 2: refuses absent/unreadable marker %s', async ledgerText => {
    await refused(ledgerText);
  });
  it.each(['missing', 'malformed', 'tampered'])('checklist 7: refuses %s signature/receipt', async kind => {
    const record = green();
    if (kind === 'missing') delete record.receipts[0].signature;
    if (kind === 'malformed') record.receipts[0].signature = 'not-base64!';
    if (kind === 'tampered') record.receipts[0].siblingShas.frontierui = sha;
    await refused(lines(record));
  });
  it.each(['abc', 'g'.repeat(40), 'a'.repeat(39)])('checklist 5: refuses invalid full SHA %s', async value => {
    await refused(lines(green({sha: value})), {sha: value});
  });
  it('checklist 5: unreadable object-store evidence refuses', async () => {
    const text = lines(green());
    fs.unlinkSync(join(repo, '.git/objects', sha.slice(0, 2), sha.slice(2)));
    await refused(text);
  });
  it('checklist 4: verification of an earlier snapshot cannot authorize a changed ledger', async () => {
    const ledger = join(root, 'ledger.jsonl');
    fs.writeFileSync(ledger, lines(green()));
    expect(await check(fs.readFileSync(ledger, 'utf8'))).toMatchObject({ok: true});
    fs.appendFileSync(ledger, lines({sha, result: 'red'}));
    await refused(fs.readFileSync(ledger, 'utf8'));
  });
  it('T7 / checklist 3: red after green with equal timestamps refuses by line order', async () => {
    const time = '2026-01-01T00:00:00Z';
    await refused(lines(green({startedAt: time, finishedAt: time}),
      {sha, result: 'red', startedAt: time, finishedAt: time}));
  });
  it('T7 / checklist 3: later signed green never clears an earlier red, regardless of timestamps', async () => {
    await refused(lines({sha, result: 'red', finishedAt: '1900-01-01T00:00:00Z'},
      green({finishedAt: '2100-01-01T00:00:00Z'})));
  });
  it('checklist 3 positive control: unsigned red for another SHA does not veto this SHA', async () => {
    expect(await check(lines(green(), {sha: otherSha, result: 'red'}))).toMatchObject({ok: true});
  });
});

describe('tree-only urgent manifest (T9 / checklist 11)', () => {
  // Import inside each case so the absent new module reports each named red test.
  const build = async (target = sha) => {
    const {buildTreeManifest} = await import('../urgent-verify-manifest.mjs');
    return buildTreeManifest({gitDir: join(repo, '.git'), sha: target});
  };
  it.each(['--assume-unchanged', '--skip-worktree'])('T9: hidden %s worktree edits cannot change tree manifest', async flag => {
    const before = await build();
    git('update-index', flag, 'a.txt'); put(join(repo, 'a.txt'), 'forged local bytes\n');
    expect(git('status', '--porcelain')).toBe('');
    expect(await build()).toEqual(before);
    expect(before.files).toContain('a.txt');
    expect(before.digest).toMatch(/^[a-f0-9]{64}$/);
    expect((await build(otherSha)).digest).not.toBe(before.digest);
  });
  it('T9: replace ref for the requested commit cannot substitute another tree', async () => {
    const before = await build(); git('replace', sha, otherSha);
    expect(git('show-ref', '--verify', `refs/replace/${sha}`)).toContain(otherSha);
    expect(await build()).toEqual(before);
  });
  it('T9: graft, ambient GIT_DIR and GIT_WORK_TREE cannot redirect fixed object store', async () => {
    const before = await build();
    put(join(repo, '.git/info/grafts'), `${sha} ${otherSha}\n`);
    vi.stubEnv('GIT_DIR', join(root, 'hostile.git'));
    vi.stubEnv('GIT_WORK_TREE', root);
    vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/attacker/');
    try { expect(await build()).toEqual(before); } finally { vi.unstubAllEnvs(); }
  });
});

function orchestration(transport) {
  // Production main modules/config stay trusted; only candidate tree is hostile.
  put(join(repo, '.github/workflows/ci.yml'), fs.readFileSync(join(sourceRoot, '.github/workflows/ci.yml')));
  put(join(repo, 'package.json'), fs.readFileSync(join(sourceRoot, 'package.json')));
  git('add', '.'); git('commit', '-qm', 'candidate'); sha = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', 'https://github.com/example/fixture.git');
  const sibling = join(root, 'frontierui'); fs.mkdirSync(sibling);
  const siblingGit = (...args) => {
    const result = realSpawnSync('git', ['-c', 'user.name=Receipt Test', '-c',
      'user.email=receipt@example.invalid', ...args], {cwd: sibling, env: env(),
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024});
    if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
    return result.stdout.trim();
  };
  siblingGit('init', '-q');
  put(join(sibling, 'package.json'), '{"name":"frontierui","private":true}');
  siblingGit('add', '.'); siblingGit('commit', '-qm', 'trusted sibling main');
  siblingSha = siblingGit('rev-parse', 'HEAD');
  siblingGit('remote', 'add', 'origin', 'https://github.com/frontier-ui/frontierui.git');
  // A hermetic previously-fetched origin/main, without any network/fetch command.
  siblingGit('update-ref', 'refs/remotes/origin/main', siblingSha);
  siblingGit('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const home = join(root, 'studio'); fs.mkdirSync(home);
  const ledger = markerAPI.urgentLedger(home);
  // Spy wraps real Git; any attempted local CI execution is recorded and blocked.
  const spawnSync = vi.spyOn(cp, 'spawnSync').mockImplementation((cmd, args, options) => {
    if (cmd === 'git' && !args.includes('fetch')) return realSpawnSync(cmd, args, {...options, env: env()});
    throw new Error('local step execution forbidden');
  });
  const spawn = vi.spyOn(cp, 'spawn').mockImplementation(() => { throw new Error('local spawn forbidden'); });
  const forgeSubmit = vi.fn(transport);
  const deps = createUrgentDeps({cwd: repo, mainCwd: sourceRoot, home,
    pinnedPublicKeyPem: publicPem(pinned), forgeSubmit, spawnSync});
  return {deps, forgeSubmit, spawn, spawnSync, home, ledger};
}
const ledgerText = path => fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
const localCalls = spy => spy.mock.calls.filter(([cmd]) => cmd !== 'git');
function forgeReply(request) {
  return receipt(request.argv, {nonce: request.nonce, manifestDigest: request.manifestDigest});
}
describe('main-owned orchestration, no Studio execution', () => {
  it('T1 / checklist 10: Studio deps expose no signing, throwaway HOME, isolation or local step hooks', () => {
    const t = orchestration(forgeReply);
    for (const name of ['guardSigning', 'readKey', 'stepHome', 'isolate', 'fetch-main-history',
      'install-fui', 'install', 'shard', 'coverage', 'hostPaths', 'integration', 'standards']) {
      expect(t.deps[name], name).toBeUndefined();
    }
    expect(fs.existsSync(markerAPI.urgentKeyPath(t.home))).toBe(false);
  });
  it('T6 / checklist 7: Forge unreachable refuses with CI fallback, no marker, no local spawn', async () => {
    const t = orchestration(async () => { throw new Error('Forge unreachable'); });
    const result = await urgentVerify({sha}, t.deps);
    expect.soft(result.ok).toBe(false);
    expect.soft(result.fallback).toMatch(/CI/);
    expect.soft(t.forgeSubmit).toHaveBeenCalledTimes(1);
    expect.soft(ledgerText(t.ledger)).toBe('');
    expect.soft(t.spawn).not.toHaveBeenCalled();
    expect.soft(localCalls(t.spawnSync)).toEqual([]);
    expect.soft(fs.existsSync(markerAPI.urgentKeyPath(t.home))).toBe(false);
  });
  it('checklist 10: Studio GitHub tokens never reach Forge requests or child environments', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'fixture-github-secret');
    vi.stubEnv('GH_TOKEN', 'fixture-gh-secret');
    const t = orchestration(forgeReply);
    await urgentVerify({sha}, t.deps);
    expect.soft(t.forgeSubmit).toHaveBeenCalled();
    expect.soft(JSON.stringify(t.forgeSubmit.mock.calls)).not.toMatch(/fixture-(?:github|gh)-secret/);
    expect.soft(JSON.stringify(t.spawnSync.mock.calls)).not.toMatch(/fixture-(?:github|gh)-secret/);
    expect.soft(fs.existsSync(markerAPI.urgentKeyPath(t.home))).toBe(false);
  });
  it('checklist 12: candidate workflow/package/quarantine changes cannot change trusted main argv', async () => {
    const t = orchestration(forgeReply);
    const expected = await t.deps.plan({sha});
    put(join(repo, '.github/workflows/ci.yml'), 'jobs: {}\n');
    put(join(repo, 'package.json'), '{"scripts":{"test:unit":"true"}}');
    put(join(repo, 'scripts/ci/quarantine-skip.mjs'), 'process.stdout.write("--exclude=**/*");');
    git('add', '.'); git('commit', '-qm', 'hostile exemptions'); sha = git('rev-parse', 'HEAD');
    expect(await t.deps.plan({sha})).toEqual(expected);
    expect((await urgentVerify({sha}, t.deps)).ok).toBe(true);
    expect(t.forgeSubmit.mock.calls.map(([request]) => request.argv)).toEqual(expected);
  });
  it('checklist 8 positive control: one nonce, every planned argv, exactly one append after final verified receipt', async () => {
    let t;
    t = orchestration(async request => {
      expect(ledgerText(t.ledger)).toBe('');
      return forgeReply(request);
    });
    const expectedPlan = await t.deps.plan({sha});
    const result = await urgentVerify({sha}, t.deps);
    expect(result.ok).toBe(true);
    const requests = t.forgeSubmit.mock.calls.map(([request]) => request);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.map(request => request.argv)).toEqual(expectedPlan);
    expect(new Set(requests.map(request => request.nonce)).size).toBe(1);
    expect(requests.every(request => request.sha === sha)).toBe(true);
    const records = ledgerText(t.ledger).trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({sha, nonce: requests[0].nonce,
      planDigest: hash(JSON.stringify(requests.map(request => request.argv)))});
    expect(records[0].receipts).toHaveLength(requests.length);
    for (const item of records[0].receipts) {
      expect(verify(null, Buffer.from(canonical(signedFields(item))), pinned.publicKey,
        Buffer.from(item.signature, 'base64'))).toBe(true);
    }
  });
  it.each(['bad signature', 'crash'])('checklist 8,9: %s after first receipt leaves no partial marker', async kind => {
    let calls = 0;
    const t = orchestration(async request => {
      calls++;
      if (calls === 2 && kind === 'crash') throw new Error('transport interrupted');
      const item = forgeReply(request);
      if (calls === 2) item.signature = 'broken';
      return item;
    });
    const result = await urgentVerify({sha}, t.deps);
    expect.soft(calls).toBe(2);
    expect.soft(result.ok).toBe(false);
    expect.soft(ledgerText(t.ledger)).toBe('');
  });
  it('checklist 4,5: object removed after receipt collection refuses before append', async () => {
    let changed = false;
    const t = orchestration(async request => {
      const item = forgeReply(request);
      if (!changed) {
        changed = true;
        // Remove the bound commit object, not worktree bytes or an unrelated ref.
        fs.unlinkSync(join(repo, '.git/objects', sha.slice(0, 2), sha.slice(2)));
      }
      return item;
    });
    expect((await urgentVerify({sha}, t.deps)).ok).toBe(false);
    expect.soft(changed).toBe(true);
    expect.soft(ledgerText(t.ledger)).toBe('');
  });
  it('checklist 4: a red appended during transport vetoes the pending green write', async () => {
    let t, red;
    t = orchestration(request => {
      fs.mkdirSync(dirname(t.ledger), {recursive: true});
      red = lines({sha, result: 'red'});
      fs.writeFileSync(t.ledger, red);
      return forgeReply(request);
    });
    expect((await urgentVerify({sha}, t.deps)).ok).toBe(false);
    expect.soft(t.forgeSubmit).toHaveBeenCalled();
    expect.soft(ledgerText(t.ledger)).toBe(red);
  });
  it('checklist 11: signed receipt binding FUI to an unfetched/untrusted sibling SHA refuses', async () => {
    const t = orchestration(request => receipt(request.argv, {nonce: request.nonce,
      manifestDigest: request.manifestDigest, siblingShas: {frontierui: 'f'.repeat(40)}}));
    expect((await urgentVerify({sha}, t.deps)).ok).toBe(false);
    expect.soft(t.forgeSubmit).toHaveBeenCalled();
    expect.soft(ledgerText(t.ledger)).toBe('');
  });
});
