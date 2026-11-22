// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { defaultResolvedSideBranchIo, runResolvedSideBranchPass } from '../resolved-side-branch-push.mjs';
import { defaultReverifyIo, normalLanePush } from '../load-flake-reverify.mjs';
import { AUTOMATION_LOGINS, buildConcurrentAuthorPauseComment, standDownComments } from '../stand-down.mjs';
import { pushGuardDecision } from '../../guard-git-push.mjs';

const H = '1'.repeat(40), B = '2'.repeat(40), S = '3'.repeat(40), T = '4'.repeat(40);
const repo = 'web-everything/web-everything', name = 'lane/topic-fix-7329-alt';
const author = { login: AUTOMATION_LOGINS[0] };
const pr = { number: 7329, state: 'OPEN', isCrossRepository: false, headRefName: 'lane/topic', headRefOid: H,
  baseRefName: 'main', baseRefOid: B, comments: [{ body: buildConcurrentAuthorPauseComment({ head: H, alt: name, altSha: S }), author }] };
const candidate = { name, sha: S, ancestors: [S, H, B] };
const safeConfig = 'local\0core.hookspath\0command\0credential.helper\0command\0http.extraheader\0command\0credential.https://github.com.helper\0';
function fixture(overrides = {}) {
  const order = [];
  const lane = { path: '/fixture/lane', lane: 9, holder: 'saved-repair' };
  const reverifyIo = { loadavg: () => [1, 1], cpuCount: () => 16, admission: vi.fn(() => ({ verdict: 'admit' })),
    prepare: vi.fn(() => order.push('prepare')), acquire: vi.fn(() => { order.push('acquire'); return lane; }),
    head: vi.fn(() => S), resolveSha: vi.fn(() => S), verify: vi.fn(() => { order.push('verify'); return { ok: true }; }),
    push: vi.fn(() => order.push('push')), release: vi.fn(() => order.push('release')), ...overrides };
  const io = defaultResolvedSideBranchIo({ env: {}, reverifyIo, log: vi.fn() });
  return { io, reverifyIo, order, lane, args: { repo, pr, candidate, token: 'ghs_app' } };
}
it('green normal verify acquires the exact saved SHA, pushes only from its lane with expected PR head, then releases', async () => {
  const f = fixture(), prepared = await f.io.preparePush(f.args);
  expect(prepared.verification).toEqual({ sha: S, status: 'green' });
  expect(f.reverifyIo.prepare).toHaveBeenCalledWith(repo, name, pr.headRefName);
  expect(f.reverifyIo.acquire).toHaveBeenCalledWith(S, pr.number);
  expect(f.reverifyIo.verify).toHaveBeenCalledWith(f.lane.path);
  await prepared.push({ expectedHead: H }); await prepared.close();
  expect(f.reverifyIo.push).toHaveBeenCalledWith(f.lane.path, S, pr.headRefName, expect.objectContaining({ expectedHead: H }));
  expect(f.order).toEqual(['prepare', 'acquire', 'verify', 'push', 'release']);
});
it.each([{ ok: false }, undefined, { ok: 'true' }])('red or unreadable verify (%j) releases and escalates with no push or repair handoff', async verification => {
  const f = fixture({ verify: vi.fn(() => verification) });
  const escalate = vi.fn();
  const io = { ...f.io, listPrs: () => [pr], readPr: () => pr, readBranches: () => [candidate],
    acquireClaim: () => ({ ok: true }), checkClaim: () => true, releaseClaim: vi.fn(), appToken: () => 'ghs_app',
    escalate, protect: vi.fn(), record: vi.fn() };
  expect((await runResolvedSideBranchPass({ repo }, io))[0].result).toBe('refused');
  expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'verify-not-green' }));
  expect(f.reverifyIo.push).not.toHaveBeenCalled(); expect(io.protect).not.toHaveBeenCalled();
  expect(f.reverifyIo.release).toHaveBeenCalledWith(f.lane);
});
it.each(['wait', 'hold', 'deny', undefined])('load admission %s defers without acquiring, verifying or pushing', async verdict => {
  const f = fixture({ admission: () => ({ verdict }) });
  await expect(f.io.preparePush(f.args)).rejects.toMatchObject({ code: 'host-load' });
  expect(f.reverifyIo.acquire).not.toHaveBeenCalled(); expect(f.reverifyIo.verify).not.toHaveBeenCalled(); expect(f.reverifyIo.push).not.toHaveBeenCalled();
});
it('legacy high load also defers, even in CI reverify mode', async () => {
  const f = fixture({ admission: () => undefined, loadavg: () => [100, 100] });
  await expect(f.io.preparePush(f.args)).rejects.toMatchObject({ code: 'host-load' });
  expect(f.reverifyIo.prepare).not.toHaveBeenCalled();
});
it.each(['acquired', 'verified', 'push'])('moved lane head at %s is refused and released', async phase => {
  const f = fixture();
  f.reverifyIo.head.mockReturnValueOnce(phase === 'acquired' ? T : S).mockReturnValueOnce(phase === 'verified' ? T : S).mockReturnValue(T);
  if (phase === 'push') { const prepared = await f.io.preparePush(f.args); await expect(prepared.push({ expectedHead: H })).rejects.toThrow(/head moved/); await prepared.close(); }
  else await expect(f.io.preparePush(f.args)).rejects.toThrow(/head/);
  expect(f.reverifyIo.push).not.toHaveBeenCalled(); expect(f.reverifyIo.release).toHaveBeenCalledOnce();
});
it('normal lane push executes the repository hook chain; a changed advertised PR head is rejected', () => {
  const root = resolve('.'), scratch = mkdtempSync(join(tmpdir(), 'saved-hook-'));
  try {
    // Only the lease read is stubbed; execute both real repository guards via the real pre-push script.
    writeFileSync(join(scratch, 'git'), '#!/bin/sh\nprintf "%s\\n" "$WE_TEST_LEASE_PATH"\n', { mode: 0o755 });
    const calls = [], env = { ...process.env, PATH: `${scratch}:${process.env.PATH}`, WE_TEST_LEASE_PATH: join(scratch, 'missing-lease'), WE_SAVED_PUSH_REPO: repo };
    let advertised = H;
    const command = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (args[0] === 'config') return args.includes('--list') ? safeConfig : '.githooks';
      if (args[0] === 'rev-parse') return S;
      return execFileSync('/bin/sh', ['.githooks/pre-push'], { cwd: root, env: opts.env, input: `HEAD ${S} refs/heads/${pr.headRefName} ${advertised}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    };
    const push = () => normalLanePush({ cwd: root, root, sha: S, branch: pr.headRefName, expectedHead: H, env, command });
    expect(push).not.toThrow(); advertised = T; expect(push).toThrow(/destination\/head changed/);
    const pushes = calls.filter(c => c.args[0] === 'push'); expect(pushes).toHaveLength(2);
    for (const c of pushes) {
      expect(c.opts.cwd).toBe(root);
      expect(c.args).toEqual(['push', `https://github.com/${repo}.git`, `${S}:refs/heads/${pr.headRefName}`]);
      expect(c.args.join(' ')).not.toMatch(/--no-verify|core.hooksPath|--force/);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
it.each(['', 'malformed', `HEAD ${S} refs/heads/lane/other ${H}`, `HEAD ${S} refs/heads/lane/topic ${H}\nHEAD ${S} refs/heads/lane/topic ${H}`])('expected-head guard fails closed on incomplete or extra ref payload %s', payload => {
  expect(pushGuardDecision(payload, { override: true, expectedPush: { head: H, sha: S, ref: 'refs/heads/lane/topic' } })).toMatch(/BLOCKED/);
});
it('default verify retains sanitized environment and bounds, including explicit injected environment', async () => {
  const runVerification = vi.fn();
  const io = defaultReverifyIo({ runVerification, env: { PATH: '/usr/bin:/bin', GH_TOKEN: 'ghs_secret', GIT_CONFIG_PARAMETERS: 'evil', WE_RESOLVED_PUSH_TOKEN: 'ghs_secret' } });
  expect(await io.verify('/fixture/lane')).toEqual({ ok: true });
  const opts = runVerification.mock.calls[0][2];
  expect(opts.env.GH_TOKEN).toBeUndefined(); expect(opts.env.WE_RESOLVED_PUSH_TOKEN).toBeUndefined(); expect(opts.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  expect(opts.timeoutMs).toBe(40 * 60_000); expect(opts.maxBytes).toBe(16 * 1024 * 1024);
});
it('actual escalation publishes a head-bound stand-down, then emits fix-question-asked; failed publication emits no event', async () => {
  const order = [], comments = [], questionEvent = vi.fn(() => order.push('question'));
  let fail = false;
  const exec = (_bin, args) => {
    if (args.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: comments.length } } } } });
    const endpoint = args.find(a => a.startsWith('repos/'));
    if (args.includes('POST')) {
      if (fail) throw Error('publication failed');
      const body = args.find(a => a.startsWith('body=')).slice(5); const c = { id: 1, node_id: 'IC_question', body, user: { login: AUTOMATION_LOGINS[0] } };
      comments.push({ ...c, author: c.user }); order.push('comment'); return JSON.stringify(c);
    }
    if (endpoint.endsWith('/comments?per_page=100&page=1')) return JSON.stringify(comments);
    if (endpoint.includes('/comments')) return JSON.stringify(comments);
    return JSON.stringify({ number: pr.number, state: 'open', head: { sha: H, ref: pr.headRefName, repo: { full_name: repo } }, base: { sha: B, ref: 'main', repo: { full_name: repo } } });
  };
  const io = defaultResolvedSideBranchIo({ exec, ghBin: '/usr/bin/gh', tokenForRepo: () => 'ghs_app', questionEvent });
  const args = { repo, pr, candidate, reason: 'host-load' };
  await io.escalate(args); expect(order).toEqual(['comment', 'question']);
  expect(standDownComments(comments, { headRefOid: H })).toHaveLength(1);
  expect(questionEvent).toHaveBeenCalledWith({ repo, pr: pr.number, head: H });
  await io.escalate(args); expect(questionEvent).toHaveBeenCalledOnce();
  comments.length = 0; fail = true;
  await expect(io.escalate(args)).rejects.toThrow(); expect(questionEvent).toHaveBeenCalledOnce();
});

it.each([false, true])('green lane verification passes actual previous-head CI admission with pushBeforeGate=%s', pushBeforeGate => {
  const calls = [];
  const exec = (_bin, args, opts) => {
    calls.push({ args, opts });
    const endpoint = args.at(-1);
    if (endpoint.includes('/rules/branches/')) return JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }]);
    if (endpoint.includes('/branches/main')) return JSON.stringify({ name: 'main', protected: false });
    if (endpoint.includes('/check-runs')) return JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', head_sha: H }] });
    if (endpoint.includes('/status?')) return JSON.stringify({ total_count: 0, statuses: [] });
    throw Error('unexpected API');
  };
  const io = defaultResolvedSideBranchIo({ exec, ghBin: '/usr/bin/gh', tokenForRepo: () => 'ghs_app', log: vi.fn(),
    env: { WE_FIX_PUSH_BEFORE_GATE: String(pushBeforeGate), WE_FIX_PUSH_AFTER_CI: 'true' } });
  expect(io.admitPush({ repo, pr, candidate, verification: { sha: S, status: 'green' } })).toBe(true);
  expect(calls).toHaveLength(4);
  for (const c of calls) expect(c.opts.throttle).toMatchObject({ personalRoute: false, retries: 0 });
});
it('unreadable required CI and oversized CI pagination name operator recovery and never admit a push', () => {
  const args = { repo, pr, candidate, verification: { sha: S, status: 'green' } };
  const io = defaultResolvedSideBranchIo({ exec: () => 'null', ghBin: '/usr/bin/gh', tokenForRepo: () => 'ghs_app', log: vi.fn() });
  expect(() => io.admitPush(args)).toThrow();
  const exec = vi.fn(() => JSON.stringify(Array.from({ length: 100 }, () => ({}))));
  const oversized = defaultResolvedSideBranchIo({ exec, ghBin: '/usr/bin/gh', tokenForRepo: () => 'ghs_app', log: vi.fn() });
  expect(() => oversized.admitPush(args)).toThrow(/pagination incomplete.*operator/);
  expect(exec.mock.calls.filter(([, argv]) => argv.at(-1).includes('/rules/'))).toHaveLength(8);
});

it('default reverify normalPush selects the lane command with hooks enabled and the pinned destination', () => {
  const root = resolve('.'), run = vi.fn((_bin, args) => args[0] === 'config' ? args.includes('--list') ? safeConfig : '.githooks' : args[0] === 'rev-parse' ? S : '');
  const io = defaultReverifyIo({ run, root, normalPush: true });
  io.push(root, S, pr.headRefName, { expectedHead: H, env: { WE_SAVED_PUSH_REPO: repo } });
  const call = run.mock.calls.find(([, args]) => args[0] === 'push');
  expect(call[1]).toEqual(['push', `https://github.com/${repo}.git`, `${S}:refs/heads/${pr.headRefName}`]);
  expect(call[2]).toMatchObject({ cwd: root, env: { WE_SAVED_PUSH_HEAD: H, WE_SAVED_PUSH_SHA: S, WE_SAVED_PUSH_REF: 'refs/heads/lane/topic' } });
  expect(run.mock.calls.flatMap(([, args]) => args).join(' ')).not.toMatch(/--no-verify|core.hooksPath=|--force/);
});
it.each(['wrong-path', 'changed-hook', 'non-executable', 'owner-not-executable'])('normal push refuses %s repository hooks instead of repairing, replacing or bypassing them', variant => {
  const root = resolve('.'), cwd = mkdtempSync(join(tmpdir(), 'saved-hooks-'));
  try {
    for (const dir of ['.githooks', 'scripts/lib']) mkdirSync(join(cwd, dir), { recursive: true });
    for (const path of ['.githooks/pre-push', 'scripts/guard-git-push.mjs', 'scripts/guard-prototype-tracker.mjs', 'scripts/lib/lane-lease.mjs']) copyFileSync(join(root, path), join(cwd, path));
    if (variant === 'changed-hook') writeFileSync(join(cwd, '.githooks/pre-push'), '#!/bin/sh\nexit 0\n');
    if (variant === 'non-executable') chmodSync(join(cwd, '.githooks/pre-push'), 0o644);
    if (variant === 'owner-not-executable') chmodSync(join(cwd, '.githooks/pre-push'), 0o641);
    const command = vi.fn((_bin, args) => args.includes('--list') ? safeConfig : variant === 'wrong-path' ? '/dev/null' : '.githooks');
    expect(() => normalLanePush({ cwd, root, sha: S, branch: pr.headRefName, expectedHead: H, env: { WE_SAVED_PUSH_REPO: repo }, command })).toThrow(/hooks|hook/);
    expect(command.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
    expect(command.mock.calls.some(([, args]) => args.includes('-c'))).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('successful push recording first hands the exact repaired head to the ordinary CI/size admission', () => {
  const order = [], markPush = vi.fn(() => order.push('ci'));
  const io = defaultResolvedSideBranchIo({ markPush, record: () => order.push('record') });
  io.record({ repo, pr: pr.number, sha: S, head: H, branch: name });
  expect(markPush).toHaveBeenCalledWith({ repo, pr: pr.number, head: S }, expect.objectContaining({ run: expect.any(Function), readRequired: expect.any(Function), readNumstat: expect.any(Function) }));
  expect(order).toEqual(['ci', 'record']);
});

it.each([
  ['URL rewrite planted by verification', 'url.https://attacker.invalid/.insteadOf', 'https://github.com/'],
  ['push URL rewrite', 'url.https://attacker.invalid/.pushInsteadOf', 'https://github.com/'],
  ['credential helper', 'credential.helper', '!printf stolen'],
  ['HTTP proxy', 'http.proxy', 'https://attacker.invalid'],
  ['URL-specific headers', 'http.https://github.com/.extraHeader', 'Authorization: attacker'],
  ['SSH transport command', 'core.sshCommand', 'attacker-command'],
  ['remote URL alias', `remote.https://github.com/${repo}.git.url`, 'https://attacker.invalid/repo'],
])('hostile lane configuration: %s refuses before any attacker request or credential delivery', (_label, key, value) => {
  const cwd = mkdtempSync(join(tmpdir(), 'saved-hostile-config-')), delivered = join(cwd, 'credential-delivered');
  const env = { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  try {
    execFileSync('/usr/bin/git', ['init', '--quiet', cwd], { env });
    execFileSync('/usr/bin/git', ['config', '--local', key, value], { cwd, env });
    // Record a canary delivery if the denied transport boundary is ever reached.
    const attackerRequest = vi.fn(() => { writeFileSync(delivered, 'ghs_fixture'); }), command = vi.fn((bin, args, opts) => {
      if (args[0] === 'push') return attackerRequest(); // never execute a network transport in this fixture
      return execFileSync('/usr/bin/git', args, { ...opts, env, encoding: 'utf8' });
    });
    expect(() => normalLanePush({ cwd, root: resolve('.'), sha: S, branch: pr.headRefName, expectedHead: H, env: { WE_SAVED_PUSH_REPO: repo }, command })).toThrow(/transport configuration.*operator inspection/);
    expect(command.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
    expect(attackerRequest).not.toHaveBeenCalled(); expect(existsSync(delivered)).toBe(false);
    expect(command.mock.calls[0][2].maxBuffer).toBe(256 * 1024);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
it('worktree configuration and included URL rewrites are refused after verification', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'saved-worktree-config-'));
  const env = { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  try {
    execFileSync('/usr/bin/git', ['init', '--quiet', cwd], { env });
    execFileSync('/usr/bin/git', ['config', '--local', 'extensions.worktreeConfig', 'true'], { cwd, env });
    execFileSync('/usr/bin/git', ['config', '--worktree', 'url.https://attacker.invalid/.insteadOf', 'https://github.com/'], { cwd, env });
    const command = vi.fn((_bin, args, opts) => execFileSync('/usr/bin/git', args, { ...opts, env, encoding: 'utf8' }));
    const push = () => normalLanePush({ cwd, root: resolve('.'), sha: S, branch: pr.headRefName, expectedHead: H, env: { WE_SAVED_PUSH_REPO: repo }, command });
    expect(push).toThrow(/transport configuration.*operator inspection/);
    expect(command.mock.results[0].value).toContain('worktree\0url.');
    execFileSync('/usr/bin/git', ['config', '--worktree', '--unset-all', 'url.https://attacker.invalid/.insteadOf'], { cwd, env });
    const included = join(cwd, 'included-config'); writeFileSync(included, '[url "https://attacker.invalid/"]\n  insteadOf = https://github.com/\n');
    execFileSync('/usr/bin/git', ['config', '--local', 'include.path', included], { cwd, env });
    expect(push).toThrow(/transport configuration.*operator inspection/);
    expect(command.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
it.each(['local\0url.https://attacker.invalid/\ncore.safe.insteadof\0', '', 'local\0', 'unknown\0core.safe\0', 'local\0core.safe', 'local\0core.safe\0'.repeat(20000), null])('unsafe, incomplete, unknown or oversized transport configuration fails closed (%#)', output => {
  const command = vi.fn(() => output);
  expect(() => normalLanePush({ cwd: resolve('.'), root: resolve('.'), sha: S, branch: pr.headRefName, expectedHead: H, env: { WE_SAVED_PUSH_REPO: repo }, command })).toThrow(/operator inspection/);
  expect(command).toHaveBeenCalledOnce();
});
it('unreadable effective transport configuration never reaches push', () => {
  const command = vi.fn(() => { throw Error('configuration unreadable'); });
  expect(() => normalLanePush({ cwd: resolve('.'), root: resolve('.'), sha: S, branch: pr.headRefName, expectedHead: H, env: { WE_SAVED_PUSH_REPO: repo }, command })).toThrow(/unreadable/);
  expect(command).toHaveBeenCalledOnce();
});
it('App credential helper supplies credentials to HTTPS github.com only, never an attacker URL or HTTP', () => {
  const calls = [], exec = (_bin, args) => { calls.push(args); return ''; };
  defaultResolvedSideBranchIo({ exec, tokenForRepo: () => 'ghs_fixture', log: vi.fn() }).readBranches(pr, repo);
  const args = calls[0].slice(0, calls[0].indexOf('init'));
  expect(args.some(arg => arg.startsWith('credential.https://github.com.helper='))).toBe(true);
  const cwd = mkdtempSync(join(tmpdir(), 'saved-credential-scope-'));
  try {
    const env = { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', WE_RESOLVED_PUSH_TOKEN: 'ghs_fixture' };
    for (const [protocol, host, allowed] of [['https', 'github.com', true], ['https', 'attacker.invalid', false], ['http', 'github.com', false], ['https', 'github.com.attacker.invalid', false]]) {
      const result = spawnSync('/usr/bin/git', [...args, 'credential', 'fill'], { cwd, env, input: `protocol=${protocol}\nhost=${host}\n\n`, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
      expect(result.status).toBe(allowed ? 0 : 128);
      expect(result.stdout.includes('ghs_fixture')).toBe(allowed);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
