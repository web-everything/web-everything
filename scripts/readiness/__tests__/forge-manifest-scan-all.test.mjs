// @vitest-environment node
import {generateKeyPairSync} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {gzipSync} from 'node:zlib';
import {describe,expect,it} from 'vitest';
import {CONTENT_SCAN_MAX_BYTES,manifestEntry} from '../forge-exec-manifest.mjs';

const {privateKey}=generateKeyPairSync('rsa',{modulusLength:1024});
const jwk=privateKey.export({format:'jwk'});
const material={
  PEM:privateKey.export({format:'pem',type:'pkcs8'}),
  JWK:JSON.stringify(jwk),
  DER:privateKey.export({format:'der',type:'pkcs1'}).toString('base64'),
  oth:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e,oth:[{r:jwk.p,d:jwk.dp,t:jwk.qi}]}),
};
const admit=(path,content,tracked=true)=>manifestEntry(Buffer.from(path),content,false,tracked);
const refused=(path,content,tracked,message)=>{
  let error;
  try {admit(path,content,tracked);} catch (caught) {error=caught;}
  expect(error).toMatchObject({code:'excluded-source-file'});
  expect(error.message).toContain(message);
  return error;
};

describe('Forge scans all manifest content',()=>{
  for(const tracked of [true,false])for(const path of ['docs/notes.md','notes.txt','data.json','NOTES'])
    for(const [format,text] of Object.entries(material))
      it(`refuses disguised ${format} at ${path} (tracked=${tracked}) without exposing material`,()=>{
        const error=refused(path,Buffer.from(text),tracked,'content-detected credential in a non-credential-named file');
        expect(error.message).not.toContain(jwk.d);
        expect(error.message).not.toContain(text);
      });

  it('refuses a disguised JWK that follows stray or unclosed double quotes',()=>{
    const quote='"';
    for(const lead of [quote+' ',quote+' a '+quote+' b '+quote+' ','say '+quote+'hello '+quote+'x '+quote+'y\n','an unclosed '+quote+'string, '])
      for(const path of ['docs/notes.md','notes.txt','NOTES'])
        refused(path,Buffer.from(lead+material.JWK),true,'content-detected credential in a non-credential-named file');
  });
  it('admits prose that only mentions private keys or key-like labels, but refuses a PEM private block',()=>{
    const words=['PRIVATE','KEY'].join(' ');
    expect(admit('docs/setup.md',Buffer.from(`Set the GitHub App ${words} secret.`))).toHaveProperty('sha256');
    expect(admit('ci.yml',Buffer.from(`private-key: \${{ secrets.APP_${['PRIVATE','KEY'].join('_')} }}\n# -----BEGIN CERTIFICATE-----`))).toHaveProperty('sha256');
  });
  it('refuses a PEM wrapped at 32 columns, an encrypted PKCS#8 PEM and JSON-escaped tokens',()=>{
    const wrap=(pem,width)=>{
      const [head,...rest]=pem.trim().split('\n'),tail=rest.pop();
      return [head,...rest.join('').match(new RegExp(`.{1,${width}}`,'g')),tail].join('\n');
    };
    const encrypted=privateKey.export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:'x'});
    for(const text of [wrap(material.PEM.toString(),32),wrap(encrypted.toString(),32),encrypted.toString()])
      for(const tracked of [true,false])refused('docs/notes.md',Buffer.from(text),tracked,'content-detected credential');
    const token='gh'+'p_'+'A1b2C3d4'.repeat(5);
    refused('docs/notes.md',Buffer.from('"\\u0067'+token.slice(1)+'"'),true,'content-detected credential');
    refused('docs/notes.md',Buffer.from('gh\\x70_'+token.slice(4)),false,'content-detected credential');
  });
  it('refuses an encrypted PEM wrapped at four columns and a gzip-compressed key, at any extension',()=>{
    const encrypted=privateKey.export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:'x'}).toString();
    const [head,...rest]=encrypted.trim().split('\n'),tail=rest.pop();
    const narrow=[head,...rest.join('').match(/.{1,4}/g),tail].join('\n');
    for(const tracked of [true,false]) {
      refused('docs/notes.md',Buffer.from(narrow),tracked,'content-detected credential');
      for(const path of ['image.gz','notes.md','NOTES'])
        refused(path,gzipSync(Buffer.from(material.PEM)),tracked,'content-detected credential');
    }
    refused('image.gz',Buffer.from([0x1f,0x8b,8,0,0,0]),true,'unreadable-compressed-content');
    expect(admit('image.gz',gzipSync(Buffer.from('# plain notes\n')))).toHaveProperty('sha256');
  });
  it('refuses base64, percent-encoded and odd-aligned UTF-16 tokens at ordinary paths',()=>{
    const token='gh'+'p_'+'A1b2C3d4'.repeat(5);
    const percent=[...token].map(char=>'%'+char.charCodeAt(0).toString(16).padStart(2,'0')).join('');
    const odd=Buffer.concat([Buffer.from([65]),Buffer.from(token,'utf16le')]);
    for(const [name,bytes] of [
      ['base64',Buffer.from(Buffer.from(token).toString('base64'))],
      ['base64url wrapped',Buffer.from('config: '+Buffer.from(token).toString('base64url'))],
      ['percent',Buffer.from(percent)],
      ['odd utf16',odd],
    ])for(const tracked of [true,false])
      expect(()=>admit('docs/notes.md',bytes,tracked),name).toThrow(/content-detected credential/);
  });
  it('refuses a PNG-signed file hiding a JWK behind nested brackets (scan exhaustion fails closed)',()=>{
    const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('['.repeat(65)),Buffer.from(material.JWK)]);
    for(const tracked of [true,false])refused('a.png',png,tracked,'content-detected credential');
  });
  it('admits ordinary documentation, code and JSON regardless of tracking',()=>{
    for(const tracked of [true,false])for(const [path,text] of [
      ['docs/notes.md','# Guide\nUse the navigation to browse examples.\n'],
      ['src/main.mjs','export const double = value => value * 2;\n'],
      ['data.json',JSON.stringify({title:'Guide',items:[1,2,3]})],
    ])expect(admit(path,Buffer.from(text),tracked)).toMatchObject({tracked});
  });

  it('scans token formats and UTF-16 content at ordinary paths',()=>{
    const token='gh'+'p_'+'A1b2C3d4'.repeat(5);
    for(const bytes of [Buffer.from(token),Buffer.from(token,'utf16le'),Buffer.from(token,'utf16le').swap16()])
      refused('docs/notes.md',bytes,true,'content-detected credential');
  });

  it('admits invalid text encodings in small binaries but still scans their bytes',()=>{
    expect(admit('image.png',Buffer.from([255,0,254,1,128]))).toHaveProperty('sha256');
    refused('image.png',Buffer.concat([Buffer.from([255,0]),Buffer.from(material.DER)]),false,'content-detected credential');
    refused('image.png',privateKey.export({format:'der',type:'pkcs1'}),true,'content-detected credential');
  });

  it('refuses files over the scan size cap with unknown or missing extensions and names local fallback',()=>{
    const bytes=Buffer.alloc(CONTENT_SCAN_MAX_BYTES+1,32);
    for(const path of ['notes.unknown','NOTES','notes.md'])for(const tracked of [true,false]) {
      const error=refused(path,bytes,tracked,'over the scan size cap');
      expect(error.message).toContain('use local fallback');
    }
  });

  it('admits clean over-cap allowlisted binaries but still scans them (also uppercase extensions)',()=>{
    const clean=Buffer.alloc(CONTENT_SCAN_MAX_BYTES+1,32);
    const bytes=Buffer.from(clean);
    bytes.write(material.PEM);
    for(const path of ['image.png','image.PNG'])for(const tracked of [true,false]) {
      expect(admit(path,clean,tracked)).toMatchObject({tracked});
      refused(path,bytes,tracked,'content-detected credential');
    }
  });

  it('does not weaken the credential-named scan for oversized allowlisted binaries',()=>{
    const bytes=Buffer.alloc(CONTENT_SCAN_MAX_BYTES+1,32);
    bytes.write(material.PEM);
    for(const tracked of [true,false])refused('token.png',bytes,tracked,'credential-named file');
  });

  it('scans exactly-at-cap ordinary files and allowlisted binaries through the last byte',()=>{
    const key=Buffer.from(material.PEM);
    const bytes=Buffer.concat([Buffer.alloc(CONTENT_SCAN_MAX_BYTES-key.length,32),key]);
    for(const path of ['notes.md','image.png'])for(const tracked of [true,false])
      refused(path,bytes,tracked,'content-detected credential');
  });

  it('scans 2000 realistic ordinary files of about 10 KB within 30 seconds',()=>{
    const files=Array.from({length:2000},(_,index)=>({
      path:`docs/page-${index}.md`,
      content:Buffer.from(`# Component ${index}\n`+Array.from({length:100},(_,line)=>
        `Section ${line}: components expose browser events and render accessible navigation for the application.\n`).join('')),
    }));
    const started=performance.now();
    for(const file of files)admit(file.path,file.content);
    const elapsed=performance.now()-started;
    console.log(`Forge manifest scan: 2000 ordinary files in ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(30000);
  },35000);
});
