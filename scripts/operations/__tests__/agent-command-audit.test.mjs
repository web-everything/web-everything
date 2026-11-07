// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCommand, redact, auditLines } from '../agent-command-audit.mjs';

const queue = 'node scripts/readiness/heavy-admission.mjs run -- ';
const claude = (command, timestamp = '2026-07-02T04:30:00Z') => JSON.stringify({ timestamp, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const codex = (args, name = 'exec_command') => JSON.stringify({ timestamp: '2026-07-02T04:30:00Z', payload: { type: 'function_call', name, arguments: JSON.stringify(args) } });

describe('agent command audit', () => {
  it.each(['pnpm exec playwright test a', 'yarn playwright test a'])('classifies package runner %s', command => {
    expect(classifyCommand(command)).toEqual([expect.objectContaining({ category: 'playwright', queued: false })]);
  });
  it.each(['npm run check:standards-extra', 'npm run test:unit-extra'])('does not admit a script-name prefix: %s', command => {
    expect(classifyCommand(command).some(row => row.queued)).toBe(false);
  });
  it('CLI includes requested-day commands from a resumed session in an earlier date directory', () => {
    const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'agent-command-audit-'));
    try {
      mkdirSync(join(home, '.claude/projects'), { recursive: true });
      const sessionDir = join(home, '.codex/sessions/2026/06/15');
      mkdirSync(sessionDir, { recursive: true });
      const earlier = JSON.parse(codex({ cmd: 'npm ci' }));
      earlier.timestamp = '2026-06-15T12:00:00Z';
      const later = JSON.parse(codex({ cmd: 'npm ci' }));
      later.timestamp = '2026-07-03T04:00:00Z';
      writeFileSync(join(sessionDir, 'resumed.jsonl'), [
        JSON.stringify(earlier),
        codex({ cmd: 'npx vitest run resumed.test.mjs' }),
        codex({ cmd: queue + 'npx playwright test resumed.spec.mjs' }),
        JSON.stringify(later),
      ].join('\n') + '\n');
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../agent-command-audit.mjs', import.meta.url)),
        '--date=2026-07-02', `--home=${home}`, '--json',
      ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.files).toBe(1);
      expect(report.rows).toHaveLength(2);
      expect(report.byCategory).toEqual({
        vitest: { queued: 0, bypassed: 1 },
        playwright: { queued: 1, bypassed: 0 },
      });
      expect(report.bySource).toEqual({
        'codex:.codex/sessions/2026/06/15/resumed.jsonl': { queued: 1, bypassed: 1 },
      });
      expect(report.invalidLines).toBe(0);
      expect(report.errors).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it.each([
    ['for f in a b; do npx vitest run "$f"; done', 'vitest'],
    ['while read f; do npx vitest run $f; done < l', 'vitest'],
    ['if true; then npx vitest run a; fi', 'vitest'],
    ['gtimeout 5 npx vitest run a', 'vitest'],
    ['env -i X=1 timeout 5 npx vitest run a', 'vitest'],
    ["bash -lc 'npx vitest run a'", 'vitest'],
    ['timeout 290 npx vitest run a.test.mjs 2>&1 | tail -15', 'vitest'],
    ['timeout 5 npx playwright test a', 'playwright'],
    ['timeout 5 node --test a', 'node --test'],
    ['gtimeout 5 node scripts/check-standards.mjs', 'check:standards'],
    ['npm test -- a', 'npm test/check'], ['npm ci', 'install/ci'],
    ['git fetch origin', 'git fetch/clone/wt/gc'], ['rg needle .', 'repo-wide find/grep'],
  ])('classifies bypass %s', (cmd, category) => {
    expect(classifyCommand(cmd)).toEqual([expect.objectContaining({ category, queued: false })]);
  });
  it('keeps admission local to a segment, including inside a loop', () => {
    expect(classifyCommand(`for f in a; do ${queue}npx vitest run "$f"; done; npx vitest run b`).map(r => r.queued)).toEqual([true, false]);
    expect(classifyCommand('npm run test:unit -- a')[0].queued).toBe(true);
    expect(classifyCommand('npm run check:standards')[0].queued).toBe(true);
    expect(classifyCommand(queue + "bash -c 'npx vitest run a | tail -15'")[0].queued).toBe(true);
  });
  it.each(['echo npx vitest run', 'grep vitest x', 'rg needle scripts', 'rg --files scripts', 'find ./src -name x', 'npx vitest --version', 'git commit -m "npx vitest run"'])('ignores harmless mention %s', cmd => {
    expect(classifyCommand(cmd)).toEqual([]);
  });
  it('counts Claude and Codex JSONL by category and source, redacting output', () => {
    const fake = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = auditLines([
      claude(`npx vitest run a --token=${fake}`),
      codex({ cmd: queue + 'npx playwright test a' }),
      codex({ command: ['node', '--test', 'a'] }, 'local_shell'),
      JSON.stringify({ timestamp: '2026-07-02T04:30:00Z', payload: { type: 'custom_tool_call', name: 'functions.exec', input: 'await tools.exec_command({cmd: "npm ci"})' } }),
    ], { date: '2026-07-02' });
    expect(result.byCategory.vitest).toEqual({ queued: 0, bypassed: 1 });
    expect(result.byCategory.playwright).toEqual({ queued: 1, bypassed: 0 });
    expect(result.bySource).toEqual({ claude: { queued: 0, bypassed: 1 }, codex: { queued: 1, bypassed: 2 } });
    expect(JSON.stringify(result)).not.toContain(fake);
  });
  it.each([
    'ghp_abcdefghijklmnopqrstuvwxyz', 'github_pat_abcdefghijklmnopqrstuvwxyz',
    'sk-abcdefghijklmnopqrstuvwxyz', 'xoxb-abcdefghijklmnopqrstuvwxyz', 'Bearer fake.credentials',
    'API_KEY="short value"', 'TOKEN=short', "SECRET='short value'", 'tokenSensitive',
    '0123456789abcdef0123456789abcdef', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/abcdEFGH==',
  ])('redacts credential form %s', value => expect(redact(value)).toBe('[REDACTED]'));
  // Red-team #6461: a credential option's separate value must not survive when only the name is redacted.
  const fakeGl = 'glpat-12345678901234567890';
  it.each([
    `--token ${fakeGl}`, `--token=${fakeGl}`, `--token "${fakeGl}"`, `--token '${fakeGl}'`, `--token\t${fakeGl}`,
    `--auth-token ${fakeGl}`, `--access-token ${fakeGl}`, `--api-key ${fakeGl}`, `--apikey ${fakeGl}`,
    `--password ${fakeGl}`, `--passwd ${fakeGl}`, `--secret ${fakeGl}`, `--client-secret ${fakeGl}`,
    `--credentials ${fakeGl}`, `--private-key ${fakeGl}`, `--"token" ${fakeGl}`, `--to''ken ${fakeGl}`,
    `PASSWORD=${fakeGl}`, `GITLAB_AUTH=${fakeGl}`, fakeGl, 'gho_abcdefghijklmnopqrstuvwxyz', 'ghs_abcdefghijklmnopqrstuvwxyz',
    'npm_abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP',
    `-H 'Authorization: token ${fakeGl}'`, `--header "Authorization: Basic ${fakeGl}"`,
    `https://user:${fakeGl}@example.com/x.git`,
  ])('redacts the value of credential form %s', value => {
    const out = redact(`npx vitest run a.test.mjs ${value}`);
    expect(out).not.toMatch(/glpat|1234567890|abcdefghij|ABCDEFGHIJ/);
    expect(out).toContain('[REDACTED]');
  });
  // A value with no known token prefix: only the option/header/assignment rules can redact it.
  const plain = 'hunter2zqPlainValue';
  it.each([
    `--token ${plain}`, `--token=${plain}`, `--token "${plain}"`, `--token '${plain}'`, `--token\n${plain}`,
    `--pass ${plain}`, `--pw ${plain}`, `--api-key ${plain}`, `"--token" ${plain}`, `"--token ${plain}"`,
    `--token "a"${plain}`, `--token=""${plain}`, `--token "" ${plain}`, `--token \\"${plain}\\"`,
    `--token $(echo ${plain})`, `--token \`echo ${plain}\``, `--token $'${plain}'`,
    `-H "x-api-key: ${plain}"`, `-H "PRIVATE-TOKEN: ${plain}"`, `-H "X-Auth-Token: ${plain}"`, `token: ${plain}`,
    `--user u:${plain}`, `-u u:${plain}`, `-uu:${plain}`, `export PASS=${plain}`, `MY_PASS=${plain}`,
    `https://x.test/a?pass=${plain}`,
    // A personal access token (`--pat`, `--gitlab-pat`, `GITLAB_PAT=`) is a credential too.
    `--pat ${plain}`, `--pat=${plain}`, `--gitlab-pat ${plain}`, `GITLAB_PAT=${plain}`, `PAT=${plain}`,
  ])('redacts a prefix-free credential value in %s', value => {
    const out = redact(`npm ci ${value}`);
    expect(out).not.toContain('hunter2zq');
    expect(out).toContain('[REDACTED]');
  });
  it.each([
    'npx vitest run a.test.mjs --passWithNoTests=false', 'git log --author=bob', 'git fetch origin main:main',
    'curl https://x.test/a', 'env -u HOME npm ci',
    'git -C . log --path=a --compat x', 'PATH=/usr/bin npm ci', 'git diff --patience a',
  ])('leaves ordinary command %s unchanged', command => expect(redact(command)).toBe(command));
  it('stays linear-time and marks a cut on oversized input', () => {
    for (const unit of ['a.', 'a-', 'a+', '-a', 'token', '"--token ', 'x:']) {
      const started = Date.now();
      redact(unit.repeat(20000));
      expect(Date.now() - started).toBeLessThan(500);
    }
    expect(redact('x'.repeat(40000) + ' --token v')).toMatch(/…\[truncated\]$/);
  });
  it.each([
    ['npm --prefix . test', 'npm test/check'], ['npm -s test', 'npm test/check'], ['node --run test', 'npm test/check'],
    ['npm it', 'npm test/check'], ['corepack pnpm test', 'npm test/check'], ['/usr/bin/env npm test', 'npm test/check'],
    ['npx --yes bun@1.4.2 test', 'npm test/check'], ['echo $(npm test)', 'npm test/check'], ['echo `node --test a`', 'node --test'],
  ])('classifies unqueued heavy spelling %s', (command, category) => {
    expect(classifyCommand(command)).toEqual([expect.objectContaining({ category, queued: false })]);
  });
  // Self-review #6461 (round 2): credentials behind a harmless name, a line continuation, other option names,
  // `-p` password options, joined or substituted values. A value with no known token prefix is used throughout.
  const zq = 'Zq9vWm4Lp';
  it.each([
    `curl https://gitlab.test/api?page=1&private_token=${zq}`, `curl https://api.test/x?a=b&access_token=${zq}`,
    `curl -d grant_type=x&client_secret=${zq}`, `docker run --env=GITHUB_TOKEN=${zq} img`,
    `docker build --build-arg=NPM_TOKEN=${zq} .`, `cmd --set-env=GH_TOKEN=${zq}`, `cmd --token \\\n ${zq}`,
    `cmd --passphrase ${zq}`, `cmd --pwd ${zq}`, `cmd --jwt ${zq}`, `MYSQL_PWD=${zq} mysql`, `cmd --access-key-id ${zq}`,
    `docker login -p ${zq} reg`, `sshpass -p ${zq} ssh h`, `mysql -u root -p${zq} db`, `GH_TOKEN="a b"${zq} gh pr list`,
    `GH_TOKEN=$(echo ${zq}) gh pr list`, `cmd --token $(a $(b) ${zq})`, `cmd --token $(a ')' ${zq})`,
    `cmd --token=$(a "x)" ${zq})`, `cmd --token <(echo ${zq})`, `cmd --token \`echo \\\` ${zq}\``,
    `cmd --token $(unterminated ${zq}`, `echo x\\\\\n--token ${zq}`, `cat <<EOF\nline\\\n--password ${zq}\nEOF`,
    `cmd --token \\\r\n ${zq}`, `GH_TOKEN=\\\n${zq} gh`, `curl -H "X-Auth: ${zq}"`, `cmd --token${String.fromCharCode(0x2028)}${zq}`,
  ])('redacts the credential value in %s', command => {
    const out = redact(command);
    expect(out).not.toContain(zq);
    expect(out).toContain('[REDACTED]');
  });
  // Self-review #6461 (round 3): positional config keys, program-specific secret options, JSON members, session
  // and one-time-password options, and a line continuation inside the option name.
  it.each([
    `npm config set //registry.npmjs.org/:_authToken ${zq}`, `npm config set //r/:_password ${zq}`,
    `yarn config set npmAuthToken ${zq}`, `aws configure set aws_secret_access_key ${zq}`,
    `git config --global github.token ${zq}`, `gh secret set NPM_TOKEN --body ${zq}`, `gh secret set X --body=${zq}`,
    `gh secret set X -b ${zq}`, `bw unlock --session ${zq}`, `x --sig ${zq}`, `x --signature ${zq}`, `x --otp ${zq}`,
    `x --pin ${zq}`, `x --sessionid ${zq}`, `redis-cli -a ${zq}`, `mongosh -p ${zq}`, `openssl enc -passin pass:${zq}`,
    `zip -P ${zq} a.zip f`, `unzip -P ${zq} a.zip`, `7z a -p${zq} a.7z`, `ssh-keygen -N ${zq} -f k`,
    `smbclient -U user%${zq}`, `curl -b s=${zq} u`, `htpasswd -b f user ${zq}`, `curl -d '{"password":"${zq}"}' u`,
    `curl -d '{"api_key": "${zq}"}' u`, `curl -d "{\\"password\\":\\"${zq}\\"}" u`, `cmd --tok\\\nen ${zq}`,
  ])('redacts the round-3 credential shape %s', command => {
    const out = redact(command);
    expect(out).not.toContain(zq);
    expect(out).toContain('[REDACTED]');
  });
  it.each([
    'git config --global user.name Bob', 'npx vitest --config vitest.config.ts run', `curl -d '{"name":"bob"}' u`,
  ])('leaves harmless config keys and JSON members in %s unchanged', command => expect(redact(command)).toBe(command));
  it.each([
    ["cat > f <<'EOF'\n" + 'hello world\n'.repeat(1500) + 'EOF', []],
    ['cat <<EOF\nnpm test\nEOF', []],
    ['bash <<EOF\nnpm test\nEOF', ['npm test/check']],
    ['npm --loglevel silent test', ['npm test/check']], ['npm --tag x test', ['npm test/check']],
    ['nohup npm test', ['npm test/check']], ["eval 'npm test'", ['npm test/check']], ['NPM test', ['npm test/check']],
  ])('classifies long plain text, heredocs, npm value options and launchers: %s', (command, categories) => {
    expect(classifyCommand(command).map(row => row.category)).toEqual(categories);
  });
  it.each([
    'mkdir -p a/b', 'npm run build -- --page=2', 'curl https://x.test/?page=1&limit=2', 'docker run -p 80:80 img',
    'ls; mysql -h host -P 3306', 'echo a=b c=d',
  ])('leaves short options and harmless assignments in %s unchanged', command => expect(redact(command)).toBe(command));
  it.each([
    ['bash -c "echo $(npm test)"', false], ["bash -c 'echo $(npm test)'", false], ['bash -c "echo \\$(npm test)"', false],
    ['sh -c "sh -c \\"npm test\\""', false], [`bash -c "x $(sh -c 'npm test')"`, false],
    [queue + 'bash -c "echo $(npm test)"', false],
    ["bash -o pipefail -c 'npm test'", false], ["bash -euo pipefail -c 'npm test'", false], ["bash -ce 'npm test'", false],
    ["bash -O extglob -c 'npm test'", false], ["bash -c -- 'npm test'", false], ["busybox sh -c 'npm test'", false],
  ])('counts the run in %s exactly once', (command, queued) => {
    expect(classifyCommand(command)).toEqual([expect.objectContaining({ category: 'npm test/check', queued })]);
  });
  it('redacts a space-separated credential option through auditLines', () => {
    const report = JSON.stringify(auditLines([claude(`npx vitest run a.test.mjs --token ${fakeGl}`)], { date: '2026-07-02' }));
    expect(report).not.toContain('12345678901234567890');
    expect(report).toContain('vitest');
  });
  // Self-review #6461: nested substitutions are classified once each, with bounded time and rows.
  const nest = (levels, inner) => Array.from({ length: levels }).reduce(cmd => `echo $(${cmd})`, inner);
  it('classifies each nested substitution once, with no combinatorial growth', () => {
    expect(classifyCommand('echo $(echo $(npm test))')).toEqual([expect.objectContaining({ category: 'npm test/check' })]);
    expect(classifyCommand(nest(5, 'npm test'))).toHaveLength(1);
    const started = Date.now();
    expect(classifyCommand(nest(20, 'echo hi'))).toEqual([]);
    expect(classifyCommand('echo ' + '$('.repeat(20))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it.each([
    ['a deep unclosed nest', '$('.repeat(8000)], ['too many substitutions', 'echo $(a) '.repeat(300)],
    ['an oversized command', 'npm ci ' + '$(a) '.repeat(4000)],
  ])('reports %s as one unparsed row instead of throwing', (_, command) => {
    expect(classifyCommand(command)).toEqual([expect.objectContaining({ category: expect.stringMatching(/^unparsed/), queued: false })]);
    expect(auditLines([claude(command)], { date: '2026-07-02' }).rows).toHaveLength(1);
  });
  it('keeps ordinary flags readable', () => {
    expect(redact('npx vitest run a.test.mjs --run --bail=1')).toBe('npx vitest run a.test.mjs --run --bail=1');
  });
  it('uses ET boundaries in both winter and summer', () => {
    expect(auditLines([claude('npm ci', '2026-11-06T04:59:59Z')], { date: '2026-11-06' }).rows).toEqual([]);
    expect(auditLines([claude('npm ci', '2026-07-02T03:59:59Z')], { date: '2026-07-02' }).rows).toEqual([]);
    expect(auditLines([claude('npm ci', '2026-07-02T04:00:00Z')], { date: '2026-07-02' }).rows).toHaveLength(1);
  });
  it('reports malformed evidence and rejects invalid dates', () => {
    expect(auditLines(['{', 'null', claude('npm ci', 'bad')]).invalidLines).toBe(3);
    expect(() => auditLines([], { date: '2026-02-30' })).toThrow('Invalid --date');
  });
});
