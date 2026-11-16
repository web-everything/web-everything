// @vitest-environment node
import {generateKeyPairSync} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {credentialBufferFinding,credentialContentFinding,ordinaryPathKeyFinding} from '../forge-exec-manifest.mjs';

const key=generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'});
const scanners={
  buffer:credentialBufferFinding,
  content:bytes=>credentialContentFinding(Buffer.from('credentials.md'),bytes),
  ordinary:ordinaryPathKeyFinding,
};

describe('Forge encoded-view reuse',()=>{
  for(const [name,scan] of Object.entries(scanners)) {
    for(const encoding of ['base64','base64url'])
      for(const offset of [0,1,2,3])
        it(`${name} keeps ${encoding} alignment ${offset} with distinct alphabets`,()=>{
          // Force both alphabet-specific characters, then place a key beyond them.
          const encoded=Buffer.concat([Buffer.from([251,255,255]),key]).toString(encoding);
          expect(encoded).toMatch(encoding==='base64'?/[+/]/:/[-_]/);
          const bytes=Buffer.from('Z'.repeat(offset)+encoded);
          expect(scan(bytes)).toBe('private-key-structure');
        });

    it(`${name} keeps reuse local to one scan and retains changed encoded suffixes`,()=>{
      const clean=Buffer.from('\\x41'.repeat(64));
      const secret=Buffer.concat([clean,Buffer.from(' '+key.toString('base64'))]);
      for(let attempt=0;attempt<2;attempt++) {
        expect(scan(clean)).toBeNull();
        expect(scan(secret)).toBe('private-key-structure');
        expect(scan(clean)).toBeNull();
      }
    });
  }

  for(const name of ['content','ordinary'])
    it(`${name} avoids decoding identical raw and backslash-dropped streams again`,()=>{
      const bytes=Buffer.from('\\x41'.repeat(256));
      const from=vi.spyOn(Buffer,'from');
      try {
        expect(scanners[name](bytes)).toBeNull();
        const decodes=encoding=>from.mock.calls.filter(([,format])=>format===encoding).length;
        // Two distinct streams (x41... and A...), each retaining every alignment.
        expect(decodes('base64')).toBe(8);
        expect(decodes('hex')).toBe(4);
        expect(decodes('base64url')).toBe(0);
      } finally {from.mockRestore();}
    });
});
