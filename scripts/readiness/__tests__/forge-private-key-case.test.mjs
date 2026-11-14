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
      'private.key = '+hex,'private'+zw+'key: '+hex,'private key'+' '.repeat(33)+hex,
      'Pri'+zw+'vate key: '+hex,'private ke'+zw+'y: '+hex,'private *key*: '+hex,'*private* **key**: '+hex,
      '<b>private</b> <b>key</b>: '+hex,'private&nbsp;key: '+hex,'private ed25519 key: '+hex,'private RSA key: '+hex,
      'private-signing-key: '+hex,'private    key: '+hex,'private ssh key: '+b64];
    for(const text of cases)
      expect(credentialTextFinding(text),text).toBe('private-key');
  });
  it('flags a label split by Unicode spaces or numeric entities',()=>{
    const hex='ab12'.repeat(16);
    const nbsp=String.fromCharCode(0xa0),emsp=String.fromCharCode(0x2003);
    for(const text of ['private'+nbsp+'key '+hex,'private'+emsp+'key '+hex,'private&#xA0;key '+hex,
      'private&#160;key '+hex,'private&ensp;key '+hex,'pri&shy;vate key '+hex,'~~private key~~: '+hex,
      'private ssh rsa key: '+hex])
      expect(credentialTextFinding(text),text).toBe('private-key');
  });
  it('keeps database keys, globs and commit ids a non-hit',()=>{
    const sha='3a18f6d4b2907e5c3a18f6d4b2907e5c3a18f6d4';
    for(const text of ['private cache key '+sha,'private index key '+sha,'private primary key '+sha,
      'private foreign key '+sha,'private or public key '+sha,'the private fork key, see commit '+sha,
      'find private*key '+sha,'ls private*key*  # commit '+sha,'~/.ssh/private~key '+sha])
      expect(credentialTextFinding(text),text).toBeNull();
  });
  it('keeps words and paths after the label a non-hit',()=>{
    for(const text of ['private key: getUserAuthenticationTokenFromRequestHeaders',
      'private key /etc/ssl/private/server-key-material-file-name-long.pem',
      'private key: the-quick-brown-fox-jumps-over-the-lazy-dog-again'])
      expect(credentialTextFinding(text),text).toBeNull();
  });
  it('scans a long run of repeated labels in linear time',()=>{
    const start=Date.now();
    for(const unit of ['private key ','priv','<b','&nbsp;','private a b '])
      expect(credentialTextFinding(unit.repeat(20000)+'!')).toBeNull();
    expect(Date.now()-start).toBeLessThan(5000);
  });
  it('flags key material on a later line, in spaced or colon hex, or as a decimal byte list',()=>{
    const hex='ab12'.repeat(16),pairs=hex.match(/../g);
    const dec=Array.from({length:32},(_,i)=>i*7+3);
    const dump=join=>pairs.join(join);
    const cases=['private key:\n'+hex,'private_key: |\n  '+hex,'private key:\r\n'+hex,'private key: |\n\n  '+hex,
      'private key: '+dump(' '),'private key: '+dump(':'),'private key: '+dump('-'),'private key: '+dump(', '),
      '"private key":['+dec.join(',')+']','"private key": [ '+dec.join(', ')+' ]',
      'Private-Key: (256 bit)\n priv:\n    '+dump(':'),
      'Private-Key: (256 bit)\npriv:\n    '+pairs.slice(0,15).join(':')+':\n    '+pairs.slice(15).join(':')];
    for(const text of cases)
      expect(credentialTextFinding(text),text).toBe('private-key');
  });
  it('flags per-byte prefixes, signed and braced decimal lists, bracket and comment line ends',()=>{
    const hex='ab12'.repeat(16),pairs=hex.match(/../g),dec=Array.from({length:32},(_,i)=>i*7+3);
    const signed=dec.map((n,i)=>i%2?n:n-256);
    const cases=['private key: '+pairs.map(p=>'0x'+p).join(', '),'private key = {'+pairs.map(p=>'0X'+p).join(',')+'}',
      'private key: '+pairs.map(p=>'\\x'+p).join(''),'private key: '+pairs.map(p=>'%'+p).join(''),
      'private key: {'+signed.join(', ')+'}','unsigned char private_key[32] = {'+dec.join(',')+'};',
      'private key = [\n'+hex,'private key = {\n  '+hex,'private key: # secret\n'+hex,'private key: // secret\n'+hex];
    for(const text of cases)
      expect(credentialTextFinding(text),text).toBe('private-key');
  });
  it('flags a pretty-printed private JWK and a digit-free base64url key',()=>{
    const d='AbCdEfGhIjKlMnOpQrStUvWxYzaBcDeFgHiJkLmNoPq',dx='Zy9XwVuTsRqPoNmLkJiHgFeDcBaZyXwVuTsRqPoNmLk';
    const jwk={kty:'OKP',crv:'Ed25519',x:dx,d};
    const cases=['"private_key": '+JSON.stringify(jwk,null,2),'private key (JWK):\n'+JSON.stringify(jwk,null,4),
      '{\n  "private key": {\n    "kty": "OKP",\n    "crv": "Ed25519",\n    "x": "'+dx+'",\n    "d": "'+d+'"\n  }\n}',
      '{\r\n\t"private key": {\r\n\t\t"kty": "OKP",\r\n\t\t"crv": "Ed25519",\r\n\t\t"d": "'+d+'"\r\n\t}\r\n}',
      'private key: '+d,'"private_key": "'+d+'"','private key:\n'+d+'=','private key: '+d+'='];
    // WebCrypto exportKey('jwk') shape: key_ops array, ext:true and a number member before the secret.
    const web={kty:'EC',crv:'P-256',ext:true,key_ops:['sign'],exp:123,y:'x'.repeat(5),d};
    cases.push('private key: '+JSON.stringify(web,null,2),'"privateKey": '+JSON.stringify(web,null,'\t'),
      '"private_key": '+JSON.stringify({ext:true,kty:'OKP',crv:'Ed25519',nbf:null,rev:false,key_ops:['sign'],d},null,2));
    for(const text of cases)
      expect(credentialTextFinding(text),text).toBe('private-key');
  });
  it('keeps prose that ends a line in a word and a comma a non-hit',()=>{
    const sha='3a18f6d4b2907e5c3a18f6d4b2907e5c3a18f6d4';
    for(const text of ['the private key, rotated,\n'+sha,'private key rotated,\nsee '+sha])
      expect(credentialTextFinding(text),text).toBeNull();
  });
  it('keeps camelCase identifiers and long words after the label a non-hit',()=>{
    for(const text of ['private key: getUserAuthenticationTokenFromRequestHeaders',
      'private key: TheQuickBrownFoxJumpsOverTheLazyDog','private key: '+'abcdefghij'.repeat(5),
      '"private key": {\n  "name": "getUserAuthenticationTokenFromRequestHeaders",\n  "kind": "string"\n}'])
      expect(credentialTextFinding(text),text).toBeNull();
  });
  it('keeps numbers, dates and ids after the label a non-hit',()=>{
    const sizes=Array.from({length:14},(_,i)=>['1024','2048','3072','4096'][i%4]).join(', ');
    for(const text of ['private key sizes tested: '+sizes,'Rotated the private key on 2025-11-13, 2025-10-01, 2025-09-01, 2025-08-01.',
      'private key id:\n123e4567-e89b-12d3-a456-426614174000','private key serial: 1234 5678 1234 5678 1234 5678 1234 5678 1234 5678',
      'private key: 1024 2048 4096 1024 2048 4096 1024 2048 4096 1024 2048 4096'])
      expect(credentialTextFinding(text),text).toBeNull();
  });
  it('keeps prose that runs onto the next line, and short byte lists, a non-hit',()=>{
    const sha='3a18f6d4b2907e5c3a18f6d4b2907e5c3a18f6d4';
    for(const text of ['the private key file is unreadable\nsee commit '+sha,'the private key file is unreadable.\n\n'+sha,
      'private key: unset\nsee commit '+sha,'private cache key:\n'+sha,'private key: ['+[1,2,3,4,5,6,7,8].join(',')+']',
      'private key: ab cd ef 01','private key:\nnotes below'])
      expect(credentialTextFinding(text),text).toBeNull();
  });
  it('scans a long run of separators and byte pairs after the label in linear time',()=>{
    const start=Date.now();
    for(const unit of ['private key:\n','private key: ab ','private key: [1,','private key:\n  ab:'])
      expect(credentialTextFinding(unit.repeat(20000)+'!')).toBeNull();
    expect(credentialTextFinding('private key'+':\n'.repeat(50000)+'!')).toBeNull();
    expect(Date.now()-start).toBeLessThan(8000);
  });
  it('scans repeated comment, separator and number lines after the label in bounded time',()=>{
    const start=Date.now();
    for(const line of ['####################','//////////////////////','# # # # # # # # # # # #','// // // // // // //',
      '--------------------','"""""""""""""""""""','1, 2, 3, 4, 5, 6, 7, 8,','true, true, true, true,']) {
      for(const count of [5,12,40])
        expect(credentialTextFinding('private key:\n'+(line+'\n').repeat(count)+'!'),line).toBeNull();
    }
    for(const label of ['private key:\r\n','Private key = [\n'])
      expect(credentialTextFinding(label+'####################\r\n'.repeat(30)+'!')).toBeNull();
    expect(Date.now()-start).toBeLessThan(3000);
  });
  it('still flags key material after a few comment lines',()=>{
    const hex='ab12'.repeat(16);
    expect(credentialTextFinding('private key:\n# one\n# two\n// three\n'+hex)).toBe('private-key');
    expect(credentialTextFinding('private key: # a\n'.repeat(3)+hex)).toBe('private-key');
  });
  it('flags a digit-free key whose letters lean to one case, and keeps acronym-free words a non-hit',()=>{
    // 6 capitals (below the 13 of the main rule) with two side by side: a 43-character digit-free key.
    const lean='qwertYUiopasdfGhjklzxCvbnmQwErtyuiopasdfghj';
    expect(lean.length).toBe(43);
    for(const text of ['private key: '+lean,'"private_key": "'+lean+'"','private key:\n'+lean,'private key: '+lean.replace('YU','Y_U')])
      expect(credentialTextFinding(text),text).toBe(text.includes('Y_U')?null:'private-key');
    for(const text of ['private key: getUserAuthenticationTokenFromRequestHeaders',
      'private key: '+'someLongCamelCaseIdentifierNameWithManyWordsInIt'])
      expect(credentialTextFinding(text),text).toBeNull();
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
