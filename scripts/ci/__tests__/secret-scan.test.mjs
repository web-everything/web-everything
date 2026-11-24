// @vitest-environment node
// Register with CI's runner while retaining the standalone node --test entrypoint.
const { afterEach, test } = process.env.VITEST
  ? await import('vitest') : await import('node:test');
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import yaml from 'js-yaml';
import { addedLines, parseRawDiff, secretText } from '../secret-scan.mjs';
import { keyStructureFinding } from '../../readiness/forge-key-structure.mjs';
import { credentialContentFinding, secretText as sharedRules } from '../../readiness/forge-exec-manifest.mjs';

const cli = new URL('../secret-scan.mjs', import.meta.url).pathname;
const token = 'ghp' + '_' + 'a'.repeat(36), aws = 'AKIA' + 'A'.repeat(16);
const dirs = [];
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function repo(initial = {}) {
  const dir = temporary();
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const put = (path, value) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), value);
  };
  const commit = (stage = true) => {
    if (stage) git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  for (const [path, value] of Object.entries(initial)) put(path, value);
  const base = commit();
  const scan = (entries = [], extra = [], env = process.env) => {
    const allowlist = join(temporary(), 'allowlist.json');
    writeFileSync(allowlist, JSON.stringify({ entries }));
    const result = spawnSync(process.execPath, [cli, '--repo', dir, '--base', base, '--head', 'HEAD', '--allowlist', allowlist, ...extra], {
      cwd: tmpdir(), env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    const output = result.stdout + result.stderr;
    assert.ok(!output.includes(token) && !output.includes(aws), 'output must suppress synthetic credentials');
    return { ...result, output };
  };
  return { dir, git, put, commit, base, scan };
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exemption = (path, rule, bytes = token) => ({ path, rule, sha256: sha256(bytes), reason: 'Obviously fake scanner fixture, reviewed for this test' });
// Assemble synthetic JWKs at runtime so this credential-named test source can ship to Forge.
const jwk = (members, space) => JSON.stringify(Object.fromEntries([['kty', 'RSA'], ...members]), null, space);
const privateJwk = jwk([['d', 'FAKE_TEST_ONLY']]);

// Build source strings at runtime so this file itself contains no private JWK.
const templateJwk = (key, members) => 'export default {' + Object.entries(key).map(([name, value]) =>
  JSON.stringify(name) + ':' + (members.includes(name) ? '`' + value + '`' : JSON.stringify(value))).join(',') + '};';
// Each real-Git/CLI probe gets its own test deadline and fixture cleanup.
for (const tag of ['String.raw', 'String["raw"]', '(String.raw)', '(0, String.raw)',
    'String /* tag */ . raw\n', 'String\r.raw', 'String\u2028.\u2029raw', 'String["r" + "aw"]',
    '(() => String.raw)()', '(chunks => chunks[0])', 'Str\\u0069ng.raw',
    '((Str\u200cing) => Str\u200cing.raw)(String)', '((Ｓ) => Ｓ.raw)(String)']) {
  for (const members of [['k'], ['kty'], ['kty', 'k']]) {
    test('usable String.raw and expression-tagged JWK values fail the whole-file scan: '
      + JSON.stringify(tag) + ' members=' + members.join(','), async () => {
      const key = Object.fromEntries([['kty', 'oct'], ['k', Buffer.alloc(16, 97).toString('base64url')]]);
      const algorithm = { name: 'HMAC', hash: 'SHA-256' };
      const source = templateJwk(key, members).replaceAll(':`', ':' + tag + '`');
      const actual = runInNewContext('(' + source.slice('export default '.length, -1) + ')');
      const imported = await webcrypto.subtle.importKey('jwk', actual, algorithm, false, ['sign']);
      assert.ok((await webcrypto.subtle.sign(algorithm, imported, Buffer.from('probe'))).byteLength);
      const r = repo(); r.put('tagged.mjs', source); r.commit();
      const result = r.scan();
      assert.equal(result.status, 1, tag);
      assert.equal(result.stdout, 'tagged.mjs:0 private-key-structure\n', tag);
      assert.ok(!result.output.includes(key.k));
    });
  }
}
test('value-only tagged edits in nested objects fail while ordinary tags pass', () => {
  const key = Object.fromEntries([['kty', 'oct'], ['k', 'FAKE']]);
  const before = templateJwk(key, []);
  const after = templateJwk(key, ['k']).replaceAll(':`', ':String.raw`');
  const wrap = source => 'export default [{payload:' + source.slice('export default '.length, -1) + '}];';
  const r = repo({ 'key.mjs': wrap(before) }); r.put('key.mjs', wrap(after)); r.commit();
  assert.equal(r.scan().stdout, 'key.mjs:0 private-key-structure\n');
  const wrappedCall = repo();
  wrappedCall.put('key.mjs', 'export default {wrapped:fn(' + after.slice('export default '.length, -1) + ', `label`)};');
  wrappedCall.commit(); assert.equal(wrappedCall.scan().stdout, 'key.mjs:0 private-key-structure\n');
  const ordinary = repo();
  ordinary.put('ordinary.mjs', templateJwk({ k: 'click', label: 'hello' }, ['k', 'label']).replaceAll(':`', ':String.raw`'));
  ordinary.commit(); assert.equal(ordinary.scan().status, 0);
});
test('template normalization nesting exhaustion fails closed with manual-review rule', () => {
  const r = repo(); r.put('deep.mjs', '('.repeat(65) + '`ordinary`' + ')'.repeat(65)); r.commit();
  assert.equal(r.scan().stdout, 'deep.mjs:0 private-key-scan-budget-exhausted-use-local\n');
});
test('tagged templates reach independent scanning, private members and filename redaction', () => {
  for (const member of ['k', 'd', 'p', 'q', 'dp', 'dq', 'qi']) {
    const key = Object.fromEntries([['kty', member === 'k' ? 'oct' : 'RSA'], [member, 'FAKE']]);
    const source = templateJwk(key, [member]).replaceAll(':`', ':String.raw`');
    const r = repo(); r.put('tagged.mjs', 'const pattern = /"/; ' + source + ' const label = "text";'); r.commit();
    assert.equal(r.scan().stdout, 'tagged.mjs:0 private-key-structure\n', member);
  }
  const source = templateJwk(Object.fromEntries([['kty', 'oct'], ['k', 'FAKE']]), ['k']).replaceAll(':`', ':String.raw`');
  const r = repo(); r.put(source + '.mjs', privateJwk); r.commit();
  assert.equal(r.scan().stdout, '[redacted-path]:0 private-key-structure\n');
});
test('usable HMAC and Ed25519 JWKs with template-literal values fail the CLI scan', async () => {
  const oct = Object.fromEntries([['kty', 'oct'], ['k', Buffer.alloc(16, 97).toString('base64url')]]);
  const ed = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  for (const [key, algorithm, variants] of [
    [oct, { name: 'HMAC', hash: 'SHA-256' }, [['k'], ['kty'], ['kty', 'k']]],
    [ed, { name: 'Ed25519' }, [['d'], ['kty'], ['kty', 'd']]],
  ]) {
    for (const members of variants) {
      const source = templateJwk(key, members);
      const actual = runInNewContext('(' + source.slice('export default '.length, -1) + ')');
      const imported = await webcrypto.subtle.importKey('jwk', actual, algorithm, false, ['sign']);
      assert.ok((await webcrypto.subtle.sign(algorithm, imported, Buffer.from('probe'))).byteLength);
      const r = repo(); r.put('signing-key.mjs', source); r.commit();
      const result = r.scan();
      assert.equal(result.status, 1, 'reject template values for ' + members.join(','));
      assert.equal(result.stdout, 'signing-key.mjs:0 private-key-structure\n');
      assert.ok(!result.output.includes(key.d ?? key.k), 'never echo key material');
    }
  }
});
test('escaped template values and value-only template edits fail the whole-file scan', () => {
  const before = templateJwk(Object.fromEntries([['kty', 'oct'], ['k', 'FAKE_OLD']]), []);
  const r = repo({ 'key.mjs': before });
  const source = templateJwk(Object.fromEntries([['kty', '\\x6f\\u0063\\u{74}'], ['k', 'FAKE\\\n_TEST']]), ['kty', 'k']);
  r.put('key.mjs', source); r.commit();
  assert.equal(r.scan().stdout, 'key.mjs:0 private-key-structure\n');
});
test('template text containing syntax cannot hide a later private member', () => {
  const r = repo();
  r.put('key.mjs', templateJwk(Object.fromEntries([['note', 'quote" brace} comment/* escaped\\`'], ['kty', 'oct'], ['k', 'FAKE']]), ['note', 'k']));
  r.commit();
  assert.equal(r.scan().stdout, 'key.mjs:0 private-key-structure\n');
});
test('ordinary template values and templates inside quoted text pass', () => {
  const r = repo();
  r.put('ordinary.mjs', 'export default {k:`click`, label:`quote" brace} comment/*`};\n' + JSON.stringify('prose `with` delimiters'));
  r.commit();
  assert.equal(r.scan().status, 0);
});
test('each private JWK member stays detectable in nested objects with template values', () => {
  for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
    const key = Object.fromEntries([['kty', member === 'k' ? 'oct' : 'RSA'], [member, 'FAKE']]);
    const source = templateJwk(key, [member]).slice('export default '.length, -1);
    const r = repo(); r.put('key.mjs', 'export default [\n/* existing */\n' + source + '\n];'); r.commit();
    assert.equal(r.scan().stdout, 'key.mjs:0 private-key-structure\n', member);
  }
});
test('opaque template interpolation cannot make private JWK material pass', () => {
  const key = Object.fromEntries([['kty', '${"oc" + "t"}'], ['k', '${"FAKE"}']]);
  const r = repo(); r.put('key.mjs', templateJwk(key, ['kty', 'k'])); r.commit();
  assert.equal(r.scan().stdout, 'key.mjs:0 private-key-structure\n');
});
test('template JWKs in filenames are redacted by the same structure adapter', () => {
  const key = Object.fromEntries([['kty', 'oct'], ['k', 'FAKE']]);
  const path = templateJwk(key, ['k']).slice('export default '.length, -1) + '.mjs';
  const r = repo(); r.put(path, privateJwk); r.commit();
  assert.equal(r.scan().stdout, '[redacted-path]:0 private-key-structure\n');
});
test('quotes in a preceding regex cannot hide a template-literal JWK', () => {
  const key = Object.fromEntries([['kty', 'oct'], ['k', 'FAKE']]);
  const r = repo();
  r.put('key.mjs', 'const pattern = /"/; ' + templateJwk(key, ['k']) + ' const label = "text";');
  r.commit();
  assert.equal(r.scan().stdout, 'key.mjs:0 private-key-structure\n');
});

test('DER key added as binary preserves NUL, CR, LF and invalid UTF-8 bytes', () => {
  const r = repo();
  // Deliberately tiny, unusable PKCS#1 integers: no generated or real secret.
  const fields = [0, 0x80, 0x0d, 0x0a, 0, 1, 2, 3, 0xff];
  r.put('key.der', Buffer.from([0x30, fields.length * 3, ...fields.flatMap(value => [2, 1, value])]));
  r.commit();
  const result = r.scan();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'key.der:0 private-key-structure\n');
});
test('public JWK with d,p,q,dp,dq,qi inserted fails', () => {
  const r = repo({ 'key.json': '{\n"kty":"RSA",\n"n":"FAKE_PUBLIC",\n"e":"AQAB"\n}' });
  r.put('key.json', JSON.stringify({ kty: 'RSA', n: 'FAKE_PUBLIC', e: 'AQAB', ...Object.fromEntries(['d', 'p', 'q', 'dp', 'dq', 'qi'].map(name => [name, 'FAKE_TEST_ONLY'])) }, null, 2));
  r.commit();
  assert.equal(r.scan().status, 1);
});
test('d added after an unchanged closing block comment fails', () => {
  const before = 'const key = {\nkty:"RSA",\n/* existing comment\nunchanged\n*/\n};\n';
  const r = repo({ 'key.js': before });
  r.put('key.js', before.replace('existing', 'updated').replace('};', 'd:"FAKE_TEST_ONLY",\n};'));
  r.commit();
  assert.match(r.scan().stdout, /private-key-structure/);
});
test('value-only replacement of d in an existing private JWK fails', () => {
  const before = jwk([['d', 'FAKE_OLD']], 2).replace(': "FAKE_OLD"', ':\n"FAKE_OLD"');
  const r = repo({ 'key.json': before });
  r.put('key.json', before.replace('FAKE_OLD', 'FAKE_NEW'));
  r.commit();
  assert.equal(r.scan().status, 1);
});
for (const ordinary of ['{"p":"Paragraph"}', "{k:'click'}"]) test(`ordinary object ${ordinary} passes`, () => {
  const r = repo(); r.put('ordinary.js', ordinary); r.commit();
  assert.equal(r.scan().status, 0);
});
test('allowlisted fixture renamed to a different path is fully scanned', () => {
  const r = repo({ 'fixture.json': privateJwk });
  renameSync(join(r.dir, 'fixture.json'), join(r.dir, 'moved.json')); r.commit();
  assert.equal(r.scan([exemption('fixture.json', 'private-key-structure', privateJwk)]).status, 1);
});
test('3 MiB lockfile requires an exact oversize exemption with a reason', () => {
  const r = repo(); r.put('package-lock.json', ' '.repeat(3 * 1024 * 1024)); r.commit();
  assert.equal(r.scan().stdout, 'package-lock.json:0 unscanned-oversize\n');
  assert.equal(r.scan().status, 1);
  assert.equal(r.scan([exemption('package-lock.json', 'unscanned-oversize', ' '.repeat(3 * 1024 * 1024))]).status, 0);
  assert.equal(r.scan([exemption('other.json', 'unscanned-oversize')]).status, 1);
  assert.equal(r.scan([{ path: 'package-lock.json', rule: 'unscanned-oversize', reason: '' }]).status, 1);
});
test('escaped AWS key is scanned after decoding', () => {
  const r = repo(); r.put('escaped.txt', [...aws].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')); r.commit();
  assert.equal(r.scan().stdout, 'escaped.txt:1 aws-access-key\n');
});
test('token plus newline in filename is parsed and path redacted', () => {
  const r = repo(); r.put(token + '\n.txt', aws); r.commit();
  const result = r.scan();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '[redacted-path]:0 github-token\n[redacted-path]:1 aws-access-key\n');
});
test('bad base ref and hunk-count mismatch fail closed without source echo', () => {
  const r = repo(); r.put('source.txt', token); r.commit();
  const bad = r.scan([], ['--base', 'missing-' + token]);
  assert.equal(bad.status, 1); assert.equal(bad.stdout, '');
  // All other calls use the real repository; only the per-file patch is corrupted.
  const bin = temporary(), realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nif(process.argv.includes('-U0')) {process.stdout.write('@@ -0,0 +1,2 @@\\n+' + ${JSON.stringify(token)} + '\\n');} else {const r=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status ?? 1);}\n`, { mode: 0o755 });
  const mismatch = r.scan([], [], { ...process.env, PATH: bin + delimiter + process.env.PATH });
  assert.equal(mismatch.status, 1); assert.equal(mismatch.stdout, '');
  assert.match(mismatch.stderr, /incomplete input/);
});
test('clean PNG and submodule bump pass', () => {
  const r = repo();
  r.git('update-index', '--add', '--cacheinfo', '160000', r.base, 'submodule');
  const submoduleBase = r.commit(false);
  r.put('image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  r.git('add', 'image.png');
  r.git('update-index', '--cacheinfo', '160000', submoduleBase, 'submodule'); r.commit(false);
  assert.match(r.git('diff', '--raw', submoduleBase + '...HEAD'), /:160000 160000 .* M\tsubmodule/);
  assert.equal(r.scan([], ['--base', submoduleBase]).status, 0);
});
test('prepending NUL cannot turn a detectable credential into a passing scan', () => {
  for (const prefix of ['', '\0']) {
    const r = repo(); r.put('credential.bin', prefix + token); r.commit();
    const result = r.scan(); assert.equal(result.status, 1);
    assert.equal(result.stdout, 'credential.bin:1 github-token\n');
  }
});
test('binary additions also scan decoded text credentials', () => {
  const r = repo(); r.put('credential.bin', '\0' + [...aws].map(c => '\\x' + c.charCodeAt(0).toString(16)).join('')); r.commit();
  const result = r.scan(); assert.equal(result.status, 1);
  assert.equal(result.stdout, 'credential.bin:1 aws-access-key\n');
});
test('token added then removed within the PR passes (net-diff non-claim)', () => {
  const r = repo({ 'README.md': 'before\n' });
  r.put('README.md', token); r.commit();
  r.put('README.md', 'after\n'); r.commit();
  assert.equal(r.scan().status, 0);
});
test('clean README edit and empty diff pass; shipped allowlist loads', () => {
  const r = repo({ 'README.md': 'before\n' });
  assert.equal(r.scan().status, 0);
  r.put('README.md', 'after\n'); r.commit();
  assert.equal(r.scan().status, 0);
  assert.equal(r.scan([], ['--allowlist', new URL('../secret-scan-allowlist.json', import.meta.url).pathname]).status, 0);
});
test('uses identical shared rules and reports each raw or encoded token without source', () => {
  assert.equal(secretText, sharedRules);
  for (const encoding of ['raw', 'hex', 'percent']) {
    const r = repo();
    const text = encoding === 'raw' ? token + ' ' + aws : [...token].map(c => (encoding === 'hex' ? '\\x' : '%') + c.charCodeAt(0).toString(16)).join('');
    r.put('fixture.txt', text); r.commit();
    assert.equal(r.scan().status, 1);
    assert.match(r.scan().stdout, /fixture.txt:1 github-token/);
    if (encoding === 'raw') assert.match(r.scan().stdout, /aws-access-key/);
    assert.equal(r.scan([exemption('fixture.txt', 'github-token', text)]).status, encoding === 'raw' ? 1 : 0);
  }
});
test('removed/context tokens are ignored; header-like added text is scanned', () => {
  const r = repo({ 'x': token + '\nold\n' });
  r.put('x', token + '\nnew\n'); r.commit(); assert.equal(r.scan().status, 0);
  r.put('x', '++ ' + aws); r.commit(); assert.equal(r.scan().stdout, 'x:1 aws-access-key\n');
});
test('exact Unicode paths match exemptions and control characters are escaped', () => {
  const r = repo(); r.put('café.txt', token); r.put('x\u001b.txt', aws); r.commit();
  const result = r.scan([exemption('café.txt', 'github-token')]);
  assert.equal(result.status, 1); assert.equal(result.stdout, '"x\\u001b.txt":1 aws-access-key\n');
});
test('whole-file exemptions are exact and deleted files are ignored', () => {
  const r = repo({ 'removed.json': privateJwk });
  rmSync(join(r.dir, 'removed.json')); r.put('fixture.json', privateJwk); r.commit();
  assert.equal(r.scan([exemption('fixture.json', 'private-key-structure', privateJwk)]).status, 0);
  assert.equal(r.scan([exemption('fixture.json', 'github-token')]).status, 1);
});
test('literal pathspecs cannot hide a token in a bracket or wildcard filename', () => {
  const r = repo(); r.put('[a]*.txt', token); r.commit();
  assert.equal(r.scan().stdout, '[a]*.txt:1 github-token\n');
});
test('invalid allowlists, unknown arguments, stdin and unreadable config fail closed', () => {
  const r = repo();
  for (const entry of [exemption('*', 'github-token'), exemption('x', 'unknown'), exemption('x', 'unscannable-binary'), { path: 'x', rule: 'github-token' }]) assert.equal(r.scan([entry]).status, 1);
  for (const extra of [['--stdin'], ['--unknown', token], ['--allowlist', 'missing']]) assert.equal(r.scan([], extra).status, 1);
});
test('more than 500 changed files fails with manual-review fallback', () => {
  const r = repo(); for (let i = 0; i < 501; i++) r.put(`f${i}`, 'clean'); r.commit();
  const result = r.scan(); assert.equal(result.status, 1); assert.match(result.stderr, /review the full diff manually/);
});
test('test source ships to Forge without an exemption while runtime JWK fixtures remain detectable', () => {
  const source = readFileSync(new URL('./secret-scan.test.mjs', import.meta.url));
  assert.equal(keyStructureFinding(source), null);
  assert.equal(credentialContentFinding(Buffer.from('scripts/ci/__tests__/secret-scan.test.mjs'), source), null);
  assert.equal(keyStructureFinding(Buffer.from(privateJwk)), 'private-key-structure');
  const { entries } = JSON.parse(readFileSync(new URL('../secret-scan-allowlist.json', import.meta.url), 'utf8'));
  assert.ok(!entries.some(e => e.path === 'scripts/ci/__tests__/secret-scan.test.mjs'));
  const r = repo(); r.put('scripts/ci/__tests__/secret-scan.test.mjs', source); r.commit();
  assert.equal(r.scan().status, 0);
});
test('text attributes cannot hide tokens and PR scanner/config copies are ignored', () => {
  const r = repo(); r.put('.gitattributes', '*.dat -diff\n'); r.put('hidden.dat', aws);
  r.put('scripts/ci/secret-scan.mjs', 'process.exit(0);');
  r.put('scripts/ci/secret-scan-allowlist.json', JSON.stringify({ entries: [exemption('hidden.dat', 'aws-access-key')] }));
  r.commit(); const result = r.scan(); assert.equal(result.status, 1); assert.match(result.stdout, /hidden.dat:1 aws-access-key/);
});
test('current trusted scanner ignores PR allowlist without --allowlist', () => {
  const r = repo();
  const trustedEntry = exemption('trusted-fixture.txt', 'github-token', token);
  const prEntry = exemption('pr-secret.txt', 'github-token', token);
  r.put('trusted-fixture.txt', token);
  r.put('pr-secret.txt', token);
  r.put('scripts/ci/secret-scan-allowlist.json', JSON.stringify({ entries: [trustedEntry, prEntry] }));
  r.commit();

  // Mirror CI's trusted checkout using the current scanner, not the historical fixture.
  const trusted = join(r.dir, 'trusted/scripts');
  mkdirSync(join(trusted, 'ci'), { recursive: true });
  mkdirSync(join(trusted, 'readiness'), { recursive: true });
  copyFileSync(cli, join(trusted, 'ci/secret-scan.mjs'));
  for (const name of ['forge-exec-manifest.mjs', 'forge-key-structure.mjs']) {
    copyFileSync(new URL('../../readiness/' + name, import.meta.url), join(trusted, 'readiness', name));
  }
  writeFileSync(join(trusted, 'ci/secret-scan-allowlist.json'), JSON.stringify({ entries: [trustedEntry] }));
  const args = [join(trusted, 'ci/secret-scan.mjs'), '--base', r.base, '--head', 'HEAD'];
  const invoke = (cwd, extra = []) => {
    const result = spawnSync(process.execPath, [...args, ...extra], {
      cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, '');
    return result;
  };
  // Both cwd-based CI usage and an explicit --repo must resolve config beside the scanner.
  for (const [cwd, extra] of [[r.dir, []], [temporary(), ['--repo', r.dir]]]) {
    const result = invoke(cwd, extra);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'pr-secret.txt:1 github-token\n');
  }
  // Prove the conflicting PR exemption really matches the committed bytes.
  const control = invoke(r.dir, ['--allowlist', join(r.dir, 'scripts/ci/secret-scan-allowlist.json')]);
  assert.equal(control.status, 0);
  assert.equal(control.stdout, '');
});
test('strict NUL records and hunk counts refuse incomplete or unknown data', () => {
  for (const raw of ['bad', ':100644 100644 ' + 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' R100\0x\0y\0', ':bad\0x\0']) assert.throws(() => parseRawDiff(Buffer.from(raw)), /incomplete input/);
  for (const patch of ['@@ -0,0 +1,2 @@\n+fake\n', '@@ -1 +1 @@\n+fake\n', '@@ -0,0 +1 @@\n+fake\n+extra\n']) assert.throws(() => addedLines(Buffer.from(patch)), /incomplete input/);
});

const workflow = yaml.safeLoad(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
test('isolated read-only PR workflow keeps existing pins, trusted scanner and bootstrap', () => {
  const job = workflow.jobs['secret-scan'];
  assert.equal(job.name, 'secret-scan'); assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.if, "${{ github.event_name == 'pull_request' }}");
  assert.doesNotMatch(JSON.stringify(job), /secrets\s*\./);
  assert.deepEqual(job.steps.filter(s => s.uses).map(s => s.uses), ['actions/checkout@v4', 'actions/checkout@v4', 'actions/setup-node@v4']);
  assert.deepEqual(job.steps[0].with, { ref: '${{ github.sha }}', 'fetch-depth': 2, 'persist-credentials': false });
  assert.deepEqual(job.steps[1].with, { ref: '${{ github.event.pull_request.base.sha }}', path: 'trusted', 'persist-credentials': false });
  assert.equal(job.steps[2].with['node-version'], 22);
  const run = job.steps.find(s => s.run);
  assert.deepEqual(run.env, { BASE_SHA: '${{ github.event.pull_request.base.sha }}', HEAD_SHA: '${{ github.sha }}' });
  assert.ok(run.run.includes('node "$scanner" --base "$BASE_SHA" --head "$HEAD_SHA"'));
  assert.ok(run.run.includes('scanner=trusted/scripts/ci/secret-scan.mjs')); assert.doesNotMatch(run.run, /--stdin/);
  for (const trusted of [true, false]) {
    const dir = temporary(); mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
    writeFileSync(join(dir, 'scripts/ci/secret-scan.mjs'), "console.log('fallback scanner');");
    if (trusted) { mkdirSync(join(dir, 'trusted/scripts/ci'), { recursive: true }); writeFileSync(join(dir, 'trusted/scripts/ci/secret-scan.mjs'), "console.log('trusted scanner');"); }
    const result = spawnSync('bash', ['-e', '-c', run.run], { cwd: dir, env: { ...process.env, BASE_SHA: 'base', HEAD_SHA: 'head' }, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    if (trusted) assert.equal(result.stdout, 'trusted scanner\n');
    else { assert.match(result.stdout, /bootstrap/); assert.match(result.stdout, /fallback scanner/); }
  }
  assert.ok(!workflow.jobs.test.needs.includes('secret-scan'));
});
test('workflow remains compatible with the pre-change trusted scanner', () => {
  for (const credential of [false, true]) {
    const r = repo(); r.put('fixture.txt', credential ? token : 'clean'); r.commit();
    mkdirSync(join(r.dir, 'trusted/scripts/ci'), { recursive: true }); mkdirSync(join(r.dir, 'trusted/scripts/readiness'), { recursive: true });
    copyFileSync(new URL('./fixtures/secret-scan-pre-repo.txt', import.meta.url), join(r.dir, 'trusted/scripts/ci/secret-scan.mjs'));
    // Pair the historical scanner with its text-only allowlist schema.
    const historicalEntries = JSON.parse(readFileSync(new URL('../secret-scan-allowlist.json', import.meta.url), 'utf8')).entries.filter(entry => sharedRules.some(([, rule]) => rule === entry.rule)).map(({ sha256, ...entry }) => entry);
    writeFileSync(join(r.dir, 'trusted/scripts/ci/secret-scan-allowlist.json'), JSON.stringify(historicalEntries));
    for (const name of ['forge-exec-manifest.mjs', 'forge-key-structure.mjs']) copyFileSync(new URL('../../readiness/' + name, import.meta.url), join(r.dir, 'trusted/scripts/readiness', name));
    const result = spawnSync('bash', ['-e', '-c', workflow.jobs['secret-scan'].steps.find(s => s.run).run], { cwd: r.dir, env: { ...process.env, BASE_SHA: r.base, HEAD_SHA: 'HEAD' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, credential ? 1 : 0); assert.equal(result.stderr, '');
    assert.equal(result.stdout, credential ? 'fixture.txt:1 github-token\n' : '');
  }
});

test('oversize exemption skips structure scanning but still rejects added tokens', () => {
  const padding = ' '.repeat(3 * 1024 * 1024) + '\n';
  const r = repo({ 'large.txt': padding });
  const content = padding + token + '\n';
  r.put('large.txt', content); r.commit();
  const result = r.scan([exemption('large.txt', 'unscanned-oversize', content)]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'large.txt:2 github-token\n');
});
test('scanner budget exhaustion fails and cannot be allowlisted', () => {
  const content = '['.repeat(65) + ']'.repeat(65);
  const r = repo(); r.put('nested.json', content); r.commit();
  const result = r.scan();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'nested.json:0 private-key-scan-budget-exhausted-use-local\n');
  const exempt = r.scan([exemption('nested.json', 'private-key-scan-budget-exhausted-use-local', content)]);
  assert.equal(exempt.status, 1); assert.match(exempt.stderr, /invalid allowlist/);
});
test('exemptions pin committed blob bytes and refuse a changed blob', () => {
  const r = repo(); r.put('fixture.txt', token); r.commit();
  const entry = exemption('fixture.txt', 'github-token', token);
  assert.equal(r.scan([entry]).status, 0);
  r.put('fixture.txt', token + ' changed'); r.commit();
  // A worktree copy matching the old digest cannot exempt the committed blob.
  r.put('fixture.txt', token);
  const result = r.scan([entry]);
  assert.equal(result.status, 1); assert.equal(result.stdout, 'fixture.txt:1 github-token\n');
});
test('missing, malformed sha256 and unknown allowlist keys fail closed', () => {
  const r = repo(); r.put('fixture.txt', token); r.commit();
  const entry = exemption('fixture.txt', 'github-token');
  const { sha256: omitted, ...missing } = entry;
  for (const invalid of [missing, ...['', 'a'.repeat(63), 'g'.repeat(64), 123].map(sha256 => ({ ...entry, sha256 })), { ...entry, extra: true }]) {
    const result = r.scan([invalid]);
    assert.equal(result.status, 1); assert.match(result.stderr, /invalid allowlist/);
  }
});
for (const form of ['point', 'unicode', 'hex', 'mixed']) test(`escaped token decoded from ${form} fails`, () => {
  const r = repo();
  const forms = [c => '\\u{' + c.codePointAt(0).toString(16) + '}',
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')];
  const content = [...token].map((c, i) => forms[form === 'mixed' ? i % 3 : ['point', 'unicode', 'hex'].indexOf(form)](c)).join('');
  r.put('escaped.txt', content); r.commit();
  const result = r.scan(); assert.equal(result.status, 1);
  assert.match(result.stdout, /escaped.txt:1 github-token/);
});
test('token in filename alone fails and the reported path is redacted', () => {
  const r = repo(); r.put(token + '.txt', 'clean'); r.commit();
  const result = r.scan(); assert.equal(result.status, 1);
  assert.equal(result.stdout, '[redacted-path]:0 github-token\n');
});
