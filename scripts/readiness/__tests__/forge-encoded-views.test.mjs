// @vitest-environment node
import {generateKeyPairSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {describe,expect,it,vi} from 'vitest';
import {credentialBufferFinding,credentialContentFinding,ordinaryPathKeyFinding,manifestEntry} from '../forge-exec-manifest.mjs';

const key=generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'});
const scanners={
  buffer:credentialBufferFinding,
  content:bytes=>credentialContentFinding(Buffer.from('credentials.md'),bytes),
  ordinary:ordinaryPathKeyFinding,
};

describe('Forge encoded-view reuse',()=>{
  it('bounds an armoured PGP header followed by a long blank body',()=>{
    const script=`import {ordinaryPathKeyFinding} from ${JSON.stringify(new URL('../forge-exec-manifest.mjs',import.meta.url).href)};
      const text='-----'+'BEGIN PGP PRIVATE'+' KEY BLOCK-----'+'\\n'.repeat(262144)+'!';
      if(ordinaryPathKeyFinding(Buffer.from(text))!==null)process.exit(1);`;
    expect(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{timeout:2000,stdio:'pipe'})).not.toThrow();
  });

  it.each(['base64','hex'])('refuses %s PEM whose encoded text exceeds the limit but decoded bytes fit',encoding=>{
    const pem='-----'+'BEGIN PRIVATE'+' KEY-----\n'+'A'.repeat(64)+'\n';
    const raw=Buffer.from('!'.repeat(3*1024*1024)+pem);
    const bytes=Buffer.from(raw.toString(encoding));
    expect(bytes.length).toBeGreaterThan(4*1024*1024);
    expect(ordinaryPathKeyFinding(bytes)).toBe('private-key');
    expect(()=>manifestEntry(Buffer.from('docs/material.md'),bytes,false,true))
      .toThrow(expect.objectContaining({code:'excluded-source-file'}));
  });

  it.each(['base64','hex'])('refuses an escape-spelled %s PGP wrapper without decoding a stream twice',encoding=>{
    const pgp='-----'+'BEGIN PGP PRIVATE'+' KEY BLOCK-----\nVersion: test\n\n'+'B'.repeat(64)+'\n';
    const encoded=Buffer.from(pgp).toString(encoding);
    const bytes=Buffer.from([...encoded].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
    expect(ordinaryPathKeyFinding(bytes)).toBe('private-key');
    for(const tracked of [false,true])
      expect(()=>manifestEntry(Buffer.from('docs/material.md'),bytes,false,tracked))
        .toThrow(expect.objectContaining({code:'excluded-source-file'}));
  });

  it('skips the additional PEM text scan when decoded bytes exceed the limit',()=>{
    const pem='-----'+'BEGIN PRIVATE'+' KEY-----\n'+'A'.repeat(64)+'\n';
    const raw=Buffer.from('!'.repeat(4*1024*1024+16)+pem);
    expect(ordinaryPathKeyFinding(Buffer.from(raw.toString('base64')))).toBeNull();
  });

  for(const [name,scan] of Object.entries(scanners)) {
    it(`${name} preserves alphabet filtering, hex prefixes and every alignment in a shared pass`,()=>{
      const text='G0x1X0X2y0xx300X40x0X5z6789abcdefABCDEF+/_-éΩ𝄞';
      const bytes=Buffer.from(text),from=vi.spyOn(Buffer,'from');
      try {
        expect(scan(bytes)).toBeNull();
        const expected={
          base64:[text.replace(/[^A-Za-z0-9+/]/g,''),4],
          base64url:[text.replace(/[^A-Za-z0-9_-]/g,''),4],
          hex:[text.replace(/0x/gi,'').replace(/[^0-9a-f]/gi,''),2],
        };
        for(const [encoding,[view,alignments]] of Object.entries(expected))
          expect(from.mock.calls.filter(([,format])=>format===encoding).map(([value])=>value))
            .toEqual(Array.from({length:alignments},(_,skip)=>view.slice(skip)));
      } finally {from.mockRestore();}
    });

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
