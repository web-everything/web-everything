// @vitest-environment node
import {createPrivateKey,createPublicKey,generateKeyPairSync,getCurves,webcrypto} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {describe,expect,it} from 'vitest';
import {keyStructureFinding,keyStructurePrecheck} from '../forge-key-structure.mjs';

const FINDING='private-key-structure';
const encode=(tag,body,indefinite=false)=>{
  if(indefinite)return Buffer.concat([Buffer.from([tag,128]),body,Buffer.from([0,0])]);
  const length=body.length<128?[body.length]:[...Buffer.from(body.length.toString(16).padStart(
    Math.ceil(body.length.toString(16).length/2)*2,'0'),'hex')];
  return Buffer.concat([Buffer.from([tag,...(body.length<128?length:[128+length.length,...length])]),body]);
};
// Independent definite-length reader used only to transform consumer-generated DER.
const read=(bytes,offset=0)=>{
  const tag=bytes[offset++];
  let length=bytes[offset++];
  if(length&128) {
    const count=length&127;length=0;
    for(let index=0;index<count;index++)length=length*256+bytes[offset++];
  }
  return {tag,body:bytes.subarray(offset,offset+length),end:offset+length};
};
const parts=bytes=>{
  const nodes=[];
  for(let offset=0;offset<bytes.length;) {
    const node=read(bytes,offset);nodes.push(node);offset=node.end;
  }
  return nodes;
};
const ber=(bytes,{indefinite=true,octets=false}={})=>{
  const {tag,body}=read(bytes);
  if(tag&32)return encode(tag,Buffer.concat(parts(body).map(node=>ber(encode(node.tag,node.body),
    {indefinite,octets}))),indefinite);
  if(tag===4&&octets) {
    const split=Math.ceil(body.length/2);
    // Nested constructed octets, including an empty fragment: don't impose scalar-size floors.
    return encode(36,Buffer.concat([encode(4,body.subarray(0,split)),
      encode(36,Buffer.concat([encode(4,Buffer.alloc(0)),encode(4,body.subarray(split))]),indefinite)]),indefinite);
  }
  return encode(tag,body);
};
const replaceField=(bytes,index,replacement)=>{
  const fields=parts(read(bytes).body).map(node=>encode(node.tag,node.body));
  fields[index]=replacement;
  return encode(48,Buffer.concat(fields));
};
const wrappers=bytes=>[
  bytes,Buffer.from(bytes.toString('base64')),Buffer.from(bytes.toString('hex')),
];
let generated;
const fixtures=()=>{
  if(generated)return generated;
  const entries=[];
  const add=(name,key,type)=>{
    const bytes=key.export({format:'der',type});
    const variants=[['DER',bytes],['outer BER',encode(48,read(bytes).body,true)],
      ['nested BER',ber(bytes)],['constructed octets',ber(bytes,{indefinite:false,octets:true})],
      ['indefinite constructed octets',ber(bytes,{octets:true})]];
    if(type==='pkcs8') {
      const payload=parts(read(bytes).body)[2].body;
      variants.push(['inner and outer BER',ber(replaceField(bytes,2,encode(4,ber(payload))))]);
      // OneAsymmetricKey v1 with optional attributes and implicit/explicit public key.
      const version1=replaceField(bytes,0,encode(2,Buffer.from([1])));
      const publicBits=parts(read(createPublicKey(key).export({format:'der',type:'spki'})).body)[1].body;
      const attributes=encode(160,encode(48,Buffer.concat([encode(6,Buffer.from([42,3])),
        encode(49,encode(12,Buffer.from('fixture')))])));
      for(const version of [bytes,version1])for(const suffix of [Buffer.alloc(0),encode(160,Buffer.alloc(0)),
        attributes,Buffer.concat([attributes,encode(129,publicBits)]),
        encode(129,publicBits),Buffer.concat([encode(160,Buffer.alloc(0)),encode(129,publicBits)]),
        Buffer.concat([encode(160,Buffer.alloc(0)),encode(161,encode(3,publicBits))])]) {
        const envelope=encode(48,Buffer.concat([read(version).body,suffix]));
        variants.push(['PKCS8 version/optional fields',envelope],['BER version/optional fields',ber(envelope)]);
      }
    }
    for(const [variant,bytes] of variants)entries.push({name:`${name} ${type} ${variant}`,type,bytes});
  };
  for(const modulusLength of [1024,2048]) {
    const {privateKey}=generateKeyPairSync('rsa',{modulusLength});
    for(const type of ['pkcs1','pkcs8'])add(`RSA-${modulusLength}`,privateKey,type);
  }
  for(const curve of ['prime256v1','secp384r1','secp521r1','secp256k1','prime192v1','secp224r1']) {
    if(!getCurves().includes(curve))continue;
    const {privateKey}=generateKeyPairSync('ec',{namedCurve:curve});
    for(const type of ['sec1','pkcs8'])add(curve,privateKey,type);
  }
  for(const type of ['ed25519','x25519'])add(type,generateKeyPairSync(type).privateKey,'pkcs8');
  for(const size of [1,7,24,28,32,48,66,80,129]) {
    const sec1=encode(48,Buffer.concat([encode(2,Buffer.from([1])),encode(4,Buffer.alloc(size,7))]));
    for(const bytes of [sec1,ber(sec1),ber(sec1,{octets:true})])
      entries.push({name:`scalar ${size}`,type:'sec1',bytes});
  }
  generated=entries;
  return entries;
};

describe('Forge key structure consumer compatibility',()=>{
  it('I2 differential: flags raw/base64/hex for every consumer-importable generated DER/BER form',()=>{
    const accepted=new Set();
    for(const {name,type,bytes} of fixtures()) {
      let imported;
      try {imported=createPrivateKey({key:bytes,format:'der',type});} catch {continue;}
      expect(imported.type,name).toBe('private');accepted.add(name);
      for(const view of wrappers(bytes))expect(keyStructureFinding(view),name).toBe(FINDING);
    }
    // Require actual consumer witnesses, so a broken transform cannot silently skip the differential.
    for(const {name} of fixtures().filter(({name})=>name.endsWith(' DER')))
      for(const variant of ['DER','outer BER','nested BER'])expect(accepted.has(name.replace(/DER$/,variant)),name).toBe(true);
    expect([...accepted].some(name=>name.endsWith('constructed octets'))).toBe(true);
  });

  it('I2 WebCrypto imports generated PKCS8 RSA, EC and OKP keys',async()=>{
    const algorithms=[['RSA-1024',{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},['sign']],
      ['prime256v1',{name:'ECDSA',namedCurve:'P-256'},['sign']],
      ['ed25519',{name:'Ed25519'},['sign']],['x25519',{name:'X25519'},['deriveBits']]];
    for(const [name,algorithm,usages] of algorithms) {
      const {bytes}=fixtures().find(entry=>entry.name===`${name} pkcs8 DER`);
      expect((await webcrypto.subtle.importKey('pkcs8',bytes,algorithm,false,usages)).type).toBe('private');
      for(const view of wrappers(bytes))expect(keyStructureFinding(view)).toBe(FINDING);
    }
  });

  it('I2 recognizes PKCS8 v0/v1 optional fields and every scalar size without cryptographic floors',()=>{
    for(const {name,bytes} of fixtures())for(const view of wrappers(bytes))
      expect(keyStructureFinding(view),name).toBe(FINDING);
  });

  it('I2 rejects incomplete BER, misplaced EOC, primitive indefinite and non-octet fragments',()=>{
    const scalar=encode(48,Buffer.concat([encode(2,Buffer.from([1])),encode(4,Buffer.from([7]))]),true);
    const badOctets=encode(48,Buffer.concat([encode(2,Buffer.from([1])),
      encode(36,encode(2,Buffer.from([7])),true)]),true);
    for(const bytes of [scalar.subarray(0,-1),scalar.subarray(0,-2),badOctets,
      Buffer.from([48,128,2,1,1,4,128,7,0,0,0,0]),
      Buffer.from([48,128,2,1,1,0,0,4,1,7,0,0])])
      expect(keyStructureFinding(bytes)).toBeNull();
  });

  it('I2 fails closed on excessive BER nesting with the operator local fallback',()=>{
    const nested=Buffer.concat([Buffer.from(Array.from({length:66},()=>[48,128]).flat()),
      Buffer.from([2,1,1,4,1,7]),Buffer.alloc(132)]);
    expect(keyStructureFinding(nested)).toBe('private-key-scan-budget-exhausted-use-local');
    let octets=encode(4,Buffer.from([7]));
    for(let depth=0;depth<66;depth++)octets=encode(36,octets);
    const sec1=encode(48,Buffer.concat([encode(2,Buffer.from([1])),octets]));
    expect(keyStructureFinding(sec1)).toBe('private-key-scan-budget-exhausted-use-local');
  });

  it('I4 pre-check is a superset of detection (every consumer and encoding fixture)',()=>{
    const detections=fixtures().flatMap(({bytes})=>wrappers(bytes));
    const jwk=Buffer.from(JSON.stringify({['kt'+'y']:'oct',k:'a'}));
    for(const bytes of [jwk,...fixtures().map(({bytes})=>bytes)]) {
      const base64=bytes.toString('base64');
      for(const width of [1,2,3,4,7,64])detections.push(Buffer.from(base64.match(new RegExp(`.{1,${width}}`,'g')).join('\n')));
      detections.push(Buffer.from([...bytes].map(byte=>`%${byte.toString(16).padStart(2,'0')}`).join('')),
        Buffer.from('['+[...bytes].join(',')+']'));
      for(const encoding of ['utf16le','utf16be']) {
        const utf16=Buffer.from(base64,'utf16le');
        detections.push(encoding==='utf16be'?utf16.swap16():utf16);
      }
    }
    for(const fixture of detections) {
      expect(keyStructureFinding(fixture,{precheck:false})).toBe(FINDING);
      expect(keyStructurePrecheck(fixture)).toBe(true);
    }
  });

  it('I4 1 MiB speed: skips innocuous non-candidates before canonicalization',()=>{
    const bytes=Buffer.alloc(1024*1024,33);
    const start=performance.now();
    expect(keyStructurePrecheck(bytes)).toBe(false);
    expect(keyStructureFinding(bytes)).toBeNull();
    expect(performance.now()-start).toBeLessThan(250);
  });

  it('I4 1 MiB speed: conservative encoded-looking and prose inputs stay bounded',()=>{
    for(const text of ['a','ordinary documentation. ']) {
      const bytes=Buffer.from(text.repeat(Math.ceil(1024*1024/text.length)).slice(0,1024*1024));
      expect(keyStructurePrecheck(bytes)).toBe(true);
      const start=performance.now();
      expect(keyStructureFinding(bytes)).toBeNull();
      expect(performance.now()-start).toBeLessThan(1000);
    }
  });

  it('I4 scaling: best-of-3 cost grows at most 6x from N to 4N',()=>{
    const best=bytes=>Math.min(...Array.from({length:3},()=>{
      const start=performance.now();
      expect(keyStructureFinding(bytes)).toBeNull();
      return performance.now()-start;
    }));
    for(const byte of [33,97]) {
      const small=Buffer.alloc(256*1024,byte),large=Buffer.alloc(1024*1024,byte);
      keyStructureFinding(small);keyStructureFinding(large); // Warm both sizes before measurement.
      const n=best(small),fourN=best(large);
      expect(fourN/n).toBeLessThanOrEqual(6);
    }
  });
});
