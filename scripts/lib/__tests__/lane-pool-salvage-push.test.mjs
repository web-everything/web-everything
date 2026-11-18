import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LANE_GIT_CONFIG_PINS } from '../lane-git-hardening.mjs';

// Intentionally absent in this red-first change: no implementation or import stub.
let salvageStamp, salvageRefName, salvagePushLane, realSalvageIo, NO_REPO_CWD, redactUrlCredentials, releasePushTarget;
beforeEach(async () => {
  ({ salvageStamp, salvageRefName, salvagePushLane, realSalvageIo, NO_REPO_CWD, redactUrlCredentials, releasePushTarget } = await import('../lane-pool-salvage-push.mjs'));
});

// The release guard prints `git -C <lane> push <target> …` and journals git error text: credentials never survive,
// while an ssh user name (not a secret, and needed to log in) and scp-style origins do.
describe('releasePushTarget / redactUrlCredentials', () => {
  it.each([
    ['a relative local path', 'some/origin.git', resolve('some/origin.git')],
    ['an absolute local path', '/srv/origin.git', '/srv/origin.git'],
    ['https with user and token', 'https://user:s3cret@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['https with a bare token', 'https://s3cret@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['https with a raw @ in the password', 'https://user:p@s3cret@host/repo.git', 'https://host/repo.git'],
    ['ssh:// with a user', 'ssh://git@github.com/org/repo.git', 'ssh://git@github.com/org/repo.git'],
    ['ssh:// with a user and password', 'ssh://git:s3cret@host/repo.git', 'ssh://git@host/repo.git'],
    ['scp-style', 'git@github.com:org/repo.git', 'git@github.com:org/repo.git'],
  ])('push target for %s', (_, url, expected) => {
    expect(releasePushTarget(url)).toBe(expected);
    expect(releasePushTarget(url)).not.toContain('s3cret');
  });
  it('strips every credentialed URL inside a git error message, leaving the rest', () => {
    const text = "Command failed: git ls-remote https://u:s3cret@host/x.git refs/heads/*\nfatal: unable to access 'https://s3cret@host/x.git/'";
    expect(redactUrlCredentials(text)).toBe("Command failed: git ls-remote https://host/x.git refs/heads/*\nfatal: unable to access 'https://host/x.git/'");
  });
  it.each([
    ['a config key with an insteadOf URL', 'url.https://oauth2:s3cret@gitlab.com/.insteadof', 'url.https://gitlab.com/.insteadof'],
    ['a scheme glued to a word character', 'x_https://u:s3cret@h/x', 'x_https://h/x'],
    ['a scheme glued to a digit', '1https://s3cret@h/x', '1https://h/x'],
  ])('redacts %s', (_, text, expected) => {
    expect(redactUrlCredentials(text)).toBe(expected);
  });
  it('redacts a failed salvage push reason', async () => {
    const io = { aheadShas: async () => { throw new Error('git push https://u:s3cret@host/x.git failed'); } };
    const result = await salvagePushLane({ lane: 1, laneDir: 'lane', io });
    expect(result).toMatchObject({ status: 'failed', reason: 'git push https://host/x.git failed' });
  });
});

const date = new Date('2026-01-02T03:04:59.999Z');
const head = 'a'.repeat(40), older = 'b'.repeat(40), other = 'c'.repeat(40);
const ref = 'salvage/lane-7-20260102-0304';
const laneDir = join('pool', 'lane-7');
function harness(overrides = {}) {
  const remote = new Map();
  const io = {
    aheadShas: vi.fn(() => [head, older]),
    unmatchedShas: vi.fn(() => [older]),
    push: vi.fn((_dir, name, sha) => { remote.set(name, sha); return { ok: true }; }),
    remoteSha: vi.fn(name => remote.get(name) ?? null),
    record: vi.fn(),
    ...overrides,
  };
  return { io, remote, run: () => salvagePushLane({ lane: 7, laneDir, io, now: () => date }) };
}

function expectFailed(result, io) {
  expect(result.status).toBe('failed');
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason.trim()).not.toBe('');
  expect(io.record).not.toHaveBeenCalled();
}

describe('salvage push contract', () => {
  it('formats a zero-padded UTC stamp, discarding seconds', () => {
    expect(salvageStamp(date)).toBe('20260102-0304');
    expect(salvageStamp(new Date('2026-12-31T23:07:00-05:00'))).toBe('20270101-0407');
  });

  it('names an ordinary branch under salvage/lane-N-stamp', () => {
    expect(salvageRefName(7, date)).toBe(ref);
  });

  it('returns none-ahead without pushing when there are no ahead commits', async () => {
    const h = harness({ aheadShas: vi.fn(() => []) });
    expect(await h.run()).toMatchObject({ status: 'none-ahead', unmatched: [] });
    expect(h.io.aheadShas).toHaveBeenCalledWith(laneDir);
    expect(h.io.push).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('returns matched without pushing when every ahead commit is already preserved', async () => {
    const h = harness({ unmatchedShas: vi.fn(() => []) });
    expect(await h.run()).toMatchObject({ status: 'matched', unmatched: [] });
    expect(h.io.unmatchedShas).toHaveBeenCalledWith(laneDir, [head, older]);
    expect(h.io.push).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('pushes HEAD rather than only the unmatched ancestor, with exactly three arguments and no force option', async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ status: 'pushed', ref, sha: head, unmatched: [older] });
    expect(h.io.push.mock.calls).toEqual([[laneDir, ref, head]]);
    expect(h.io.push.mock.calls.flat().some(arg => /force|^\+|^-f$/.test(String(arg)))).toBe(false);
  });

  it('checks the remote before pushing, verifies the pushed SHA, then records the ref and SHA exactly once', async () => {
    const h = harness();
    await h.run();
    expect(h.io.remoteSha.mock.calls).toEqual([[ref], [ref]]);
    expect(h.io.remoteSha.mock.invocationCallOrder[0]).toBeLessThan(h.io.push.mock.invocationCallOrder[0]);
    expect(h.io.push.mock.invocationCallOrder[0]).toBeLessThan(h.io.remoteSha.mock.invocationCallOrder[1]);
    expect(h.io.remoteSha.mock.invocationCallOrder[1]).toBeLessThan(h.io.record.mock.invocationCallOrder[0]);
    expect(h.io.record).toHaveBeenCalledTimes(1); expect(h.io.record).toHaveBeenCalledWith(7, expect.stringContaining(ref));
    expect(h.io.record.mock.calls[0][1]).toContain(head);
  });

  it.each([null, other])('fails closed and never records success when verification returns %s', async verifiedSha => {
    const h = harness({ remoteSha: vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(verifiedSha) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1);
    expect(h.io.remoteSha).toHaveBeenCalledTimes(2);
  });

  it('fails closed with a reason when the push returns ok:false', async () => {
    const h = harness({ push: vi.fn(() => ({ ok: false })) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1);
  });

  it.each(['aheadShas', 'unmatchedShas', 'push', 'remoteSha'])('contains a %s exception and returns failed with a reason', async method => {
    const h = harness({ [method]: vi.fn(() => { throw new Error(`${method} unavailable`); }) });
    expectFailed(await h.run(), h.io);
  });

  it('contains a record exception rather than claiming a fully recorded push', async () => {
    const h = harness({ record: vi.fn(() => { throw new Error('record unavailable'); }) });
    const result = await h.run();
    expect(result.status).toBe('failed');
    expect(result.reason).toEqual(expect.stringMatching(/\S/));
  });

  it('returns failed without recording when asynchronous verification resolves to a mismatched SHA', async () => {
    const h = harness({ remoteSha: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(other) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1); expect(h.io.push).toHaveBeenCalledWith(laneDir, ref, head);
    expect(h.io.remoteSha).toHaveBeenCalledTimes(2);
  });

  it('returns failed when the record write rejects despite a verified remote SHA', async () => {
    const h = harness({ record: vi.fn().mockRejectedValue(new Error('record write rejected')) });
    expect(await h.run()).toMatchObject({ status: 'failed', reason: expect.stringContaining('record write rejected') });
    expect(h.io.remoteSha).toHaveReturnedWith(head);
    expect(h.io.record).toHaveBeenCalledTimes(1); expect(h.io.record).toHaveBeenCalledWith(7, `${ref} ${head}\n`);
  });

  it('reports pushed only after remote verification and the pending record write both succeed', async () => {
    let finishRecord, recordStarted;
    const written = new Promise(resolve => { finishRecord = resolve; });
    const started = new Promise(resolve => { recordStarted = resolve; });
    const h = harness({ record: vi.fn(() => { recordStarted(); return written; }) });
    let settled = false;
    const pending = h.run().then(result => { settled = true; return result; });
    await started;
    await Promise.resolve();
    expect(h.io.remoteSha).toHaveReturnedWith(head);
    expect(h.io.record).toHaveBeenCalledTimes(1); expect(h.io.record).toHaveBeenCalledWith(7, `${ref} ${head}\n`);
    expect(settled).toBe(false);
    finishRecord();
    expect(await pending).toMatchObject({ status: 'pushed', ref, sha: head, unmatched: [older] });
    expect(settled).toBe(true);
  });

  it('fails closed if the remote verification throws after a successful push', async () => {
    const h = harness({ remoteSha: vi.fn().mockReturnValueOnce(null).mockImplementationOnce(() => { throw new Error('verification unavailable'); }) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])('skips %i occupied names with -2/-3 suffixes and never overwrites them', async occupied => {
    const h = harness();
    const names = [ref, `${ref}-2`, `${ref}-3`];
    for (const name of names.slice(0, occupied)) h.remote.set(name, other);
    const expected = names[occupied];
    expect(await h.run()).toMatchObject({ status: 'pushed', ref: expected });
    expect(h.io.push.mock.calls).toEqual([[laneDir, expected, head]]);
    expect(h.io.remoteSha.mock.calls).toEqual([...names.slice(0, occupied + 1), expected].map(name => [name]));
    for (const name of names.slice(0, occupied)) expect(h.remote.get(name)).toBe(other);
  });

  it('exports realSalvageIo with the five IO functions', () => {
    const io = realSalvageIo({ repo: { name: 'fixture', poolDir: 'pool', referencePath: 'reference', originUrl: 'origin.git', branch: 'main' }, backupRoot: 'backups' });
    for (const method of ['aheadShas', 'unmatchedShas', 'push', 'remoteSha', 'record']) expect(io[method]).toBeTypeOf('function');
  });
});

describe('remoteHeads (the release proof) reads the canonical origin from the primary checkout', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'salvage-heads-'));
    const origin = join(dir, 'origin.git'), primary = join(dir, 'primary');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, primary], { stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: primary });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/heads/ops/ledger'], { cwd: primary });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: primary, encoding: 'utf8' }).trim();
    const io = realSalvageIo({ repo: { branch: 'main', originUrl: origin, referencePath: primary, primaryPath: primary }, backupRoot: join(dir, 'backups') });
    return { dir, primary, sha, io };
  };
  // PR #6319 send-back: the auth exemption follows a VALIDATED primary (resolveRepo's primaryPath), never the
  // invoking checkout. A release run inside a lane keeps that lane as referencePath: without a validated primary its
  // credential helper refuses; with one, the listing runs in the primary and the lane's config is never consulted.
  // `hook.<name>.command`: a config-defined hook runs during a transport even with the core.hooksPath pin (git 2.54).
  it.each(['credential.helper', 'http.extraHeader', 'core.askPass', 'hook.lanehook.command'])('refuses %s in a referencePath that is not the validated primary', key => {
    const { dir, primary, sha } = setup();
    try {
      const lane = join(dir, 'lane-1');
      execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), lane], { stdio: 'ignore' });
      execFileSync('git', ['config', key, '!touch marker'], { cwd: lane });
      const unvalidated = realSalvageIo({ repo: { branch: 'main', originUrl: join(dir, 'origin.git'), referencePath: lane }, backupRoot: join(dir, 'backups') });
      expect(() => unvalidated.remoteHeads()).toThrow(/lane-controlled transport/);
      // The salvage ref check is the same canonical-origin listing: same cwd rule, same refusal.
      expect(() => unvalidated.remoteSha('main')).toThrow(/lane-controlled transport/);
      const runGit = vi.fn(execFileSync);
      const validated = realSalvageIo({ repo: { branch: 'main', originUrl: join(dir, 'origin.git'), referencePath: lane, primaryPath: primary }, backupRoot: join(dir, 'backups'), runGit });
      expect(validated.remoteHeads()).toEqual([sha]);
      expect(validated.remoteSha('main')).toBe(sha);
      expect(runGit.mock.calls.filter(([, args]) => args.includes('ls-remote'))).toHaveLength(2);
      // The config checks read the validated primary; the no-pins listing itself runs outside any repository.
      for (const [, args, options] of runGit.mock.calls) expect(options.cwd, args.join(' ')).toBe(args.includes('ls-remote') ? NO_REPO_CWD : primary);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('pins lane transports to no credential helper and no askpass; every transport drops inherited askpass / ssh and prompts', () => {
    const { dir, primary } = setup();
    try {
      // A caller inside a lane controls its own env: an inherited askpass program must not reach the transport.
      vi.stubEnv('GIT_ASKPASS', join(dir, 'lane-askpass'));
      vi.stubEnv('SSH_ASKPASS', join(dir, 'lane-ssh-askpass'));
      vi.stubEnv('GIT_SSH_COMMAND', join(dir, 'lane-ssh'));
      vi.stubEnv('GIT_SSH', join(dir, 'lane-ssh'));
      const lane = join(dir, 'lane-1');
      execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), lane], { stdio: 'ignore' });
      const runGit = vi.fn(execFileSync);
      const io = realSalvageIo({ repo: { branch: 'main', originUrl: join(dir, 'origin.git'), referencePath: lane, primaryPath: primary }, backupRoot: join(dir, 'backups'), runGit });
      io.remoteHeads();
      io.fetchHeads(lane);
      // The same listing without a validated primary runs where it can (here the lane): it keeps the reset pins.
      const fallbackGit = vi.fn(execFileSync);
      realSalvageIo({ repo: { branch: 'main', originUrl: join(dir, 'origin.git'), referencePath: lane }, backupRoot: join(dir, 'backups'), runGit: fallbackGit }).remoteHeads();
      const pinsOf = ({ env }) => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
      const transports = {
        primaryListing: runGit.mock.calls.find(([, args]) => args.includes('ls-remote'))[2],
        laneFetch: runGit.mock.calls.find(([, args]) => args.includes('fetch'))[2],
        fallbackListing: fallbackGit.mock.calls.find(([, args]) => args.includes('ls-remote'))[2],
      };
      expect(transports.primaryListing.cwd).toBe(NO_REPO_CWD);
      expect(pinsOf(transports.primaryListing)).not.toHaveProperty('credential.helper');
      expect(pinsOf(transports.primaryListing)).not.toHaveProperty('core.askPass');
      for (const name of ['laneFetch', 'fallbackListing']) {
        expect(transports[name].cwd, name).toBe(lane);
        expect(pinsOf(transports[name]), name).toMatchObject({ 'credential.helper': '', 'core.askPass': '' });
      }
      for (const [name, options] of Object.entries(transports)) {
        const { env } = options;
        expect(env.GIT_TERMINAL_PROMPT, name).toBe('0');
        for (const key of ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_SSH']) expect(env, `${name} ${key}`).not.toHaveProperty(key);
        expect(pinsOf(options)['core.sshCommand'], name).toBe('ssh');
        expect(pinsOf(options)['core.hooksPath'], name).toBe('/dev/null');
      }
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  // PR #6319 operator ruling (R674 route a): the operator's own credential helper (account-home global scope)
  // authenticates the canonical-origin listing run in the validated primary; a lane-set helper never runs on a lane
  // transport. A helper in the primary's LOCAL config is refused instead (next test): the send-back trusts
  // global/system scope only, and any non-pool clone with the right origin can be the "primary".
  it('the primary listing authenticates with a global dummy helper while a lane-set helper stays blocked', () => {
    const { dir, primary } = setup();
    try {
      const home = join(dir, 'home');
      mkdirSync(home);
      const primaryRan = join(dir, 'primary-helper-ran'), evilRan = join(dir, 'lane-helper-ran');
      const helper = `!f() { touch '${primaryRan}'; [ "$1" = get ] && printf 'username=operator\\npassword=primary-pass\\n'; }; f`;
      execFileSync('git', ['config', '--file', join(home, '.gitconfig'), 'credential.helper', helper]);
      // The caller (a release run inside a lane) points HOME / XDG_CONFIG_HOME at a lane-written config with its own
      // helper: the primary listing reads global config from the account home (`accountHome`) instead.
      const callerHome = join(dir, 'caller-home');
      mkdirSync(join(callerHome, 'git'), { recursive: true });
      const evilHelper = `!f() { touch '${evilRan}'; echo username=evil; echo password=evil; }; f`;
      for (const file of [join(callerHome, '.gitconfig'), join(callerHome, 'git', 'config')]) execFileSync('git', ['config', '--file', file, 'credential.helper', evilHelper]);
      vi.stubEnv('HOME', callerHome);
      vi.stubEnv('XDG_CONFIG_HOME', callerHome);
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      const lane = join(dir, 'lane-1');
      execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), lane], { stdio: 'ignore' });
      const runGit = vi.fn(execFileSync);
      const io = realSalvageIo({ repo: { branch: 'main', originUrl: join(dir, 'origin.git'), referencePath: lane, primaryPath: primary }, backupRoot: join(dir, 'backups'), runGit, accountHome: home });
      io.remoteHeads();
      io.fetchHeads(lane);
      const envOf = command => runGit.mock.calls.find(([, args]) => args.includes(command))[2].env;
      const fill = (cwd, env) => spawnSync('git', ['credential', 'fill'], { cwd, env, input: 'protocol=https\nhost=example.invalid\n\n', encoding: 'utf8', timeout: 20_000 });
      const listingEnv = envOf('ls-remote');
      expect(listingEnv.GIT_TERMINAL_PROMPT).toBe('0');
      const filled = fill(primary, listingEnv);
      expect(filled.status, filled.stderr).toBe(0);
      expect(filled.stdout).toContain('password=primary-pass');
      expect(existsSync(primaryRan)).toBe(true);
      expect(existsSync(evilRan), 'the caller-home helper ran in the primary listing').toBe(false);
      // The lane transport keeps the reset pins: a helper the lane sets afterwards is not run and nothing answers.
      execFileSync('git', ['config', 'credential.helper', `!f() { touch '${evilRan}'; echo username=evil; echo password=evil; }; f`], { cwd: lane });
      execFileSync('git', ['config', 'core.askPass', `${join(dir, 'lane-askpass')}`], { cwd: lane });
      const laneFill = fill(lane, envOf('fetch'));
      expect(laneFill.status).not.toBe(0);
      expect(existsSync(evilRan), 'the lane credential helper ran').toBe(false);
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  // PR #6319 self-review (check-then-run race): the primary's local config passes the check, then an agent with write
  // access to that `.git/config` plants a helper and a URL rewrite before the no-pins listing starts. The listing must
  // not read the primary's local config at all, so neither runs: it runs outside any repository.
  it('a helper or URL rewrite planted in the primary after the config check never reaches the no-pins listing', () => {
    const { dir, primary, sha } = setup();
    try {
      const home = join(dir, 'home'), marker = join(dir, 'planted-ran'), decoy = join(dir, 'decoy.git');
      mkdirSync(home);
      execFileSync('git', ['init', '--bare', '-q', '-b', 'main', decoy]);
      execFileSync('git', ['push', '-q', decoy, `${sha}:refs/heads/main`, `${sha}:refs/heads/decoy-only`], { cwd: primary });
      const seen = [];
      const runGit = vi.fn((file, args, options) => {
        if (args.includes('ls-remote')) {
          // The race: the check has passed; the primary's local config changes before the listing runs.
          execFileSync('git', ['config', 'credential.helper', `!f() { touch '${marker}'; echo username=evil; echo password=evil; }; f`], { cwd: primary });
          execFileSync('git', ['config', `url.${decoy}.insteadOf`, join(dir, 'origin.git')], { cwd: primary });
          const helpers = spawnSync('git', ['config', '--get-all', 'credential.helper'], { cwd: options.cwd, env: options.env, encoding: 'utf8' });
          const fill = spawnSync('git', ['credential', 'fill'], { cwd: options.cwd, env: options.env, input: 'protocol=https\nhost=example.invalid\n\n', encoding: 'utf8', timeout: 20_000 });
          const gitDir = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: options.cwd, env: options.env, encoding: 'utf8' });
          seen.push({ cwd: options.cwd, helpers: helpers.stdout, filled: fill.stdout, gitDirStatus: gitDir.status });
        }
        return execFileSync(file, args, options);
      });
      const io = realSalvageIo({ repo: { branch: 'main', originUrl: join(dir, 'origin.git'), referencePath: primary, primaryPath: primary }, backupRoot: join(dir, 'backups'), runGit, accountHome: home });
      // The decoy carries an extra head: a rewrite that reached the listing would add it to the result.
      expect(io.remoteHeads()).toEqual([sha]);
      expect(seen).toHaveLength(1);
      expect(seen[0].cwd).not.toBe(primary);
      expect(seen[0].gitDirStatus, 'the no-pins listing cwd is inside a repository').not.toBe(0);
      expect(seen[0].helpers).not.toContain(marker);
      expect(seen[0].filled).not.toContain('password=evil');
      expect(existsSync(marker), 'the planted primary helper ran').toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // PR #6319 self-review: the primary listing's config check reads the SAME global config the listing applies (the
  // account home), so a caller-set HOME cannot hide an account-level URL rewrite of the canonical origin from it.
  it('the primary listing refuses a URL rewrite in the account home even when the caller points HOME elsewhere', () => {
    const { dir, primary } = setup();
    try {
      const home = join(dir, 'home'), callerHome = join(dir, 'caller-home');
      mkdirSync(home);
      mkdirSync(callerHome);
      execFileSync('git', ['config', '--file', join(home, '.gitconfig'), `url.${join(dir, 'elsewhere.git')}.insteadOf`, join(dir, 'origin.git')]);
      vi.stubEnv('HOME', callerHome);
      vi.stubEnv('XDG_CONFIG_HOME', callerHome);
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      const runGit = vi.fn(execFileSync);
      const io = realSalvageIo({ repo: { branch: 'main', originUrl: join(dir, 'origin.git'), referencePath: primary, primaryPath: primary }, backupRoot: join(dir, 'backups'), runGit, accountHome: home });
      expect(() => io.remoteHeads()).toThrow(/URL rewriting configured/);
      expect(runGit.mock.calls.some(([, args]) => args.includes('ls-remote'))).toBe(false);
      // Every config read of that check ran under the listing's env (account home), not the caller's HOME.
      for (const [, args, options] of runGit.mock.calls.filter(([, args]) => args.includes('config'))) expect(options.env.HOME, args.join(' ')).toBe(home);
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('accepts operator signing keys in the primary, a global credential helper, and excludes ops/* heads', () => {
    const { dir, primary, sha } = setup();
    try {
      // An agent-writable lane may not carry these; the operator's primary legitimately can.
      execFileSync('git', ['config', 'commit.gpgSign', 'false'], { cwd: primary });
      const home = join(dir, 'home');
      mkdirSync(home);
      execFileSync('git', ['config', '--file', join(home, '.gitconfig'), 'credential.helper', 'store']);
      const io = realSalvageIo({ repo: { branch: 'main', originUrl: join(dir, 'origin.git'), referencePath: primary, primaryPath: primary }, backupRoot: join(dir, 'backups'), accountHome: home });
      expect(io.remoteHeads()).toEqual([sha]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // PR #6319 self-review: the primary listing drops the credential resets, and "validated primary" means only a clone
  // outside the pool roots with the right origin — an agent can `git init` one under the workspace. So a credential
  // helper, askpass, proxy, TLS or gitProxy key in the primary's LOCAL (or worktree) config is refused, never run.
  it.each([
    ['credential.helper', marker => `!touch '${marker}'`],
    ['credential.https://example.invalid.helper', marker => `!touch '${marker}'`],
    ['core.askPass', marker => marker],
    ['core.gitProxy', marker => `!touch '${marker}'`],
    ['http.proxy', () => 'http://127.0.0.1:9'],
    ['http.sslVerify', () => 'false'],
  ])('refuses a planted primary whose local config sets %s, and runs nothing', (key, value) => {
    const { dir, primary } = setup();
    try {
      const marker = join(dir, 'planted-ran');
      execFileSync('git', ['config', key, value(marker)], { cwd: primary });
      const runGit = vi.fn(execFileSync);
      const io = realSalvageIo({ repo: { branch: 'main', originUrl: join(dir, 'origin.git'), referencePath: primary, primaryPath: primary }, backupRoot: join(dir, 'backups'), runGit, accountHome: join(dir, 'home') });
      expect(() => io.remoteHeads()).toThrow(/lane-controlled transport/);
      expect(() => io.remoteSha('main')).toThrow(/lane-controlled transport/);
      expect(runGit.mock.calls.some(([, args]) => args.includes('ls-remote'))).toBe(false);
      expect(existsSync(marker), 'a planted primary helper ran').toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // The primary is the operator's own checkout: an upstream or fork remote there is normal, and the transport names
  // the canonical origin URL explicitly, so a remote under any other name cannot redirect it.
  it('accepts ordinary non-origin remotes (upstream, fork) in the primary for the release proof', () => {
    const { dir, primary, sha, io } = setup();
    try {
      execFileSync('git', ['remote', 'add', 'upstream', 'https://example.invalid/upstream/repo.git'], { cwd: primary });
      execFileSync('git', ['remote', 'add', 'fork', join(dir, 'fork.git')], { cwd: primary });
      execFileSync('git', ['config', 'remote.fork.pushurl', 'https://example.invalid/fork/repo.git'], { cwd: primary });
      expect(io.remoteHeads()).toEqual([sha]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // A remote NAMED like the canonical origin is what git resolves the explicit URL argument to: that stays refused.
  it.each(['url', 'pushurl', 'uploadpack'])('still refuses a primary remote aliasing the canonical origin (%s)', key => {
    const { dir, primary, io } = setup();
    try {
      execFileSync('git', ['config', `remote.${join(dir, 'origin.git')}.${key}`, join(dir, 'decoy.git')], { cwd: primary });
      expect(() => io.remoteHeads()).toThrow(/lane-controlled transport/);
      expect(() => io.remoteSha('main')).toThrow(/lane-controlled transport/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('still refuses a URL rewrite in the primary', () => {
    const { dir, primary, io } = setup();
    try {
      execFileSync('git', ['config', 'url.https://example.invalid/.insteadOf', '/'], { cwd: primary });
      expect(() => io.remoteHeads()).toThrow(/URL rewriting/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('real salvage preservation and transport', () => {
  const repo = { branch: 'main', originUrl: 'https://example.test/canonical.git', referencePath: 'reference' };
  describe.each(['local', 'worktree'])('%s signing configuration isolation', scope => {
    it.each(['gpg.ssh.defaultKeyCommand', 'gpg.program', 'push.gpgSign', 'user.signingKey',
      'commit.gpgSign', 'gpg.format', 'combined SSH signing payload'])(
      'refuses %s without executing a signer or publishing a ref', async key => {
        const dir = mkdtempSync(join(tmpdir(), 'salvage-signing-'));
        try {
          const lane = join(dir, 'lane'), origin = join(dir, 'origin.git');
          const marker = join(dir, 'signer-ran'), script = join(dir, 'signer.sh');
          writeFileSync(script, '#!/bin/sh\ntouch "$(dirname "$0")/signer-ran"\n', { mode: 0o700 });
          const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
          const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10000 });
          git(dir, ['init', '--bare', '-q', origin]);
          git(dir, ['init', '-q', '-b', 'main', lane]);
          const commit = message => git(lane, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test',
            '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', message]);
          commit('base');
          git(lane, ['-c', 'push.gpgSign=false', 'push', '-q', origin, 'HEAD:refs/heads/main']);
          git(lane, ['fetch', '-q', origin, 'refs/heads/main:refs/remotes/origin/main']);
          writeFileSync(join(lane, 'work.txt'), 'unique lane work\n');
          git(lane, ['add', 'work.txt']);
          commit('unpushed');
          const sha = git(lane, ['rev-parse', 'HEAD']).trim();
          const before = git(origin, ['for-each-ref', '--format=%(refname) %(objectname)']);
          if (scope === 'worktree') git(lane, ['config', 'extensions.worktreeConfig', 'true']);
          const config = {
            'gpg.ssh.defaultKeyCommand': script, 'gpg.program': script, 'push.gpgSign': 'true',
            'user.signingKey': script, 'commit.gpgSign': 'true', 'gpg.format': 'ssh',
          };
          const keys = key === 'combined SSH signing payload'
            ? ['push.gpgSign', 'gpg.format', 'gpg.ssh.defaultKeyCommand'] : [key];
          for (const setting of keys) git(lane, ['config', `--${scope}`, setting, config[setting]]);
          const runGit = (command, args, options) => execFileSync(command, args, {
            ...options, env: { ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
          });
          const io = realSalvageIo({ repo: { ...repo, originUrl: origin, referencePath: lane },
            backupRoot: join(dir, 'backups'), runGit });
          // Exercise the release/recovery entry and each shared transport boundary with real Git.
          const result = await salvagePushLane({ lane: 7, laneDir: lane, io, now: () => date });
          expect.soft(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/lane-controlled transport/i) });
          for (const operation of [() => io.unmatchedShas(lane, [sha]),
            () => io.push(lane, ref, sha), () => io.remoteSha(ref)]) {
            expect.soft(operation).toThrow(/lane-controlled transport.*inspect/i);
          }
          expect.soft(existsSync(marker)).toBe(false);
          expect.soft(git(origin, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(before);
          // Release scrubbing must not erase the refusal captured by preflight.
          const releaseIo = realSalvageIo({ repo: { ...repo, originUrl: origin, referencePath: lane },
            preflightLaneDir: lane, runGit });
          for (const setting of keys) git(lane, ['config', `--${scope}`, '--unset-all', setting]);
          expect.soft(() => releaseIo.push(lane, ref, sha)).toThrow(/lane-controlled transport/i);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
  });

  describe.each(['local', 'worktree'])('%s remote alias isolation', scope => {
    it.each([
      ['url', origin => origin],
      ['pushurl', origin => origin],
      ['url', origin => `${origin.toUpperCase()}.git/`],
      ['pushurl', origin => `${origin.toUpperCase()}.git/`],
      ['url', () => 'other'],
      ['fetch', () => 'Origin'],
      ['url', origin => `${origin}/\u2028quoted.with.dots`],
    ])('refuses alias %s configuration (case %#) before every transport', (setting, aliasFor) => {
      const dir = mkdtempSync(join(tmpdir(), 'salvage-remote-alias-'));
      try {
        const lane = join(dir, 'lane.git'), origin = join(dir, 'canonical');
        const otherRepo = join(dir, 'other.git');
        const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
        for (const path of [lane, origin, otherRepo]) git(dir, ['init', '--bare', '-q', path]);
        git(lane, ['config', 'remote.origin.url', origin]);
        if (scope === 'worktree') git(lane, ['config', 'extensions.worktreeConfig', 'true']);
        git(lane, ['config', `--${scope}`, `remote.${aliasFor(origin)}.${setting}`, otherRepo]);
        const commands = [];
        const io = realSalvageIo({ repo: { ...repo, originUrl: origin, referencePath: lane },
          runGit: (command, args, options) => {
            commands.push(args);
            // A failing regression must not leak even fixture commits to an alias.
            if (!args.includes('config')) throw new Error('unguarded transport reached');
            return execFileSync(command, args, { ...options,
              env: { ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
          } });
        for (const operation of [() => io.unmatchedShas(lane, [head]),
          () => io.push(lane, ref, head), () => io.remoteSha(ref)]) {
          expect(operation).toThrow(/lane-controlled transport.*inspect/i);
        }
        expect(commands.every(args => args.includes('config'))).toBe(true);
        expect(git(otherRepo, ['for-each-ref', '--format=%(refname)'])).toBe('');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('allows ordinary exact-origin URL and fetch configuration', () => {
      const runGit = vi.fn((_command, args) => args.includes('config')
        ? args.includes('--show-scope')
          ? `${scope}\0file:.git/config\0remote.origin.url\0${scope}\0file:.git/config\0remote.origin.fetch\0`
          : 'remote.origin.url\0remote.origin.fetch\0' : '');
      const io = realSalvageIo({ repo, runGit });
      expect(io.push(laneDir, ref, head)).toEqual({ ok: true });
      expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(true);
    });
  });

  it.each(['local', 'worktree'])('follows real %s includes before allowing any transport', scope => {
    const dir = mkdtempSync(join(tmpdir(), 'salvage-transport-config-'));
    try {
      const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git(['init', '-q']);
      const included = join(dir, 'transport.config'), sentinel = join(dir, 'helper-ran');
      // Git rejects LF in config keys; U+2028 is a valid subsection line separator.
      const key = 'credential.https://example.test/\u2028quoted.helper';
      git(['config', '--file', included, key, `!touch '${sentinel}'`]);
      expect(git(['config', '--file', included, '--null', '--name-only', '--list'])).toBe(`${key}\0`);
      if (scope === 'worktree') git(['config', 'extensions.worktreeConfig', 'true']);
      git(['config', `--${scope}`, 'include.path', included]);
      const commands = [];
      const io = realSalvageIo({ repo: { ...repo, referencePath: dir }, runGit: (command, args, options) => {
        commands.push(args);
        // A regression must fail without attempting a real network connection.
        if (!args.includes('config')) throw new Error('unguarded transport reached');
        return execFileSync(command, args, options);
      } });
      for (const operation of [() => io.unmatchedShas(dir, [head]),
        () => io.push(dir, ref, head), () => io.remoteSha(ref)]) {
        expect(operation).toThrow(/lane-controlled transport/);
      }
      expect(commands.every(args => args.includes('config'))).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  describe('unattended transport config regression', () => {
    it.each(['credential.helper', 'credential.https://example.test.helper', 'core.gitproxy',
      'core.askpass', 'http.proxy', 'http.https://example.test.extraheader',
      'credential.https://example.test/\nquoted.helper', 'https.proxy', 'remote.origin.proxy',
      'remote.other.vcs', 'core.sshcommand', 'ssh.variant', 'fetch.bundleuri'])(
      'refuses lane-controlled %s before every transport', key => {
        for (const scope of ['local', 'worktree']) {
          const runGit = vi.fn((_command, args) => args.includes('config')
            ? args.includes('--show-scope') ? `${scope}\0file:.git/config\0${key}\0` : `${key}\0` : '');
          const io = realSalvageIo({ repo, runGit });
          for (const operation of [() => io.unmatchedShas(laneDir, [head]),
            () => io.push(laneDir, ref, head), () => io.remoteSha(ref)]) {
            expect(operation).toThrow(/lane-controlled transport.*inspect/i);
          }
          expect(runGit.mock.calls.every(([, args]) => args.includes('config'))).toBe(true);
        }
      });

    it('retains a credential refusal observed before release scrubs the lane', async () => {
      let scrubbed = false;
      const runGit = vi.fn((_command, args) => {
        if (args.includes('config')) return scrubbed ? '' : args.includes('--show-scope')
          ? 'local\0file:.git/config\0credential.helper\0' : 'credential.helper\0';
        return args.includes('rev-list') ? head : '';
      });
      const io = realSalvageIo({ repo, runGit, preflightLaneDir: laneDir });
      scrubbed = true;
      expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({
        status: 'failed', reason: expect.stringMatching(/lane-controlled transport/i),
      });
      expect(runGit.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
    });

    it.each(['global', 'system'])('preserves operator transport credentials from %s scope', scope => {
      const runGit = vi.fn((_command, args) => args.includes('config')
        ? args.includes('--show-scope') ? `${scope}\0file:/operator/gitconfig\0credential.helper\0` : 'credential.helper\0' : '');
      const io = realSalvageIo({ repo, runGit });
      expect(io.push(laneDir, ref, head)).toEqual({ ok: true });
      expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(true);
    });

    it.each(['credential.helper', 'init.defaultbranch'])(
      'allows unknown scope from an absolute external toolchain file for %s', key => {
        const runGit = vi.fn((_command, args) => {
          if (args.includes('config')) return args.includes('--show-scope')
            ? `unknown\0file:${join(tmpdir(), 'toolchain', 'gitconfig')}\0${key}\0` : `${key}\0`;
          if (args.includes('--is-bare-repository')) return 'false';
          if (args.includes('--git-dir')) return `${resolve(laneDir, '.git')}\n${resolve(laneDir, '.git')}`;
          if (args.includes('--show-toplevel')) return resolve(laneDir);
          return '';
        });
        const io = realSalvageIo({ repo, runGit });
        expect(io.push(laneDir, ref, head)).toEqual({ ok: true });
        expect(runGit.mock.calls.find(([, args]) => args.includes('--show-scope'))[1]).toContain('--show-origin');
      });

    it.each([
      'file:relative/gitconfig', 'file:.git/config', `file:${resolve(laneDir, 'included.config')}`,
      `file:${resolve(laneDir, '.git', 'config')}`, 'command line:', 'blob:HEAD:config', 'standard input', '',
      `file:${resolve('separate-git', 'config')}`, `file:${resolve('separate-worktree', 'config')}`,
    ])('refuses unknown scope from untrusted origin %j before transport', origin => {
      const runGit = vi.fn((_command, args) => {
        if (args.includes('config')) return args.includes('--show-scope')
          ? `unknown\0${origin}\0credential.helper\0` : 'credential.helper\0';
        if (args.includes('--is-bare-repository')) return 'false';
        if (args.includes('--git-dir')) return `${resolve('separate-git')}\n${resolve('separate-git')}`;
        if (args.includes('--show-toplevel')) return resolve('separate-worktree');
        return '';
      });
      const io = realSalvageIo({ repo, runGit });
      expect(() => io.push(laneDir, ref, head)).toThrow('unknown transport config scope; inspect the lane manually');
      expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    });

    it.each(['', 'relative/gitdir', 'unreadable'])(
      'refuses unknown scope when repository path evidence is %j', evidence => {
        const runGit = vi.fn((_command, args) => {
          if (args.includes('config')) return args.includes('--show-scope')
            ? `unknown\0file:${join(tmpdir(), 'toolchain', 'gitconfig')}\0credential.helper\0` : 'credential.helper\0';
          if (evidence === 'unreadable') throw new Error('cannot read repository paths');
          return evidence;
        });
        const io = realSalvageIo({ repo, runGit });
        expect(() => io.push(laneDir, ref, head)).toThrow('unknown transport config scope; inspect the lane manually');
        expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
      });

    it('reads real Git scope/origin/key NUL triples and permits an external system file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'salvage-origin-layout-'));
      try {
        const lane = join(dir, 'lane'), system = join(dir, 'toolchain.gitconfig');
        writeFileSync(system, '[credential]\nhelper = osxkeychain\n[init]\ndefaultBranch = main\n');
        const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_SYSTEM: system, GIT_CONFIG_GLOBAL: '/dev/null' };
        execFileSync('git', ['init', '-q', lane], { env });
        const runGit = vi.fn((command, args, options) => {
          if (args.includes('push')) return ''; // Probe config and repo paths without transport.
          const output = execFileSync(command, args, { ...options, env: { ...options.env,
            GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_SYSTEM: system, GIT_CONFIG_GLOBAL: '/dev/null' } });
          if (!args.includes('--show-scope')) return output;
          const parts = output.split('\0');
          expect(parts.at(-1)).toBe('');
          expect((parts.length - 1) % 3).toBe(0);
          const records = [];
          for (let i = 0; i < parts.length - 1; i += 3) records.push(parts.slice(i, i + 3));
          expect(records).toContainEqual(['system', `file:${system}`, 'credential.helper']);
          // Reproduce Apple Git's toolchain scope while preserving real origin/key bytes.
          return records.map(([scope, origin, key]) =>
            `${origin === `file:${system}` ? 'unknown' : scope}\0${origin}\0${key}\0`).join('');
        });
        expect(realSalvageIo({ repo, runGit }).push(lane, ref, head)).toEqual({ ok: true });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it.each(['local\0file:.git/config\0credential.helper', 'local\0', 'local\0file:.git/config\0', 'mystery\0file:/operator/gitconfig\0credential.helper\0'])(
      'fails closed on incomplete or unknown config evidence %j', scoped => {
        const runGit = vi.fn((_command, args) => args.includes('--show-scope') ? scoped : '');
        const io = realSalvageIo({ repo, runGit });
        expect(() => io.push(laneDir, ref, head)).toThrow(/transport config.*inspect/);
        expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
      });
  });
  it.each(['insteadOf', 'pushInsteadOf', 'newline subsection'])(
    'refuses %s rewrites before fetch, push, and remote verification', key => {
      const runGit = vi.fn((_command, args) => args.includes('config')
        ? (key === 'newline subsection' ? 'url./untrusted\nremote.insteadof\0' : `url./untrusted/remote.${key.toLowerCase()}\0`) : '');
      const io = realSalvageIo({ repo, runGit });
      for (const operation of [() => io.unmatchedShas(laneDir, [head]),
        () => io.push(laneDir, ref, head), () => io.remoteSha(ref)]) {
        expect(operation).toThrow(/URL rewriting.*canonical origin/);
      }
      expect(runGit.mock.calls.some(([, args]) => args.some(arg => ['fetch', 'push', 'ls-remote'].includes(arg)))).toBe(false);
    });

  it('fails closed when the effective transport configuration cannot be read', () => {
    const runGit = vi.fn((_command, args) => {
      if (args.includes('config')) throw new Error('configuration unreadable');
      return '';
    });
    const io = realSalvageIo({ repo, runGit });
    expect(() => io.unmatchedShas(laneDir, [head])).toThrow(/configuration unreadable/);
    expect(runGit.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
  });

  it.each(['URL rewrite', 'unreadable config'])(
    'retains a pre-scrub %s refusal after lane config is cleaned', async failure => {
      let scrubbed = false;
      const runGit = vi.fn((_command, args) => {
        if (args.includes('config')) {
          if (scrubbed) return '';
          if (failure === 'unreadable config') throw new Error('configuration unreadable');
          return 'url./untrusted/remote.insteadof\0';
        }
        if (args.includes('rev-list')) return head;
        return '';
      });
      const io = realSalvageIo({ repo, preflightLaneDir: laneDir, runGit });
      scrubbed = true;
      expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({
        status: 'failed', reason: expect.stringMatching(failure === 'URL rewrite'
          ? /URL rewriting.*canonical origin/ : /configuration unreadable/),
      });
      expect(runGit.mock.calls.filter(([, args]) => args.includes('config'))).toHaveLength(1);
      expect(runGit.mock.calls.some(([, args]) => args.some(arg => ['fetch', 'push', 'ls-remote'].includes(arg)))).toBe(false);
    });

  it('still checks transport config when a rewrite appears after a clean preflight', () => {
    let rewritten = false;
    const runGit = vi.fn((_command, args) => args.includes('config') && rewritten
      ? 'url./untrusted/remote.pushinsteadof\0' : '');
    const io = realSalvageIo({ repo, preflightLaneDir: laneDir, runGit });
    rewritten = true;
    expect(() => io.push(laneDir, ref, head)).toThrow(/URL rewriting.*canonical origin/);
    expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
  });

  const SYMREF_LISTING = '--format=%(refname)%00%(symref)';
  const containsCalls = runGit => runGit.mock.calls.filter(([, args]) => args.includes('for-each-ref') && args.includes('--contains'));
  // A git dir that does not exist: no ref directory on the fetch paths is present, so none is a symlink.
  const NO_GIT_DIR = resolve(tmpdir(), 'salvage-push-no-such-git-dir');
  function realHarness({ cherry = `+ ${head}\n+ ${older}`, contains = '', symrefs = 'refs/remotes/origin/HEAD\0refs/remotes/origin/main\nrefs/remotes/origin/main\0', verifyRefs = '', gitDir = NO_GIT_DIR, fail } = {}) {
    const runGit = vi.fn((_command, args) => {
      if (fail && args.includes(fail)) throw new Error(`${fail} unavailable`);
      if (args.includes('rev-list')) return `${head}\n${older}`;
      if (args.includes('cherry')) return cherry;
      if (args.includes(SYMREF_LISTING)) return symrefs;
      if (args.includes('--git-common-dir')) return gitDir;
      if (args.includes('for-each-ref') && args.some(arg => arg.startsWith('refs/release-verify/'))) return verifyRefs;
      if (args.includes('for-each-ref')) return contains;
      return '';
    });
    return { runGit, io: realSalvageIo({ repo, runGit }) };
  }

  // PR #6319 send-back (R639): a fetch writes THROUGH a symbolic ref, so a lane-made tracking symref aimed at a local
  // branch would reset that branch. Every transport fetch refuses one before running; the ordinary origin/HEAD alias passes.
  it.each([
    ['refs/remotes/origin/main\0refs/heads/work/keep', 'refs/remotes/origin/main'],
    ['refs/remotes/origin/HEAD\0refs/heads/work/keep', 'refs/remotes/origin/HEAD'],
    ['refs/remotes/origin/HEAD\0refs/remotes/origin/HEAD', 'refs/remotes/origin/HEAD'],
    ['refs/remotes/origin/x\0refs/remotes/origin/main', 'refs/remotes/origin/x'],
  ])('refuses every fetch, before fetching, when the lane has the tracking symref %j', (symrefs, name) => {
    const { io, runGit } = realHarness({ symrefs });
    for (const operation of [() => io.fetchHeads(laneDir), () => io.fetchVerifyObjects(laneDir), () => io.unmatchedShas(laneDir, [head])]) {
      expect(operation).toThrow(new RegExp(`${name.replaceAll('/', '\\/')} is a symbolic ref`));
    }
    expect(runGit.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
  });
  // A filesystem symlink on a fetch's write path redirects it without any symbolic ref showing (PR #6319 self-review).
  it.each([
    ['refs/remotes/origin', 'dir'], ['refs/remotes', 'dir'], ['refs/remotes/origin/work', 'dir'], ['refs/remotes/origin/main', 'file'],
    ['refs/release-verify', 'dir'], ['logs/refs/remotes/origin/main', 'file'], ['logs/refs/release-verify', 'dir'], ['logs/refs', 'dir'],
  ])('refuses every fetch, before fetching, when %s is a filesystem symlink (%s)', (link, kind) => {
    const gitDir = mkdtempSync(join(tmpdir(), 'salvage-symlink-'));
    try {
      mkdirSync(join(gitDir, 'refs', 'remotes', 'origin'), { recursive: true });
      mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
      const target = join(gitDir, 'elsewhere');
      if (kind === 'dir') mkdirSync(target); else writeFileSync(target, `${head}\n`);
      rmSync(join(gitDir, link), { recursive: true, force: true });
      mkdirSync(join(gitDir, link, '..'), { recursive: true });
      symlinkSync(target, join(gitDir, link));
      const { io, runGit } = realHarness({ gitDir, symrefs: '' });
      for (const operation of [() => io.fetchHeads(laneDir), () => io.fetchVerifyObjects(laneDir), () => io.unmatchedShas(laneDir, [head])]) {
        expect(operation).toThrow(`${link} is a filesystem symlink`);
      }
      expect(runGit.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
    } finally { rmSync(gitDir, { recursive: true, force: true }); }
  });
  it('allows real ref directories and refuses an unreadable or relative git dir', () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'salvage-real-'));
    try {
      mkdirSync(join(gitDir, 'refs', 'remotes', 'origin', 'work'), { recursive: true });
      mkdirSync(join(gitDir, 'logs', 'refs', 'release-verify'), { recursive: true });
      writeFileSync(join(gitDir, 'refs', 'remotes', 'origin', 'work', 'x'), `${head}\n`);
      const { io, runGit } = realHarness({ gitDir, symrefs: '' });
      io.fetchHeads(laneDir);
      // The salvage fetch writes no FETCH_HEAD and runs no lane-configured maintenance (reflog expiry, gc, pack-refs).
      const fetchArgs = runGit.mock.calls.find(([, args]) => args.includes('fetch'))[1];
      expect(fetchArgs).toEqual(expect.arrayContaining(['--no-write-fetch-head', '--no-auto-maintenance', '--recurse-submodules=no']));
    } finally { rmSync(gitDir, { recursive: true, force: true }); }
    const relative = realHarness({ gitDir: '.git', symrefs: '' });
    expect(() => relative.io.fetchHeads(laneDir)).toThrow(/unreadable lane git dir/);
    expect(relative.runGit.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
  });
  it.each(['unreadable', 'malformed'])('refuses every fetch when the tracking symref listing is %s', failure => {
    const { io, runGit } = failure === 'unreadable' ? realHarness({ fail: SYMREF_LISTING })
      : realHarness({ symrefs: 'refs/remotes/origin/main\0refs/heads/a\0extra' });
    expect(() => io.fetchHeads(laneDir)).toThrow();
    expect(() => io.fetchVerifyObjects(laneDir)).toThrow();
    expect(runGit.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
  });
  it('fetchVerifyObjects fetches into a fresh private namespace with no FETCH_HEAD and deletes it without dereferencing', () => {
    let fetched = null;
    const runGit = vi.fn((_command, args, options) => {
      if (args.includes(SYMREF_LISTING)) return '';
      if (args.includes('--git-common-dir')) return NO_GIT_DIR;
      if (args.includes('fetch')) { fetched = args.find(arg => arg.startsWith('+refs/heads/*:')).split(':')[1].replace(/\/\*$/, ''); return ''; }
      if (args.includes('for-each-ref')) return fetched ? `${fetched}/main\n${fetched}/work/x` : '';
      if (args.includes('update-ref')) { expect(options.input).toBe(`option no-deref\ndelete ${fetched}/main\noption no-deref\ndelete ${fetched}/work/x\n`); }
      return '';
    });
    const io = realSalvageIo({ repo, runGit });
    io.fetchVerifyObjects(laneDir);
    expect(fetched).toMatch(/^refs\/release-verify\/[a-f0-9]{16}$/);
    const fetchArgs = runGit.mock.calls.find(([, args]) => args.includes('fetch'))[1];
    expect(fetchArgs).toEqual(expect.arrayContaining(['--no-write-fetch-head', '--no-auto-maintenance', '--no-tags', repo.originUrl, `+refs/heads/*:${fetched}/*`, '^refs/heads/ops/*']));
    expect(fetchArgs).not.toContain('--prune');
    expect(fetchArgs.some(arg => arg.includes('refs/remotes/'))).toBe(false);
    expect(runGit.mock.calls.filter(([, args]) => args.includes('update-ref'))).toHaveLength(1);
  });
  it('fetchVerifyObjects deletes its namespace even when the fetch fails, and refuses an occupied namespace', () => {
    let fetched = null;
    const runGit = vi.fn((_command, args) => {
      if (args.includes(SYMREF_LISTING)) return '';
      if (args.includes('--git-common-dir')) return NO_GIT_DIR;
      if (args.includes('fetch')) { fetched = args.find(arg => arg.startsWith('+refs/heads/*:')).split(':')[1].replace(/\/\*$/, ''); throw new Error('fetch died'); }
      if (args.includes('for-each-ref')) return fetched ? `${fetched}/main` : '';
      return '';
    });
    expect(() => realSalvageIo({ repo, runGit }).fetchVerifyObjects(laneDir)).toThrow('fetch died');
    expect(runGit.mock.calls.filter(([, args]) => args.includes('update-ref'))).toHaveLength(1);
    const { io, runGit: occupied } = realHarness({ verifyRefs: 'refs/release-verify/x/main' });
    expect(() => io.fetchVerifyObjects(laneDir)).toThrow(/already holds refs/);
    expect(occupied.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
  });

  it('fetches pruned branch refs and pushes/verifies against the explicit canonical URL with transport pins and hardened env', () => {
    const { io, runGit } = realHarness();
    io.aheadShas(laneDir);
    io.unmatchedShas(laneDir, [head, older]);
    io.push(laneDir, ref, head);
    io.remoteSha(ref);
    for (const command of ['fetch', 'push', 'ls-remote']) {
      const call = runGit.mock.calls.find(([, args]) => args.includes(command));
      expect(call).toBeDefined();
      const [, args, options] = call;
      expect(args).toEqual(expect.arrayContaining([
        '-c', 'remote.origin.uploadpack=git-upload-pack',
        '-c', 'remote.origin.receivepack=git-receive-pack', '-c', 'remote.origin.pushurl=', repo.originUrl,
        '-c', 'push.gpgSign=false', '-c', 'gpg.ssh.defaultKeyCommand=',
      ]));
      expect(LANE_GIT_CONFIG_PINS).toContainEqual(['push.gpgSign', 'false']);
      expect(args).not.toContain('origin');
      for (const [key, value] of LANE_GIT_CONFIG_PINS) {
        const index = Object.keys(options.env).find(k => /^GIT_CONFIG_KEY_\d+$/.test(k) && options.env[k] === key).replace('KEY', 'VALUE');
        expect(options.env[index]).toBe(value);
      }
    }
    const fetchArgs = runGit.mock.calls.find(([, args]) => args.includes('fetch'))[1];
    expect(fetchArgs).toEqual(expect.arrayContaining(['--recurse-submodules=no', '--prune', '--no-tags', '+refs/heads/*:refs/remotes/origin/*', '^refs/heads/ops/*']));
    const pushArgs = runGit.mock.calls.find(([, args]) => args.includes('push'))[1];
    expect(pushArgs.slice(pushArgs.indexOf('push'))).toEqual(['push', '--recurse-submodules=no', repo.originUrl, `${head}:refs/heads/${ref}`]);
    expect(runGit.mock.calls.findIndex(([, args]) => args.includes(SYMREF_LISTING)))
      .toBeLessThan(runGit.mock.calls.findIndex(([, args]) => args.includes('fetch')));
    expect(runGit.mock.calls.findIndex(([, args]) => args.includes('fetch')))
      .toBeLessThan(runGit.mock.calls.findIndex(([, args]) => args.includes('--contains')));
  });

  it('uses one integration-branch patch check and exact-SHA reachability without enumerating or capping remote refs', () => {
    const { io, runGit } = realHarness({ cherry: `- ${head}\n+ ${older}` });
    expect(io.unmatchedShas(laneDir, [head, older])).toEqual([older]);
    expect(runGit.mock.calls.filter(([, args]) => args.includes('cherry')).map(([, args]) => args))
      .toEqual([['cherry', 'origin/main', 'HEAD']]);
    expect(containsCalls(runGit).map(([, args]) => args))
      .toEqual([['for-each-ref', '--exclude=refs/remotes/origin/ops/*', '--contains', older, '--format=%(refname)\t%(symref)', 'refs/remotes/origin']]);
    expect(runGit.mock.calls.filter(([, args]) => args.includes(SYMREF_LISTING))).toHaveLength(1);
  });

  it('returns matched without pushing when the exact SHAs are reachable from remote branches', async () => {
    const { io, runGit } = realHarness({ contains: 'refs/remotes/origin/work/published' });
    expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({ status: 'matched', unmatched: [] });
    expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    expect(containsCalls(runGit)).toHaveLength(2);
  });

  it('does not accept a symbolic ref (such as one aimed at origin/ops) as reachability evidence', async () => {
    const { io, runGit } = realHarness({ contains: 'refs/remotes/origin/HEAD\trefs/remotes/origin/ops/ledger' });
    const result = await salvagePushLane({ lane: 7, laneDir, io });
    expect(result.status).not.toBe('matched');
  });

  it.each(['fetch', 'cherry', 'for-each-ref'])('fails closed without pushing when %s evidence is unreadable', async fail => {
    const { io, runGit } = realHarness({ fail });
    expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({ status: 'failed', reason: expect.stringContaining(fail) });
    expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
  });

  it.each([undefined, laneDir])('fails closed with an operator fallback when the canonical origin is unresolved (preflight %s)', async preflightLaneDir => {
    const runGit = vi.fn(() => head);
    const io = realSalvageIo({ repo: { ...repo, originUrl: null }, preflightLaneDir, runGit });
    expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({
      status: 'failed', reason: expect.stringContaining('supply --origin or a primary --reference'),
    });
    expect(runGit.mock.calls.map(([, args]) => args)).toEqual([['rev-list', 'origin/main..HEAD']]);
  });

  it('rejects every transport operation before reading config when the canonical origin is unresolved', () => {
    const runGit = vi.fn(() => { throw new Error('configuration unreadable'); });
    const io = realSalvageIo({ repo: { ...repo, originUrl: null }, preflightLaneDir: laneDir, runGit });
    for (const operation of [() => io.unmatchedShas(laneDir, [head]),
      () => io.push(laneDir, ref, head), () => io.remoteSha(ref)]) {
      expect(operation).toThrow('canonical origin unresolved; supply --origin or a primary --reference');
    }
    expect(runGit).not.toHaveBeenCalled();
  });
});

