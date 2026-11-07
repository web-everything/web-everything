// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { credentialContentFinding } from '../forge-exec-manifest.mjs';

const scan = text => credentialContentFinding(Buffer.from('.github/workflows/ci.yml'), Buffer.from(text));
const literal = 'abcdefghij0123456789XYZ';

describe('credentialContentFinding GitHub Actions references', () => {
  it.each([
    ['private-key', '${{ secrets.WE_APP_PRIVATE_KEY }}'],
    ['token', '${{ steps.fui-app-token.outputs.token || secrets.FUI_READ_TOKEN }}'],
    ['secret', '${{ secrets.DEPLOY_SECRET }}'],
  ])('allows an entirely expression-valued YAML %s field', (field, value) => {
    expect(scan(`          ${field}: ${value}\n`)).toBeNull();
  });

  it.each(['\n', '\n\n', '\r\n  \r\n'])('refuses an expression followed by a more-indented literal continuation (%j)', separator => {
    expect(scan('private-key: ${{ secrets.X }}' + separator + `  ${literal}\n`)).not.toBeNull();
  });

  it.each(['', '\n', '\n  \n'])('allows a ci.yml reference followed by a sibling key at the same indent (%j)', blank => {
    expect(scan('  private-key: ${{ secrets.X }}\n' + blank + '  name: CI\n')).toBeNull();
  });

  it('allows a reference followed by a less-indented key', () => {
    expect(scan('  private-key: ${{ secrets.X }}\nname: CI\n')).toBeNull();
  });

  it('still refuses a literal high-entropy YAML private-key value', () => {
    expect(scan(`private-key: ${literal}\n`)).toBe('high-entropy-private-key');
  });

  it.each(['private-key', 'token', 'secret'].flatMap(field =>
    ['abcdefghij0123456789XYZ${{ x }}', '${{ x }}abcdefghij0123456789XYZ', '${{ x }}abcdefghij0123456789XYZ${{ y }}'].map(value => [field, value]),
  ))('refuses mixed literal/reference YAML %s value %s', (field, value) => {
    expect(scan(`${field}: ${value}\n`)).not.toBeNull();
  });

  it.each([
    ['PEM block', '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n', 'pem-header'],
    ['GitHub token', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'github-token'],
  ])('still refuses a %s elsewhere in a file containing a reference', (_name, content, finding) => {
    expect(scan('private-key: ${{ secrets.WE_APP_PRIVATE_KEY }}\n' + content)).toBe(finding);
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
  ])('refuses unsupported whole-value Actions expression for %s: %s', (field, value) => {
    expect(scan(`${field}: ${value}\n`)).not.toBeNull();
  });

  // YAML parsers (libyaml/Psych) treat NEL, LS and PS as line breaks, so a continuation led by one is still
  // a more-indented continuation of the reference line. The scanner must break lines the same way.
  it.each([
    ['LS', ' '], ['PS', ' '], ['NEL', '\u0085'],
  ])('refuses a literal continuation after a reference when a %s line break precedes it', (_name, brk) => {
    for (const field of ['private-key', 'token', 'secret']) {
      expect(scan(`${field}: \${{ secrets.WE_APP_PRIVATE_KEY }}\n${brk} ${literal}\n`)).not.toBeNull();
      expect(scan(`${field}: \${{ secrets.WE_APP_PRIVATE_KEY }}${brk} ${literal}\n`)).not.toBeNull();
      expect(scan(`  ${field}: \${{ secrets.X }}${brk}    ${literal}\n`)).not.toBeNull();
    }
    expect(scan(`private-key: \${{ secrets.X }}\n${brk} ${literal}\n`)).toBe('high-entropy-private-key');
  });

  it.each([' ', ' ', '\u0085'])('still allows a reference followed by a same-indent sibling key across a %j line break', brk => {
    expect(scan(`  private-key: \${{ secrets.X }}${brk}  name: CI\n`)).toBeNull();
    expect(scan(`private-key: \${{ secrets.X }}\n${brk}name: CI\n`)).toBeNull();
  });

  it('refuses a literal continuation led by a non-breaking space after a reference', () => {
    expect(scan('private-key: ${{ secrets.WE_APP_PRIVATE_KEY }}\n  \u00a0' + literal + '\n')).not.toBeNull();
  });
});
