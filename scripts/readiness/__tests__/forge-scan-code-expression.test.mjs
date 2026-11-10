// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { credentialContentFinding } from '../forge-exec-manifest.mjs';

const scan = (text, path = 'scripts/lib/example.mjs') => credentialContentFinding(Buffer.from(path), Buffer.from(text));
const literal = 'abcdefghij0123456789XYZ';

// Forge fell back to the loaded Mac when ordinary source lines such as `keys: [index], at: r.at, action });`
// tripped the high-entropy-assignment rule: a code expression or prose sentence is not one opaque secret.
describe('credentialContentFinding code expressions and prose', () => {
  it.each([
    '              keys: [index], at: r.at, action });',
    '          jobKey: p.jobKey, head: p.head, session, coordinationRoot });',
    '    inputsKey: plan.inputsKey, mainSha: plan.mainSha, applied: plan.applied, verified: true,',
  ])('does not flag an unquoted key-named field with an expression value (%s)', line => {
    expect(scan(`${line}\n`)).toBeNull();
  });

  it.each([
    `key: ${literal}`,
    `signing_key = "${literal}"`,
    `apiKey: '${literal} with spaces'`,
    `key: ${literal}${literal}`,
  ])('still flags a contiguous or quoted literal secret (%s)', line => {
    expect(scan(`${line}\n`)).not.toBeNull();
  });
});

// R824/R825 whitespace-exemption boundaries: one row per exemption clause, each with the outcome it promises.
// Rows hold only the value; the test body prefixes the key name, so this file has no `name: value` lines of
// its own for the scan to read. The fixture literal is not a real credential.
describe('credentialContentFinding whitespace-exemption boundaries', () => {
  const flagged = 'high-entropy-signing_key';
  it.each([
    ['source file, opaque token then trailing comment', 'x.js', '=', `${literal} // note`],
    ['source file, opaque token then parenthetical', 'x.js', ':', `${literal} (rotated)`],
    ['markdown, opaque token then trailing word', 'notes.md', ':', `${literal} # prod`],
    ['YAML keeps the full rule', 'config/x.yml', ':', `has some words ${literal}`],
    ['INI keeps the full rule', 'config/x.ini', '=', `has some words ${literal}`],
    ['plain-text config keeps the full rule', 'config/x.conf', ':', `has some words ${literal}`],
    ['GitHub expression with a literal in source', 'x.mjs', ':', "${{ 'abcdefghij0123456789XYZ' }} tail"],
    ['GitHub expression with a literal in markdown', 'notes.md', ':', "${{ 'abcdefghij0123456789XYZ' }} tail"],
    ['double quote in source', 'x.mjs', ':', `say "${literal}" now`],
    ['single quote in source', 'x.mjs', ':', `say '${literal}' now`],
    ['backtick in source', 'x.mjs', ':', `say \`${literal} with spaces\``],
    ['backtick in markdown', 'notes.md', ':', `say \`${literal} with spaces\``],
    ['double quote in markdown', 'notes.md', ':', `say "${literal}" now`],
    ['single-quoted literal in markdown', 'notes.md', ':', `say '${literal}' now`],
    ['single-quoted spaced credential in markdown', 'notes.md', ':', "'aB3dE5fG7h J9kL2mN4pQ6 rS8tU0vW2xY'"],
    ['backticked spaced credential in markdown', 'notes.md', ':', '`aB3dE5fG7h J9kL2mN4pQ6 rS8tU0vW2xY`'],
    ['spaced credential embedded in markdown prose', 'notes.md', ':', "use 'aB3dE5fG7h J9kL2mN4pQ6 rS8tU0vW2xY' here"],
  ])('flags: %s', (_name, path, sep, value) => {
    expect(scan(`signing_key${sep} ${value}\n`, path)).toBe(flagged);
  });

  it.each([
    ['source expression', 'x.mjs', 'keys: [index], at: r.at, action });'],
    ['markdown prose with an apostrophe', 'notes.md', "key: it's a short note about the config surface"],
    ['short markdown code span', 'notes.md', 'key: `foo bar`'],
    // The original Forge fallback line; it comes from a markdown file, where backticks are code spans.
    ['markdown prose with code spans (the original fallback line)', 'notes.md', 'key=value` config surface (`codex exec --help`, or grep the installed binary)'],
    ['markdown prose with code spans', 'notes.md', 'key: see `codex exec --help` or grep the installed binary for it'],
  ])('allows: %s', (_name, path, line) => {
    expect(scan(`${line}\n`, path)).toBeNull();
  });
});

// Ruled residual (R824/R825, card x5b2hyl): in a TEST file an unquoted contiguous value followed by a call or
// arrow is read as a code expression, and so is a quoted literal beside a call. Pinned so that changing the
// shape is a decision, not an accident. Non-test files keep the full rule.
describe('credentialContentFinding test-file code expression residuals', () => {
  const testPath = 'scripts/lib/example.test.mjs';
  it.each([
    ['unquoted value then call', `${literal}(x)`],
    ['unquoted value then arrow', `${literal} => x`],
    ['quoted literal beside a call', `f('${literal}')`],
  ])('pins the ruled test-file residual: %s', (_name, value) => {
    expect(scan(`creds: ${value}\n`, testPath)).toBeNull();
  });

  it('applies the residual to test files only', () => {
    expect(scan(`creds: ${literal}(x)\n`, 'scripts/lib/example.mjs')).toBe('high-entropy-creds');
  });
});

describe('credentialContentFinding narrow source exemptions', () => {
  const testPath = 'scripts/lib/example.test.mjs';
  const scannerPath = 'scripts/readiness/forge-exec-manifest.mjs';
  const token = 'AbC9dE2fG5hJ8kL1mN4p'.repeat(2);
  const pem = ['-----' + 'BEGIN PRIVATE' + ' KEY-----', Buffer.from(token).toString('base64'), '-----' + 'END PRIVATE' + ' KEY-----'].join('\n');

  it.each([
    "  GITHUB_TOKEN: 'secret-token-marker', ANTHROPIC_API_KEY: 'secret-key-marker',",
    "  GITHUB_TOKEN: 'github', SERVICE_TOKEN: 'token', SERVICE_SECRET: 'secret', SERVICE_KEY: 'key', NODE_API_KEY: 'key' };",
  ])('allows short object fixture values in test files: %s', line => {
    expect(scan(line, testPath)).toBeNull();
    expect(scan(line)).not.toBeNull();
  });
  it('allows a source hash call chain', () => {
    expect(scan("WE_GH_AUTH_TOKEN_HASH: createHash('sha256').update(token).digest('hex'),")).toBeNull();
  });
  it('allows a source template with short static and quoted parts', () => {
    expect(scan("readerKey = `reader:${basename(String(entries?.[0] || 'daemon'))}`, ")).toBeNull();
  });
  it('exempts pattern text only at the scanner path', () => {
    const pattern = '/' + '-----' + 'BEGIN/';
    expect(scan(pattern, scannerPath)).toBeNull();
    expect(scan(pattern)).toBe('pem-header');
    expect(scan(pattern, 'other/' + scannerPath)).toBe('pem-header');
    expect(scan(readFileSync(new URL('../forge-exec-manifest.mjs', import.meta.url)), scannerPath)).toBeNull();
  });
  it.each([testPath, 'scripts/lib/example.mjs'])('still catches real literal tokens in %s', path => {
    expect(token).toHaveLength(40);
    for (const value of [token, `'${token}'`, `f('${token}')`, `\`reader:${token}\``, `\`reader:\${f('${token}')}\``, `\`\${/${token}/.source}\``]) {
      // The existing test-file call residual is pinned separately above.
      if (path === testPath && value.startsWith('f(')) continue;
      expect(scan(`GITHUB_TOKEN: ${value}`, path)).not.toBeNull();
    }
  });
  it.each(['ordinary.txt', scannerPath])('still catches a real PEM block in %s', path => {
    expect(scan(pem, path)).toBe('pem-header');
  });
  it.each(['x.mjs', testPath, scannerPath])('keeps known token patterns everywhere in %s', path => {
    for (const value of ['gh' + 'p_' + token, 'AK' + 'IA' + '0123456789ABCDEF', 's' + 'k-' + token, 'PRIVATE' + ' KEY']) {
      expect(scan(value, path)).not.toBeNull();
    }
  });
  it.each([
    "'short' /* comment */ suffix()", "'short' // suffix()", "'unclosed suffix()", "'escaped\\'value' + suffix()",
  ])('refuses unsafe quote handling: %s', value => {
    expect(scan(`GITHUB_TOKEN: ${value}`, testPath)).not.toBeNull();
    expect(scan(`GITHUB_TOKEN: ${value}`)).not.toBeNull();
  });
});

// A test file that spells out a credential marker contiguously fails the very scan it exercises, so Forge
// refuses it and falls back to the local host. Scan each of these files as Forge would.
describe('forge scan test files pass their own scan', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  it.each(['forge-exec-manifest.test.mjs', 'forge-scan-code-expression.test.mjs'])('%s has no credential finding', name => {
    const content = readFileSync(join(dir, name));
    expect(credentialContentFinding(Buffer.from(`scripts/readiness/__tests__/${name}`), content)).toBeNull();
  });
});
