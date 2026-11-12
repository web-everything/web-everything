import {describe,expect,it} from 'vitest';
import {credentialBufferFinding,credentialTextFinding} from '../forge-exec-manifest.mjs';

// Fixtures are assembled at runtime so this file passes its own scan.
const BEGIN='-----BEGIN '+'PRIVATE '+'KEY-----';
const END='-----END '+'PRIVATE '+'KEY-----';

describe('private-key rule is case-sensitive',()=>{
  it('ignores lowercase prose',()=>{
    expect(credentialTextFinding('the private key file is unreadable')).toBeNull();
    expect(credentialBufferFinding(Buffer.from('// the private key file is unreadable'))).toBeNull();
  });
  it('still flags every real format',()=>{
    expect(credentialTextFinding(`${BEGIN}\nabc\n${END}`)).not.toBeNull();
    expect(credentialTextFinding(BEGIN)).not.toBeNull();
    expect(credentialTextFinding(`{"private_key": "${BEGIN}\\nabc"}`)).not.toBeNull();
    expect(credentialTextFinding('x PRIVATE '+'KEY y')).toBe('private-key');
  });
});
