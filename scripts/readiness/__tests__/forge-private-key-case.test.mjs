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
  it('flags raw key material after "private key" in any case',()=>{
    const hex='ab12'.repeat(16);
    for(const label of ['Private key: 0x','private key=','PrIvAtE kEy: "0X','private_key": "','Private key '])
      expect(credentialTextFinding(label+hex),label).toBe('private-key');
    expect(credentialTextFinding('private key: '+'Aa1+/'.repeat(10))).toBe('private-key');
    expect(credentialTextFinding('private key: 0x'+'ab12'.repeat(4))).toBeNull();
  });
  it('scans a long whitespace run after the label in bounded time',()=>{
    const start=Date.now();
    for(const pad of [' ','\t ',' :'])
      expect(credentialTextFinding('private key'+pad.repeat(100000)+'!')).toBeNull();
    expect(Date.now()-start).toBeLessThan(2000);
  });
  it('flags a key after a padded label or short gap',()=>{
    const hex='ab12'.repeat(16);
    for(const label of ['private   key: ','Private\tkey = ','private key  :  0x'])
      expect(credentialTextFinding(label+hex),label).toBe('private-key');
  });
  it('flags key material through Markdown and JSON formatting',()=>{
    const hex='ab12'.repeat(16);
    const cases=['private key: `'+hex+'`','**Private key:** '+hex,'| private key | '+hex+' |',
      '{"private key": "'+hex+'"}','{"private key"'+' '.repeat(9)+':'+' '.repeat(9)+'"'+hex+'"}',
      "'private_key': '"+hex+"'",'privkey = '+hex,'Private key is: 0x'+hex,'private key (hex): '+hex,
      'private   key: '+hex];
    for(const text of cases)
      expect(credentialTextFinding(text),text).toBe('private-key');
    expect(credentialBufferFinding(Buffer.from('private key: `'+hex+'`'))).toBe('private-key');
  });
  it('flags key material behind code, table, identifier-suffix and hyphen shapes',()=>{
    const hex='ab12'.repeat(16),b64='Qz9xK2mP7vLw4RtYb8NcHd3FsJa6UeGo1XiZ5WqVkMy',zw=String.fromCharCode(0x200b);
    const cases=['private key - '+hex,'private key -> '+hex,'const privateKey: string = "'+hex+'";',
      'privateKey = Buffer.from("'+hex+'")','<td>private key</td><td>'+hex+'</td>','privateKeyHex: "'+hex+'"',
      'private_key: !!binary '+b64,'private key (base64): '+b64,'{"PrivateKey":{"d":"'+b64+'"}}',
      'private.key = '+hex,'private'+zw+'key: '+hex,'private key'+' '.repeat(33)+hex];
    for(const text of cases)
      expect(credentialTextFinding(text),text).toBe('private-key');
  });
  it('keeps words and paths after the label a non-hit',()=>{
    for(const text of ['private key: getUserAuthenticationTokenFromRequestHeaders',
      'private key /etc/ssl/private/server-key-material-file-name-long.pem',
      'private key: the-quick-brown-fox-jumps-over-the-lazy-dog-again'])
      expect(credentialTextFinding(text),text).toBeNull();
  });
  it('does not span a newline from label to material',()=>{
    expect(credentialTextFinding('private key:\n'+'ab12'.repeat(16))).toBeNull();
  });
  it('keeps lane-31 prose a non-hit',()=>{
    for(const line of ["if (diag.keyUnreadable) parts.push('the private key file is unreadable');",
      "// Never echo a partial token or the private key path's contents — only the API's own error message,"])
      expect(credentialTextFinding(line),line).toBeNull();
  });
  it('still flags every real format',()=>{
    expect(credentialTextFinding(`${BEGIN}\nabc\n${END}`)).not.toBeNull();
    expect(credentialTextFinding(BEGIN)).not.toBeNull();
    expect(credentialTextFinding(`{"private_key": "${BEGIN}\\nabc"}`)).not.toBeNull();
    expect(credentialTextFinding('x PRIVATE '+'KEY y')).toBe('private-key');
  });
});
