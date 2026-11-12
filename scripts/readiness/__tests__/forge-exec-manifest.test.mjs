// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { credentialContentFinding, credentialContentWarning } from '../forge-exec-manifest.mjs';

const path=Buffer.from('.github/workflows/ci.yml');
const scan=text=>{
  const content=Buffer.from(text);
  expect(credentialContentFinding(path,content)).toBeNull();
  return credentialContentWarning(path,content);
};
const literal = 'abcdefghij0123456789XYZ';

describe('credentialContentFinding GitHub Actions references', () => {
  it.each([
    ['private-key', '${{ secrets.WE_APP_PRIVATE_KEY }}'],
    ['token', '${{ steps.fui-app-token.outputs.token || secrets.FUI_READ_TOKEN }}'],
    ['secret', '${{ secrets.DEPLOY_SECRET }}'],
  ])('allows an entirely expression-valued YAML %s field', (field, value) => {
    expect(scan(`          ${field}: ${value}\n`)).toBeNull();
  });

  it.each(['\n', '\n\n', '\r\n  \r\n'])('warns on an expression followed by a more-indented literal continuation (%j)', separator => {
    expect(scan('private-key: ${{ secrets.X }}' + separator + `  ${literal}\n`)).not.toBeNull();
  });

  it.each(['', '\n', '\n  \n'])('allows a ci.yml reference followed by a sibling key at the same indent (%j)', blank => {
    expect(scan('  private-key: ${{ secrets.X }}\n' + blank + '  name: CI\n')).toBeNull();
  });

  it('allows a reference followed by a less-indented key', () => {
    expect(scan('  private-key: ${{ secrets.X }}\nname: CI\n')).toBeNull();
  });

  it('still warns on a literal high-entropy YAML private-key value', () => {
    expect(scan(`private-key: ${literal}\n`)).toBe('high-entropy-private-key');
  });

  it.each(['private-key', 'token', 'secret'].flatMap(field =>
    ['abcdefghij0123456789XYZ${{ x }}', '${{ x }}abcdefghij0123456789XYZ', '${{ x }}abcdefghij0123456789XYZ${{ y }}'].map(value => [field, value]),
  ))('warns on mixed literal/reference YAML %s value %s', (field, value) => {
    expect(scan(`${field}: ${value}\n`)).not.toBeNull();
  });

  it.each([
    // Marker words are split so this file never spells them contiguously (it would fail its own scan).
    ['PEM block', ['-----', 'BEGIN', ' PRIV', 'ATE KE', 'Y-----'].join('') + '\nfixture\n' + ['-----', 'END PRIV', 'ATE KE', 'Y-----\n'].join(''), 'pem-header'],
    ['GitHub token', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'github-token'],
  ])('still refuses a %s elsewhere in a file containing a reference', (_name, content, finding) => {
    expect(credentialContentFinding(path,Buffer.from('private-key: ${{ secrets.WE_APP_PRIVATE_KEY }}\n'+content))).toBe(finding);
  });

  // private-key is only refused by the entropy rule (value >= 20 chars); short forms carry no credential there.
  const unsupported = ["${{ format('abcdefghij0123456789XYZ') }}", "${{ 'abcdefghij0123456789XYZ' }}", '${{ toJSON(secrets) }}',
    "${{ secrets.X == 'abcdefghij0123456789XYZ' }}",
    // a || chain is only a reference when EVERY arm is a dotted context path
    "${{ steps.x.outputs.token || 'abcdefghij0123456789XYZ' }}", "${{ 'abcdefghij0123456789XYZ' || secrets.X }}",
    '${{ secrets.X || abcdefghij0123456789XYZ }}', '${{ secrets.X || secrets.Y || "abcdefghij0123456789XYZ" }}'];
  it.each([
    ...unsupported.map(value => ['private-key', value]),
    ...['token', 'secret'].flatMap(field => [...unsupported, '${{ secrets }}', '${{ secrets.X[0] }}'].map(value => [field, value])),
  ])('warns on unsupported whole-value Actions expression for %s: %s', (field, value) => {
    expect(scan(`${field}: ${value}\n`)).not.toBeNull();
  });

  // YAML parsers (libyaml/Psych) treat NEL, LS and PS as line breaks, so a continuation led by one is
  // still a more-indented continuation. Built from char codes: no literal separators in this file.
  const breaks = [['NEL', 0x85], ['LS', 0x2028], ['PS', 0x2029]].map(([name, code]) => [name, String.fromCharCode(code)]);
  it.each(breaks)('warns on a literal continuation after a reference across a %s line break', (_name, brk) => {
    for (const field of ['private-key', 'token', 'secret']) {
      expect(scan(`${field}: \${{ secrets.WE_APP_PRIVATE_KEY }}\n${brk} ${literal}\n`)).not.toBeNull();
      expect(scan(`${field}: \${{ secrets.WE_APP_PRIVATE_KEY }}${brk} ${literal}\n`)).not.toBeNull();
      expect(scan(`  ${field}: \${{ secrets.X }}${brk}    ${literal}\n`)).not.toBeNull();
    }
    expect(scan(`private-key: \${{ secrets.X }}\n${brk} ${literal}\n`)).toBe('high-entropy-private-key');
  });

  it.each(breaks)('still warns on a literal tucked behind a %s break on a non-reference credential line', (_name, brk) => {
    expect(scan(`signing_key: x${brk}  ${literal}\n`)).toBe('high-entropy-signing_key');
    expect(scan(`signing_key: "x${brk}${literal}"\n`)).toBe('high-entropy-signing_key');
    expect(scan(`signing_key:${brk}  ${literal}\n`)).toBe('high-entropy-signing_key');
    expect(scan(`secret:${brk}  ${literal}\n`)).not.toBeNull();
  });

  it.each(breaks)('sees a credential key that follows a %s break on the same physical line', (_name, brk) => {
    expect(scan(`name: x${brk}signing_key: ${literal}\n`)).toBe('high-entropy-signing_key');
  });

  it.each(breaks)('allows a reference followed by a same-indent sibling key across a %s break', (_name, brk) => {
    expect(scan(`private-key: \${{ secrets.X }}\n${brk}name: CI\n`)).toBeNull();
  });

  // The continuation check covers every more-indented line, not only the first one.
  it.each([
    ['value on the next line', `signing_key:\n  ${literal}\n`],
    ['next-line list item', `token:\n  - ${literal}\n`],
    ['block scalar', `signing_key: |\n  ${literal}\n`],
    ['folded scalar', `signing_key: >-\n  ${literal}\n`],
    ['quoted multi-line scalar', `signing_key: "x\n  ${literal}"\n`],
    ['literal on the second continuation line', `private-key: \${{ secrets.X }}\n  x\n  ${literal}\n`],
    ['secret split across short continuation lines', 'private-key: ${{ secrets.X }}\n  Zk9xQ2vB7mT4pL8wRc3\n  Yh6NdAAAAAAAAAAAAAA\n'],
  ])('warns on a credential literal in a YAML continuation: %s', (_name, content) => {
    expect(scan(content)).not.toBeNull();
  });

  it('blocks a continuation longer than the scan bound for local fallback', () => {
    const lines = Array.from({ length: 300 }, () => '  x').join('\n');
    const content=Buffer.from(`private-key: \${{ secrets.X }}\n${lines}\n`);
    expect(credentialContentFinding(path,content)).toBe('unbounded-continuation-private-key');
    expect(credentialContentWarning(path,content)).toBeNull();
  });

  it('warns on a literal continuation led by a non-breaking space after a reference', () => {
    expect(scan('private-key: ${{ secrets.WE_APP_PRIVATE_KEY }}\n  \u00a0' + literal + '\n')).not.toBeNull();
  });
});

// R824/R825: in test files only, the name:value high-entropy heuristic skips code expressions.
// High-entropy values are warnings (generic evidence is advisory); token formats still block.
describe('credentialContentFinding code expressions in test files (R824)', () => {
  const at = (path, text) => {
    const content = Buffer.from(text);
    return credentialContentFinding(Buffer.from(path), content) ?? credentialContentWarning(Buffer.from(path), content);
  };
  const testPath = 'scripts/readiness/__tests__/heavy-admission-remote-client.test.mjs';
  const hashLine = "  pathKey: createHash('sha256').update(String(p)).digest('hex'),\n";
  const randomValue = 'q8Zr3LkP0vXw9TnB5mJd2YcH7sFgA4uE6oIe1KtN';

  it('does not flag a createHash code expression in a test file', () => {
    expect(at(testPath, hashLine)).toBeNull();
  });
  it('does not flag an arrow/vi.fn fixture carrying a ghp_ prefix that is not a real token', () => {
    // Assembled at runtime: written out whole, this line would be a name:value pair the scan reads in THIS file.
    const [fn, ctor, field, rest] = ['readRecoveryCredential', 'vi.fn(() => ({', 'token', "'ghp_acceptance_fixture', other: 1})),\n"];
    expect(at('scripts/conveyor/__tests__/missing-run-startup-failure.test.mjs', `${fn}: ${ctor}${field}:${rest}`)).toBeNull();
  });
  it('still flags the same createHash line in a non-test file', () => {
    expect(at('scripts/readiness/some-module.mjs', hashLine)).toBe('high-entropy-pathKey');
  });
  it('does not treat a lookalike path as a test file', () => {
    expect(at('scripts/readiness/__tests__x/a.mjs', hashLine)).toBe('high-entropy-pathKey');
    expect(at('scripts/readiness/a.test.txt', hashLine)).toBe('high-entropy-pathKey');
  });
  it('still flags a bare high-entropy string literal in a test file', () => {
    expect(at(testPath, `API_TOKEN: '${randomValue}'\n`)).toBe('high-entropy-API_TOKEN');
  });
  it('still flags a bare literal that merely contains a call-like fragment', () => {
    expect(at(testPath, `API_TOKEN: 'q8Zr3LkP0vXw9TnB5mJd2Y(cH7sFgA4uE6oIe1KtN'\n`)).toBe('high-entropy-API_TOKEN');
  });
  it.each([
    ['escaped literal', '"\\x61B3dE5fG7hJ9kL2mN4pQ6rS8" + suffix()'],
    ['interpolated template', '`aB3dE5fG7hJ9kL2mN4pQ6rS8${suffix()}`'],
    ['comment quote', "/* ' */ 'aB3dE5fG7hJ9kL2mN4pQ6rS8abc('"] ,
    ['trailing comment', '"aB3dE5fG7hJ9kL2mN4pQ6rS8", // suffix('],
    ['unclosed template', '`aB3dE5fG7hJ9kL2mN4pQ6rS8abc('],
  ])('rejects %s forms the skip cannot prove safe, including continuations', (_name, value) => {
    expect(at(testPath, `creds: ${value}\n`)).toBe('high-entropy-creds');
    expect(at(testPath, `creds:\n  ${value}\n`)).toBe('high-entropy-creds');
  });
  it('flags a high-entropy argument inside a test-file credential call', () => {
    expect(at(testPath, `creds: f('${randomValue}')\n`)).toBe('high-entropy-creds');
    expect(at(testPath, 'creds: "aB3dE5fG7hJ9kL2mN4pQ6rS8" + suffix()\n')).toBe('high-entropy-creds');
  });
  it('flags an unquoted high-entropy value beside a call or arrow in a test file', () => {
    expect(at(testPath, `creds: ${randomValue}(x)\n`)).toBe('high-entropy-creds');
    expect(at(testPath, `creds: ${randomValue} => x\n`)).toBe('high-entropy-creds');
  });
  it('rejects a multiline template whose literal content resembles a call', () => {
    expect(at(testPath, `creds: \`${randomValue}abc(\n  \`,\n`)).toBe('high-entropy-creds');
    expect(at(testPath, `creds: \`\n  ${randomValue}abc(\n  \`,\n`)).toBe('high-entropy-creds');
  });
  it('always flags a real-format token inside a code expression in a test file', () => {
    const real = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    expect(at(testPath, `getToken: vi.fn(() => ({token:'${real}'})),\n`)).toBe('github-token');
    expect(at(testPath, `x: createHash('sha256').update('sk-${randomValue}')\n`)).toBe('sk-token');
  });
});

describe('credential format byte views', () => {
  it.each(['latin1', 'utf8', 'utf16le', 'utf16be'])('blocks a GitHub token decoded from %s', encoding => {
    const token = 'ghp_' + 'a'.repeat(36);
    const content = encoding === 'utf16be' ? Buffer.from(token, 'utf16le').swap16() : Buffer.from(token, encoding);
    expect(credentialContentFinding(path, content)).toBe('github-token');
  });
  it('scans big-endian whole code units with an odd trailing byte', () => {
    const content = Buffer.from('ghp_' + 'a'.repeat(36), 'utf16le').swap16();
    expect(credentialContentFinding(path, Buffer.concat([content, Buffer.from([255])]))).toBe('github-token');
  });
});


describe('strict credential regression', () => {
  it.each([
    ['prefixed GitHub', 'a' + 'ghp_' + 'a'.repeat(20), 'github-token'],
    ['prefixed AWS', 'a' + 'AKIA' + 'A'.repeat(16) + 'Z', 'aws-access-key'],
    ['short sk', 'sk-' + 'a'.repeat(16), 'sk-token'],
    ['short Slack', 'xoxb-' + 'a'.repeat(8), 'slack-token'],
    ['bare armor', '-----' + 'BEGIN', 'pem-header'],
    ['private-key prose', 'a private' + ' key marker', 'private-key'],
  ])('blocks %s', (_name, value, finding) => {
    expect(credentialContentFinding(path, Buffer.from(value))).toBe(finding);
  });
  it.each([
    ['invalid JSON', 'data.json', Buffer.from('{'), 'unparseable-json'],
    ...['null', '[]', '1', '"public"'].map(value => ['non-object JSON '+value, 'data.json', Buffer.from(value), 'non-object-json']),
    ...['data.txt', 'data.json'].flatMap(name => [
      ['invalid UTF-8 '+name, name, Buffer.from([255]), 'unsupported-text-encoding'],
      ['UTF-16 '+name, name, Buffer.from('public', 'utf16le'), 'unsupported-text-encoding'],
      ['NUL '+name, name, Buffer.from('public\0'), 'unsupported-text-encoding'],
    ]),
  ])('blocks %s', (_name, name, content, finding) => {
    expect(credentialContentFinding(Buffer.from(name), content)).toBe(finding);
  });
  it.each(['key: q8Zr2LmX9vT4pW7kJ1nB5cY3', 'password=short'])(
    'warns without blocking readable generic evidence %s', value => {
      const content=Buffer.from(value);
      expect(credentialContentFinding(path,content)).toBeNull();
      expect(credentialContentWarning(path,content)).toMatch(/^(high-entropy|secret-assignment)-/);
    });
});

describe('generic evidence never masks a blocking continuation bound', () => {
  it('still blocks when password=short precedes an unbounded continuation', () => {
    const lines=Array.from({length:300},(_,i)=>`  line${i}`).join('\n');
    const content=Buffer.from(`password=short\nprivate-key: \${{ secrets.X }}\n${lines}\n`);
    expect(credentialContentFinding(path,content)).toBe('unbounded-continuation-private-key');
  });
});
