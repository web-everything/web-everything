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
    ['PEM block', '-----'+'BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n', 'pem-header'],
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
    ['private key prose', 'a private key marker', 'private-key'],
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
