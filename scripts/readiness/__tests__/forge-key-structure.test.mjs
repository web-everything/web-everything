import {generateKeyPairSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {credentialBufferFinding,credentialContentFinding,credentialTextFinding} from '../forge-exec-manifest.mjs';

// Fixtures are generated or assembled at runtime so this file passes its own scan.
const FINDING='private-key-structure';
const priv=(type,opts,format,extra={})=>generateKeyPairSync(type,{...opts,privateKeyEncoding:{format:'der',...format},...extra}).privateKey;
const ed=priv('ed25519',{},{type:'pkcs8'});
const rsa=priv('rsa',{modulusLength:1024},{type:'pkcs1'});
const rsa8=priv('rsa',{modulusLength:1024},{type:'pkcs8'});
const ec=priv('ec',{namedCurve:'prime256v1'},{type:'sec1'});
const ec8=priv('ec',{namedCurve:'secp384r1'},{type:'pkcs8'});
const ssh=Buffer.concat([Buffer.from('openssh-key-v1\0'),Buffer.from('none'.padEnd(40,'x'))]);
const putty=Buffer.from(['PuTTY','User','Key','File'].join('-')+'-3: ssh-ed25519\nEncryption: none\n');

const binaries={'pkcs8-ed25519':ed,'pkcs1-rsa':rsa,'pkcs8-rsa':rsa8,'sec1-ec':ec,'pkcs8-ec-p384':ec8,'openssh-key-v1':ssh,'putty':putty};
const jwks={};
for(const [name,type,opts] of [['rsa','rsa',{modulusLength:1024}],['ec','ec',{namedCurve:'P-256'}],['okp','ed25519',{}]])
  jwks['jwk-'+name]=Buffer.from(JSON.stringify(generateKeyPairSync(type,opts).privateKey.export({format:'jwk'})));
jwks['jwk-oct']=Buffer.from(JSON.stringify({kty:'oct',k:Buffer.alloc(32,7).toString('base64url')}));
jwks['jwk-pretty']=Buffer.from(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'}),null,4));

const wrap=(s,n)=>s.match(new RegExp(`.{1,${n}}`,'g')).join('\n');
const views={
  base64:b=>b.toString('base64'),
  'base64-wrapped':b=>wrap(b.toString('base64'),64),
  base64url:b=>b.toString('base64url'),
  hex:b=>b.toString('hex'),
  'hex-0x':b=>[...b].map(x=>'0x'+x.toString(16).padStart(2,'0')).join(', '),
  'hex-colon':b=>b.toString('hex').match(/../g).join(':'),
  'hex-escape':b=>[...b].map(x=>'\\x'+x.toString(16).padStart(2,'0')).join(''),
  decimal:b=>'['+[...b].join(', ')+']',
  'decimal-json':b=>JSON.stringify({material:[...b]},null,4),
};
const embed=s=>`// config\nconst value = "${s}";\n`;
const embedPlain=s=>`# data\nvalue: ${s}\n`;

describe('forge-key-structure: structured keys without a label',()=>{
  for(const [name,bytes] of Object.entries({...binaries,...jwks})) {
    for(const [view,encode] of Object.entries(views)) {
      const text=encode(bytes);
      it(`${name} as ${view} is blocked`,()=>{
        for(const body of [text,embed(text),embedPlain(text),'prefix glued '+text+' suffix']) {
          const buf=Buffer.from(body);
          expect(credentialBufferFinding(buf),body.slice(0,60)).toBe(FINDING);
          expect(credentialContentFinding(Buffer.from('docs/notes.md'),buf)).toBe(FINDING);
        }
      });
    }
  }
  for(const [name,bytes] of Object.entries(binaries))
    it(`${name} raw bytes are blocked under an innocent name`,()=>{
      expect(credentialBufferFinding(bytes)).toBe(FINDING);
      expect(credentialBufferFinding(Buffer.concat([Buffer.from('junk-prefix'),bytes,Buffer.from('tail')]))).toBe(FINDING);
    });
  for(const [name,bytes] of Object.entries(jwks))
    it(`${name} plain text is blocked`,()=>{
      expect(credentialBufferFinding(bytes)).toBe(FINDING);
      expect(credentialContentFinding(Buffer.from('docs/notes.json'),bytes)).toBe(FINDING);
    });
  it('blocks UTF-16 encoded text',()=>{
    const text=embed(ed.toString('base64'));
    expect(credentialBufferFinding(Buffer.from(text,'utf16le'))).toBe(FINDING);
    expect(credentialBufferFinding(Buffer.from(text,'utf16le').swap16())).toBe(FINDING);
  });
  it('blocks across line comments inside a wrapped body',()=>{
    const lines=wrap(rsa.toString('base64'),64).split('\n');
    const text=lines.map((l,i)=>i%2?l+'  # chunk '+i:l).join('\n');
    expect(credentialBufferFinding(Buffer.from(text))).toBe(FINDING);
  });
});

describe('forge-key-structure: clean inputs stay clean',()=>{
  it('privateKeyPath beside a 40-hex SHA',()=>{
    const text='const privateKeyPath = "keys/x.pem";\nconst sha = "'+'a1ce49e0'.repeat(5)+'";\n';
    expect(credentialBufferFinding(Buffer.from(text))).toBeNull();
  });
  it('ordinary public key material, prose and hashes',()=>{
    const pub=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'});
    for(const text of ['hello world\n',pub.toString('base64'),pub.toString('hex'),JSON.stringify({kty:'EC',crv:'P-256',x:'abc',y:'def'}),
      '1.2.3 version 10 20 30','sha256 '+'0123456789abcdef'.repeat(4)])
      expect(credentialBufferFinding(Buffer.from(text)),text).toBeNull();
  });
});

describe('forge-key-structure: never weaker than main',()=>{
  const BEGIN='-----'+'BEGIN '+'PRIVATE '+'KEY-----';
  const cases=[[BEGIN,'pem-header'],['-----'+'BEGIN CERTIFICATE-----','pem-header'],['the private '+'key is here','private-key'],
    ['PRIVATE '+'KEY','private-key'],['Private '+'Key','private-key'],['ghp_'+'a'.repeat(24),'github-token'],
    ['AKIA'+'A'.repeat(16),'aws-access-key'],['sk-'+'a'.repeat(20),'sk-token']];
  for(const [text,expected] of cases)
    it(`still reports ${expected} for ${JSON.stringify(text.slice(0,20))}`,()=>{
      expect(credentialTextFinding(text)).toBe(expected);
      expect(credentialBufferFinding(Buffer.from(text))).toBe(expected);
      expect(credentialBufferFinding(Buffer.from(text,'utf16le'))).toBe(expected);
      expect(credentialContentFinding(Buffer.from('docs/notes.md'),Buffer.from(text))).toBe(expected);
    });
  it('a labelled structured key keeps main finding (label rule wins)',()=>{
    const text=BEGIN+'\n'+ed.toString('base64')+'\n';
    expect(credentialBufferFinding(Buffer.from(text))).toBe('pem-header');
  });
});

describe('forge-key-structure: shipped sources are scan-clean',()=>{
  it('the manifest and this test carry no blocking finding of their own',()=>{
    for(const file of ['../forge-exec-manifest.mjs','./forge-key-structure.test.mjs']) {
      const bytes=readFileSync(new URL(file,import.meta.url));
      expect(credentialBufferFinding(bytes),file).toBeNull();
      expect(credentialContentFinding(Buffer.from(file.replace(/^[./]+/,'')),bytes),file).toBeNull();
    }
  });
});

describe('forge-key-structure: perf and tracked files',()=>{
  it('scans a 3 MiB adversarial blob in under one second',()=>{
    const size=3*1024*1024;
    const blobs=[Buffer.alloc(size,0x41),Buffer.from('A'.repeat(size)),Buffer.from('0, '.repeat(size/3)),
      Buffer.from('0x3'.repeat(size/3)),Buffer.from('+/'.repeat(size/2)),Buffer.from('30 '.repeat(size/3)),
      Buffer.from('a-_'.repeat(size/3)),Buffer.from('# x\n'.repeat(size/4)),Buffer.from('"kty":"RSA" '.repeat(size/12))];
    for(const blob of blobs) {
      const start=performance.now();
      credentialBufferFinding(blob);
      expect(performance.now()-start).toBeLessThan(1000);
    }
  });
  it('adds no more than a handful of findings over tracked files',()=>{
    const files=execFileSync('git',['ls-files','-z'],{maxBuffer:1<<26}).toString().split('\0').filter(Boolean);
    const hits=[];
    for(const file of files) {
      let bytes;
      try {bytes=readFileSync(file);} catch {continue;}
      if(bytes.length>3*1024*1024)continue;
      if(credentialBufferFinding(bytes)===FINDING)hits.push(file);
    }
    // Measured 2026-11-15: three fixture files carry fake PKCS#1 key bodies hidden behind \x escapes; blocking them
    // only sends those files to the Mac fallback. Any new hit beyond these needs a deliberate review.
    expect(hits.sort()).toEqual(['scripts/conveyor/__tests__/ci-heal-mark.test.mjs','scripts/operations/__tests__/coroner-transcripts.test.mjs',
      'scripts/readiness/__tests__/remote-git-bundle.test.mjs'].sort());
  },120000);
});
