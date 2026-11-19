// @vitest-environment node
import {createPrivateKey,generateKeyPairSync} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {credentialBufferFinding,credentialContentFinding,manifestEntry} from '../forge-exec-manifest.mjs';
import {keyStructureFinding} from '../forge-key-structure.mjs';

// Adapted from origin/lane/forge-key-structure-s1; generate material instead of shipping secrets.
const FINDING='private-key-structure';
// manifestEntry scans credential-named sources; the byte/content scanners have no path exemption.
const path=Buffer.from('docs/token.md');
const priv=(type,options,format)=>generateKeyPairSync(type,options).privateKey.export({format:'der',type:format});
const rsa=priv('rsa',{modulusLength:1024},'pkcs1');
const keys=[rsa,priv('ed25519',{},'pkcs8'),priv('ec',{namedCurve:'prime256v1'},'sec1')];
const mixed=bytes=>{
  let index=0;
  return bytes.toString('base64').replace(/[+/]/g,char=>index++%2?char:char==='+'?'-':'_');
};
const views={
  base64:bytes=>bytes.toString('base64'),
  base64url:bytes=>bytes.toString('base64url'),
  mixed,
  wrapped:bytes=>bytes.toString('base64').match(/.{1,64}/g).join('\n'),
  hex:bytes=>bytes.toString('hex'),
  decimal:bytes=>'['+[...bytes].join(', /* byte */ \n')+']',
  pem:bytes=>'-----BEGIN '+['PRIVATE','KEY'].join(' ')+'-----\n'+bytes.toString('base64')+'\n-----END '+['PRIVATE','KEY'].join(' ')+'-----',
};
const blocked=content=>{
  expect(keyStructureFinding(content)).toBe(FINDING);
  const finding=credentialBufferFinding(content);
  expect([FINDING,'pem-header']).toContain(finding);
  expect(credentialContentFinding(path,content)).toBe(finding);
  for(const tracked of [false,true])expect(()=>manifestEntry(path,content,false,tracked))
    .toThrow(expect.objectContaining({code:'excluded-source-file'}));
};

describe('Forge key structure slice 1',()=>{
  it('acceptance break: blocks a 14-char oct k',()=>{
    blocked(Buffer.from(JSON.stringify({kty:'oct',k:'abcdefghijklm'+'n'})));
  });
  it('acceptance break: blocks mixed-alphabet RSA',()=>{
    const text=mixed(rsa);
    expect(text).toMatch(/[+/]/);
    expect(text).toMatch(/[-_]/);
    expect(Buffer.from(text,'base64')).toEqual(rsa);
    expect(createPrivateKey({key:Buffer.from(text,'base64'),format:'der',type:'pkcs1'}).type).toBe('private');
    blocked(Buffer.from(text));
  });
  it('blocks RSA multiprime oth private members without a top-level d (red-team #7076)',()=>{
    blocked(Buffer.from(JSON.stringify({kty:'RSA',oth:[{r:'a',d:'b',t:'c'}]})));
    blocked(Buffer.from(JSON.stringify({kty:'RSA',n:'AQAB',e:'AQAB',oth:[{r:'a',d:'b',t:'c'}]}).replace('[','/* x */[')));
    expect(keyStructureFinding(Buffer.from(JSON.stringify({kty:'RSA',n:'AQAB',e:'AQAB',oth:[]})))).toBeFalsy();
  });
  it('blocks a JWK after stray double quotes or an unclosed string (red-team #7076)',()=>{
    const jwk=JSON.stringify({kty:'oct',k:'abcdefghijklm'+'n'});
    const quote='"';
    for(const lead of [quote+' ',quote+' a '+quote+' b '+quote+' ','say '+quote+'hello '+quote+'x '+quote+'y\n','an unclosed '+quote+'string, '])
      blocked(Buffer.from(lead+jwk));
    expect(keyStructureFinding(Buffer.from('prose with a '+quote+' and {not json} only'))).toBeFalsy();
  });
  it('I1 decode once then detect (mixed alphabets, comments in byte arrays, hex, PEM)',()=>{
    for(const bytes of keys)for(const encode of Object.values(views))blocked(Buffer.from(encode(bytes)));
  });
  it.each(['RSA PKCS#1','PKCS#8','SEC1'])('blocks four-character-wrapped %s and other short base64 chunks',name=>{
    const bytes=keys[['RSA PKCS#1','PKCS#8','SEC1'].indexOf(name)];
    for(const width of [4,2,3,5,6,7]) {
      const chunks=bytes.toString('base64').match(new RegExp(`.{1,${width}}`,'g'));
      // Force a one-character final line even when the encoded length divides the width.
      if(chunks.at(-1).length===width) {
        const last=chunks.pop();chunks.push(last.slice(0,-1),last.slice(-1));
      }
      const text=chunks.join('\n');
      expect(chunks.at(-1).length).toBeLessThan(width);
      expect(Buffer.from(text,'base64')).toEqual(bytes);
      blocked(Buffer.from(text));
    }
  });
  it.each(['RSA PKCS#1','PKCS#8','SEC1'])('blocks an A-newline prefix before four-character-wrapped %s',name=>{
    const bytes=keys[['RSA PKCS#1','PKCS#8','SEC1'].indexOf(name)];
    const wrapped=bytes.toString('base64').match(/.{1,4}/g).join('\n');
    blocked(Buffer.from('A\n'+wrapped));
  });
  it.each(['RSA PKCS#1','PKCS#8','SEC1'])('blocks %s across encoding, chunk-width and surrounding-prose matrices',name=>{
    const bytes=keys[['RSA PKCS#1','PKCS#8','SEC1'].indexOf(name)];
    const encodings=Object.values(views).map(encode=>encode(bytes));
    for(const encode of [views.base64,views.base64url,mixed])for(const width of [2,3,4,5,6,7,64])
      encodings.push(encode(bytes).match(new RegExp(`.{1,${width}}`,'g')).join('\n'));
    for(const encoded of encodings)for(const prefix of ['A\n','AB\n','ABC\n','ordinary prose\n','ordinary prose =\n'])
      for(const suffix of ['\nA','\nordinary suffix','\n= ordinary suffix'])blocked(Buffer.from(prefix+encoded+suffix));
  });
  it('keeps invalid UTF-8 outside JSON strings from extending container scope',()=>{
    const noise=Buffer.from(Array.from({length:80},()=>[255,91]).flat());
    expect(keyStructureFinding(noise)).toBeNull();
    blocked(Buffer.concat([noise,Buffer.from(JSON.stringify({kty:'oct',k:'a'}))]));
  });
  it('I3 no length floors (oct k any length, 14-char k, private members)',()=>{
    for(const length of [1,2,3,4,8,13,14,15,16,22])
      blocked(Buffer.from(JSON.stringify({kty:'oct',k:'a'.repeat(length)})));
    for(const length of [1,2,3,14,16,22])for(const jwk of [{kty:'oct',k:'a'.repeat(length)},{k:'a'.repeat(length),kty:'oct'}])
      blocked(Buffer.from(JSON.stringify(jwk)));
    for(const kty of ['RSA','EC','OKP','oct'])for(const member of ['d','p','q','dp','dq','qi'])
      blocked(Buffer.from(JSON.stringify({kty,[member]:'a'})));
  });
  it('parses JSON object scope, escapes, strings and encoded JWK text',()=>{
    const object={kty:'oct',k:'a'};
    const text=JSON.stringify(object).replace('kty','k\\u0074y');
    for(const source of [text,JSON.stringify(text),JSON.stringify(JSON.stringify(text)),
      `const material = ${text};`,JSON.stringify({nested:object}),JSON.stringify([object])]) {
      blocked(Buffer.from(source));
      for(const encode of Object.values(views))blocked(Buffer.from(encode(Buffer.from(source))));
    }
  });
  it('keeps public JWKs, empty members, unrelated scopes and ordinary data clean',()=>{
    for(const object of [{kty:'oct',k:''},{kty:'RSA',k:'a'},{kty:'EC',d:''},
      {kty:'oct',nested:{k:'a'}},[{kty:'oct'},{k:'a'}],{kty:'OKP',kid:'a'},
      {note:'data',d:'a'}])expect(keyStructureFinding(Buffer.from(JSON.stringify(object)))).toBeNull();
    for(const bytes of [Buffer.from('ordinary documentation'),Buffer.from('[1, /* byte */ 2, 3]'),
      Buffer.from([48,3,2,1,1]),keys[1].subarray(0,-1)])expect(keyStructureFinding(bytes)).toBeNull();
  });
  it('walks embedded PKCS#8 v0/v1, PKCS#1 and SEC1 TLVs',()=>{
    const version1=Buffer.from(keys[1]);version1[4]=1;
    for(const bytes of [...keys,version1])blocked(Buffer.concat([Buffer.from('prefix '),bytes,Buffer.from(' suffix')]));
    // Minimal short scalar: no cryptographic-size threshold in structural recognition.
    const scalar=version=>Buffer.from([48,6,2,1,version,4,1,7]);
    blocked(scalar(1));
    for(const bytes of [scalar(0),scalar(2),
      Buffer.from([48,128,2,1,1,4,1,7,0,0]),Buffer.from([48,130,255,255,2,1,1])])
      expect(keyStructureFinding(bytes)).toBeNull();
  });
  it('fails closed on oversized input and names the operator local fallback',()=>{
    const bytes=Buffer.alloc(32*1024*1024+1,33);
    expect(keyStructureFinding(bytes)).toBe('private-key-scan-budget-exhausted-use-local');
    expect(credentialBufferFinding(bytes)).toBe('private-key-scan-budget-exhausted-use-local');
  });
  it('fails closed on candidate-count exhaustion',()=>{
    // Ordinary prose is terminal after decoding; use distinct escaped text layers to
    // exhaust the queue of views that actually need further canonicalization.
    const text=Array.from({length:16400},(_,index)=>JSON.stringify('value'+String(index).padStart(8,'0'))
      .replace('v','\\u0076')).join('\n');
    expect(keyStructureFinding(Buffer.from(text))).toBe('private-key-scan-budget-exhausted-use-local');
  });
  it('keeps many ordinary encoded-looking words clean without exhausting candidates',()=>{
    const text=Array.from({length:16400},(_,index)=>'value'+String(index).padStart(8,'0')).join(' ');
    expect(keyStructureFinding(Buffer.from(text))).toBeNull();
  });
  it('detects minimal structures before pruning terminal decoded views',()=>{
    const version=1;
    const minimal=Buffer.from([48,6,2,1,version,4,1,7]);
    for(const encode of Object.values(views))blocked(Buffer.from(encode(minimal)));
    blocked(Buffer.from(minimal.toString('base64url')));
    const text=JSON.stringify({kty:'oct',k:'a'});
    for(const body of [Buffer.from(text),Buffer.from(text,'utf16le'),Buffer.from(text,'utf16le').swap16()]) {
      blocked(body);
      blocked(Buffer.from(body.toString('base64')));
      // Decoded binary may surround another encoded representation.
      blocked(Buffer.from(Buffer.concat([Buffer.from([255]),body,Buffer.from([255])]).toString('hex')));
    }
  });
  it('preserves nested UTF-16 text after non-ASCII prefixes and Unicode whitespace',()=>{
    const text=JSON.stringify({kty:'oct',k:'a'});
    const wrapped=Buffer.from(text).toString('base64').split('').join('\u2003');
    for(const innerBE of [false,true])for(const outerBE of [false,true])for(const source of [text,wrapped]) {
      const inner=Buffer.from(source,'utf16le');
      if(innerBE)inner.swap16();
      const outer=Buffer.from(inner.toString('latin1'),'utf16le');
      if(outerBE)outer.swap16();
      blocked(outer);
      const prefix=Buffer.from('\u0800'.repeat(100),'utf16le');
      if(outerBE)prefix.swap16();
      blocked(Buffer.concat([prefix,outer]));
    }
  });
  it.each(['LE','BE'])('blocks embedded UTF-16%s after odd and even binary prefixes',endian=>{
    const text=JSON.stringify({kty:'oct',k:'a'});
    const body=Buffer.from(text,'utf16le');
    if(endian==='BE')body.swap16();
    for(const prefixLength of [0,1,2,3])for(const suffixLength of [0,1]) {
      const bytes=Buffer.concat([Buffer.alloc(prefixLength,255),body,Buffer.alloc(suffixLength,255)]);
      blocked(bytes);
      blocked(Buffer.from(bytes.toString('hex')));
      blocked(Buffer.from(bytes.toString('base64')));
    }
  });
  it('fails closed on decoding depth and JSON nesting exhaustion',()=>{
    let text=JSON.stringify({kty:'oct',k:'a'});
    for(let depth=0;depth<10;depth++)text=JSON.stringify(text);
    for(const source of [text,'['.repeat(65)+']'.repeat(65)])
      expect(keyStructureFinding(Buffer.from(source))).toBe('private-key-scan-budget-exhausted-use-local');
  });
  // Members are assembled at runtime so this source file holds no literal JWK for the tracked sweep.
  const member=(name,value)=>JSON.stringify(name)+':'+JSON.stringify(value);
  const jwk=(...members)=>'{'+members.map(([name,value])=>member(name,value)).join(',')+'}';
  it('I3 scans every duplicate JSON member, not the parsed object',()=>{
    blocked(Buffer.from(jwk(['kty','oct'],['k','abcdefghijklmn'],['k',''])));
    blocked(Buffer.from(jwk(['d','abcd'],['kty','RSA'],['d',''])));
    blocked(Buffer.from(jwk(['kty','oct'],['k','abcdefghijklmn'],['kty','RSA'])));
    blocked(Buffer.from(jwk(['kty','RSA'],['k','abcdefghijklmn'],['kty','oct'])));
    expect(keyStructureFinding(Buffer.from(jwk(['kty','oct'],['k',''],['k',''])))).toBeNull();
  });
  it('I1 finds a JWK inside line and block comments',()=>{
    const key=jwk(['kty','oct'],['k','abcdefghijklmn']);
    blocked(Buffer.from('// '+key));
    blocked(Buffer.from('/* '+key+' */'));
    blocked(Buffer.from(key.replace(',',', /* c */ ')));
  });
  it('fails closed on unreadable input',()=>{
    expect(keyStructureFinding(null)).toBe('private-key-scan-unreadable-use-local');
  });
});
