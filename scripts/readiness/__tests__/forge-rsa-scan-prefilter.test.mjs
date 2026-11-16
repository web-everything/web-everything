// @vitest-environment node
import {generateKeyPairSync} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {credentialBufferFinding,credentialContentFinding,manifestEntry,ordinaryPathKeyFinding} from '../forge-exec-manifest.mjs';

// Generate fixtures in memory so no private material is stored in the repository.
const rsa=generateKeyPairSync('rsa',{modulusLength:1024,
  privateKeyEncoding:{format:'der',type:'pkcs1'}}).privateKey;
const path=Buffer.from('docs/material.md');
const scans=[credentialBufferFinding,bytes=>credentialContentFinding(path,bytes),ordinaryPathKeyFinding];
const size=3*1024*1024;

describe('RSA candidate prefilter',()=>{
  for(const [name,prefix] of [
    ['decimal byte list',Buffer.from('0, '.repeat(size/3))],
    ['SEQUENCE tags without INTEGERs',Buffer.alloc(size,0x30)],
    ['INTEGER tags without SEQUENCEs',Buffer.alloc(size,2)],
  ]) {
    it(`admits clean ${name} on an ordinary manifest path`,()=>{
      expect(ordinaryPathKeyFinding(prefix)).toBeNull();
      expect(manifestEntry(path,prefix,false,false)).toMatchObject({path,executable:false,tracked:false});
    });
    for(const [encoding,encode] of [
      ['DER',bytes=>bytes],
      ['base64',bytes=>Buffer.from(bytes.toString('base64'))],
      ['hex',bytes=>Buffer.from(bytes.toString('hex'))],
      ['decimal',bytes=>Buffer.from([...bytes].join(', '))],
    ])
      it(`blocks a complete ${encoding} RSA key after ${name}`,()=>{
        const bytes=Buffer.concat([prefix,Buffer.from('\n'),encode(rsa)]);
        for(const scan of scans)expect(scan(bytes)).toBe('private-key-structure');
        for(const tracked of [false,true])
          expect(()=>manifestEntry(path,bytes,false,tracked))
            .toThrow(expect.objectContaining({code:'excluded-source-file'}));
      });
  }
  it('does not borrow an INTEGER preceding the last incomplete SEQUENCE',()=>{
    const bytes=Buffer.concat([Buffer.alloc(size,2),Buffer.from([0x30,0x20])]);
    expect(ordinaryPathKeyFinding(bytes)).toBeNull();
  });
});
