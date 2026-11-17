// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCommand, redact, auditLines, REDACT_MAX_CHARS } from '../agent-command-audit.mjs';

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
    // Review #6461 round 3: env split strings, compound commands and more exec wrappers.
    ["env -S 'npx vitest run a'", 'vitest'], ["env --split-string='npx vitest run a'", 'vitest'],
    ["env -iS 'node --test a'", 'node --test'], ['time -p npx vitest run a', 'vitest'],
    ['case x in x) npx vitest run a;; esac', 'vitest'], ['f() { npx playwright test a; }', 'playwright'],
    ['stdbuf -oL npx vitest run a', 'vitest'], ['ionice -c 3 npx vitest run a', 'vitest'],
    ['npm test -- a', 'npm test/check'], ['npm ci', 'install/ci'],
    ['git fetch origin', 'git fetch/clone/wt/gc'], ['rg needle .', 'repo-wide find/grep'],
  ])('classifies bypass %s', (cmd, category) => {
    expect(classifyCommand(cmd)).toEqual([expect.objectContaining({ category, queued: false })]);
  });
  // Review #6461 round 2: only Node's executable positions count; an argument after the script operand is data.
  it.each([
    'node scripts/light.mjs --test', 'node scripts/light.mjs --test a.test.mjs',
    'node scripts/light.mjs node_modules/vitest/vitest.mjs run a',
    'node scripts/light.mjs scripts/check-standards.mjs', 'node --title --test light.mjs',
  ])('ignores Node test flags and entry names after the script operand: %s', cmd => {
    expect(classifyCommand(cmd)).toEqual([]);
  });
  it.each([
    ['node --test a.test.mjs', 'node --test'], ['node --require ./setup.js --test a', 'node --test'],
    ['node --no-warnings node_modules/vitest/vitest.mjs run a', 'vitest'],
    ['node node_modules/.bin/vitest run a', 'vitest'],
    ['node --max-old-space-size 4096 scripts/check-standards.mjs', 'check:standards'],
  ])('still classifies Node in executable position: %s', (cmd, category) => {
    expect(classifyCommand(cmd)).toEqual([expect.objectContaining({ category, queued: false })]);
  });
  it.each(['node scripts/readiness/heavy-admission.mjs run -- node --test a',
    'node --no-warnings scripts/readiness/heavy-admission.mjs run -- node --test a'])('counts an admitted Node test run as queued: %s', cmd => {
    expect(classifyCommand(cmd)).toEqual([expect.objectContaining({ category: 'node --test', queued: true })]);
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
    const fake = 'gh\x70_abcdefghijklmnopqrstuvwxyz1234567890';
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
    'gh\x70_abcdefghijklmnopqrstuvwxyz', 'github_\x70at_abcdefghijklmnopqrstuvwxyz',
    's\x6b-abcdefghijklmnopqrstuvwxyz', 'xo\x78b-abcdefghijklmnopqrstuvwxyz', 'Bearer fake.credentials',
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
    `PASSWORD=${fakeGl}`, `GITLAB_AUTH=${fakeGl}`, fakeGl, 'gh\x6f_abcdefghijklmnopqrstuvwxyz', 'gh\x73_abcdefghijklmnopqrstuvwxyz',
    'npm_abcdefghijklmnopqrstuvwxyz0123', 'AKI\x41ABCDEFGHIJKLMNOP',
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
    // round 4: both readings of a continuation, and unquoted object-literal keys
    `x --pass\\\n${zq}`, `x --pat\\\n${zq}`, `curl --user\\\nme:${zq}`, `node -e "login({password: \\"${zq}\\"})"`,
    `node -e "f({ password: '${zq}' })"`, `node -e "f({pin: ${zq}})"`,
  ])('redacts the round-3 credential shape %s', command => {
    const out = redact(command);
    expect(out).not.toContain(zq);
    expect(out).toContain('[REDACTED]');
  });
  // Review #6461 round 3: a credential is one whole shell word, so quoting, concatenation or a quoted separator
  // never leaves part of it readable (the old rules cut the value at a space or a `;`).
  it.each([
    `htpasswd -nb user 'firstPart secondPart'`, `htpasswd -nb user "firstPart secondPart"`,
    `htpasswd -nb user 'firstPart'"secondPart"`, `htpasswd -nb user firstPart\\ secondPart`,
    `htpasswd -B -b f user 'firstPart secondPart'`, `htpasswd -bc f user 'firstPart;secondPart' && echo ok`,
    `htpasswd -nb user 'firstPart secondPart' 2>&1 | tail`, `htpasswd -nb user 'firstPart secondPart' > out`,
    `mysql -p'firstPart;secondPart' db`, `gh secret set X --repo 'a;b' --body 'firstPart secondPart'`,
    `openssl enc -pass pass:'firstPart secondPart'`, `openssl enc -passin "pass:firstPart secondPart"`,
    `curl -u 'user:firstPart secondPart' x`, `curl --user "user:firstPart secondPart" x`,
    `git clone https://user:"firstPart secondPart"@host/repo`,
  ])('redacts every part of a quoted or concatenated credential in %s', command => {
    const out = redact(command);
    expect(out).not.toMatch(/firstPart|secondPart/);
    expect(out).toContain('[REDACTED]');
  });
  // Self-review of round 3: the password is found inside `$( … )` / a subshell, before a comment or a line break,
  // behind a path, and for every curl user option; a quote that closes a URL never starts a userinfo scan.
  it.each([
    ['x=$(htpasswd -nb user firstPart)', 'x=$(htpasswd -nb user [REDACTED])'],
    ['(htpasswd -nb user firstPart)', '(htpasswd -nb user [REDACTED])'],
    ['htpasswd -nb user firstPart) && echo x', 'htpasswd -nb user [REDACTED]) && echo x'],
    ['/usr/bin/htpasswd -nb u firstPart', '/usr/bin/htpasswd -nb u [REDACTED]'],
    ['htpasswd -nb u firstPart # note', 'htpasswd -nb u [REDACTED] # note'],
    ['htpasswd -nb u firstPart\necho done', 'htpasswd -nb u [REDACTED] echo done'],
    ['curl -su user:firstPart x', 'curl [REDACTED] x'], ['curl -U u:firstPart x', 'curl [REDACTED] x'],
    ['curl --proxy-user u:firstPart x', 'curl [REDACTED] x'], ['curl -u= user:firstPart x', 'curl [REDACTED] x'],
    ['echo "https://x.com" && npx @11ty/eleventy', 'echo "https://x.com" && npx @11ty/eleventy'],
    [`curl "http://example.com" -d 'mail=a@b.c'`, `curl "http://example.com" -d 'mail=a@b.c'`],
    [`curl 'https://user:firstPart@h/x'`, `curl 'https://[REDACTED]@h/x'`],
  ])('redacts exactly the credential in %s', (command, expected) => {
    expect(redact(command)).toBe(expected);
  });
  it('stays linear on an unterminated substitution after many -u options', () => {
    const started = Date.now();
    expect(redact('curl -u "$('.repeat(1600))).toContain('curl');
    expect(Date.now() - started).toBeLessThan(500);
  });
  it('keeps the operands around a quoted htpasswd password and ordinary -u options', () => {
    expect(redact(`htpasswd -nb user 'a b' 2>&1 | tail`)).toBe('htpasswd -nb user [REDACTED] 2>&1 | tail');
    expect(redact('htpasswd -i f user')).toBe('htpasswd -i f user');
    expect(redact('sort -u file')).toBe('sort -u file');
    expect(redact('git clone https://github.com/a/b')).toBe('git clone https://github.com/a/b');
  });
  it.each([
    String.raw`htpasswd -nb user "pa\"ss word"`,
    String.raw`htpasswd -nb user 'pa'\''ss word'`,
  ])('redacts the whole htpasswd password containing an escaped quote: %s', command => {
    expect(redact(command)).toBe('htpasswd -nb user [REDACTED]');
  });
  it('redacts an over-long htpasswd password whole, before the length bound can cut it', () => {
    // The password is found on the full text, so nothing is left to cut: no part of it survives and no cut mark is owed.
    const out = redact(`htpasswd -nb user 'firstPart ${'x'.repeat(20000)} secondPart'`);
    expect(out).toBe('htpasswd -nb user [REDACTED]');
  });
  it('marks a cut after redaction when the redacted text still exceeds the length bound', () => {
    const out = redact(`htpasswd -nb user 'pw' && echo ${'x'.repeat(20000)}`);
    expect(out).not.toMatch(/pw'/);
    expect(out).toContain('htpasswd -nb user [REDACTED]');
    expect(out.endsWith(' …[truncated]')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(REDACT_MAX_CHARS + ' …[truncated]'.length);
  });
  // Review #6461 round 3: the source is the transcript's own path, so real uuid-named files keep distinct keys.
  it('keeps real-shaped transcript paths as distinct bySource keys', () => {
    const sources = [
      'claude:.claude/projects/-Users-x-workspace-proj/0d5c4b9e-6f1a-4c2b-9e8d-7a6b5c4d3e2f.jsonl',
      'claude:.claude/projects/-Users-x-workspace-proj/1e6d5c0f-7a2b-4d3c-8f9e-8b7c6d5e4f3a.jsonl',
      'codex:.codex/sessions/2026/07/02/rollout-2026-07-02T04-30-00-2f7e6d1a-8b3c-4e4d-9a0f-9c8d7e6f5a4b.jsonl',
    ];
    const bySource = {};
    for (const source of sources) Object.assign(bySource, auditLines([claude('npm ci')], { date: '2026-07-02', source }).bySource);
    expect(Object.keys(bySource)).toEqual(sources);
    expect(auditLines([claude('npm ci')], { date: '2026-07-02', source: 'claude:a\x1b[31m\nb' }).rows[0].source).toBe('claude:a?b');
  });
  it.each([
    'git config --global user.name Bob', 'npx vitest --config vitest.config.ts run', `curl -d '{"name":"bob"}' u`,
    'node -e "f({ name: 1 })"', 'docker run -p 80:80 img',
  ])('leaves harmless config keys and JSON members in %s unchanged', command => expect(redact(command)).toBe(command));
  it('reads --body-file as its own option, not --body', () => {
    expect(redact('gh secret set X --body-file f')).toContain('--body-file f');
  });
  it('keeps every new redaction rule linear on long adversarial input', () => {
    const started = Date.now();
    for (const unit of ['b', 'htpasswd -b', '{"password":"', 'password: ', 'config set ', 'gh secret set x ', 'x\\\n', "'", "h'", 'h"\'', "'htpasswd' -b ", "my'sql' ", "con'fig' set "]) {
      redact((unit === 'b' ? 'htpasswd -' : '') + unit.repeat(Math.ceil(16000 / unit.length)));
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('does not backtrack exponentially on repeated dash-option runs after config (CodeQL js/redos)', () => {
    const started = Date.now();
    redact(`config ${'--\t-'.repeat(4000)}`);
    redact(`config ${'--\t-'.repeat(4000)}\u0000`);
    expect(Date.now() - started).toBeLessThan(2000);
    // the flag-skipping still reaches the key after real option runs
    expect(redact('git config --global --replace-all github.token ghp_abc123')).not.toContain('ghp_abc123');
  });
  it.each([
    ["cat > f <<'EOF'\n" + 'hello world\n'.repeat(1500) + 'EOF', []],
    ['cat <<EOF\nnpm test\nEOF', []],
    ['bash <<EOF\nnpm test\nEOF', ['npm test/check']], ['cd /x && bash <<EOF\nnpm test\nEOF', ['npm test/check']],
    ["set -e; bash -s <<'EOF'\nnpm test\nEOF", ['npm test/check']],
    ['npm --loglevel silent test', ['npm test/check']], ['npm --tag x test', ['npm test/check']],
    ['nohup npm test', ['npm test/check']], ["eval 'npm test'", ['npm test/check']], ['NPM test', ['npm test/check']],
  ])('classifies long plain text, heredocs, npm value options and launchers: %s', (command, categories) => {
    expect(classifyCommand(command).map(row => row.category)).toEqual(categories);
  });
  // Review #6461 round 5: the audit's own patterns (Playwright, installs, git fetch, repo-wide search) apply to every
  // command a launcher runs, not only to the outer head.
  it.each([
    ['nohup npx playwright test a', 'playwright', false], ['setsid -f npx playwright test a', 'playwright', false],
    ["eval 'npx playwright test a'", 'playwright', false], ['nohup nohup pnpm exec playwright test a', 'playwright', false],
    ['nohup npm ci', 'install/ci', false], ['setsid git fetch origin', 'git fetch/clone/wt/gc', false],
    ['nohup rg needle .', 'repo-wide find/grep', false], ['nohup npm run test:unit', 'npm test/check', true],
    // Self-review: the launched command goes through the whole classifier (sh -c, env -S, admission, heredocs).
    ['nohup sh -c "npx vitest run a"', 'vitest', false], ['nohup sh -c "npm ci"', 'install/ci', false],
    ["setsid bash -c 'git fetch'", 'git fetch/clone/wt/gc', false],
    ["nohup env -S \"sh -c 'npx playwright test a'\"", 'playwright', false],
    ['nohup node scripts/readiness/heavy-admission.mjs run -- npx playwright test a', 'playwright', true],
    ['nohup bash <<EOF\nnpx vitest run a\nEOF', 'vitest', false], ["setsid -f sh -s <<'EOF'\nnpm test\nEOF", 'npm test/check', false],
  ])('classifies Playwright and other audited runs behind launchers: %s', (cmd, category, queued) => {
    expect(classifyCommand(cmd)).toEqual([expect.objectContaining({ category, queued })]);
  });
  it('classifies every segment of a launched command string', () => {
    expect(classifyCommand("eval 'npm ci; npx playwright test a'").map(row => row.category)).toEqual(['install/ci', 'playwright']);
    expect(classifyCommand('nohup cat <<EOF\nnpm test\nEOF')).toEqual([]);
  });
  // Review #6461 round 6: a launched string that STARTS with a classified run was reported by its first command only,
  // because the head classifier reads through the launcher; every later command must be reported too.
  const firstRuns = [
    ['npx vitest run a', 'vitest', false], ['node --test a.mjs', 'node --test', false], ['npm test', 'npm test/check', false],
    ['npm run test:unit -- a', 'npm test/check', true], ['npm run check:standards', 'check:standards', true],
  ];
  const launchers = [s => `eval '${s}'`, s => `eval "${s}"`, s => `setsid -f eval '${s}'`, s => `nohup bash -c '${s}'`, s => `nohup eval '${s}'`,
    s => `eval -- '${s}'`];
  it.each(firstRuns.flatMap(([first, category, queued]) => launchers.map(wrap => [wrap(`${first}; npx playwright test b && npm ci`), category, queued])))(
    'classifies every command after a classified first run of a launched string: %s', (command, category, queued) => {
      expect(classifyCommand(command).map(({ category: c, queued: q }) => [c, q]))
        .toEqual([[category, queued], ['playwright', false], ['install/ci', false]]);
    });
  it('admits every command of a launched string run under the admission wrapper', () => {
    expect(classifyCommand(`${queue}eval 'npx vitest run a; npx playwright test b'`).map(({ category, queued }) => [category, queued]))
      .toEqual([['vitest', true], ['playwright', true]]);
  });
  // Operator send-back on #6461 round 7: a wrapper's command-string (`npx --call "…"`, `npx -c "…"`, `flock f -c "…"`,
  // `watch "…"`, `pnpm dlx -c "…"`) is a whole command line, so every command in it is classified.
  it.each([
    'npx --call "echo ok; npx vitest run a"', 'npx -c "echo ok; npx vitest run a"', 'npx --call="echo ok; npx vitest run a"',
    'flock /tmp/l -c "echo ok; npx vitest run a"', 'watch "echo ok; npx vitest run a"', 'pnpm dlx -c "echo ok; npx vitest run a"',
  ])('classifies the nested run of a wrapper command string: %s', command => {
    expect(classifyCommand(command).map(({ category, queued }) => [category, queued])).toEqual([['vitest', false]]);
  });
  it('reads an escaped quote in a wrapper command string as the inner shell does, and a launched wrapper', () => {
    expect(classifyCommand('npx -c "echo \\"x; npx vitest run b\\""')).toEqual([]);
    expect(classifyCommand('nohup npx -c "echo ok; npx vitest run a"').map(row => row.category)).toEqual(['vitest']);
    expect(classifyCommand('fish -c "npx vitest run a"').map(row => row.category)).toEqual(['vitest']);
  });
  it('classifies every command of a wrapper command string, admitted or not', () => {
    expect(classifyCommand('npx -c "echo ok && npx playwright test a"').map(row => row.category)).toEqual(['playwright']);
    expect(classifyCommand(`npx -c "echo ok; ${queue}npx vitest run a"`).map(({ category, queued }) => [category, queued]))
      .toEqual([['vitest', true]]);
  });
  it.each(['nohup echo hi', 'nohup npx playwright --version', 'eval echo playwright test', 'setsid ls'])('leaves a harmless launched command unaudited: %s', cmd => {
    expect(classifyCommand(cmd)).toEqual([]);
  });
  // Review #6461 round 5: a path-qualified program (`/usr/bin/mysql`, `./mysql`, a quoted path) runs the same program,
  // so its short-option and `--body` secrets are redacted too, including inside a command substitution.
  it.each([
    '/usr/bin/mysql -pZq9vWm4Lp', './mysql -pZq9vWm4Lp', '../bin/mariadb -p Zq9vWm4Lp', "'/usr/bin/mysql' -pZq9vWm4Lp",
    '/usr/bin/redis-cli -a Zq9vWm4Lp', '/opt/bin/sshpass -p Zq9vWm4Lp ssh h', '/usr/bin/zip -P Zq9vWm4Lp f.zip a',
    '/usr/local/bin/docker login -p Zq9vWm4Lp', '/usr/local/bin/gh secret set X --body Zq9vWm4Lp',
    'echo $(/usr/bin/mysql -pZq9vWm4Lp)', 'x=`/usr/bin/mysql -pZq9vWm4Lp`',
    // Self-review: each word of a multi-word program may be quoted on its own.
    "'/usr/local/bin/gh' secret set X --body Zq9vWm4Lp", "'gh' secret set X -b Zq9vWm4Lp", "'docker' login -p Zq9vWm4Lp",
    '"/usr/bin/docker" login -p Zq9vWm4Lp', "'helm' 'registry' 'login' -p Zq9vWm4Lp r",
  ])('redacts path-qualified short-option passwords: %s', command => {
    const out = redact(command);
    expect(out).not.toContain('Zq9vWm4Lp');
    expect(out).toContain('[REDACTED]');
  });
  // Review #6461 round 6: a program or keyword word quoted whole or in part (`'/usr/bin/htpasswd'`, `my"sql"`,
  // `npm 'config' set`) is the same word to the shell, so its secret is redacted too.
  it.each([
    "'/usr/bin/htpasswd' -nb user Zq9vWm4Lp", '"htpasswd" -nb user Zq9vWm4Lp', "htpass'wd' -nb user Zq9vWm4Lp",
    "'htpasswd' -b f user Zq9vWm4Lp", '"/usr/sbin/htpasswd" -B -b f user Zq9vWm4Lp', "x=$('htpasswd' -nb u Zq9vWm4Lp)",
    "sh -c \"'htpasswd' -nb u Zq9vWm4Lp\"", 'my"sql" -pZq9vWm4Lp', "m'y'sql -p Zq9vWm4Lp", '"/usr/bin/mysql"dump -pZq9vWm4Lp',
    '"redis"-cli -a Zq9vWm4Lp', "z'ip' -P Zq9vWm4Lp f", "g'h' secret set X --body Zq9vWm4Lp", "'gh' 'secret' 'set' X --body Zq9vWm4Lp",
    "g'h' sec\"ret\" set X -b Zq9vWm4Lp", 'doc"ker" log\'in\' -p Zq9vWm4Lp', "npm 'config' set //r/:_authToken Zq9vWm4Lp",
    'git "config" --global github.token Zq9vWm4Lp', "aws configure 'set' aws_secret_access_key Zq9vWm4Lp",
    "npm config set '--location=user' //r/:_authToken Zq9vWm4Lp",
    // Self-review: any number of quotes, and a quoted option word (`'-p'v`, `"--body" v`).
    "m''''ysql -pZq9vWm4Lp", "h''''tpasswd -nb u Zq9vWm4Lp", "npm co''''nfig set //r/:_authToken Zq9vWm4Lp",
    "mysql '-p'Zq9vWm4Lp", 'mysql "-pZq9vWm4Lp"', "mysql -'p'Zq9vWm4Lp", 'mysql \\-pZq9vWm4Lp', "mysql '-p' Zq9vWm4Lp",
    'gh secret set X "--body" Zq9vWm4Lp', "gh secret set X '-b' Zq9vWm4Lp", "gh secret set X --'body'=Zq9vWm4Lp",
    'redis-cli "-a" "" Zq9vWm4Lp',
  ])('redacts the secret of a quoted program or keyword word: %s', command => {
    const out = redact(command);
    expect(out).not.toContain('Zq9vWm4Lp');
    expect(out).toContain('[REDACTED]');
  });
  it('redacts only the password of a quoted htpasswd program and keeps the next command', () => {
    expect(redact("'/usr/bin/htpasswd' -nb user Zq9vWm4Lp; npm ci")).toBe("'/usr/bin/htpasswd' -nb user [REDACTED]; npm ci");
    expect(redact('"htpasswd" -nb u Zq9vWm4Lp && echo ok')).toBe('"htpasswd" -nb u [REDACTED] && echo ok');
  });
  // Operator send-back on #6461 round 7: a credential header's value runs to the end of its argument, past `;`,
  // spaces and quotes inside it, so a later cookie (`sid=…`) or Digest field is redacted too.
  it('redacts every cookie of a Cookie header value through auditLines', () => {
    const command = "git clone -c 'http.extraHeader=Cookie: theme=light; sid=Zq9vWm4Lp' https://x.test/r.git";
    const out = JSON.stringify(auditLines([claude(command)]));
    expect(out).not.toContain('Zq9vWm4Lp');
    expect(out).not.toMatch(/sid=/);
    expect(redact(command)).toBe("git clone -c 'http.extraHeader=[REDACTED]' https://x.test/r.git");
  });
  it.each([
    'curl -H "Cookie: a=1; sid=Zq9vWm4Lp" u', "curl -H 'Set-Cookie: a=1; sid=Zq9vWm4Lp' u", 'curl -H Cookie:\\ a=1\\;\\ sid=Zq9vWm4Lp u',
    'git -c "http.extraHeader=Cookie: theme=light; sid=Zq9vWm4Lp" fetch',
    'curl -H \'Authorization: Digest username="u", response="Zq9vWm4Lp"\' u', 'curl -H "X-Api-Key: a b Zq9vWm4Lp" u',
    'curl -H "Cookie:a=1;sid=Zq9vWm4Lp" u', "curl -b x -H $'Cookie: a=1; sid=Zq9vWm4Lp' u",
  ])('redacts a whole credential header value inside one argument: %s', command => {
    const out = redact(command);
    expect(out).not.toContain('Zq9vWm4Lp');
    expect(out).toContain('[REDACTED]');
  });
  // Self-review of the round 7 send-back: the value ends with the header's own quoted run, prose keeps its words,
  // a value in the next word and `…-Key` / `X-Authentication` headers are redacted too.
  it.each([
    "curl -H 'Cookie:' 'a=1; sid=Zq9vWm4Lp' u", 'curl -H Cookie: "a=1; sid=Zq9vWm4Lp" u',
    "curl -H 'Ocp-Apim-Subscription-Key: a; Zq9vWm4Lp' u", "curl -H 'X-Authentication: a; Zq9vWm4Lp' u",
    "curl -H 'Cookie: a; b' -H 'Authorization: Digest r=\"x\", response=\"Zq9vWm4Lp\"' u",
    "bash -c 'curl -H \"Cookie: a=1; sid=Zq9vWm4Lp\" u; curl -H \"X-Api-Key: b c Zq9vWm4Lp\" v'", "curl -H 'Cookie: a=1; sid='Zq9vWm4Lp u",
  ])('redacts a credential header value given in its own quoted run or the next word: %s', command => {
    expect(redact(command)).not.toContain('Zq9vWm4Lp');
  });
  it('keeps the rest of a command string and prose around a credential header', () => {
    expect(redact("bash -c 'curl -H \"Cookie: a=1; sid=Zq9vWm4Lp\" https://e.com/p; npm test'"))
      .toBe("bash -c 'curl -H \"[REDACTED]\" https://e.com/p; npm test'");
    expect(redact('git commit -m "docs: rotate token: see README for steps"')).toContain('README for steps');
    expect(redact("curl -H 'Cookie:' 'a=1; sid=Zq9vWm4Lp' -o out u")).toBe("curl -H '[REDACTED]' [REDACTED] -o out u");
  });
  it('keeps a harmless header value and the arguments after a credential header', () => {
    expect(redact("curl -H 'Accept: a; q=Zq9vWm4Lp' u")).toBe("curl -H 'Accept: a; q=Zq9vWm4Lp' u");
    expect(redact('curl -H "Cookie: a=1; sid=Zq9vWm4Lp" -o out.txt u')).toBe('curl -H "[REDACTED]" -o out.txt u');
  });
  it('keeps the words around a quoted option value and a look-alike long option', () => {
    expect(redact("mysql -h db '-p'Zq9vWm4Lp -e 'select 1'")).toBe("mysql -h db -p [REDACTED] -e 'select 1'");
    expect(redact('gh secret set X --body-file f.txt')).toContain('X --body-file f.txt');
  });
  it('stays fast on quote runs shared by a config option value and its separator (self-review ReDoS)', () => {
    const started = Date.now();
    for (const unit of ["-a=''' ", "-a=' ", "''' ", "-a''' "]) redact(`npm config set ${unit.repeat(2000)}x`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('keeps a word that only contains a quoted program name as data', () => {
    for (const command of ["x'htpasswd' -nb user Zq9vWm4Lp", "my-'mysql' -pZq9vWm4Lp", "x\\htpasswd -nb u Zq9vWm4Lp"]) {
      expect(redact(command)).toContain('Zq9vWm4Lp');
    }
  });
  it('keeps a hyphen- or dot-joined name, or a folder inside a path word, that is not the program as data', () => {
    expect(redact('my-mysql -pZq9vWm4Lp')).toContain('Zq9vWm4Lp');
    expect(redact('docker run -v /data/mysql:/srv/db -p 3306:3306 img')).toContain('3306:3306');
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
    // Review #6461 round 2: the length bound alone, with one harmless substitution and no other limit hit.
    ['one substitution in an oversized command', 'echo $(echo hi) ' + 'a'.repeat(17000)],
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
