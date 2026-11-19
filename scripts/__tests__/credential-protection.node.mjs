import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyBashCommand, readCredentialProtection, DEFAULT_CREDENTIAL_PROTECTION } from '../lib/credential-protection.mjs';
import { resolveCredentialProtection, loadCredentialProtection } from '../lib/credential-protection-settings.mjs';
import { credentialHook } from '../hooks/credential-read-deny.mjs';
import { withCredentialDeny, withoutCredentialDeny, credentialDenyStatus, syncCredentialDeny, credentialDenyRules, credentialHookEntry, main as bootstrapMain } from '../bootstrap-session.mjs';
import { gitleaksGuard, pushedRanges } from '../gitleaks-guard.mjs';

const options = { home: '/home/operator', repoRoot: '/repo' };
const deny = [
  'cat ~/.ssh/id_rsa', 'less ~/.gnupg/private', 'more ~/.aws/credentials',
  'head $HOME/.docker/config.json', 'tail ${HOME}/.kube/config',
  'cp ~/.netrc output', 'mv ~/.secrets output', 'tar czf out ~/.ssh',
  'zip out ~/.aws', 'base64 ~/.ssh/key', 'xxd ~/.ssh/key', 'od ~/.ssh/key',
  'strings ~/.ssh/key', 'openssl rsa -in ~/.ssh/key', 'ssh-keygen -y -f ~/.ssh/key',
  'grep token ~/.config/gh/hosts.yml', 'sed -n 1p ~/.netrc', 'awk 1 ~/.aws/config',
  `node -e "require('fs').readFileSync('/home/operator/.ssh/key')"`,
  `python3 -c "open('/home/operator/.netrc').read()"`,
  `ruby -e "File.read('/home/operator/.ssh/key')"`,
  'sort < ~/.netrc', 'echo $(<~/.ssh/key)', 'true && cat ~/.ssh/key',
  'true || cat ~/.ssh/key', 'true; cat ~/.ssh/key', 'cat ~/.ssh/key | head',
  'printf x | base64 ~/.ssh/key', 'git status; cat ~/.ssh/key',
  'ls ~/.ssh && cat ~/.ssh/key', 'ssh host $(cat ~/.ssh/key)',
  'git status < ~/.netrc', 'cat /home/operator/.aws/credentials',
  'cat .env', 'cat .env.local', 'cat config/.env.production', 'cat /repo/.env.local',
  'cat .envfoo', 'cat ~/.ssh/../.aws/credentials', `cat ~/'.ssh'/key`,
];
for (const command of deny) test(`denies content read: ${command}`, () => {
  const hit = classifyBashCommand(command, options);
  assert.equal(hit.decision, 'deny'); assert.ok(hit.path); assert.ok(hit.reason);
});
const allow = [
  'ssh host uptime', 'ssh -i ~/.ssh/id_rsa host uptime', 'ssh-add ~/.ssh/key',
  'git status', 'git -c core.sshCommand="ssh -i ~/.ssh/key" fetch', 'gh auth status',
  'scp -i ~/.ssh/key file host:file', 'rsync -e "ssh -i ~/.ssh/key" file host:file',
  'ls ~/.ssh', 'ls -la ~/.ssh', 'cat ~/.sshfoo', 'cat my.ssh/key',
  'cat .env.example', 'cat .env.sample', 'cat .env.template',
  'cat config/.env.example', 'cat /elsewhere/.env', 'echo hello',
];
for (const command of allow) test(`passes intended exception: ${command}`, () => assert.equal(classifyBashCommand(command, options).decision, 'pass'));
test('HOME containing spaces and quoted full path remain protected', () => {
  assert.equal(classifyBashCommand('cat "$HOME/.ssh/key"', { ...options, home: '/home/an operator' }).decision, 'deny');
});

test('invalid file uses strict defaults including required scanner', () => {
  for (const raw of ['', '{', 'null', '[]', '{"protectedPaths":[]}']) {
    const policy = readCredentialProtection(raw);
    assert.equal(policy.gitleaks.mode, 'require'); assert.equal(policy.protectedPaths.length, 9);
  }
  assert.equal(readCredentialProtection(JSON.stringify(DEFAULT_CREDENTIAL_PROTECTION)).gitleaks.mode, 'auto');
});
test('settings cascade logs effective values and sources; invalid evidence closes', () => {
  const logs = [];
  const result = resolveCredentialProtection({ platform: { gitleaks: { mode: 'require' } },
    tool: { gitleaks: { mode: 'off' } }, env: { WE_GITLEAKS_MODE: 'auto' }, log: l => logs.push(l) });
  assert.equal(result.settings.gitleaks.mode, 'auto'); assert.equal(result.sources.gitleaks, 'env');
  assert.match(logs.join(''), /\(env\)/);
  assert.equal(resolveCredentialProtection({ tool: { gitleaks: { mode: 'wrong' } } }).settings.gitleaks.mode, 'require');
  assert.equal(loadCredentialProtection({ read: () => { throw Error('unreadable'); }, readPlatform: () => ({ prefs: {}, errors: [] }), log: () => {} }).settings.gitleaks.mode, 'require');
  assert.equal(loadCredentialProtection({ read: () => '{}', readPlatform: () => ({ prefs: {}, errors: ['bad'] }), log: () => {} }).settings.gitleaks.mode, 'require');
});
test('hook denies agents and asks operator, with protected path and reason', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/key' } };
  for (const identity of [{ agent_id: 'worker' }, { agent_type: 'builder' }]) {
    const output = credentialHook({ ...input, ...identity }, { ...options, env: {} }).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny'); assert.match(output.permissionDecisionReason, /\.ssh.*SSH private/);
  }
  assert.equal(credentialHook(input, { ...options, env: { WE_CONVEYOR_WORKER: '1' } }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(credentialHook(input, { ...options, env: {} }).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(credentialHook({ ...input, tool_input: { command: 'ls ~/.ssh' } }, { ...options, env: {} }), null);
  for (const tool of ['Read', 'Edit', 'Write', 'NotebookEdit']) {
    assert.equal(credentialHook({ agent_id: 'a', tool_name: tool, tool_input: { file_path: '/home/operator/.netrc' } }, { ...options, env: {} }).hookSpecificOutput.permissionDecision, 'deny');
  }
});

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'credential-protection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('hook CLI fails closed on malformed matching input and oversized evidence; unrelated malformed input is silent', t => {
  const home = scratch(t);
  const invoke = input => spawnSync(process.execPath, ['scripts/hooks/credential-read-deny.mjs'], {
    input, env: { ...process.env, HOME: home, WE_CONVEYOR_WORKER: '1' }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(invoke('{invalid').stdout, '');
  assert.equal(JSON.parse(invoke('{"command":"cat ~/.ssh/key"').stdout).hookSpecificOutput.permissionDecision, 'deny');
  const huge = invoke(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, padding: 'x'.repeat(1024 * 1024) }));
  assert.match(JSON.parse(huge.stdout).hookSpecificOutput.permissionDecisionReason, /exceeds 1 MiB/);
});
test('merge preserves foreign rules/hooks, is idempotent, and uninstalls only owned entries', () => {
  const shared = credentialDenyRules()[0], entry = credentialHookEntry('/hooks');
  const before = { permissions: { allow: ['Read(src/**)'], deny: ['Read(foreign)', shared] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign' }] }, entry] } };
  const first = withCredentialDeny(before, { hooksDir: '/hooks' });
  const second = withCredentialDeny(first.settings, { hooksDir: '/hooks', ownership: first.ownership });
  assert.deepEqual(second.settings, first.settings); assert.deepEqual(second.diff, { rules: [], hooks: [] });
  assert.deepEqual(withoutCredentialDeny(second.settings, second.ownership), before);
  assert.deepEqual(before.permissions.deny, ['Read(foreign)', shared]);
  assert.ok(first.settings.permissions.deny.includes('Read(**/.env.*)'));
});
test('dry-run names exact missing rules, hook entry and deploy artifacts; check reports drift', () => {
  const result = credentialDenyStatus({ settings: {}, hooksDir: '/hooks', dryRun: true });
  assert.equal(result.status, 'planned'); assert.match(result.detail, /Read\(~\/\.ssh\/\*\*\)/);
  assert.match(result.detail, /Bash\|Read\|Edit\|Write\|NotebookEdit/); assert.match(result.detail, /credential-read-deny.mjs/);
  assert.equal(credentialDenyStatus({ settings: {} }).status, 'drift');
});
test('scratch installer deploys runnable hook; second install writes nothing; uninstall preserves foreign files/settings', t => {
  const home = scratch(t), hooksDir = join(home, '.plateau/hooks');
  let settings = { permissions: { deny: ['Read(foreign)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'foreign' }] }] } };
  const before = structuredClone(settings); let writes = 0;
  const invoke = extra => syncCredentialDeny({ settings, home, hooksDir, policy: DEFAULT_CREDENTIAL_PROTECTION,
    applySettings: next => { writes++; settings = next; }, ...extra });
  assert.equal(invoke({ dryRun: true }).status, 'planned'); assert.equal(existsSync(hooksDir), false);
  assert.equal(invoke({ write: true }).status, 'ok'); assert.equal(writes, 1);
  assert.equal(invoke({ write: true }).status, 'ok'); assert.equal(writes, 1);
  const result = spawnSync(process.execPath, [join(hooksDir, 'credential-read-deny.mjs')], {
    input: JSON.stringify({ agent_id: 'test', cwd: home, tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/key' } }),
    env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const hook = join(hooksDir, 'credential-read-deny.mjs'); writeFileSync(hook, '// operator changed');
  assert.equal(invoke({ write: true }).status, 'drift');
  assert.equal(invoke({ uninstall: true, dryRun: true }).status, 'planned'); assert.equal(writes, 1);
  assert.equal(invoke({ uninstall: true, write: true }).status, 'ok'); assert.deepEqual(settings, before);
  assert.equal(readFileSync(hook, 'utf8'), '// operator changed');
  assert.equal(existsSync(join(hooksDir, 'credential-protection.mjs')), false);
});
test('unreadable ownership and malformed settings refuse writes with recovery message', t => {
  const home = scratch(t), hooksDir = join(home, '.plateau/hooks'); mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'credential-protection-install.json'), '{');
  const result = syncCredentialDeny({ settings: {}, home, policy: DEFAULT_CREDENTIAL_PROTECTION, write: true, applySettings: () => assert.fail('must not write') });
  assert.equal(result.status, 'drift'); assert.match(result.detail, /repair/);
});
test('bootstrap routes credential step through injected IO for dry-run/check/uninstall', () => {
  const calls = [], io = { syncCredentialDeny: args => { calls.push(args); return { status: args.dryRun ? 'planned' : 'ok', detail: 'test' }; },
    readSettings: () => ({}), writeSettings: () => assert.fail('unexpected write'), uninstallHook: () => 'removed', out: () => {} };
  assert.equal(bootstrapMain(['uninstall', '--dry-run'], io), 0);
  assert.equal(calls[0].write, false); assert.equal(calls[0].dryRun, true);
});

const local = 'a'.repeat(40), remote = 'b'.repeat(40), zero = '0'.repeat(40);
test('pre-push uses every supplied range, all new-ref history, and skips deletions', () => {
  assert.deepEqual(pushedRanges(`refs/heads/a ${local} refs/heads/a ${remote}\nrefs/heads/b ${remote} refs/heads/b ${zero}\nrefs/heads/c ${zero} refs/heads/c ${local}`), [`${remote}..${local}`, remote]);
  assert.throws(() => pushedRanges('bad'), /invalid/);
  assert.throws(() => pushedRanges('x'.repeat(1024 * 1024 + 1)), /operator must inspect/);
  const args = [];
  assert.equal(gitleaksGuard({ phase: 'pre-push', input: `refs/heads/a ${local} refs/heads/a ${remote}`,
    find: () => '/scanner', run: (_bin, argv) => { args.push(argv); return { status: 0 }; } }), 0);
  assert.deepEqual(args, [['detect', '--redact', `--log-opts=${remote}..${local}`]]);
});
test('stub PATH covers scanner installed/clean, findings, missing auto/require, and off', t => {
  const dir = scratch(t), bin = join(dir, 'bin'); mkdirSync(bin);
  const logs = [], common = { phase: 'pre-commit', env: { PATH: bin }, log: line => logs.push(line) };
  assert.equal(gitleaksGuard(common), 0); assert.match(logs.join('\n'), /gitleaks not installed: secret scan SKIPPED.*\nInstall:/);
  assert.equal(gitleaksGuard({ ...common, mode: 'require' }), 1);
  writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\n[ "$1" = protect ] && [ "$2" = --staged ] && [ "$3" = --redact ]\n', { mode: 0o755 });
  assert.equal(gitleaksGuard(common), 0);
  writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\nexit 1\n'); assert.equal(gitleaksGuard(common), 1);
  assert.equal(gitleaksGuard({ ...common, mode: 'off', find: () => assert.fail('disabled scanner must not run') }), 0);
  assert.match(logs.at(-1), /disabled/);
  assert.equal(gitleaksGuard({ ...common, phase: 'pre-push', input: 'broken' }), 1);
});
