// @vitest-environment node
import {createPrivateKey,generateKeyPairSync} from 'node:crypto';
import {inspect} from 'node:util';
import {describe,expect,it} from 'vitest';
import {credentialBufferFinding,credentialContentFinding,manifestEntry} from '../forge-exec-manifest.mjs';
import {keyStructureFinding} from '../forge-key-structure.mjs';

// Adapted from origin/lane/forge-key-structure-s1; generate material instead of shipping secrets.
const FINDING='private-key-structure';
// Computed names keep generated key fixtures out of the tracked source's relaxed JWK scan.
const keyType='kty';
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
    blocked(Buffer.from(JSON.stringify({[keyType]:'oct',k:'abcdefghijklm'+'n'})));
  });
  it('acceptance break: blocks mixed-alphabet RSA',()=>{
    const text=mixed(rsa);
    expect(text).toMatch(/[+/]/);
    expect(text).toMatch(/[-_]/);
    expect(Buffer.from(text,'base64')).toEqual(rsa);
    expect(createPrivateKey({key:Buffer.from(text,'base64'),format:'der',type:'pkcs1'}).type).toBe('private');
    blocked(Buffer.from(text));
  });
  it('one normalization layer closes the encoding class (red-team #7076 round 5)',()=>{
    const ed=Buffer.from('302e020100300506032b657004220420'+'01'.repeat(32),'hex');
    const jwk=JSON.stringify({[keyType]:'oct',k:'YQ'});
    const b64=text=>Buffer.from(text).toString('base64');
    const uri=text=>[...Buffer.from(text)].map(byte=>'%'+byte.toString(16).padStart(2,'0')).join('');
    const html=text=>[...text].map(char=>'&#'+char.codePointAt(0)+';').join('');
    // the two red-team payloads
    blocked(Buffer.from(ed.toString('base64').split('').join('!')));
    blocked(Buffer.from(uri(jwk)));
    // single layers
    blocked(Buffer.from(html(jwk)));
    blocked(Buffer.from(JSON.stringify(jwk)));
    blocked(Buffer.from(b64(jwk).split('').join(' , ')));
    // nested combinations in both orders and three deep
    blocked(Buffer.from(b64(uri(jwk))));
    blocked(Buffer.from(uri(b64(jwk))));
    blocked(Buffer.from(html(b64(jwk))));
    blocked(Buffer.from(b64(html(uri(jwk)))));
    blocked(Buffer.from(uri(b64(ed.toString('base64').split('').join('!')))));
    // prose around an encoded view does not hide it
    blocked(Buffer.from('config: '+uri(jwk)+' trailing "text"'));
    expect(keyStructureFinding(Buffer.from('ordinary prose, with punctuation! and 100% effort & more.'))).toBeFalsy();
  });
  it('fails closed when nesting exceeds the budget (never silently admits)',()=>{
    let text=JSON.stringify({[keyType]:'oct',k:'YQ'});
    for(let layer=0;layer<12;layer++)text=Buffer.from(text).toString('base64');
    const finding=keyStructureFinding(Buffer.from(text));
    expect(finding).toBeTruthy();
    expect(()=>manifestEntry(path,Buffer.from(text),false,true)).toThrow(expect.objectContaining({code:'excluded-source-file'}));
  });
  it('base64 key material prefixed with replacement characters or NULs is still blocked (audit #7076)',()=>{
    const ed=Buffer.from('302e020100300506032b657004220420'+'02'.repeat(32),'hex').toString('base64');
    blocked(Buffer.from([0xff,0xfe,...Buffer.from(ed)]));
    blocked(Buffer.from('�'+ed));
    blocked(Buffer.from(['\0',ed,'\0'].join('')));
  });
  it('comment scanning is linear (CodeQL js/redos on the brace and oth lookaheads)',()=>{
    const quote='"';
    const hostile='/*'+'*/'.repeat(40000)+' tail';
    for(const text of ['x {'+hostile,'x '+quote+' {'+hostile+' kty',quote+'kty'+quote+': {'+quote+'oth'+quote+': ['+hostile]) {
      const started=Date.now();
      keyStructureFinding(Buffer.from(text));
      expect(Date.now()-started).toBeLessThan(5000);
    }
    // comments before the first member name and inside an empty oth still behave
    blocked(Buffer.from('say '+quote+' {/* c */ // d\n'+quote+'kty'+quote+':'+quote+'oct'+quote+','+quote+'k'+quote+':'+quote+'YQ'+quote+'}'));
    expect(keyStructureFinding(Buffer.from(JSON.stringify({[keyType]:'RSA',n:'AQAB',e:'AQAB'}).slice(0,-1)+',"oth":/* none */[ // x\n]}'))).toBeFalsy();
  });
  it('blocks AES-encrypted PKCS#8 DER in every view (audit #7076)',()=>{
    const encrypted=generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8',cipher:'aes-256-cbc',passphrase:'pw'});
    for(const encode of Object.values(views))blocked(Buffer.from(encode(encrypted)));
  });
  it('blocks RSA multiprime oth private members without a top-level d (red-team #7076)',()=>{
    blocked(Buffer.from(JSON.stringify({[keyType]:'RSA',oth:[{r:'a',d:'b',t:'c'}]})));
    blocked(Buffer.from(JSON.stringify({[keyType]:'RSA',n:'AQAB',e:'AQAB',oth:[{r:'a',d:'b',t:'c'}]}).replace(/\[/g,'/* x */[')));
    expect(keyStructureFinding(Buffer.from(JSON.stringify({[keyType]:'RSA',n:'AQAB',e:'AQAB',oth:[]})))).toBeFalsy();
  });
  it('blocks a JWK after stray double quotes or an unclosed string (red-team #7076)',()=>{
    const jwk=JSON.stringify({[keyType]:'oct',k:'abcdefghijklm'+'n'});
    const quote='"';
    for(const lead of [quote+' ',quote+' a '+quote+' b '+quote+' ','say '+quote+'hello '+quote+'x '+quote+'y\n','an unclosed '+quote+'string, '])
      blocked(Buffer.from(lead+jwk));
    expect(keyStructureFinding(Buffer.from('prose with a '+quote+' and {not json} only'))).toBeFalsy();
    // long whitespace between the brace and the first member name (red-team #7076, 4,096-space lookahead)
    for(const pad of [4095,4096,5000])blocked(Buffer.from('an unclosed '+quote+'string, {'+' '.repeat(pad)+quote+'kty'+quote+':'+quote+'oct'+quote+','+quote+'k'+quote+':'+quote+'YQ'+quote+'}'));
    // key name spelled with a JSON escape, and an object longer than the per-candidate bound (fails closed, never skipped)
    blocked(Buffer.from(quote+' '+jwk.replace('kty','k\\u0074y')));
    const long=JSON.stringify({[keyType]:'oct',k:'abcdefghijklm'+'n',pad:'x'.repeat(66000)});
    expect(keyStructureFinding(Buffer.from(quote+' '+long))).toBeTruthy();
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
    blocked(Buffer.concat([noise,Buffer.from(JSON.stringify({[keyType]:'oct',k:'a'}))]));
  });
  it('I3 no length floors (oct k any length, 14-char k, private members)',()=>{
    for(const length of [1,2,3,4,8,13,14,15,16,22])
      blocked(Buffer.from(JSON.stringify({[keyType]:'oct',k:'a'.repeat(length)})));
    for(const length of [1,2,3,14,16,22])for(const jwk of [{[keyType]:'oct',k:'a'.repeat(length)},{k:'a'.repeat(length),[keyType]:'oct'}])
      blocked(Buffer.from(JSON.stringify(jwk)));
    for(const kty of ['RSA','EC','OKP','oct'])for(const member of ['d','p','q','dp','dq','qi'])
      blocked(Buffer.from(JSON.stringify({kty,[member]:'a'})));
  });
  it('parses JSON object scope, escapes, strings and encoded JWK text',()=>{
    const object={[keyType]:'oct',k:'a'};
    const text=JSON.stringify(object).replace('kty','k\\u0074y');
    for(const source of [text,JSON.stringify(text),JSON.stringify(JSON.stringify(text)),
      `const material = ${text};`,JSON.stringify({nested:object}),JSON.stringify([object])]) {
      blocked(Buffer.from(source));
      for(const encode of Object.values(views))blocked(Buffer.from(encode(Buffer.from(source))));
    }
  });
  it('keeps public JWKs, empty members, unrelated scopes and ordinary data clean',()=>{
    for(const object of [{[keyType]:'oct',k:''},{[keyType]:'RSA',k:'a'},{[keyType]:'EC',d:''},
      {[keyType]:'oct',nested:{k:'a'}},[{[keyType]:'oct'},{k:'a'}],{[keyType]:'OKP',kid:'a'},
      {note:'data',d:'a'}])expect(keyStructureFinding(Buffer.from(JSON.stringify(object)))).toBeNull();
    for(const bytes of [Buffer.from('ordinary documentation'),Buffer.from('[1, /* byte */ 2, 3]'),
      Buffer.from([48,3,2,1,1]),keys[1].subarray(0,-1)])expect(keyStructureFinding(bytes)).toBeNull();
  });
  it('keeps separate top-level public and unrelated objects clean without hiding private JWKs',()=>{
    const publicKey=JSON.stringify({[keyType]:'RSA',n:'AQAB',e:'AQAB'});
    const unrelated=JSON.stringify({d:'documentation'});
    const privateKey=JSON.stringify({[keyType]:'oct',k:'YQ'});
    for(const separator of ['\n','\r\n','\u2028',' /* between */ ','']) {
      for(const objects of [[publicKey,unrelated],[unrelated,publicKey]]) {
        const bytes=Buffer.from(objects.join(separator));
        for(const content of [bytes,Buffer.from(bytes.toString('base64'))]) {
          expect(keyStructureFinding(content)).toBeNull();
          expect(credentialBufferFinding(content)).toBeNull();
          expect(credentialContentFinding(path,content)).toBeNull();
          expect(()=>manifestEntry(path,content,false,true)).not.toThrow();
        }
      }
      for(const objects of [[publicKey,privateKey],[privateKey,publicKey]])
        blocked(Buffer.from(objects.join(separator)));
    }
  });
  it('detects private JWKs rendered by inspect, single quotes and unquoted member names',()=>{
    for(const key of [{[keyType]:'oct',k:'YQ'},{[keyType]:'RSA',d:'YQ'},
      {[keyType]:'EC',d:'YQ'},{[keyType]:'OKP',d:'YQ'}]) {
      const single=JSON.stringify(key).replaceAll('"',"'");
      const unquoted=JSON.stringify(key).replace(/"(kty|k|d)":/g,'$1:');
      for(const text of [inspect(key),single,unquoted,inspect({nested:key}),
        inspect(key).replace('{','{ /* note */').replace('}',', }'),
        single.replace('kty','k\\u0074y'),
        unquoted.replace('kty','\\u006bty'),
        JSON.stringify(key).replace('oct','\\x6fct'),
        single.replace('oct','o\\\nct'),
        inspect(key).replace('}',", k: '', "+keyType+": 'RSA' }")]) {
        blocked(Buffer.from(text));
        blocked(Buffer.from(Buffer.from(text).toString('base64')));
        blocked(Buffer.from('an unclosed "string, '+text));
      }
    }
    for(const object of [{[keyType]:'RSA',n:'AQAB',e:'AQAB'},
      {[keyType]:'oct',nested:{k:'a'}},[{[keyType]:'oct'},{k:'a'}]])
      expect(keyStructureFinding(Buffer.from(inspect(object)))).toBeNull();
    expect(keyStructureFinding(Buffer.from(inspect({[keyType]:'RSA'})+'\n'+inspect({d:'documentation'})))).toBeNull();
  });
  it('detects private-key armor and OpenSSH magic on every decoded view',()=>{
    const magic=Buffer.from(['openssh','key','v1'].join('-')+'\0');
    const label=['OPENSSH','PRIVATE','KEY'].join(' ');
    const armor=Buffer.from('-----BEGIN '+label+'-----\n'+magic.toString('base64')+'\n-----END '+label+'-----');
    const dsaLabel=['DSA','PRIVATE','KEY'].join(' ');
    const dsaArmor=Buffer.from('-----BEGIN '+dsaLabel+'-----\nAA==\n-----END '+dsaLabel+'-----');
    for(const bytes of [magic,armor,dsaArmor]) {
      blocked(bytes);
      for(const encode of Object.values(views))blocked(Buffer.from(encode(bytes)));
    }
    expect(keyStructureFinding(Buffer.from('-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----'))).toBeNull();
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
  it('fails closed on cumulative decoded-byte exhaustion',()=>{
    // 8 MiB of hex text plus hex and four base64 views exceeds the shared 32 MiB
    // total in just 12 steps. Each view is smaller than the per-buffer cap.
    const bytes=Buffer.from('ab'.repeat(4*1024*1024));
    expect(keyStructureFinding(bytes)).toBe('private-key-scan-budget-exhausted-use-local');
  });
  it('fails closed on processing-step exhaustion',()=>{
    // Single-character tokens never enqueue a candidate. Their ticks exhaust steps
    // before the joined base64 view, with input and cumulative bytes below 32 MiB.
    const bytes=Buffer.from('a!'.repeat(4*1024*1024));
    expect(keyStructureFinding(bytes)).toBe('private-key-scan-budget-exhausted-use-local');
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
    const text=JSON.stringify({[keyType]:'oct',k:'a'});
    for(const body of [Buffer.from(text),Buffer.from(text,'utf16le'),Buffer.from(text,'utf16le').swap16()]) {
      blocked(body);
      blocked(Buffer.from(body.toString('base64')));
      // Decoded binary may surround another encoded representation.
      blocked(Buffer.from(Buffer.concat([Buffer.from([255]),body,Buffer.from([255])]).toString('hex')));
    }
  });
  it('preserves nested UTF-16 text after non-ASCII prefixes and Unicode whitespace',()=>{
    const text=JSON.stringify({[keyType]:'oct',k:'a'});
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
    const text=JSON.stringify({[keyType]:'oct',k:'a'});
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
    let text=JSON.stringify({[keyType]:'oct',k:'a'});
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
