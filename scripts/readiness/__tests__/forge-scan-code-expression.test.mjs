// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { credentialContentFinding, credentialContentWarning } from '../forge-exec-manifest.mjs';

// A high-entropy value is advisory evidence (a warning); token formats and unbounded blocks still block.
// The code-expression exemptions sit on the warning path, so read the block verdict first, then the warning.
const scan = (text, path = 'scripts/lib/example.mjs') => {
  const content = Buffer.from(text);
  return credentialContentFinding(Buffer.from(path), content) ?? credentialContentWarning(Buffer.from(path), content);
};
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
    // Markdown code spans need no word boundary: only the apostrophe does (prose contractions). A span glued to
    // word characters is still a valid code span, so it must not escape the opaque-token check.
    ['backticked spaced credential glued on both sides in markdown', 'notes.md', ':', 'x`aB3dE5fG7h J9kL2mN4pQ6 rS8tU0vW2xY`y'],
    ['backticked spaced credential glued before in markdown', 'notes.md', ':', 'x`aB3dE5fG7h J9kL2mN4pQ6 rS8tU0vW2xY` tail'],
    ['backticked spaced credential glued after in markdown', 'notes.md', ':', 'head `aB3dE5fG7h J9kL2mN4pQ6 rS8tU0vW2xY`y'],
    ['backticked spaced credential with word text around it in markdown', 'notes.md', ':', 'use`aB3dE5fG7h J9kL2mN4pQ6 rS8tU0vW2xY`here ok'],
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
    ['markdown prose with glued short code spans', 'notes.md', 'key: use the`codex exec`flag or the`grep -r`tool here'],
  ])('allows: %s', (_name, path, line) => {
    expect(scan(`${line}\n`, path)).toBeNull();
  });
});

// R824/R825 test-file skip (card x5b2hyl): a code expression carrying a high-entropy token of its own is still a
// secret, quoted or not, so the skip never covers it. Non-test files keep the full rule.
describe('credentialContentFinding test-file code expression opaque tokens', () => {
  const testPath = 'scripts/lib/example.test.mjs';
  it.each([
    ['unquoted value then call', `${literal}(x)`],
    ['unquoted value then arrow', `${literal} => x`],
    ['quoted literal beside a call', `f('${literal}')`],
    ['double-quoted literal beside a call', `f("${literal}")`],
    ['backtick literal beside a call', `f(\`${literal}\`)`],
    ['quoted literal concatenated with a call', `'${literal}' + suffix()`],
    ['unquoted token as an argument', `f(${literal}, 1)`],
    ['quoted literal inside an arrow', `() => '${literal}'`],
    ['whitespace-split quoted literal beside a call', `f('${literal.slice(0, 12)} ${literal.slice(12)}')`],
    // A secret cut into pieces under the length floor; the base scan reads the value whole, so the skip must too.
    ['dot-split unquoted pieces', `f(${literal.slice(0, 12)}.${literal.slice(12)})`],
    ['comma-split quoted pieces', `f('${literal.slice(0, 12)}', '${literal.slice(12)}')`],
    ['plus-concatenated quoted pieces', `f('${literal.slice(0, 12)}' + '${literal.slice(12)}')`],
    ['adjacent quoted pieces', `f('${literal.slice(0, 12)}','${literal.slice(12)}')`],
    ['quoted pieces after a call', `f(a) + '${literal.slice(0, 12)}' + '${literal.slice(12)}'`],
    ['array join of pieces', `f(['${literal.slice(0, 12)}', '${literal.slice(12)}'].join(''))`],
    ['zero-width split token', `f(${literal.slice(0, 12)}\u200B${literal.slice(12)})`],
    ['piece hidden behind a call-like quoted fragment', `f('${literal.slice(0, 12)}(', '${literal.slice(12)}')`],
  ])('flags an opaque token in a test-file code expression: %s', (_name, value) => {
    expect(scan(`creds: ${value}\n`, testPath)).toBe('high-entropy-creds');
    expect(scan(`creds:\n  ${value}\n`, testPath)).toBe('high-entropy-creds');
  });

  it.each([
    ['fixture word beside a call', "f('ghp_acceptance_fixture')"],
    ['long camelCase identifier call', 'readRecoveryCredentialFromStore(arg)'],
    ['long identifier arrow', 'buildHeavyAdmissionRemoteClient => x'],
    ['long argument list of identifiers', 'someVeryLongFunctionName(argumentNumberOne, argumentNumberTwo)'],
    ['fixture word pieces', "f('ghp_acceptance', 'fixture_value')"],
  ])('still skips a word-like test-file code expression: %s', (_name, value) => {
    expect(scan(`creds: ${value}\n`, testPath)).toBeNull();
  });

  // A paren, a keyword before a paren, or a conditional around a literal is not a call or an arrow: the
  // literal is still a bare secret. Only an arrow or a call to a non-keyword identifier is a code expression.
  it.each([
    ['parenthesized quoted literal', `('${literal}')`],
    ['parenthesized double-quoted literal', `("${literal}")`],
    ['parenthesized backtick literal', `(\`${literal}\`)`],
    ['parenthesized unquoted literal', `(${literal})`],
    ['padded parenthesized literal', `(  '${literal}'  )`],
    ['nested parenthesized literal', `(('${literal}'))`],
    ['return keyword before a paren', `return ('${literal}')`],
    ['typeof keyword before a paren', `typeof ('${literal}')`],
    ['await keyword before a paren', `await ('${literal}')`],
    ['new keyword before a paren', `new ('${literal}')`],
    ['async keyword before a paren', `async ('${literal}')`],
    ['function keyword before a paren', `function ('${literal}')`],
    ['import keyword before a paren', `import ('${literal}')`],
    ['this keyword before a paren', `this ('${literal}')`],
    ['conditional around a literal', `x ? ('${literal}') : y`],
  ])('flags a test-file credential value that is only a %s', (_name, value) => {
    expect(scan(`creds: ${value}\n`, 'scripts/lib/example.test.mjs')).toBe('high-entropy-creds');
    expect(scan(`creds:\n  ${value}\n`, 'scripts/lib/example.test.mjs')).toBe('high-entropy-creds');
  });

  it.each([
    ['arrow with parenthesized params', "(a, b) => a + b + 'suffix_value_here'"],
    ['await of a call', "(await readCredential('fixture')).value_here_long"],
    ['createHash chain', "createHash('sha256').update(String(p)).digest('hex')"],
  ])('still skips a genuine test-file code expression: %s', (_name, value) => {
    expect(scan(`creds: ${value}\n`, 'scripts/lib/example.test.mjs')).toBeNull();
  });

  // Mid-entropy random tokens (3.5-4.3 bits, under three digits) used to pass the digit/entropy floor inside a call
  // while the base scan flags them. Word-shape, not entropy alone, now decides.
  const randomTokens = [
    ['lowercase', 'zgujkzpaensjbhrujdsb'],
    ['long lowercase', 'jimbhqopwnjrngzlrsrserrerdokezvd'],
    ['mixed case', 'jedARwwtWIavtsztvRpH'],
    ['long mixed case', 'KEVSTmpVAlDVRSqxbeKblyUJFEEAVFTM'],
    ['hex digest', '06d6155d741c4f151af31625cf5bb176'],
    ['40-char hex', '818ab8c024cc088a81c018334b0fb3087963fb70'],
    ['separator-split mixed case', 'jedARwwtWI-avtsztvRpH'],
  ];
  it.each(randomTokens)('flags a mid-entropy random token in a test-file call (%s)', (_name, token) => {
    for (const value of [`f('${token}')`, `f("${token}")`, `f(${token})`, `f(${token}, 1)`, `() => '${token}'`]) {
      expect(scan(`creds: ${value}\n`, testPath)).toBe('high-entropy-creds');
      expect(scan(`creds:\n  ${value}\n`, testPath)).toBe('high-entropy-creds');
    }
  });
  it('flags a mid-entropy random token cut into quoted pieces', () => {
    const [a, b] = ['zgujkzpaen', 'sjbhrujdsb'];
    expect(scan(`creds: f('${a}', '${b}')\n`, testPath)).toBe('high-entropy-creds');
    expect(scan(`creds: f('${a}' + '${b}')\n`, testPath)).toBe('high-entropy-creds');
  });
  it.each([
    ['dot-split unquoted pieces', 'f(zgujkzpaen.sjbhrujdsb)'],
    ['comma-split unquoted pieces', 'f(zgujkzpaen,sjbhrujdsb)'],
    ['three dot-split unquoted pieces', 'f(zgujkzpaen.sjbhrujdsb.qwrtplkjh)'],
    ['unquoted pieces around a short identifier', 'f(zgujkzpaen.x.sjbhrujdsb)'],
  ])('flags unquoted mid-entropy pieces joined across separators: %s', (_name, value) => {
    expect(scan(`creds: ${value}\n`, testPath)).toBe('high-entropy-creds');
    expect(scan(`creds: ${value}\n`, 'scripts/lib/example.mjs')).toBe('high-entropy-creds');
  });
  it.each([
    ['spaced fixture sentence', "f('fixture network failure')"],
    ['single-letter parameters', "(a, b) => a + b + 'suffix_value_here'"],
    ['long identifier arguments', 'someVeryLongFunctionName(argumentNumberOne, argumentNumberTwo)'],
    ['colon-separated fixture id', "f('pass-daemon:ci-queue-watch')"],
    ['word pieces with a digit suffix', "f('package-lock.json', 'utf8')"],
    ['snake-case fixture', "f('acceptance_fixture_value')"],
    ['camelCase fixture literal', "f('readRecoveryCredentialValue')"],
  ])('still skips a word-like fixture in a test-file call: %s', (_name, value) => {
    expect(scan(`creds: ${value}\n`, testPath)).toBeNull();
  });
  it('keeps the word-shape rule off non-test files (full rule applies)', () => {
    expect(scan("creds: f('fixture network failure')\n", 'scripts/lib/example.mjs')).toBe('high-entropy-creds');
  });

  it('applies the residual to test files only', () => {
    expect(scan(`creds: ${literal}(x)\n`, 'scripts/lib/example.mjs')).toBe('high-entropy-creds');
  });
});

// A test file that spells out a credential marker contiguously fails the very scan it exercises, so Forge
// refuses it and falls back to the local host. Scan each of these files as Forge would.
describe('forge scan test files pass their own scan', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  it.each(['forge-exec-manifest.test.mjs', 'forge-scan-code-expression.test.mjs'])('%s has no credential finding', name => {
    const content = readFileSync(join(dir, name));
    expect(credentialContentFinding(Buffer.from(`scripts/readiness/__tests__/${name}`), content)).toBeNull();
    expect(credentialContentWarning(Buffer.from(`scripts/readiness/__tests__/${name}`), content)).toBeNull();
  });
});
