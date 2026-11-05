// @vitest-environment node
/** R593: remote.transport=git-bundle - verified bundle ships a real worktree to Forge; default stays rsync. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { materializeWorktree, mirrorReadOnlyForSlots, validBundleEvidence, readMainFetchAge, BUNDLE_MAIN_MAX_AGE_CEILING_MS } from '../forge-exec-bases.mjs';
import { manifestWire, digestManifest } from '../forge-exec-manifest.mjs';
import { planBundle, bundleEvidence, resolveTransport, runnerSupportsBundle, capabilityRecord, capabilityAdvertisesBundle, scanBundleRange, mainFreshness, MAIN_MAX_AGE_CEILING_MS } from '../remote-git-bundle.mjs';
import { decideRemote, resolveAdmissionPolicy, readRunnerBundleCapability, writeRunnerCapabilities } from '../heavy-admission.mjs';

const ident = ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid'];
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const exec = async ({ file, args, cwd, input }) => {
  const r = spawnSync(file, args, { cwd, input });
  return { code: r.status ?? 254, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) };
};
const hash = (text) => createHash('sha256').update(text).digest('hex');

let root, lane, runnerMain, tip, work, container, spy;
beforeEach(async () => {
  root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'gbt-'));
  const source = join(root, 'public');
  await fs.mkdir(source);
  git(source, 'init', '-b', 'main');
  await fs.writeFile(join(source, 'tracked.txt'), 'base');
  git(source, 'add', '.'); git(source, ...ident, 'commit', '-m', 'public');
  runnerMain = git(source, 'rev-parse', 'HEAD');
  git(root, 'clone', '--bare', source, join(root, 'repo.git'));
  git(join(root, 'repo.git'), 'update-ref', 'refs/remotes/origin/main', runnerMain);
  lane = join(root, 'lane');
  git(root, 'clone', source, lane);
  await fs.writeFile(join(lane, 'tracked.txt'), 'changed');
  git(lane, 'add', '.'); git(lane, ...ident, 'commit', '-m', 'wip');
  tip = git(lane, 'rev-parse', 'HEAD');
  work = join(root, 'snapshot'); container = join(root, 'container');
  await fs.mkdir(work); await fs.mkdir(join(container, 'bundle'), { recursive: true });
  await fs.writeFile(join(work, 'tracked.txt'), 'changed');
  await fs.writeFile(join(root, 'main-fetched.json'), JSON.stringify({ sha: runnerMain, fetchedAtMs: Date.now() }));
  spy = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const manifestFor = (head) => {
  const manifest = { ...manifestWire({ entries: [{ path: Buffer.from('tracked.txt'), sha256: hash('changed'), executable: false, tracked: true }], excluded: [] }), git: { head } };
  return { manifest, manifestDigest: digestManifest(manifest) };
};
const run = async ({ head = tip, bundle, runnerBase = runnerMain, sharedClone = true, mutate } = {}) => {
  const dir = join(root, 'out'); await fs.mkdir(dir, { recursive: true });
  const plan = await planBundle({ cwd: lane, head: tip, runnerBase, exec, directory: dir });
  if (plan.file) await fs.copyFile(plan.file, join(container, 'bundle', 'git.bundle'));
  if (mutate) await mutate(join(container, 'bundle', 'git.bundle'));
  const evidence = { maxMainAgeMs: 600000, ...(bundle ?? bundleEvidence(plan)) };
  const { manifest, manifestDigest } = manifestFor(head);
  const spied = async (call) => { spy.push(call.args); return exec(call); };
  await materializeWorktree({ work, root, head, manifest, manifestDigest, exec: spied, sharedClone,
    bundle: { ...evidence, file: join(container, 'bundle', 'git.bundle') } });
  return plan;
};

describe('R593 bundle ingest on the runner', () => {
  it('fetches a verified incremental bundle into a per-run clone and checks out the exact tip', async () => {
    const plan = await run();
    expect(plan.mode).toBe('incremental');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(tip);
    // No network fetch from the public origin in bundle mode.
    expect(spy.some(a => a.includes('fetch') && a.includes('origin'))).toBe(false);
  });
  it('a missing base falls back to a full bundle that still verifies', async () => {
    const plan = await run({ runnerBase: 'f'.repeat(40) });
    expect(plan.mode).toBe('full');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(tip);
  });
  it('ships no bundle when Forge already has the tip', async () => {
    await fs.writeFile(join(work, 'tracked.txt'), 'changed');
    const dir = join(root, 'out2'); await fs.mkdir(dir);
    const plan = await planBundle({ cwd: lane, head: runnerMain, runnerBase: runnerMain, exec, directory: dir });
    expect(plan).toEqual({ mode: 'none', tip: runnerMain });
  });
  it('refuses a bundle whose tip is not the manifest-bound head', async () => {
    await expect(run({ head: runnerMain })).rejects.toMatchObject({ code: 'git-head-unavailable' });
    expect(existsSync(join(work, '.git'))).toBe(false);
  });
  it('refuses when the mirror has no refreshed public main (no cached local main fallback)', async () => {
    git(join(root, 'repo.git'), 'update-ref', '-d', 'refs/remotes/origin/main');
    await expect(run()).rejects.toMatchObject({ code: 'git-head-unavailable' });
  });
  it('refuses a corrupt bundle (digest mismatch)', async () => {
    await expect(run({ mutate: async file => { const b = await fs.readFile(file); b[b.length - 5] ^= 0xff; await fs.writeFile(file, b); } }))
      .rejects.toMatchObject({ code: 'git-head-unavailable' });
    expect(existsSync(join(work, '.git'))).toBe(false);
  });
  it('refuses a corrupt bundle even when the attacker also fixes the digest (git bundle verify)', async () => {
    const garbage = Buffer.from('# v2 git bundle\n' + `${tip} HEAD\n\nPACK-not-a-pack`);
    await expect(run({ mutate: file => fs.writeFile(file, garbage), bundle: { mode: 'incremental', sha256: createHash('sha256').update(garbage).digest('hex'), bytes: garbage.length } }))
      .rejects.toMatchObject({ code: 'git-head-unavailable' });
  });
  it('refuses a size mismatch and invalid evidence', async () => {
    await expect(run({ bundle: { mode: 'incremental', sha256: 'a'.repeat(64), bytes: 1 } })).rejects.toMatchObject({ code: 'git-head-unavailable' });
    expect(validBundleEvidence({ mode: 'weird' })).toBe(false);
    expect(validBundleEvidence({ mode: 'full', sha256: 'zz', bytes: 5 })).toBe(false);
    expect(validBundleEvidence({ mode: 'none' })).toBe(true);
  });
  it('uses --shared only while repo.git is not writable by slot users, else --no-local copies', async () => {
    const mirror = join(root, 'repo.git');
    await fs.chmod(mirror, 0o755);
    expect(await mirrorReadOnlyForSlots(mirror)).toBe(true);
    await run();
    expect(spy.find(a => a.includes('clone'))).toContain('--shared');
    spy = []; await fs.rm(join(work, '.git'), { recursive: true, force: true });
    await fs.chmod(join(mirror, 'objects'), 0o777);
    expect(await mirrorReadOnlyForSlots(mirror)).toBe(false);
    await run();
    const clone = spy.find(a => a.includes('clone'));
    expect(clone).toContain('--no-local'); expect(clone).not.toContain('--shared');
  });
});

describe('R593 client and routing', () => {
  it('defaults to rsync and only an exact git-bundle selects the bundle', () => {
    expect(resolveTransport(undefined)).toBe('rsync'); expect(resolveTransport('bundle')).toBe('rsync');
    expect(resolveTransport('git-bundle')).toBe('git-bundle');
    expect(resolveAdmissionPolicy({ platform: {} }).settings.remote.transport).toBe('rsync');
  });
  it('an old runner (no gitBundle) is not fed a bundle', () => {
    expect(runnerSupportsBundle({ gitWorktree: 2 })).toBe(false);
    expect(runnerSupportsBundle({ gitBundle: 1 })).toBe(true);
    const old = capabilityRecord({ host: 'forge', capabilities: { gitWorktree: 2 }, nowMs: 1000 });
    expect(capabilityAdvertisesBundle(old, { host: 'forge', nowMs: 1001 })).toBe(false);
  });
  it('capability cache expires and is host-bound', () => {
    const rec = capabilityRecord({ host: 'forge', capabilities: { gitBundle: 1 }, nowMs: 1000 });
    expect(capabilityAdvertisesBundle(rec, { host: 'forge', nowMs: 2000 })).toBe(true);
    expect(capabilityAdvertisesBundle(rec, { host: 'other', nowMs: 2000 })).toBe(false);
    expect(capabilityAdvertisesBundle(rec, { host: 'forge', nowMs: 1000 + 61 * 60_000 })).toBe(false);
  });
  describe('needs-git tests route remote only with the capability', () => {
    let cwd;
    const mk = (transport) => resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always', loadPerCoreThreshold: 3, clientPath: null,
      maxConcurrent: 8, backoffMs: 120000, backoffFailures: 3, maxLoadPerCore: 0.8, minFreeRamPct: 15, transport } } });
    beforeEach(async () => {
      cwd = join(root, 'repo'); await fs.mkdir(cwd);
      await fs.writeFile(join(cwd, 'git.test.mjs'), "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['ls-files']);\n");
    });
    const decide = (policy, runnerBundleOk) => decideRemote({ policy, loadPerCore: 4, cwd, argv: ['npx', 'vitest', 'run', 'git.test.mjs'], runnerBundleOk });
    it('git-bundle + capability keeps remote', () => expect(decide(mk('git-bundle'), true)).toMatchObject({ remote: true }));
    it('git-bundle without capability stays local', () => expect(decide(mk('git-bundle'), false)).toMatchObject({ remote: false, needsGit: true }));
    it('rsync stays local even with the capability', () => expect(decide(mk('rsync'), true)).toMatchObject({ remote: false, needsGit: true }));
    it('capability cache round-trips and unreadable means no', () => {
      const dir = join(root, 'remote'); const clock = () => 5000;
      expect(readRunnerBundleCapability({ root: dir, host: 'forge', clock })).toBe(false);
      writeRunnerCapabilities({ root: dir, host: 'forge', capabilities: { gitBundle: 1 }, clock });
      expect(readRunnerBundleCapability({ root: dir, host: 'forge', clock })).toBe(true);
    });
  });
});

const commit = async (repo, files, message) => {
  for (const [name, text] of Object.entries(files)) {
    if (text === null) git(repo, 'rm', '-q', '--', name);
    else { await fs.writeFile(join(repo, name), text); git(repo, 'add', '--', name); }
  }
  git(repo, ...ident, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};

describe('R593 credential scan over the whole bundled range (R559)', () => {
  it('passes a clean range', async () => {
    expect(await scanBundleRange({ cwd: lane, head: tip, prerequisite: runnerMain, exec })).toBeNull();
  });
  it('flags a committed .env that a later commit deleted (every commit, not the final tree)', async () => {
    await commit(lane, { '.env': 'A=1\n' }, 'add env');
    const head = await commit(lane, { '.env': null }, 'drop env');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: '.env' });
  });
  it('flags a token-shaped blob that a later commit scrubbed', async () => {
    await commit(lane, { 'notes.md': 'key ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' + '\n' }, 'oops');
    const head = await commit(lane, { 'notes.md': 'clean\n' }, 'scrub');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: 'notes.md', finding: 'github-token' });
  });
  it('flags a credential-named path and a symlink', async () => {
    const head = await commit(lane, { 'credentials.txt': 'x\n' }, 'cred');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: 'credentials.txt' });
  });
  const tokenName = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  it('flags a token in a FILE NAME (tree entry) even when the content is clean', async () => {
    const head = await commit(lane, { [`${tokenName}.txt`]: 'clean\n' }, 'token-named file');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ finding: 'github-token' });
  });
  it('flags a token in a DIRECTORY name component', async () => {
    await fs.mkdir(join(lane, tokenName));
    const head = await commit(lane, { [`${tokenName}/a.txt`]: 'clean\n' }, 'token-named dir');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ finding: 'github-token' });
  });
  it('flags a token-named file that a later commit deleted (historical tree entry still travels)', async () => {
    await commit(lane, { [`${tokenName}.txt`]: 'clean\n' }, 'token-named file');
    const head = await commit(lane, { [`${tokenName}.txt`]: null }, 'drop it');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ finding: 'github-token' });
  });
  it('ignores secrets that only live in the base history before the prerequisite', async () => {
    expect(await scanBundleRange({ cwd: lane, head: tip, prerequisite: tip, exec })).toBeNull();
  });
  it('planBundle fails closed with bundle-credential-hit and builds no bundle (incremental)', async () => {
    await commit(lane, { 'aws.md': 'AKIA' + 'ABCDEFGHIJKLMNOP' + '\n' }, 'aws');
    const head = await commit(lane, { 'aws.md': 'x\n' }, 'scrub');
    const dir = join(root, 'scan-out'); await fs.mkdir(dir);
    await expect(planBundle({ cwd: lane, head, runnerBase: runnerMain, exec, directory: dir })).rejects.toMatchObject({ code: 'bundle-credential-hit' });
    expect(existsSync(join(dir, 'git.bundle'))).toBe(false);
  });
  it('the full-bundle path scans the whole bundled history, root commit included', async () => {
    const solo = join(root, 'solo'); await fs.mkdir(solo); git(solo, 'init', '-b', 'main');
    await commit(solo, { 'id_rsa': 'k\n' }, 'root');
    const head = await commit(solo, { 'id_rsa': null, 'a.txt': 'a\n' }, 'next');
    const dir = join(root, 'scan-full'); await fs.mkdir(dir);
    await expect(planBundle({ cwd: solo, head, runnerBase: 'f'.repeat(40), exec, directory: dir })).rejects.toMatchObject({ code: 'bundle-credential-hit' });
  });
  it('refuses (does not skip) a range too large to scan', async () => {
    await expect(scanBundleRange({ cwd: lane, head: tip, prerequisite: runnerMain, exec, maxBlobs: 0 })).rejects.toMatchObject({ code: 'bundle-credential-scan-too-large' });
  });
});

describe('R593 mirror main freshness bound (R559)', () => {
  it('fresh within the bound, stale beyond it, unknown when unreadable', () => {
    expect(mainFreshness({ gitBundleMainAgeMs: 5 * 60_000 }, 10 * 60_000)).toBe('fresh');
    expect(mainFreshness({ gitBundleMainAgeMs: 11 * 60_000 }, 10 * 60_000)).toBe('stale');
    expect(mainFreshness({}, 10 * 60_000)).toBe('unknown');
    expect(mainFreshness({ gitBundleMainAgeMs: -1 }, 10 * 60_000)).toBe('unknown');
    expect(mainFreshness({ gitBundleMainAgeMs: 1 }, Number.NaN)).toBe('unknown');
  });
  it('the runner reads the warmer fetch stamp and refuses a stale or missing one at ingest', async () => {
    const stamp = join(root, 'main-fetched.json');
    expect(await readMainFetchAge(root, { clock: () => 1000 })).toBeUndefined();
    await fs.writeFile(stamp, JSON.stringify({ sha: runnerMain, fetchedAtMs: 400 }));
    expect(await readMainFetchAge(root, { clock: () => 1000 })).toBe(600);
    const dir = join(root, 'fresh-out'); await fs.mkdir(dir);
    const plan = await planBundle({ cwd: lane, head: tip, runnerBase: runnerMain, exec, directory: dir });
    await fs.copyFile(plan.file, join(container, 'bundle', 'git.bundle'));
    const { manifest, manifestDigest } = manifestFor(tip);
    const call = (maxMainAgeMs) => materializeWorktree({ work, root, head: tip, manifest, manifestDigest, exec, clock: () => 1000,
      bundle: { ...bundleEvidence(plan), file: join(container, 'bundle', 'git.bundle'), maxMainAgeMs } });
    await expect(call(500)).rejects.toMatchObject({ code: 'git-head-unavailable' });
    await fs.rm(stamp);
    await expect(call(5000)).rejects.toMatchObject({ code: 'git-head-unavailable' });
    await fs.writeFile(stamp, JSON.stringify({ sha: runnerMain, fetchedAtMs: 400 }));
    await call(5000);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(tip);
  });
  it('remote.bundle.mainMaxAgeMin defaults to 10 and resolves through the policy cascade', () => {
    expect(resolveAdmissionPolicy({ platform: {} }).settings.remote.bundle.mainMaxAgeMin).toBe(10);
    const set = resolveAdmissionPolicy({ platform: { remote: { bundle: { mainMaxAgeMin: 3 } } } });
    expect(set.settings.remote.bundle.mainMaxAgeMin).toBe(3);
    expect(set.sources['remote.bundle.mainMaxAgeMin']).toBe('platform');
    const bad = resolveAdmissionPolicy({ platform: { remote: { bundle: { mainMaxAgeMin: 0 } } } });
    expect(bad.settings.remote.bundle.mainMaxAgeMin).toBe(10);
    expect(bad.invalid.join(' ')).toContain('mainMaxAgeMin');
  });
});

describe('R593 audit round 3 fixes (R559)', () => {
  it('bundles the pinned sha through a temporary ref, not the live HEAD, and leaves no ref behind', async () => {
    const pinned = tip;
    await commit(lane, { 'later.txt': 'later\n' }, 'HEAD moves after the scan');
    const dir = join(root, 'pin-out'); await fs.mkdir(dir);
    const plan = await planBundle({ cwd: lane, head: pinned, runnerBase: runnerMain, exec, directory: dir });
    const heads = git(lane, 'bundle', 'list-heads', plan.file).split('\n');
    expect(heads).toHaveLength(1);
    expect(heads[0].startsWith(pinned + ' refs/we/bundle-')).toBe(true);
    expect(git(lane, 'for-each-ref', 'refs/we')).toBe('');
  });
  it('flags a token in a commit message', async () => {
    await commit(lane, { 'ok.txt': 'ok\n' }, 'deploy with ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
    const head = git(lane, 'rev-parse', 'HEAD');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: 'commit-message', finding: 'github-token' });
  });
  it('the runner refuses a client-supplied main age above the ceiling', async () => {
    expect(BUNDLE_MAIN_MAX_AGE_CEILING_MS).toBe(1440 * 60_000);
    await expect(run({ bundle: { mode: 'incremental', sha256: 'a'.repeat(64), bytes: 1, maxMainAgeMs: BUNDLE_MAIN_MAX_AGE_CEILING_MS + 1 } })).rejects.toMatchObject({ code: 'git-head-unavailable' });
    expect(MAIN_MAX_AGE_CEILING_MS).toBe(BUNDLE_MAIN_MAX_AGE_CEILING_MS);
  });
  it('refuses a stamp whose fetched sha is not the mirror ref', async () => {
    await fs.writeFile(join(root, 'main-fetched.json'), JSON.stringify({ sha: tip, fetchedAtMs: Date.now() }));
    await expect(run()).rejects.toMatchObject({ code: 'git-head-unavailable' });
    expect(existsSync(join(work, '.git'))).toBe(false);
  });
});

describe('R593 content scanner parity with the rsync path (R559)', () => {
  it('flags a secret assignment in a historical blob that only the rsync content scanner knows', async () => {
    await commit(lane, { 'config.ini': 'password=actual-private-value\n' }, 'cfg');
    const head = await commit(lane, { 'config.ini': 'ok=1\n' }, 'scrub');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: 'config.ini', finding: expect.stringContaining('password') });
  });
  it('fails closed on a binary historical blob', async () => {
    await fs.writeFile(join(lane, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    git(lane, 'add', '--', 'blob.bin'); git(lane, ...ident, 'commit', '-q', '-m', 'bin');
    expect(await scanBundleRange({ cwd: lane, head: git(lane, 'rev-parse', 'HEAD'), prerequisite: runnerMain, exec })).toMatchObject({ path: 'blob.bin', finding: 'unsupported-text-encoding' });
  });
});

describe('R593 identical blob under several paths (path-dependent scanner)', () => {
  it('scans a deduplicated blob under every path that adds it, not only the first', async () => {
    // Same bytes: clean as plain text at a-notes.txt (sorts first), a secret under the structural JSON scanner at z-settings.json.
    const body = '{"password":"actual-private-value-1234567890"}\n';
    const head = await commit(lane, { 'a-notes.txt': body, 'z-settings.json': body }, 'same blob twice');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: 'z-settings.json' });
  });
  it('flags it when the benign path is the newest commit that adds the blob', async () => {
    const body = '{"password":"actual-private-value-1234567890"}\n';
    await commit(lane, { 'z-settings.json': body }, 'json path');
    const head = await commit(lane, { 'a-notes.txt': body }, 'newer plain path');
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: 'z-settings.json' });
  });
  it('refuses (does not skip) when the path fan-out of one blob exceeds the bound', async () => {
    const head = await commit(lane, { 'a1.txt': 'same\n', 'a2.txt': 'same\n', 'a3.txt': 'same\n' }, 'fan-out');
    await expect(scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec, maxBlobs: 2 })).rejects.toMatchObject({ code: 'bundle-credential-scan-too-large' });
  });
});

describe('R593 commit-message scanner parity (R559)', () => {
  it('flags a secret assignment in a commit message', async () => {
    await commit(lane, { 'ok.txt': 'ok\n' }, 'notes\npassword=actual-private-value');
    expect(await scanBundleRange({ cwd: lane, head: git(lane, 'rev-parse', 'HEAD'), prerequisite: runnerMain, exec })).toMatchObject({ path: 'commit-message' });
  });
});

describe('R593 raw commit object scan (R559)', () => {
  const rawCommit = (extraHeader) => {
    const tree = git(lane, 'rev-parse', 'HEAD^{tree}');
    const body = `tree ${tree}\nparent ${tip}\nauthor F <f@example.invalid> 1700000000 +0000\ncommitter F <f@example.invalid> 1700000000 +0000\n${extraHeader}\nempty child\n`;
    const r = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: lane, input: body, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const sig = (comment) => `gpgsig -----BEGIN PGP SIGNATURE-----\n Comment: ${comment}\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n`;
  it('flags a token hidden in a multiline gpgsig header (empty child commit)', async () => {
    const head = rawCommit(sig('ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'));
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: 'commit-object', finding: 'github-token' });
  });
  it('passes the same extended header without a credential', async () => {
    const head = rawCommit(sig('GnuPG v2'));
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toBeNull();
  });
  it('refuses (does not skip) a single commit object over the per-batch bound', async () => {
    const head = rawCommit(`x-pad ${'x'.repeat(3 * 1024 * 1024 + 1)}\n`);
    await expect(scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).rejects.toMatchObject({ code: 'bundle-credential-scan-too-large' });
  });
  it('refuses (does not skip) a commit range too large to scan', async () => {
    await expect(scanBundleRange({ cwd: lane, head: tip, prerequisite: runnerMain, exec, maxTotalBytes: 1 })).rejects.toMatchObject({ code: 'bundle-credential-scan-too-large' });
  });
});

describe('R593 degraded coverage (R559)', () => {
  it('refuses a symlink (120000) in the bundled range', async () => {
    await fs.symlink('tracked.txt', join(lane, 'link'));
    git(lane, 'add', '--', 'link'); git(lane, ...ident, 'commit', '-q', '-m', 'symlink');
    expect(await scanBundleRange({ cwd: lane, head: git(lane, 'rev-parse', 'HEAD'), prerequisite: runnerMain, exec })).toMatchObject({ path: 'link', finding: 'symlink' });
  });
  it('refuses a gitlink (160000) in the bundled range', async () => {
    git(lane, 'update-index', '--add', '--cacheinfo', `160000,${tip},sub`);
    git(lane, ...ident, 'commit', '-q', '-m', 'gitlink');
    expect(await scanBundleRange({ cwd: lane, head: git(lane, 'rev-parse', 'HEAD'), prerequisite: runnerMain, exec })).toMatchObject({ path: 'sub', finding: 'gitlink' });
  });
  it('the main-age ceiling is the only thing refused when the bundle evidence is otherwise valid', async () => {
    const dir = join(root, 'ceil-out'); await fs.mkdir(dir);
    const plan = await planBundle({ cwd: lane, head: tip, runnerBase: runnerMain, exec, directory: dir });
    await fs.copyFile(plan.file, join(container, 'bundle', 'git.bundle'));
    const { manifest, manifestDigest } = manifestFor(tip);
    const call = (maxMainAgeMs) => materializeWorktree({ work, root, head: tip, manifest, manifestDigest, exec,
      bundle: { ...bundleEvidence(plan), file: join(container, 'bundle', 'git.bundle'), maxMainAgeMs } });
    await expect(call(BUNDLE_MAIN_MAX_AGE_CEILING_MS + 1)).rejects.toMatchObject({ code: 'git-head-unavailable' });
    expect(existsSync(join(work, '.git'))).toBe(false);
    await call(BUNDLE_MAIN_MAX_AGE_CEILING_MS);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(tip);
  });
});

describe('R593 empty directory tree entries (R559)', () => {
  const tokenDir = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  /** A commit whose root tree carries `<name>` as an EMPTY subtree entry (git add can never produce this; mktree can). */
  const emptyDirCommit = (name, repo = lane, parent = tip) => {
    const base = git(repo, 'rev-parse', `${parent}^{tree}`);
    const entries = git(repo, 'ls-tree', base).split('\n').filter(Boolean);
    const mk = spawnSync('git', ['mktree'], { cwd: repo, input: `${entries.join('\n')}\n040000 tree ${EMPTY_TREE}\t${name}\n`, encoding: 'utf8' });
    if (mk.status !== 0) throw new Error(mk.stderr);
    const out = spawnSync('git', [...ident, 'commit-tree', mk.stdout.trim(), '-p', parent, '-m', 'empty dir'], { cwd: repo, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(out.stderr);
    return out.stdout.trim();
  };
  it('flags a token in an empty directory entry name (no blob below it)', async () => {
    const head = emptyDirCommit(tokenDir);
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: 'tree-entry-name', finding: 'github-token' });
  });
  it('flags a token in an empty directory nested under a real directory', async () => {
    await fs.mkdir(join(lane, 'pkg'));
    const parentSha = await commit(lane, { 'pkg/a.txt': 'a\n' }, 'pkg');
    const pkgTree = git(lane, 'rev-parse', `${parentSha}:pkg`);
    const inner = spawnSync('git', ['mktree'], { cwd: lane, input: `100644 blob ${git(lane, 'rev-parse', `${parentSha}:pkg/a.txt`)}\ta.txt\n040000 tree ${EMPTY_TREE}\t${tokenDir}\n`, encoding: 'utf8' }).stdout.trim();
    expect(inner).not.toBe(pkgTree);
    const root2 = spawnSync('git', ['mktree'], { cwd: lane, input: `${git(lane, 'ls-tree', `${parentSha}^{tree}`).split('\n').filter(l => !l.endsWith('\tpkg')).join('\n')}\n040000 tree ${inner}\tpkg\n`, encoding: 'utf8' }).stdout.trim();
    const head = spawnSync('git', [...ident, 'commit-tree', root2, '-p', parentSha, '-m', 'nested empty dir'], { cwd: lane, encoding: 'utf8' }).stdout.trim();
    expect(await scanBundleRange({ cwd: lane, head, prerequisite: runnerMain, exec })).toMatchObject({ path: 'tree-entry-name', finding: 'github-token' });
  });
  it('flags it when a later commit removed the empty directory (historical tree entry still travels)', async () => {
    const bad = emptyDirCommit(tokenDir);
    const clean = spawnSync('git', [...ident, 'commit-tree', git(lane, 'rev-parse', `${tip}^{tree}`), '-p', bad, '-m', 'drop'], { cwd: lane, encoding: 'utf8' }).stdout.trim();
    expect(await scanBundleRange({ cwd: lane, head: clean, prerequisite: runnerMain, exec })).toMatchObject({ path: 'tree-entry-name', finding: 'github-token' });
  });
  it('passes an empty directory entry with a clean name', async () => {
    expect(await scanBundleRange({ cwd: lane, head: emptyDirCommit('vendor-empty'), prerequisite: runnerMain, exec })).toBeNull();
  });
});
