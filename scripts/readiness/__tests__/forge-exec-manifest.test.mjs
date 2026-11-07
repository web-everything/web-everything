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

  it('refuses a literal continuation led by a non-breaking space after a reference', () => {
    expect(scan('private-key: ${{ secrets.WE_APP_PRIVATE_KEY }}\n  \u00a0' + literal + '\n')).not.toBeNull();
  });
});
