// @vitest-environment node
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
    'key=value` config surface (`codex exec --help`, or grep the installed binary)',
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
