// @vitest-environment node
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,expect,it,vi} from 'vitest';
import {credentialBufferFinding,credentialContentFinding,credentialTextFinding,manifestEntry,secretText} from '../forge-exec-manifest.mjs';
import {buildManifest,main,runRemote} from '../remote-exec.mjs';
import {scanBundleRange} from '../remote-git-bundle.mjs';
import {easternTimestamp} from '../forge-exec-run.mjs';

// Fixtures are generated or assembled at runtime so this file passes its own scan.
const FINDING='private-key-structure';
const priv=(type,opts,format,extra={})=>generateKeyPairSync(type,{...opts,privateKeyEncoding:{format:'der',...format},...extra}).privateKey;
const ed=priv('ed25519',{},{type:'pkcs8'});
const rsa=priv('rsa',{modulusLength:1024},{type:'pkcs1'});
const rsa8=priv('rsa',{modulusLength:1024},{type:'pkcs8'});
const ec=priv('ec',{namedCurve:'prime256v1'},{type:'sec1'});
const ec8=priv('ec',{namedCurve:'secp384r1'},{type:'pkcs8'});
const ssh=Buffer.concat([Buffer.from(['openssh','key','v1'].join('-')+String.fromCharCode(0)),Buffer.from('none'.padEnd(40,'x'))]);
const putty=Buffer.from(['PuTTY','User','Key','File'].join('-')+'-3: ssh-ed25519\nEncryption: none\n');

const binaries={'pkcs8-ed25519':ed,'pkcs1-rsa':rsa,'pkcs8-rsa':rsa8,'sec1-ec':ec,'pkcs8-ec-p384':ec8,'openssh-key-v1':ssh,'putty':putty};
Object.assign(binaries,{
  'pkcs8-x25519':priv('x25519',{},{type:'pkcs8'}),
  'pkcs8-ec-p256':priv('ec',{namedCurve:'prime256v1'},{type:'pkcs8'}),
  'pkcs8-ec-p521':priv('ec',{namedCurve:'secp521r1'},{type:'pkcs8'}),
  'sec1-ec-p384':priv('ec',{namedCurve:'secp384r1'},{type:'sec1'}),
  'sec1-ec-p521':priv('ec',{namedCurve:'secp521r1'},{type:'sec1'}),
  'pkcs1-rsa-512':priv('rsa',{modulusLength:512},{type:'pkcs1'}),
  'pkcs8-ec-secp256k1':priv('ec',{namedCurve:'secp256k1'},{type:'pkcs8'}),
});
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
  'hex-percent':b=>[...b].map(x=>'%'+x.toString(16).padStart(2,'0')).join(''),
  decimal:b=>'['+[...b].join(', ')+']',
  'decimal-signed':b=>'['+[...b].map(x=>x<128?x:x-256).join(', ')+']',
  'decimal-json':b=>JSON.stringify({material:[...b]},null,4),
};
const embed=s=>`// config\nconst value = "${s}";\n`;
const embedPlain=s=>`# data\nvalue: ${s}\n`;
// Send-back x1b8hlo: usable keys, including modulus sizes absent from the signature inventory.
const rsaVariants=[768,1536,1544,2048].map(modulusLength=>({modulusLength,
  bytes:priv('rsa',{modulusLength},{type:'pkcs1'})}));
const staticJwk=generateKeyPairSync('ed25519').privateKey.export({format:'jwk'});
const staticJwkVariants=Object.fromEntries([
  ['computed double quotes',key=>'['+JSON.stringify(key)+']',JSON.stringify],
  ['computed single quotes',key=>"['"+key+"']",JSON.stringify],
  ['backtick values',key=>key,value=>'`'+value+'`'],
  ['computed backticks',key=>'[`'+key+'`]',value=>'`'+value+'`'],
  ['computed names across line comments',key=>'[ // name\r\n'+JSON.stringify(key)+'\u2028]',JSON.stringify],
  ['escaped computed names',key=>'[ /* name */ "'+[...key].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'" ]',JSON.stringify],
].map(([name,keyText,valueText])=>[name,'{'+Object.entries(staticJwk).map(([key,value])=>keyText(key)+':'+valueText(value)).join(',\r\n')+'}']));
// Inventory is separate from fixture registration: removing an advertised fixture/view must fail the gate.
const supportedFormats=['pkcs8-ed25519','pkcs8-x25519','pkcs1-rsa','pkcs1-rsa-512','pkcs8-rsa',
  'sec1-ec','sec1-ec-p384','sec1-ec-p521','pkcs8-ec-p256','pkcs8-ec-p384','pkcs8-ec-p521',
  'pkcs8-ec-secp256k1','openssh-key-v1','putty','jwk-rsa','jwk-ec','jwk-okp','jwk-oct','jwk-pretty'];
const supportedViews=['base64','base64-wrapped','base64url','hex','hex-0x','hex-colon','hex-escape',
  'hex-percent','decimal','decimal-signed','decimal-json'];

describe('forge-key-structure: structured keys without a label',()=>{
  it('registers the complete supported-format and supported-view inventory',()=>{
    expect(Object.keys({...binaries,...jwks}).sort()).toEqual([...supportedFormats].sort());
    expect(Object.keys(views).sort()).toEqual([...supportedViews].sort());
  });
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
  it('blocks a JWK whose keywords are spelled with escapes',()=>{
    const text=jwks['jwk-ec'].toString().replace('kty','k\\u0074y');
    expect(credentialContentFinding(Buffer.from('docs/notes.md'),Buffer.from(text))).toBe(FINDING);
    expect(credentialContentFinding(Buffer.from('docs/notes.md'),Buffer.from(text.replace(/\\u0074/,'\\x74')))).toBe(FINDING);
  });
  it('blocks Markdown-escaped JWK values through the backslash-dropped view',()=>{
    const text=JSON.stringify({kty:'oct',k:'_'.repeat(32)}).replace(/_/g,'\\_');
    expect(credentialContentFinding(Buffer.from('credentials.md'),Buffer.from(text))).toBe(FINDING);
  });
  it('preserves legacy token priority across both decoded views',()=>{
    const text=jwks['jwk-ec'].toString().replace('kty','k\\u0074y')+'\nghp\\_'+'a'.repeat(24);
    expect(credentialContentFinding(Buffer.from('credentials.md'),Buffer.from(text))).toBe('github-token');
  });
  for(const [view,token] of [['escape-decoded','ghp\\u005f'],['backslash-dropped','ghp\\_']])
    for(const encoding of ['raw','base64'])
      it(`legacy token in ${view} wins over a ${encoding} structured key`,()=>{
        const key=encoding==='raw'?jwks['jwk-ec'].toString():jwks['jwk-ec'].toString('base64');
        const text=key+'\n'+token+'a'.repeat(24);
        expect(credentialContentFinding(Buffer.from('credentials.md'),Buffer.from(text))).toBe('github-token');
      });
  it.each([
    ['invalid UTF-8',Buffer.concat([Buffer.from([255]),ed])],
    ['NUL',Buffer.concat([Buffer.from([0]),ed])],
    ['UTF-16',Buffer.from(jwks['jwk-ec'].toString(),'utf16le')],
  ])('retains the structure finding with %s content',(_name,content)=>{
    expect(credentialContentFinding(Buffer.from('credentials.md'),content)).toBe(FINDING);
  });
  it.each(['ghp\\u005f','ghp\\_'])('preserves tokens beyond escape-decoder chunks (%s)',token=>{
    const text='\\x41'.repeat(8192)+'\n'+token+'a'.repeat(24);
    expect(credentialContentFinding(Buffer.from('credentials.md'),Buffer.from(text))).toBe('github-token');
  });
  it.each(['raw','base64'])('blocks a serialized JWK with escaped braces in %s',encoding=>{
    const text=JSON.stringify(jwks['jwk-ec'].toString()).replace('{','\\u007b').replace('}','\\u007d');
    const content=Buffer.from(encoding==='raw'?text:Buffer.from(text).toString('base64'));
    expect(credentialBufferFinding(content)).toBe(FINDING);
    expect(credentialContentFinding(Buffer.from('credentials.md'),content)).toBe(FINDING);
  });
  for(const quoting of ['"',"'",''])
    for(const order of [false,true])
      it(`blocks private members in the same object (${quoting||'bare'} names, reversed=${order})`,()=>{
        const fields=[`${quoting}kty${quoting}:"EC"`,`${quoting}d${quoting}:"${'a'.repeat(32)}"`];
        if(order)fields.reverse();
        expect(credentialBufferFinding(Buffer.from('{'+fields.join(',')+'}'))).toBe(FINDING);
      });
  it.each(['d','p','q','dp','dq','qi','k'])('recognizes exact private member %s even before a duplicate',member=>{
    const text=`{"kty":"RSA","${member}":"${'a'.repeat(32)}","${member}":"short"}`;
    expect(credentialBufferFinding(Buffer.from(text))).toBe(FINDING);
  });
  it.each(['\n','\r\n',String.fromCharCode(0x2028),'\u00a0'])('accepts JWK member whitespace %j',space=>{
    const text=`{${space}"kty"${space}:${space}"EC",${space}"d":"${'a'.repeat(32)}"}`;
    expect(credentialBufferFinding(Buffer.from(text))).toBe(FINDING);
  });
  it('blocks a serialized JWK string without borrowing its enclosing object scope',()=>{
    const jwk={kty:'EC',d:'a'.repeat(32)};
    for(const text of [JSON.stringify(JSON.stringify(jwk)),JSON.stringify({material:JSON.stringify(jwk)})])
      expect(credentialContentFinding(Buffer.from('credentials.md'),Buffer.from(text))).toBe(FINDING);
  });
  it('keeps padded and whitespace-wrapped private member values blocked',()=>{
    for(const value of ['a'.repeat(32)+'==','a'.repeat(16)+'\n'+'a'.repeat(16)])
      expect(credentialContentFinding(Buffer.from('credentials.md'),Buffer.from(JSON.stringify({kty:'EC',d:value})))).toBe(FINDING);
  });
  it.each(['/* } */','// }\n','# }\n'])('ignores comment braces between JWK members: %j',comment=>{
    const text=`{kty:'EC', ${comment} d:'${'a'.repeat(32)}'}`;
    expect(credentialContentFinding(Buffer.from('credentials.md'),Buffer.from(text))).toBe(FINDING);
  });
  it('still detects a complete JWK inside a comment as its own object',()=>{
    const text=`// ${JSON.stringify({kty:'EC',d:'a'.repeat(32)})}`;
    expect(credentialBufferFinding(Buffer.from(text))).toBe(FINDING);
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

describe('forge-key-structure: escaped JWK members in decoded views',()=>{
  const jwk=generateKeyPairSync('ed25519').privateKey.export({format:'jwk'});
  const unicode=value=>[...value].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  const variants={
    'escaped kty':JSON.stringify(jwk).replace('"kty"','"k\\u0074y"'),
    'escaped private member':JSON.stringify(jwk).replace('"d"','"\\u0064"'),
    'escaped type':JSON.stringify(jwk).replace('"OKP"','"'+unicode('OKP')+'"'),
    'all names and values escaped':'{'+Object.entries(jwk).map(([key,value])=>'"'+unicode(key)+'":"'+unicode(value)+'"').join(',')+'}',
  };
  const views={
    raw:text=>Buffer.from(text),
    base64:text=>Buffer.from(Buffer.from(text).toString('base64')),
    base64url:text=>Buffer.from(Buffer.from(text).toString('base64url')),
    hex:text=>Buffer.from(Buffer.from(text).toString('hex')),
    'decimal bytes':text=>Buffer.from('['+[...Buffer.from(text)].join(',')+']'),
    'UTF-16':text=>Buffer.from(text,'utf16le'),
  };
  for(const [variant,text] of Object.entries(variants)) {
    it(`${variant} retains a working signing key`,()=>{
      const key=createPrivateKey({key:JSON.parse(text),format:'jwk'}),message=Buffer.from('escaped JWK regression');
      expect(verify(null,message,createPublicKey(key),sign(null,message,key))).toBe(true);
    });
    for(const [view,encode] of Object.entries(views))
      it(`blocks ${variant} in ${view} through both scanner APIs`,()=>{
        const content=encode(text);
        expect(credentialBufferFinding(content)).toBe(FINDING);
        expect(credentialContentFinding(Buffer.from('docs/material.md'),content)).toBe(FINDING);
      });
  }
  for(const [variant,text] of Object.entries({
    'JS hex escape':variants['escaped kty'].replace('\\u0074','\\x74'),
    'JS code point escape':variants['escaped kty'].replace('\\u0074','\\u{74}'),
    'JS octal escape':variants['escaped kty'].replace('\\u0074','\\164'),
    'YAML long Unicode escape':variants['escaped kty'].replace('\\u0074','\\U00000074'),
    'escaped CRLF continuation':variants['escaped kty'].replace('\\u0074','\\\r\n \tt'),
    'escaped Unicode continuation':variants['escaped kty'].replace('\\u0074','\\'+String.fromCharCode(0x2028)+' \tt'),
    'single quotes':variants['escaped kty'].replaceAll('"',"'"),
    'serialized object':JSON.stringify({payload:JSON.stringify({payload:variants['all names and values escaped']})}),
    'comment body':'/* '+variants['all names and values escaped']+' */',
    'duplicate members':variants['escaped private member'].replace(/}$/,',"d":"","kty":"other"}'),
  }))it(`blocks ${variant} after base64 decoding`,()=>{
    const content=views.base64(text);
    expect(credentialBufferFinding(content)).toBe(FINDING);
    expect(credentialContentFinding(Buffer.from('docs/material.md'),content)).toBe(FINDING);
  });
  it.each(['\\u{1f600}','\\U0001F600','\\uD800','\\uDFFF','\\u{d800}',
    '\\U00110000','\\u{ffffff}','\\u{}','\\u{1234567}','\\x1','\\u12'])
    ('does not erase malformed or non-ASCII type suffix %s',suffix=>{
      const text='{"kty":"OKP'+suffix+'","d":"'+'a'.repeat(43)+'"}';
      for(const content of [Buffer.from(text),views.base64(text)]) {
        expect(credentialBufferFinding(content)).toBeNull();
        expect(credentialContentFinding(Buffer.from('docs/material.md'),content)).toBeNull();
      }
    });
  for(const [variant,value] of Object.entries({
    'public kid':{kty:'OKP',kid:'a'.repeat(43)},
    'separate objects':{keys:[{kty:'OKP'},{d:'a'.repeat(43)}]},
    'quoted braces':{kty:'OKP',description:'"}, {"d":"'+'a'.repeat(43)},
  }))it(`keeps ${variant} clean with escaped names and quotes`,()=>{
    const text=JSON.stringify(value).replaceAll('kty','k\\u0074y').replaceAll('kid','ki\\u0064').replaceAll('"d"','"\\u0064"');
    for(const content of [Buffer.from(text),views.base64(text)]) {
      expect(credentialBufferFinding(content)).toBeNull();
      expect(credentialContentFinding(Buffer.from('docs/material.md'),content)).toBeNull();
    }
  });
});

describe('forge-key-structure: RSA length and static JWK regressions',()=>{
  for(const {modulusLength,bytes} of rsaVariants) {
    it(`PKCS#1 RSA ${modulusLength} is usable and blocked in every view`,()=>{
      const key=createPrivateKey({key:bytes,type:'pkcs1',format:'der'}),message=Buffer.from('RSA regression');
      expect(verify('sha256',message,createPublicKey(key),sign('sha256',message,key))).toBe(true);
      for(const content of [bytes,...Object.values(views).map(encode=>Buffer.from(encode(bytes)))]) {
        expect(credentialBufferFinding(content)).toBe(FINDING);
        expect(credentialContentFinding(Buffer.from('docs/material.mjs'),content)).toBe(FINDING);
      }
    });
  }
  for(const [name,text] of Object.entries(staticJwkVariants)) {
    it(`${name} imports a working signing key`,()=>{
      // Evaluate only this test's generated literals, never repository or external input.
      const key=createPrivateKey({key:Function('return ('+text+')')(),format:'jwk'}),message=Buffer.from('static JWK regression');
      expect(verify(null,message,createPublicKey(key),sign(null,message,key))).toBe(true);
    });
    it(`${name} is blocked through both APIs in raw and encoded views`,()=>{
      const bytes=Buffer.from('const value = '+text+';');
      for(const content of [bytes,Buffer.from(bytes.toString(),'utf16le'),...Object.values(views).map(encode=>Buffer.from(encode(bytes)))]) {
        expect(credentialBufferFinding(content)).toBe(FINDING);
        expect(credentialContentFinding(Buffer.from('docs/material.mjs'),content)).toBe(FINDING);
      }
    });
  }
  it('does not borrow static computed names or backtick contents from other scopes',()=>{
    const long='a'.repeat(43);
    for(const text of [`{['kty']:'OKP', ['kid']:\`${long}\`}`,
      `[{['kty']:'OKP'},{['d']:\`${long}\`}]`,
      `{kty:'OKP',metadata:{['d']:\`${long}\`}}`,
      `{kty:'OKP',description:\`}, {d:'${long}'\`}`,
      `{kty:'OKP', values:['d'], other:\`${long}\`}`]) {
      expect(credentialBufferFinding(Buffer.from(text))).toBeNull();
      expect(credentialContentFinding(Buffer.from('docs/material.mjs'),Buffer.from(text))).toBeNull();
    }
  });
  it('rejects incomplete or invalid RSA integer structures as evidence of a key',()=>{
    const integer=body=>Buffer.from([2,body.length,...body]);
    const version=integer([0]),modulus=integer(Array(97).fill(1));
    for(const bytes of [Buffer.concat([version,modulus]),
      Buffer.concat([version,modulus,...Array.from({length:7},()=>integer([]))]),
      Buffer.concat([version,Buffer.from([2,0x84,0xff,0xff,0xff,0xff])])])
      expect(credentialBufferFinding(bytes)).toBeNull();
  });
});

describe('forge-key-structure: known Layer A signature gaps outside the supported inventory',()=>{
  it.each(['brainpoolP320r1','brainpoolP512r1'])('does not yet recognize PKCS#8 EC %s',curve=>{
    // These curves have different AlgorithmIdentifier lengths AND scalar sizes from P-256/P-384/P-521.
    const bytes=priv('ec',{namedCurve:curve},{type:'pkcs8'});
    expect(credentialBufferFinding(bytes)).toBeNull();
    expect(credentialBufferFinding(Buffer.from(bytes.toString('base64')))).toBeNull();
  });
});

// Public tracked-and-identical-to-main evidence is the credential path allowance. Exercise that real
// allowance, not an invented allowlist option; all Git responses are injected and no .git is written.
function dispatchFixture(content) {
  const root=realpathSync(mkdtempSync(join(process.env.TMPDIR??tmpdir(),'forge-key-dispatch-')));
  const cwd=join(root,'repo');mkdirSync(cwd);
  const name='credentials.test.mjs';
  const files={'package-lock.json':Buffer.from('{}'),[name]:content};
  const oid=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  for(const [path,bytes] of Object.entries(files))writeFileSync(join(cwd,path),bytes);
  const exec=vi.fn(async call=>{
    const args=call.args[0]?.startsWith('--git-dir=')?call.args.slice(4):call.args;
    const ok=stdout=>({code:0,stdout:Buffer.from(stdout)});
    if(call.file==='git') {
      if(args.includes('--show-toplevel'))return ok(cwd+'\n'+cwd+'\n');
      if(args[0]==='ls-files')return ok(args.includes('-i')?'':args.includes('--stage')
        ?Object.entries(files).map(([path,bytes])=>`100644 ${oid(bytes)} 0\t${path}\0`).join('')
        :Object.keys(files).join('\0')+'\0');
      if(args[0]==='ls-tree')return ok(Object.entries(files).map(([path,bytes])=>`100644 blob ${oid(bytes)}\t${path}\0`).join(''));
    }
    if(call.file==='ssh'&&args.at(-1)==='true')return ok('');
    throw new Error('Unexpected dispatch IO: '+call.file+' '+args.join(' '));
  });
  return {root,name,options:{cwd,exec,argv:['npm','run','test:unit','--',name],runId:'key-structure-1',
    env:{NODE_ENV:'test'},disableDelta:true,sshOptions:[],log:()=>{},lockRoot:join(root,'heavy'),
    readTelemetry:async()=>({sampledAtET:easternTimestamp(Date.now()),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]})}};
}

describe('forge-key-structure: non-allowlistable blocking and local routing',()=>{
  const blocking=[['pem-header','-----'+'BEGIN CERTIFICATE-----'],['private-key','private '+'key'],
    ['github-token','ghp_'+'a'.repeat(24)],['aws-access-key','AKIA'+'A'.repeat(16)],
    ['sk-token','sk-'+'a'.repeat(20)],['slack-token','xoxb-'+'a'.repeat(12)],
    ['google-api-key','AIza'+'A'.repeat(35)],['npm-token','npm_'+'a'.repeat(36)],[FINDING,ed.toString('base64')]];
  it('covers every hard token rule and the structure finding in the dispatch gate',()=>{
    expect(blocking.map(([finding])=>finding).sort()).toEqual([...secretText.map(([,finding])=>finding),FINDING].sort());
  });
  for(const [finding,text] of blocking)
    it(`${finding} cannot use the public-tracked allowance and selects local fallback without Forge dispatch`,async()=>{
      const content=Buffer.from(text),f=dispatchFixture(content);
      try {
        expect(()=>manifestEntry(Buffer.from(f.name),content,false,true)).toThrow(expect.objectContaining({code:'excluded-source-file'}));
        // The name, index, public tree and working bytes agree: only the content finding prevents shipping.
        await expect(buildManifest(f.options)).rejects.toMatchObject({code:'unshipped-test-file',detail:f.name});
        expect(await runRemote(f.options)).toMatchObject({mode:'not-started',reason:'unshipped-test-file'});
        const local=vi.fn(async()=>7);
        expect(await main({...f.options,local})).toBe(7);
        expect(local).toHaveBeenCalledTimes(1);
        expect(local).toHaveBeenCalledWith(f.options.argv);
        expect(f.options.exec.mock.calls.some(([call])=>call.file==='rsync'
          ||call.file==='ssh'&&/ (?:prepare|run)$/.test(call.args.at(-1)))).toBe(false);
        expect(credentialContentFinding(Buffer.from(f.name),content)).toBe(finding);
      } finally {rmSync(f.root,{recursive:true,force:true});}
    });
  it('admits clean content through the same public-tracked allowance',async()=>{
    const f=dispatchFixture(Buffer.from('export const fixture = 1;'));
    try {expect((await buildManifest(f.options)).entries.map(entry=>entry.path.toString())).toContain(f.name);}
    finally {rmSync(f.root,{recursive:true,force:true});}
  });
  it.each([
    ...rsaVariants.map(({bytes})=>['docs/material.mjs',Buffer.from(bytes.toString('base64'))]),
    ...Object.values(staticJwkVariants).flatMap(text=>[Buffer.from(text),Buffer.from(Buffer.from(text).toString('base64'))]
      .map(content=>['docs/material.mjs',content])),
    ...['docs/notes.md','src/material.mjs'].map(path=>[path,Buffer.from(ed.toString('base64'))]),
    ...['kty','d'].flatMap(member=>['base64','base64url'].map(encoding=>[
      'docs/material.md',Buffer.from(JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({format:'jwk'}))
        .replace('"'+member+'"','"'+[...member].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"')).toString(encoding),
    ])).map(([path,text])=>[path,Buffer.from(text)]),
  ])('scans unlabeled keys in bundle blobs at ordinary path %s (case %#)',async(path,content)=>{
    const sha='a'.repeat(40),blob='b'.repeat(40);
    const commit=Buffer.from('tree '+'c'.repeat(40)+'\n\nfixture\n');
    const exec=vi.fn(async({args,input})=>{
      args=args.slice(1); // --no-replace-objects
      let stdout;
      if(args[0]==='rev-parse')stdout=args.includes('--is-shallow-repository')?'false\n':'missing-grafts\n';
      else if(args[0]==='rev-list')stdout=sha+'\n';
      else if(args[0]==='log')stdout=args.includes('--raw')?`:000000 100644 ${'0'.repeat(40)} ${blob} A\0${path}\0`:'fixture\0';
      else if(args[0]==='cat-file') {
        const isCommit=input.trim()===sha,bytes=isCommit?commit:content,id=isCommit?sha:blob,type=isCommit?'commit':'blob';
        stdout=args[1]==='--batch'?Buffer.concat([Buffer.from(`${id} ${type} ${bytes.length}\n`),bytes,Buffer.from('\n')]):`${id} ${type} ${bytes.length}\n`;
      } else throw new Error('Unexpected bundle IO: '+args.join(' '));
      return {code:0,stdout:Buffer.from(stdout)};
    });
    expect(await scanBundleRange({cwd:tmpdir(),head:sha,prerequisite:null,exec})).toEqual({path,finding:FINDING});
  });
});

describe('forge-key-structure: clean inputs stay clean',()=>{
  for(const kid of ['3f2b9c1e-7a4d-4e8b-9c21-5d6e7f8a9b0c','a'.repeat(43)])
    for(const kty of ['RSA','EC'])
      it(`public JWKS with ${kty} and ${kid.length}-character kid stays clean`,()=>{
        const text=JSON.stringify({keys:[{kty,kid,n:'abc',e:'AQAB',x:'abc',y:'def'}]});
        expect(credentialBufferFinding(Buffer.from(text))).toBeNull();
        expect(credentialContentFinding(Buffer.from('public-jwks.json'),Buffer.from(text))).toBeNull();
      });
  for(const member of ['kid','id','metadata_dp','monkey','lookup','faq','café_d','é'+'d','e\u0301d','\u200dd','$d'])
    it(`property suffix ${member} is not a private member`,()=>{
      for(const text of [JSON.stringify({kty:'EC',[member]:'a'.repeat(32)}),`{kty:'EC',${member}:'${'a'.repeat(32)}'}`])
        expect(credentialBufferFinding(Buffer.from(text))).toBeNull();
    });
  for(const value of [
    {keys:[{kty:'EC'},{d:'a'.repeat(32)}]},
    {key:{kty:'EC'},metadata:{id:'a'.repeat(32),d:'a'.repeat(32)}},
    {kty:'EC',metadata:{d:'a'.repeat(32)}},
    {metadata:{kty:'EC'},d:'a'.repeat(32)},
    {kty:'EC',description:'d:"'+'a'.repeat(32)+'"'},
    {kty:'EC',description:JSON.stringify({d:'a'.repeat(32)})},
    {description:JSON.stringify({kty:'EC'}),d:'a'.repeat(32)},
  ])it(`does not combine unrelated objects or string contents: ${JSON.stringify(value).slice(0,50)}`,()=>{
    const bytes=Buffer.from(JSON.stringify(value));
    expect(credentialBufferFinding(bytes)).toBeNull();
    expect(credentialContentFinding(Buffer.from('public-jwks.json'),bytes)).toBeNull();
  });
  it('does not borrow private members mentioned in an inline comment',()=>{
    const text=`{kty:'EC' /* d:'${'a'.repeat(32)}' */}`;
    expect(credentialBufferFinding(Buffer.from(text))).toBeNull();
  });
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
  it('bounds both buffer and content scans of 3 MiB adversarial and escape-heavy blobs to one second',()=>{
    const size=3*1024*1024;
    const blobs=[Buffer.alloc(size,0x41),Buffer.from('A'.repeat(size)),Buffer.from('0, '.repeat(size/3)),
      Buffer.from('0x3'.repeat(size/3)),Buffer.from('+/'.repeat(size/2)),Buffer.from('30 '.repeat(size/3)),
      Buffer.from('a-_'.repeat(size/3)),Buffer.from('# x\n'.repeat(size/4)),Buffer.from('"kty":"RSA" '.repeat(size/12)),
      Buffer.from('\\x41'.repeat(size/4)),Buffer.from('\\u0041'.repeat(size/6)),Buffer.from('"k\\u0074y":"RSA" '.repeat(Math.floor(size/16))),
      Buffer.from('//'.repeat(size/2-3)+'{kty}'),Buffer.from('/*'.repeat(size/2-3)+'{kty}'),
      Buffer.from('"'+'\\"'.repeat(size/2-4)+'{kty}\\'),
      Buffer.from('`'+'\\`'.repeat(size/2-4)+'{kty}\\'),
      Buffer.from('[`kty`]:`RSA`,'.repeat(Math.floor(size/13))),
      Buffer.alloc(size,Buffer.from([2,1,0,2,0x84,0xff,0xff,0xff,0xff]))];
    for(const [name,scan] of [['buffer',credentialBufferFinding],
      ['content',bytes=>credentialContentFinding(Buffer.from('credentials.md'),bytes)]])
      for(const [index,blob] of blobs.entries()) {
        const start=performance.now();
        scan(blob);
        expect(performance.now()-start,`${name} adversarial blob ${index}`).toBeLessThan(1000);
      }
  },30000);
  it('adds no more than a handful of findings over tracked files',()=>{
    const files=execFileSync('git',['ls-files','-z'],{maxBuffer:1<<26}).toString().split('\0').filter(Boolean);
    const hits=[];
    for(const file of files) {
      let bytes;
      try {bytes=readFileSync(file);} catch {continue;}
      if(bytes.length>3*1024*1024)continue;
      if(credentialBufferFinding(bytes)===FINDING)hits.push(file);
    }
    // Measured 2026-11-15: three fixtures carry fake PKCS#1 bodies behind \x escapes. In supersede-rule,
    // comment-stripped decimal numbers across unrelated cases also form an RSA-shaped byte sequence.
    // All four deliberately retain the Mac fallback. Any further hit needs a deliberate review.
    expect(hits.sort()).toEqual(['scripts/conveyor/__tests__/ci-heal-mark.test.mjs','scripts/conveyor/__tests__/supersede-rule.test.mjs',
      'scripts/operations/__tests__/coroner-transcripts.test.mjs',
      'scripts/readiness/__tests__/remote-git-bundle.test.mjs'].sort());
  },120000);
});
