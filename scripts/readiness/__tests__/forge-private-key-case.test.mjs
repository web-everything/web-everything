import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {credentialBufferFinding,credentialContentFinding,credentialTextFinding} from '../forge-exec-manifest.mjs';

// Fixtures are assembled at runtime so this file passes its own scan.
const BEGIN='-----BEGIN '+'PRIVATE '+'KEY-----';
const END='-----END '+'PRIVATE '+'KEY-----';

describe('private-key rule is case-sensitive',()=>{
  it('referral block: keeps the tracked GitHub App minting card scan-clean',()=>{
    const path='backlog/3912-add-a-github-app-installation-token-minting-utility-jwt-sign.md';
    const content=readFileSync(new URL('../../../'+path,import.meta.url));
    expect(credentialTextFinding(content.toString())).toBeNull();
    expect(credentialBufferFinding(content)).toBeNull();
    expect(credentialContentFinding(Buffer.from(path),content)).toBeNull();
  });
  it('does not cross prose because an inline issue reference resembles a comment',()=>{
    const path=['skills-src','conveyor','reconcile-fix-dispatch-daemon'].join('/');
    for(const reference of ['#3872',"#3872's",'owner/repo#3872'])
      for(const line of [`See ${reference}: the private key file is unreadable.`,
        `The private key file belongs to ${reference}.`])
        for(const newline of ['\n','\r\n','\r']) {
          const text=line+newline+newline+'See '+path+'.mjs for details.';
          expect(credentialTextFinding(text),text).toBeNull();
          expect(credentialContentFinding('docs/notes.md',Buffer.from(text)),text).toBeNull();
        }
  });
  it('still crosses numeric comments at a line start or directly after a key label',()=>{
    const key='q'.repeat(43);
    for(const prefix of ['private key: #123 comment','private key #123 comment',
      '#123 the private key is recorded here','private key:\n  #123 comment',
      'private key: #123 reference #456 comment','private key: note #123 comment',
      'private key'+ ' '.repeat(10000)+'= note #123 comment'])
      expect(credentialTextFinding(prefix+'\n'+key),prefix).toBe('private-key');
  });
  it('send-back item 1: flags the exact four-space JSON byte-array bypasses',()=>{
    const bytes32=Array.from({length:32},(_,i)=>i*7+3);
    for(const text of ['{"private key": '+JSON.stringify(bytes32,null,4).replace(/\n/g,'\n    ')+'}',
      JSON.stringify({private_key:bytes32},null,4)]) {
      expect(credentialTextFinding(text),text).toBe('private-key');
      expect(credentialBufferFinding(Buffer.from(text)),text).toBe('private-key');
      expect(credentialContentFinding(Buffer.from('docs/notes.json'),Buffer.from(text)),text).toBe('private-key');
    }
  });
  it('send-back item 1: byte-array detection ignores JSON indentation, depth and line endings',()=>{
    const bytes32=Array.from({length:32},(_,i)=>i*7+3);
    for(const indent of [0,2,4,8,'\t'])for(const depth of [1,2,3])for(const newline of ['\n','\r\n','\r','\u2028']) {
      let value={private_key:bytes32};
      for(let n=1;n<depth;n++)value={nested:value};
      const text=JSON.stringify(value,null,indent).replace(/\n/g,newline);
      expect(credentialTextFinding(text),JSON.stringify({indent,depth,newline})).toBe('private-key');
    }
  });
  it('send-back item 2: flags the reported lowercase run and a valid digit-free base64 key',()=>{
    const reported='abcdefghijklmnopqrstuvwxyz'+'abcdefghijklmnopqrstuv';
    const key=Buffer.from(reported.slice(0,43),'base64').toString('base64');
    expect(Buffer.from(key,'base64')).toHaveLength(32);
    expect(key).toMatch(/^[a-z]+=$/);
    for(const value of [reported,key,key.replace(/=$/,'')])for(const gap of [' ','\n','\r\n\t']) {
      const text='private key:'+gap+value;
      expect(credentialTextFinding(text),text).toBe('private-key');
      expect(credentialBufferFinding(Buffer.from(text)),text).toBe('private-key');
      expect(credentialContentFinding(Buffer.from('docs/notes.md'),Buffer.from(text)),text).toBe('private-key');
    }
  });
  it('send-back item 2: detects generated 32-byte base64 and base64url keys regardless of case or digits',()=>{
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    for(let seed=0;seed<128;seed++) {
      const bytes=createHash('sha256').update('send-back key fixture '+seed).digest();
      const digitFree=Array.from({length:42},(_,i)=>alphabet[bytes[i%32]%52]).join('')+'A';
      for(const key of [bytes.toString('base64'),bytes.toString('base64url'),digitFree,digitFree.slice(0,-1).toLowerCase()+'g',digitFree.toUpperCase()]) {
        expect(Buffer.from(key,'base64')).toHaveLength(32);
        expect(Buffer.from(key,'base64').toString('base64url')).toBe(key.replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'));
        expect(credentialTextFinding('private key: '+key),`seed ${seed}: ${key}`).toBe('private-key');
      }
    }
  });
  it('send-back item 2: applies the 40-character floor without case or digit requirements',()=>{
    for(const character of ['q','Q','7','+','/','_','-'])for(const length of [39,40,43]) {
      // Digits also match the existing 32-character hex rule.
      const expected=length>=40||character==='7'?'private-key':null;
      expect(credentialTextFinding('private key: '+character.repeat(length))).toBe(expected);
    }
  });
  it('send-back item 1: scans long whitespace inside incomplete byte arrays in bounded time',()=>{
    const start=Date.now();
    for(const gap of [' ','\t','\r\n']) {
      expect(credentialTextFinding('private key: ['+gap.repeat(100000)+'!')).toBeNull();
      expect(credentialTextFinding('private key: ['+('1'+gap.repeat(1000)+',').repeat(30)+'!]')).toBeNull();
    }
    expect(Date.now()-start).toBeLessThan(3000);
  });
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
  it('fails closed on long words and paths made of base64 characters after the label',()=>{
    for(const text of ['private key: getUserAuthenticationTokenFromRequestHeaders',
      'private key /etc/ssl/private/server-key-material-file-name-long.pem',
      'private key: the-quick-brown-fox-jumps-over-the-lazy-dog-again'])
      expect(credentialTextFinding(text),text).toBe('private-key');
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
  describe('hex folding has no distance or dump-length cutoff',()=>{
    const hex='4ed05b9fd71eb615900620b834c66b45cbba790ab8411716669353d514fe9f20';
    const pairs=hex.match(/../g),groups=hex.match(/.{1,8}/g);
    const check=text=>{
      expect(credentialTextFinding(text)).toBe('private-key');
      expect(credentialBufferFinding(Buffer.from(text))).toBe('private-key');
      expect(credentialContentFinding(Buffer.from('docs/notes.md'),Buffer.from(text))).toBe('private-key');
    };
    it('blocks the reported colon dump after a 321-character comment',()=>{
      check('private key: # '+'x'.repeat(321)+'\n'+pairs.join(':'));
    });
    it('folds every supported dump after arbitrarily long gaps',()=>{
      const dumps=[...[':', ' ', '-', ', '].map(separator=>pairs.join(separator)),
        pairs.map(pair=>'0x'+pair).join(', '),pairs.map(pair=>'\\x'+pair).join(''),
        pairs.map(pair=>'%'+pair).join(''),groups.join(' '),groups.join('\n')];
      for(const gap of [' # '+'x'.repeat(5000)+'\n',' // '+'x'.repeat(5000)+'\r\n',
        ' '.repeat(5000),'\n'+'# comment\n'.repeat(500),'\n'+'\n'.repeat(5000),
        '\n'+'`'.repeat(3)+'text\n'+' '.repeat(5000)])
        for(const dump of dumps)check('private key:'+gap+dump);
    });
    it('folds an entire dump even when its separators exceed the old window',()=>{
      for(const separator of [' '.repeat(400),':\n'+' '.repeat(400),':\r',':\r\n'])
        check('private key: '+pairs.join(separator));
      for(const separator of [' '.repeat(400),'\r','\r\n','\n'])
        check('private key: '+groups.join(separator));
    });
    it('uses the same folding after label normalization and buffer decoding',()=>{
      const text='**Pri'+String.fromCharCode(0x200b)+'vate key:** # '+'x'.repeat(5000)+'\n'+pairs.join(':');
      check(text);
      for(const content of [Buffer.from(text,'utf16le'),Buffer.from(text,'utf16le').swap16()]) {
        expect(credentialBufferFinding(content)).toBe('private-key');
        expect(credentialContentFinding(Buffer.from('docs/notes.md'),content)).toBe('private-key');
      }
      check('ｐｒｉｖａｔｅ ｋｅｙ: '+' '.repeat(5000)+pairs.join(String.fromCharCode(0x2028)));
    });
    it('preserves prose boundaries and short dump negatives after long gaps',()=>{
      for(const text of ['the private key file is unreadable\n'+' '.repeat(5000)+pairs.join(':'),
        'private key: # '+'word '.repeat(1000)+'\nab:12:cd:34',
        'private key: unset\n'+' '.repeat(5000)+groups.join(' ')]) {
        expect(credentialTextFinding(text)).toBeNull();
        expect(credentialContentFinding(Buffer.from('docs/notes.md'),Buffer.from(text))).toBeNull();
      }
      // A long base64-shaped comment is now deliberately a hit even when the later dump is short.
      expect(credentialTextFinding('private key: # '+'x'.repeat(5000)+'\nab:12:cd:34')).toBe('private-key');
    });
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
  it('fails closed on long identifiers and words while keeping short words a non-hit',()=>{
    for(const text of ['private key: getUserAuthenticationTokenFromRequestHeaders',
      'private key: '+'abcdefghij'.repeat(5),
      '"private key": {\n  "name": "getUserAuthenticationTokenFromRequestHeaders",\n  "kind": "string"\n}'])
      expect(credentialTextFinding(text),text).toBe('private-key');
    expect(credentialTextFinding('private key: TheQuickBrownFoxJumpsOverTheLazyDog')).toBeNull();
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
  it('flags digit-free keys and long identifiers regardless of case mix or adjacent capitals',()=>{
    // Preserve the previous skewed-case fixture, including its base64url variant without adjacent capitals.
    const lean='qwertYUiopasdfGhjklzxCvbnmQwErtyuiopasdfghj';
    expect(lean.length).toBe(43);
    for(const text of ['private key: '+lean,'"private_key": "'+lean+'"','private key:\n'+lean,'private key: '+lean.replace('YU','Y_U')])
      expect(credentialTextFinding(text),text).toBe('private-key');
    for(const text of ['private key: getUserAuthenticationTokenFromRequestHeaders',
      'private key: '+'someLongCamelCaseIdentifierNameWithManyWordsInIt'])
      expect(credentialTextFinding(text),text).toBe('private-key');
  });
  it('sees through Markdown fences between the label and the key',()=>{
    const hex='ab12'.repeat(16),b64='Qz9xK2mP7vLw4RtYb8NcHd3FsJa6UeGo1XiZ5WqVkMy',f='`'.repeat(3),t='~'.repeat(3);
    const cases=['private key:\n'+f+'text\n'+hex+'\n'+f,'private key:\n'+f+'\n'+hex+'\n'+f,'private key:\n'+f+'js\n'+hex,
      'private key:\n'+t+'\n'+hex+'\n'+t,'private key:\r\n'+f+'text\r\n'+hex+'\r\n'+f,'private key:\n\n'+f+'text\n'+hex,
      'the private key is below\n'+f+'text\n'+hex+'\n'+f,'private key\n'+f+'\n'+f+'text\n'+hex,'private key:\n  '+f+' text\n  '+hex,
      'private key (base64):\n'+f+'\n'+b64+'\n'+f,'private key: '+f+'\n'+hex,'**Private key:**\n\n'+f+'text\n'+hex+'\n'+f];
    for(const text of cases) {
      expect(credentialTextFinding(text),text).toBe('private-key');
      expect(credentialBufferFinding(Buffer.from(text)),text).toBe('private-key');
      expect(credentialContentFinding('docs/notes.md',Buffer.from(text)),text).toBe('private-key');
    }
  });
  it('keeps fenced prose and short values after the label a non-hit',()=>{
    const f='`'.repeat(3);
    for(const text of ['private key:\n'+f+'text\nunset\n'+f,'the private key is below\n'+f+'\nnpm run build\n'+f,
      'private key:\n'+f+'text\n'+'ab12'.repeat(4)+'\n'+f])
      expect(credentialTextFinding(text),text).toBeNull();
  });
  it('scans repeated fence lines after the label in bounded time',()=>{
    const start=Date.now(),f='`'.repeat(3);
    for(const line of [f,f+'text','~~~','  '+f+' js',f+f+f+f,'`'.repeat(40),'~'.repeat(40)])
      for(const count of [5,12,40])
        expect(credentialTextFinding('private key:\n'+(line+'\n').repeat(count)+'!'),line).toBeNull();
    expect(credentialTextFinding('private key '+(f+'\n').repeat(2000)+'!')).toBeNull();
    expect(Date.now()-start).toBeLessThan(3000);
  });
  // The walk from the label to a value on a later line has no limit on a line, a comment or trailing spaces.
  describe('later-line value past long lines, comments and trailing spaces',()=>{
    const key='aB3'.repeat(14)+'xY',hex='ab12'.repeat(16),pad=n=>'x'.repeat(n);
    it('flags a key after a trailing comment of any length',()=>{
      for(const n of [61,100,5000])
        for(const marker of ['#','//'])
          expect(credentialTextFinding(`private key: ${marker} ${pad(n)}\n${key}`),`${marker} ${n}`).toBe('private-key');
      expect(credentialTextFinding(`private key: # ${pad(100)}\r\n${hex}`)).toBe('private-key');
      expect(credentialTextFinding(`private key: # ${pad(100)}\r${key}`)).toBe('private-key');
      expect(credentialBufferFinding(Buffer.from(`private key: // ${pad(300)}\n${key}`))).toBe('private-key');
    });
    it('flags a key after a comment line or a long line between the label and the value',()=>{
      expect(credentialTextFinding(`private key:\n  # ${pad(250)}\n  ${key}`)).toBe('private-key');
      expect(credentialTextFinding(`private key:\n  description: "${pad(250)}"\n  ${key}`)).toBe('private-key');
      expect(credentialTextFinding(`private key: "${pad(200)}",\n${key}`)).toBe('private-key');
    });
    it('flags a key after any amount of trailing whitespace',()=>{
      for(const space of [' '.repeat(10),'\t'.repeat(10),' \t '.repeat(40),' '.repeat(5000)])
        expect(credentialTextFinding(`private key:${space}\n${key}`)).toBe('private-key');
    });
    it('flags a key when the comment marker comes before the label',()=>{
      expect(credentialTextFinding(`# private key: ${pad(100)}\n# ${key}`)).toBe('private-key');
      expect(credentialTextFinding(`// the private key ${pad(100)}\n${key}`)).toBe('private-key');
    });
    it('keeps a long prose line that ends in a word a non-hit',()=>{
      expect(credentialTextFinding(`the private key ${'is a word '.repeat(60)}rotated\n${key}`)).toBeNull();
      expect(credentialTextFinding(`private key: ${'word '.repeat(60)}rotated,\n${key}`)).toBeNull();
      expect(credentialTextFinding(`private key: ${pad(300)} rotated,\n${key}`)).toBe('private-key');
    });
    it('scans a long run of labels on long lines in linear time',()=>{
      const start=Date.now();
      expect(credentialTextFinding('private key '.repeat(80000)+'!')).toBeNull();
      expect(credentialTextFinding(('private key: '+'word '.repeat(400)+' # '+'word '.repeat(400)+'\n').repeat(300)+'!')).toBeNull();
      expect(credentialTextFinding(('private key: '+pad(2000)+' # '+pad(2000)+'\n').repeat(300)+'!')).toBe('private-key');
      expect(credentialTextFinding(('private key:\n').repeat(60000)+'!')).toBeNull();
      expect(credentialTextFinding(('private key: #\n'+pad(30)+'\n').repeat(20000))).toBeNull();
      expect(Date.now()-start).toBeLessThan(5000);
    });
  });
  // Round 8 (red team on 18fbacd59): the same-line gap had a 96-character cap, a label line ending in "is" was never
  // crossed, and a Bitcoin mini private key (22/26/30 characters) is under the 40-character token floor.
  describe('no gap length, connector word or short key format is a way past the label scan',()=>{
    const hex='4ed05b9fd71eb615900620b834c66b45cbba790ab8411716669353d514fe9f20',alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    // A valid mini key: the first byte of sha256(key + "?") is 0 (about 1 in 256 candidates).
    const miniKey=length=>{
      for(let n=0;;n++) {
        let key='S',x=n*2654435761+length;
        for(let i=1;i<length;i++) {x=(x*1103515245+12345)%2147483648;key+=alphabet[x%58];}
        if(createHash('sha256').update(key+'?').digest()[0]===0)return key;
      }
    };
    it('flags a key after a gap of any length on the label line',()=>{
      for(const gap of [96,97,200,5000]) {
        expect(credentialTextFinding('private key:'+' '.repeat(gap)+hex),`space ${gap}`).toBe('private-key');
        expect(credentialTextFinding('private key'+'x'.repeat(gap)+' '+hex),`x ${gap}`).toBe('private-key');
        expect(credentialContentFinding('notes.txt',Buffer.from('private key:'+'\t'.repeat(gap)+hex)),`tab ${gap}`).toBe('private-key');
      }
      expect(credentialTextFinding('private key:\n'+' '.repeat(300)+hex)).toBe('private-key');
    });
    it('flags a key on the line after a label line that ends in a connector word',()=>{
      for(const text of ['The private key is\n'+hex,'the private key is:\n'+hex,'private key is as follows\r\n'+hex,
        'The private key was\n\n'+hex,'private key reads\n  '+hex,'private key is the\n'+hex])
        expect(credentialTextFinding(text),text).toBe('private-key');
    });
    it('still keeps prose before a commit id a non-hit',()=>{
      const sha='3a18f6d4b2907e5c3a18f6d4b2907e5c3a18f6d4';
      for(const text of ['the private key file is unreadable\n'+sha,'the private key rotation is done\n'+sha,'private key is\nunset\nsee '+sha,
        'the private key file is unreadable.\n\n'+sha])
        expect(credentialTextFinding(text),text).toBeNull();
    });
    it('flags a key after a label that ends its line, a closing period or dash, or any number of blank and comment lines',()=>{
      for(const text of ['Private key\n'+hex,'Here is the private key\n'+hex,'## Private key\n'+hex,'The private key is below.\n'+hex,
        'The private key is now\n'+hex,'private key is set to\n'+hex,'private key is stored as\n'+hex,'private key is, as follows\n'+hex,
        'The private key is—\n'+hex,'private key:\n\n\n\n\n\n'+hex,'private key:\n'+'# c\n'.repeat(12)+hex,
        'private key:\n'+'# c\n'.repeat(500)+hex,'private key:\n'+'\n'.repeat(5000)+hex])
        expect(credentialTextFinding(text),text.slice(0,40)).toBe('private-key');
    });
    it('flags a key wrapped over lines or cut into groups, a label split over two lines, and fullwidth forms',()=>{
      for(const width of [8,16,31]) {
        expect(credentialTextFinding('private key:\n'+hex.match(new RegExp('.{1,'+width+'}','g')).join('\n')),'wrap '+width).toBe('private-key');
        expect(credentialTextFinding('private key: '+hex.match(new RegExp('.{1,'+width+'}','g')).join(' ')),'groups '+width).toBe('private-key');
      }
      expect(credentialTextFinding('private\nkey: '+hex)).toBe('private-key');
      expect(credentialTextFinding('the private ssh\r\n  key: '+hex)).toBe('private-key');
      const wide=text=>text.replace(/[!-~]/g,c=>String.fromCharCode(c.charCodeAt(0)+0xfee0));
      expect(credentialTextFinding(wide('private key: ')+hex)).toBe('private-key');
      expect(credentialTextFinding('private key: '+wide(hex))).toBe('private-key');
    });
    it('keeps 4-digit groups, dates and short wrapped lines a non-hit',()=>{
      expect(credentialTextFinding('private key:\n'+'1234 5678 '.repeat(8))).toBeNull();
      expect(credentialTextFinding('private key:\n2025-11-13\n2025-11-14')).toBeNull();
      expect(credentialTextFinding('private key:\n'+'abcd1234\n'.repeat(3))).toBeNull();
    });
    it('scans trailing whitespace, many blank lines and many comment lines after many labels in linear time',()=>{
      const start=Date.now();
      expect(credentialTextFinding('private key '.repeat(20000)+' '.repeat(200000)+'\n!')).toBeNull();
      expect(credentialTextFinding('private key '.repeat(20000)+'\t'.repeat(200000)+'\n!')).toBeNull();
      expect(credentialTextFinding(('private key\n'+'\n'.repeat(20)).repeat(20000)+'!')).toBeNull();
      expect(credentialTextFinding('private key:\n'+'# c\n'.repeat(200000)+'!')).toBeNull();
      expect(credentialTextFinding('private key:\n'.repeat(2)+'private key '.repeat(1000)+('\n'+' '.repeat(100)).repeat(2000))).toBeNull();
      expect(Date.now()-start).toBeLessThan(8000);
    });
    it('flags a Bitcoin mini private key of 22, 26 and 30 characters, and keeps a bad checksum a non-hit',()=>{
      for(const length of [22,26,30]) {
        const key=miniKey(length);
        expect(key.length).toBe(length);
        for(const text of ['private key: '+key,'"private key": "'+key+'"','private key:\n'+key,'Private key (mini): '+key+'\n'])
          expect(credentialTextFinding(text),text).toBe('private-key');
        expect(credentialBufferFinding(Buffer.from('private key: '+key))).toBe('private-key');
        const bad=key.slice(0,-1)+(key.endsWith('2')?'3':'2');
        if(createHash('sha256').update(bad+'?').digest()[0]!==0)
          expect(credentialTextFinding('private key: '+bad),bad).toBeNull();
      }
      expect(credentialTextFinding('private key: SecretKeyStoreManagerProvider')).toBeNull();
    });
    it('scans a long run of mini-key candidates and long gaps in bounded time',()=>{
      const start=Date.now();
      expect(credentialTextFinding('private key: '+'S'+'1'.repeat(29)+' ')).toBeNull();
      expect(credentialTextFinding('private key '+('S'+'1'.repeat(29)+' ').repeat(20000)+'!')).toBeNull();
      expect(credentialTextFinding(('private key'+' '.repeat(2000)+'!\n').repeat(300))).toBeNull();
      expect(credentialTextFinding('private key is\n'.repeat(60000)+'!')).toBeNull();
      expect(Date.now()-start).toBeLessThan(5000);
    });
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
