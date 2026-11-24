// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { secretText } from '../../readiness/forge-exec-manifest.mjs';
import { keyStructureFinding } from '../../readiness/forge-key-structure.mjs';

const cli = new URL('../secret-scan.mjs', import.meta.url);
const token = 'ghp' + '_' + 'a'.repeat(36);
const aws = 'AKIA' + 'A'.repeat(16);
const diff = (text, path = 'fixture.txt') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +7 @@\n+${text}\n`;
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function scan(input, entries = []) {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  dirs.push(dir);
  const allowlist = join(dir, 'allowlist.json');
  writeFileSync(allowlist, JSON.stringify(entries));
  const result = spawnSync(process.execPath, [cli.pathname, '--stdin', '--allowlist', allowlist], {
    input, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  return { ...result, output: result.stdout + result.stderr };
}

describe('secret-scan', () => {
  it('exports the identical shared rule array', async () => {
    expect((await import('../secret-scan.mjs')).secretText).toBe(secretText);
  });
  it.each([[token, 'github-token'], [aws, 'aws-access-key']])('reports only location and rule for fake credential %#', (value, rule) => {
    const result = scan(diff(value));
    expect(result.status).toBe(1);
    expect(result.output).toBe(`fixture.txt:7 ${rule}\n`);
    expect(result.output).not.toContain(value);
  });
  it('passes clean text and an empty diff', () => {
    expect(scan(diff('ordinary text')).status).toBe(0);
    expect(scan('').status).toBe(0);
  });
  it.each([
    '{"p":"Paragraph"}',
    'const event = { k: "click" };',
    '{"nested":{"d":"description","p":"Paragraph","k":"kind"}}',
    '{"\\u0070":"Paragraph"}',
    'const event = { /* trivia */ k: "click", nested: [{p:"Paragraph"}] };',
    '{"p":"Paragraph"}\n{"k":"kind"}',
  ])('does not invent key evidence in complete ordinary objects %#', text => {
    const lines = text.split('\n');
    const input = '--- /dev/null\n+++ b/locale.json\n'
      + `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => `+${line}\n`).join('');
    expect(keyStructureFinding(Buffer.from(text))).toBeNull();
    const result = scan(input);
    expect(result.status).toBe(0);
    expect(result.output).toBe('');
  });
  it.each([false, true])('does not carry an added comment across omitted closing syntax (context=%s)', context => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const publicMembers = Object.entries(publicKey.export({ format: 'jwk' }))
      .map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)},`);
    const member = `d:${JSON.stringify(jwk.d)},`;
    const resulting = ['({', ...publicMembers, '/* updated comment', 'unchanged', '*/', member, '})'].join('\n');
    // Only locally generated fixture source is evaluated, never scanner input.
    expect(createPrivateKey({ key: Function(`return ${resulting}`)(), format: 'jwk' }).asymmetricKeyType).toBe('ec');
    expect(keyStructureFinding(Buffer.from(resulting))).toBe('private-key-structure');
    const input = '--- a/key.js\n+++ b/key.js\n'
      + (context
        ? '@@ -6,3 +6,4 @@\n-/* existing comment\n+/* updated comment\n unchanged\n */\n'
        : '@@ -6 +6 @@\n-/* existing comment\n+/* updated comment\n@@ -8,0 +9 @@\n')
      + `+${member}\n`;
    const result = scan(input);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/^key\.js:\d+ private-key-structure\n$/);
    expect(result.output).not.toContain(jwk.d);
  });
  it.each(['/* changed comment', '"changed string', "'changed string"])(
    'resets incomplete lexical state across a diff gap %#', opener => {
      const input = '--- a/key.js\n+++ b/key.js\n'
        + `@@ -1 +1 @@\n-old\n+${opener}\n@@ -8,0 +9 @@\n+"d":"abc",\n`;
      expect(scan(input).output).toMatch(/^key\.js:\d+ private-key-structure\n$/);
    },
  );
  it('keeps private members visible when both their syntax and an earlier comment span gaps', () => {
    const input = '--- a/key.js\n+++ b/key.js\n'
      + '@@ -1 +1 @@\n-old\n+/* updated comment\n'
      + '@@ -4,0 +5 @@\n+{\n'
      + '@@ -7,0 +9 @@\n+"d":\n'
      + '@@ -10,0 +13,2 @@\n+"abc",\n+}\n';
    expect(scan(input).output).toBe('key.js:1 private-key-structure\n');
  });
  it('preserves comments and literals within consecutive added lines and separate complete objects across gaps', () => {
    const lines = ['const metadata = {', '/* comment', 'd:"abc",', '*/', 'p:"Paragraph",', 'k:"kind",', '};'];
    const input = '--- a/locale.js\n+++ b/locale.js\n'
      + `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => `+${line}\n`).join('')
      + '@@ -10,0 +18 @@\n+const event = {k:"click"};\n';
    expect(scan(input).status).toBe(0);
  });
  it('treats adjacent postimage lines as contiguous even in separate hunks', () => {
    const input = '--- a/locale.json\n+++ b/locale.json\n'
      + ['{', '"p":"Paragraph"', '}'].map((text, index) =>
        `@@ -${index},0 +${index + 1} @@\n+${text}\n`).join('');
    expect(scan(input).status).toBe(0);
  });
  it('ignores removed lines and context, keeping new-file line numbers', () => {
    const result = scan(`--- a/x\n+++ b/x\n@@ -3,2 +3,2 @@\n-${token}\n ${token}\n+${aws}\n`);
    expect(result.status).toBe(1);
    expect(result.output).toBe('x:4 aws-access-key\n');
    expect(scan(`--- a/x\n+++ b/x\n@@ -1 +0,0 @@\n-${token}\n`).status).toBe(0);
  });
  it('scans additions beginning with header-like text', () => {
    expect(scan(diff('++ ' + token)).output).toBe('fixture.txt:7 github-token\n');
  });
  it('honors only the exact allowlisted path and rule', () => {
    const entries = [{ path: 'fixture.txt', rule: 'github-token', reason: 'Synthetic token fixture' }];
    expect(scan(diff(token), entries).status).toBe(0);
    expect(scan(diff(aws), entries).status).toBe(1);
    expect(scan(diff(token, 'other.txt'), entries).status).toBe(1);
  });
  it.each([undefined, '', '   '])('fails closed on missing or blank allowlist reason %#', reason => {
    expect(scan('', [{ path: 'fixture.txt', rule: 'github-token', reason }]).status).toBe(1);
  });
  it('fails closed on unknown rules, wildcard paths and malformed diffs', () => {
    expect(scan('', [{ path: 'x', rule: 'unknown', reason: 'test' }]).status).toBe(1);
    expect(scan('', [{ path: '*', rule: 'github-token', reason: 'test' }]).status).toBe(1);
    expect(scan('@@ -0,0 +1 @@\n+text\n').status).toBe(1);
    expect(scan('--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+text\n').status).toBe(1);
  });
  it('fails closed on unreadable config, unknown args and unavailable git refs without echoing inputs', () => {
    for (const args of [['--allowlist', 'missing-config'], ['--unknown', token], ['--base', 'nonexistent-secret-scan-ref']]) {
      const result = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(token);
    }
  });
  it('refuses oversized input with an operator fallback', () => {
    const result = scan(' '.repeat(32 * 1024 * 1024 + 1));
    expect(result.status).toBe(1);
    expect(result.output).toContain('review the full diff manually');
  });
  it('decodes Git quoted paths and scans multiple hunks', () => {
    const result = scan(`--- "a/sp ace.txt"\n+++ "b/sp ace.txt"\n@@ -0,0 +1 @@\n+clean\n@@ -5,0 +6 @@\n+${token}\n`);
    expect(result.output).toBe('sp ace.txt:6 github-token\n');
  });
  it('decodes octal UTF-8 paths for exact allowlist matching and escapes terminal controls', () => {
    const input = `--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -0,0 +1 @@\n+${token}\n`;
    expect(scan(input).output).toBe('café.txt:1 github-token\n');
    expect(scan(input, [{ path: 'café.txt', rule: 'github-token', reason: 'Synthetic fixture' }]).status).toBe(0);
    expect(scan(`--- "a/x\\033.txt"\n+++ "b/x\\033.txt"\n@@ -0,0 +1 @@\n+${token}\n`).output).toBe('"x\\u001b.txt":1 github-token\n');
  });
  it('reports every matching shared rule on a line', () => {
    expect(scan(diff(token + ' ' + aws)).output).toBe('fixture.txt:7 github-token\nfixture.txt:7 aws-access-key\n');
  });
  it.each(['unicode', 'hex', 'percent'])('scans %s escaped ASCII without echoing it', encoding => {
    const encoded = [...token].map(char => encoding === 'unicode'
      ? '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
      : (encoding === 'hex' ? '\\x' : '%') + char.charCodeAt(0).toString(16)).join('');
    const result = scan(diff(encoded));
    expect(result.status).toBe(1);
    expect(result.output).toBe('fixture.txt:7 github-token\n');
    expect(result.output).not.toContain(encoded);
  });
  it('scans private JWK structure across added lines and hunks', () => {
    const keyType = 'k' + 'ty';
    const body = JSON.stringify({ [keyType]: 'RSA', ['d']: 'a' + 'bc' }, null, 2).split('\n');
    const input = '--- a/key.json\n+++ b/key.json\n' + body.map((text, i) => `@@ -${i},0 +${i + 1} @@\n+${text}\n`).join('');
    const result = scan(input);
    expect(result.status).toBe(1);
    expect(result.output).toBe('key.json:1 private-key-structure\n');
  });
  it.each([false, true])('rejects private members inserted into an existing public RSA JWK (context=%s)', context => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = privateKey.export({ format: 'jwk' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const members = ['d', 'p', 'q', 'dp', 'dq', 'qi'].map(name => `  ${JSON.stringify(name)}: ${JSON.stringify(jwk[name])},`);
    const publicLines = JSON.stringify(publicJwk, null, 2).split('\n');
    const resulting = [publicLines[0], ...members, ...publicLines.slice(1)].join('\n');
    expect(createPrivateKey({ key: JSON.parse(resulting), format: 'jwk' }).asymmetricKeyType).toBe('rsa');
    expect(keyStructureFinding(Buffer.from(resulting))).toBe('private-key-structure');
    const input = '--- a/key.json\n+++ b/key.json\n'
      + (context ? `@@ -1,${publicLines.length} +1,${publicLines.length + members.length} @@\n ${publicLines[0]}\n` : '@@ -1,0 +2,6 @@\n')
      + members.map(text => `+${text}\n`).join('')
      + (context ? publicLines.slice(1).map(text => ` ${text}\n`).join('') : '');
    const result = scan(input);
    expect(result.status).toBe(1);
    expect(result.output).toBe('key.json:2 private-key-structure\n');
  });
  it.each([false, true])('rejects a value-only replacement under an unchanged private JWK member (context=%s)', context => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const publicLines = JSON.stringify(publicKey.export({ format: 'jwk' }), null, 2).split('\n');
    const before = [...publicLines.slice(0, -1), ', "d":', '""', '}'];
    const after = [...before.slice(0, -2), JSON.stringify(jwk.d), '}'];
    expect(createPrivateKey({ key: JSON.parse(after.join('\n')), format: 'jwk' }).asymmetricKeyType).toBe('ec');
    expect(keyStructureFinding(Buffer.from(after.join('\n')))).toBe('private-key-structure');
    const at = before.length - 1;
    const input = '--- a/key.json\n+++ b/key.json\n'
      + (context ? `@@ -1,${before.length} +1,${after.length} @@\n`
        + before.slice(0, -2).map(text => ` ${text}\n`).join('') : `@@ -${at} +${at} @@\n`)
      + `-""\n+${JSON.stringify(jwk.d)}\n` + (context ? ' }\n' : '');
    const result = scan(input);
    expect(result.output).toBe(`key.json:${at} private-key-structure\n`);
    expect(result.status).toBe(1);
    expect(scan(input, [{ path: 'key.json', rule: 'private-key-structure', reason: 'Generated fixture' }]).status).toBe(0);
  });
  it.each([
    '"abc",', "'abc',", '"\\u0061bc",', '"a" + "bc",',
    '/* value */\r\u2028"abc",', '// value\n"abc",',
  ])('rejects a quoted value fragment with omitted member syntax %#', value => {
    const lines = value.split('\n');
    const input = '--- a/key.json\n+++ b/key.json\n@@ -1 +1 @@\n-old\n+// changed metadata\n'
      + `@@ -10 +10,${lines.length} @@\n-""\n` + lines.map(text => `+${text}\n`).join('');
    expect(scan(input).output).toBe('key.json:1 private-key-structure\n');
  });
  it.each(['"",', "'',", '"description": "clean",', '/* comment */ "description": "clean",'])
    ('keeps empty values and ordinary member fragments clean %#', value => {
      expect(scan(diff(value)).status).toBe(0);
    });
  it.each(['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'])('scans an inserted %s member without its unchanged JWK enclosure or type', name => {
    const value = name === 'oth' ? [Object.fromEntries(['r', 'd', 't'].map(member => [member, 'abc']))] : 'abc';
    const body = `${JSON.stringify(name)}: ${JSON.stringify(value)},`;
    expect(scan(diff(body)).output).toBe('fixture.txt:7 private-key-structure\n');
    expect(scan(diff(body), [{ path: 'fixture.txt', rule: 'private-key-structure', reason: 'Synthetic member fixture' }]).status).toBe(0);
  });
  it.each([
    '"\\u0064": "abc",',
    "\\u0064 /* member */ : 'abc',",
    '"d":\n"abc",',
    '"metadata": {"description":"brace { in a literal"},\n"d":"abc",',
    '{\n"d":"abc",',
    '// brace { in a comment\r\n"d":"abc",',
    '/* brace { in a comment */\n"d":"abc",',
    '// comment\u2028"d":"abc",',
    '"description":"new metadata"\n},\n"d":"abc",\n"more":{',
    '],\n"d":"abc",\n"more":[',
  ])('scans partial JWK members across hunks with escaping, trivia and added containers %#', fragment => {
    const input = '--- a/key.json\n+++ b/key.json\n'
      + fragment.split('\n').map((text, i) => `@@ -${i + 1},0 +${2 * i + 2} @@\n+${text}\n`).join('');
    expect(scan(input).output).toBe('key.json:2 private-key-structure\n');
  });
  it('ignores unchanged/removed private members and keeps public or empty fragments clean', () => {
    for (const text of ['"n":"abc", "e":"AQAB",', '"d":"", "k":"", "oth":[],', '"oth":{},', '"oth":{ /* empty */ },', '"d":0, "p":null,', 'a brace { and ordinary prose', '"description":"literal { and d: text",']) {
      expect(scan(diff(text)).status).toBe(0);
    }
    expect(scan('--- a/key.json\n+++ b/key.json\n@@ -1,2 +1,2 @@\n "d":"abc",\n-"p":"abc",\n+"description":"clean",\n').status).toBe(0);
  });
  it('finds partial JWK members in the real Git diff path with unchanged public key material', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-scan-partial-jwk-'));
    dirs.push(dir);
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = privateKey.export({ format: 'jwk' });
    const publicText = JSON.stringify(publicKey.export({ format: 'jwk' }), null, 2);
    git('init', '-q');
    writeFileSync(join(dir, 'key.json'), publicText);
    git('add', 'key.json');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'public');
    const base = git('rev-parse', 'HEAD').trim();
    const members = ['d', 'p', 'q', 'dp', 'dq', 'qi'].map(name => `  ${JSON.stringify(name)}: ${JSON.stringify(jwk[name])},\n`).join('');
    writeFileSync(join(dir, 'key.json'), publicText.replace('{\n', '{\n' + members));
    git('add', 'key.json');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'private');
    const result = spawnSync(process.execPath, [cli.pathname, '--repo', dir, '--base', base, '--head', 'HEAD'], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('key.json:2 private-key-structure\n');
    expect(result.stderr).toBe('');
  });
  it.each(['pkcs8', 'pkcs1'])('scans raw %s DER bytes in a real Git patch through stdin', type => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048, privateKeyEncoding: { type, format: 'der' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    expect(createPrivateKey({ key: privateKey, type, format: 'der' }).asymmetricKeyType).toBe('rsa');
    expect(keyStructureFinding(privateKey)).toBe('private-key-structure');
    const patch = spawnSync('git', ['diff', '--no-index', '--text', '--unified=0', '/dev/null', '-'], {
      input: privateKey, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(patch.status).toBe(1);
    const result = scan(patch.stdout);
    expect(result.status).toBe(1);
    expect(result.output).toBe('-:1 private-key-structure\n');
  });
  it.each([0x0a, 0x0d, 0xff])('preserves DER line endings and non-UTF-8 bytes (last byte=%i)', last => {
    // Minimal PKCS#1 structure with CR, LF, NUL and invalid UTF-8 inside INTEGERs.
    // A terminal LF belongs to DER, whereas Git's no-newline marker is patch syntax.
    const fields = [0, 0x80, 0x0d, 0x0a, 0, 1, 2, 3, last];
    const bytes = Buffer.from([0x30, fields.length * 3, ...fields.flatMap(value => [2, 1, value])]);
    expect(keyStructureFinding(bytes)).toBe('private-key-structure');
    const patch = spawnSync('git', ['diff', '--no-index', '--text', '--unified=0', '/dev/null', '-'], {
      input: bytes, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(patch.status).toBe(1);
    const result = scan(patch.stdout);
    expect(result.status).toBe(1);
    expect(result.output).toBe('-:1 private-key-structure\n');
  });
  it('redacts credential-bearing paths without suppressing location or rule', () => {
    expect(scan(diff(aws, token + '.txt')).output).toBe('[redacted-path]:7 aws-access-key\n');
    const keyType = 'k' + 'ty';
    const path = JSON.stringify({ [keyType]: 'RSA', ['d']: 'a' + 'bc' });
    const input = `--- a/x\n+++ ${JSON.stringify('b/' + path)}\n@@ -0,0 +7 @@\n+${aws}\n`;
    expect(scan(input).output).toBe('[redacted-path]:7 aws-access-key\n');
    const fragmentPath = '"d":"abc",';
    expect(scan(`--- a/x\n+++ ${JSON.stringify('b/' + fragmentPath)}\n@@ -0,0 +7 @@\n+${aws}\n`).output).toBe('[redacted-path]:7 aws-access-key\n');
    const ordinaryPath = '{"p":"Paragraph"}';
    expect(scan(`--- a/x\n+++ ${JSON.stringify('b/' + ordinaryPath)}\n@@ -0,0 +7 @@\n+${aws}\n`).output)
      .toBe(`${ordinaryPath}:7 aws-access-key\n`);
  });
  it('fails closed on a residual binary notice and redacts its path', () => {
    for (const path of ['image.bin', token + '.bin']) {
      const result = scan(`diff --git a/${path} b/${path}\nBinary files /dev/null and b/${path} differ\n`);
      expect(result.status).toBe(1);
      expect(result.output).toBe(`${path.includes(token) ? '[redacted-path]' : path}:0 unscannable-binary\n`);
    }
  });
  it('uses the requested PR repo, forces binary and -diff text, and ignores PR validator/config copies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-scan-repo-'));
    dirs.push(dir);
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, '.gitattributes'), '*.dat -diff\n');
    writeFileSync(join(dir, 'binary.bin'), '\0' + token);
    writeFileSync(join(dir, 'hidden.dat'), aws);
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    expect(keyStructureFinding(privateKey)).toBe('private-key-structure');
    writeFileSync(join(dir, 'private.der'), privateKey);
    mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
    writeFileSync(join(dir, 'scripts/ci/secret-scan.mjs'), 'process.exit(0);');
    writeFileSync(join(dir, 'scripts/ci/secret-scan-allowlist.json'), JSON.stringify([
      { path: 'binary.bin', rule: 'github-token', reason: 'PR-controlled exemption' },
    ]));
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'head');
    const result = spawnSync(process.execPath, [cli.pathname, '--repo', dir, '--base', base, '--head', 'HEAD'], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('binary.bin:1 github-token');
    expect(result.stdout).toContain('hidden.dat:1 aws-access-key');
    expect(result.stdout).toContain('private.der:1 private-key-structure');
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain(aws);
  });
  it('loads the shipped allowlist', () => {
    const clean = spawnSync(process.execPath, [cli.pathname, '--stdin'], { input: diff('clean'), encoding: 'utf8', timeout: 10_000 });
    expect(clean.status).toBe(0);
  });
});

it('runs an isolated read-only PR workflow using only existing action pins', () => {
  const source = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const workflow = yaml.safeLoad(source);
  const job = workflow.jobs['secret-scan'];
  expect(job).toBeDefined();
  expect(job.name).toBe('secret-scan');
  expect(job.permissions).toEqual({ contents: 'read' });
  expect(job.if).toBe("${{ github.event_name == 'pull_request' }}");
  expect(JSON.stringify(job)).not.toMatch(/secrets\s*\./);
  expect(job.steps.filter(step => step.uses).map(step => step.uses)).toEqual(['actions/checkout@v4', 'actions/checkout@v4', 'actions/setup-node@v4']);
  expect(job.steps[0].with).toMatchObject({ 'fetch-depth': 2,'persist-credentials': false, ref: '${{ github.sha }}' });
  expect(job.steps[1].with).toMatchObject({ ref: '${{ github.event.pull_request.base.sha }}', path: 'trusted', 'persist-credentials': false });
  expect(job.steps[2].with['node-version']).toBe(22);
  const run = job.steps.find(step => step.run);
  expect(run.env).toEqual({ BASE_SHA: '${{ github.event.pull_request.base.sha }}', HEAD_SHA: '${{ github.sha }}' });
  expect(run.run).toContain('node "$scanner" --base "$BASE_SHA" --head "$HEAD_SHA"');
  expect(run.run).toContain('scanner=trusted/scripts/ci/secret-scan.mjs');
  for (const trusted of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'secret-scan-workflow-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
    writeFileSync(join(dir, 'scripts/ci/secret-scan.mjs'), "console.log('fallback scanner');");
    if (trusted) {
      mkdirSync(join(dir, 'trusted/scripts/ci'), { recursive: true });
      writeFileSync(join(dir, 'trusted/scripts/ci/secret-scan.mjs'), "console.log('trusted scanner');");
    }
    const result = spawnSync('bash', ['-e', '-c', run.run], { cwd: dir, env: { ...process.env, BASE_SHA: 'base', HEAD_SHA: 'head' }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    if (trusted) expect(result.stdout).toBe('trusted scanner\n');
    else {
      expect(result.stdout).toContain('fallback scanner\n');
      expect((result.stdout + result.stderr).trim().split('\n')).toHaveLength(2);
      expect(result.stdout + result.stderr).toMatch(/bootstrap/i);
    }
  }
  expect(workflow.jobs.test.needs).not.toContain('secret-scan');
});


it.each([false, true])('runs the workflow with the pre-change trusted scanner (credential=%s)', credential => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-compat-'));
  dirs.push(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'fixture.txt'), credential ? token : 'ordinary text');
  git('add', 'fixture.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'head');
  mkdirSync(join(dir, 'trusted/scripts/ci'), { recursive: true });
  mkdirSync(join(dir, 'trusted/scripts/readiness'), { recursive: true });
  copyFileSync(new URL('./fixtures/secret-scan-pre-repo.txt', import.meta.url), join(dir, 'trusted/scripts/ci/secret-scan.mjs'));
  // The pre-change scanner only reads a bare array; the shipped file is `{ entries }`.
  writeFileSync(join(dir, 'trusted/scripts/ci/secret-scan-allowlist.json'),
    JSON.stringify(JSON.parse(readFileSync(new URL('../secret-scan-allowlist.json', import.meta.url), 'utf8')).entries));
  for (const name of ['forge-exec-manifest.mjs', 'forge-key-structure.mjs']) {
    copyFileSync(new URL('../../readiness/' + name, import.meta.url), join(dir, 'trusted/scripts/readiness', name));
  }
  const workflow = yaml.safeLoad(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const run = workflow.jobs['secret-scan'].steps.find(step => step.run);
  const result = spawnSync('bash', ['-e', '-c', run.run], {
    cwd: dir, env: { ...process.env, BASE_SHA: base, HEAD_SHA: 'HEAD' },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  expect(result.status).toBe(credential ? 1 : 0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(credential ? 'fixture.txt:1 github-token\n' : '');
  expect(result.stdout + result.stderr).not.toContain(token);
});
