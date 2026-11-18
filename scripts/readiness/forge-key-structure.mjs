// One bounded decoding pipeline feeds byte-only DER and parsed-JSON detectors.
// Exhaustion refuses remote admission; the operator can inspect the file and run locally.
const LIMITS={bytes:32*1024*1024,candidates:16384,depth:8,steps:4*1024*1024};
const EXHAUSTED='private-key-scan-budget-exhausted-use-local';
const FINDING='private-key-structure';

function derFinding(bytes,tick) {
  const tlv=(offset,end)=>{
    tick();
    if(offset+2>end)return null;
    const tag=bytes[offset++];
    let length=bytes[offset++];
    if(length&128) {
      const count=length&127;
      if(!count||count>4||offset+count>end)return null;
      length=0;
      for(let i=0;i<count;i++)length=length*256+bytes[offset++];
    }
    return offset+length<=end?{tag,start:offset,end:offset+length}:null;
  };
  const children=node=>{
    const result=[];
    for(let offset=node.start;offset<node.end;) {
      const child=tlv(offset,node.end);
      if(!child)return null;
      result.push(child);offset=child.end;
    }
    return result;
  };
  const nonempty=(node,tag)=>node?.tag===tag&&node.end>node.start;
  for(let offset=0;offset<bytes.length;offset++) {
    if(bytes[offset]!==48)continue;
    const sequence=tlv(offset,bytes.length);
    if(!sequence)continue;
    const fields=children(sequence);
    if(!fields||fields.length<2)continue;
    const version=fields[0];
    if(version.tag!==2||version.end-version.start!==1)continue;
    const value=bytes[version.start];
    if(value>1)continue;
    // PKCS#1: version followed by the eight private RSA INTEGERs.
    if(fields.length>=9&&fields.slice(1,9).every(node=>nonempty(node,2))
      &&(fields.length===9||(value===1&&fields.length===10&&fields[9].tag===48)))return true;
    // SEC1: version one, scalar OCTET STRING, optional parameters/public key.
    if(value===1&&nonempty(fields[1],4)&&fields.slice(2).every(node=>[160,161].includes(node.tag)))return true;
    // PKCS#8 v0/v1: AlgorithmIdentifier and privateKey OCTET STRING.
    if(fields[1].tag===48&&nonempty(fields[2],4)
      &&fields.slice(3).every(node=>[160,129,161].includes(node.tag))) {
      const algorithm=children(fields[1]);
      if(algorithm?.length&&nonempty(algorithm[0],6))return true;
    }
  }
  return false;
}

// Scan every top-level member occurrence (duplicates included); a parsed object keeps only the last one.
function jwkFinding(bytes) {
  const text=bytes.toString('utf8');
  if(!text.trimStart().startsWith('{'))return false;
  let depth=0,key=null,pending=null,anyKty=false,octKty=false,oct=false,priv=false;
  const decoded=token=>{try {return JSON.parse(token);} catch {return '';}};
  for(const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[{}\[\]:,]/g)) {
    const token=match[0];
    if(token[0]==='/')continue;
    if(token==='{'||token==='[')depth++;
    else if(token==='}'||token===']')depth--;
    else if(depth!==1)continue;
    else if(token===':') {key=pending;pending=null;}
    else if(token===',') {key=pending=null;}
    else if(key===null)pending=decoded(token);
    else {
      const value=decoded(token);
      if(key==='kty'&&typeof value==='string') {anyKty=true;octKty||=value==='oct';}
      else if(value.length>0&&key==='k')oct=true;
      else if(value.length>0&&['d','p','q','dp','dq','qi'].includes(key))priv=true;
      key=null;
    }
  }
  return (octKty&&oct)||(anyKty&&priv);
}

// All representations (including mixed base64 alphabets) converge here, before detection.
function canonicalize(bytes,emit,tick) {
  const text=bytes.toString('utf8');
  // JSON token boundaries preserve object scope and decode JSON string escapes once.
  const stack=[];
  for(const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[{}\[\]\ufffd]/g)) {
    tick();
    const token=match[0];
    if(token[0]==='/')emit(Buffer.from(token.replace(/^\/\/|^\/\*|\*\/$/g,'')));
    else if(token[0]==='"') {
      if(token.includes('\\')) {
        try {emit(Buffer.from(JSON.parse(token)));} catch(error) {if(error===EXHAUSTED)throw error;}
      }
    // Broken UTF-8 outside strings cannot extend a JSON container's scope.
    } else if(token==='\ufffd')stack.length=0;
    else if(token==='{'||token==='[') {
      if(stack.length>=64)throw EXHAUSTED;
      stack.push({token,start:match.index});
    } else if(token==='}'||token===']') {
      const open=stack.pop();
      if(open&&open.token===(token==='}'?'{':'['))emit(Buffer.from(text.slice(open.start,match.index+1)));
    }
  }
  // Decimal/signed/0x byte arrays: comments are whitespace, never squeezed into numbers.
  for(const match of text.matchAll(/\[([^\[\]]*)\]/g)) {
    tick();
    const body=match[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,' ').trim();
    if(!/^(?:-?\d+|0x[\da-f]+)(?:\s*,\s*(?:-?\d+|0x[\da-f]+))*\s*,?$/i.test(body))continue;
    const numbers=body.replace(/,\s*$/,'').split(',').map(Number);
    if(numbers.every(number=>Number.isInteger(number)&&number>=-128&&number<=255))emit(Buffer.from(numbers));
  }
  // Hex byte notations all decode to the same candidate type.
  for(const match of text.matchAll(/(?:\\x[\da-f]{2})+|(?:%[\da-f]{2})+|(?:[\da-f]{2}:)+[\da-f]{2}|\b(?:[\da-f]{2})+\b/gi)) {
    tick();emit(Buffer.from(match[0].replace(/\\x|%|:/gi,''),'hex'));
  }
  // Token and whitespace-wrapped runs share ONE base64 decoder. Node accepts + / - _ together.
  let run='',end=-1;
  const decode=value=>{
    // Prose can change quartet alignment or add padding before the material.
    // Decode each padding-delimited segment at all four phases; the byte walker
    // finds embedded structures. Every candidate still shares the global budgets.
    for(const compact of value.replace(/\s/g,'').split(/=+/)) {
      for(let phase=0;phase<4&&compact.length-phase>=8;phase++) {
        tick();emit(Buffer.from(compact.slice(phase),'base64'));
      }
    }
  };
  // Decode armor bodies separately so their labels cannot join the wrapped run.
  for(const match of text.matchAll(/-----BEGIN [^\r\n-]+-----([\s\S]*?)-----END [^\r\n-]+-----/g)) {
    tick();decode(match[1]);
  }
  for(const match of text.matchAll(/[A-Za-z0-9+/_=-]+/g)) {
    tick();
    decode(match[0]);
    if(end>=0&&/^\s+$/.test(text.slice(end,match.index)))run+=match[0];
    else {if(run)decode(run);run=match[0];}
    end=match.index+match[0].length;
  }
  if(run)decode(run);
  // Preserve the existing scanner's UTF-16 reach for structured material, too.
  if(bytes.includes(0)&&bytes.length>=2) {
    emit(Buffer.from(bytes.toString('utf16le')));
    const whole=Buffer.from(bytes.subarray(0,bytes.length-bytes.length%2)).swap16();
    emit(Buffer.from(whole.toString('utf16le')));
  }
}

export function keyStructureFinding(buffer) {
  if(!Buffer.isBuffer(buffer))return 'private-key-scan-unreadable-use-local';
  const queue=[],seen=new Set();
  let total=0,steps=0;
  const tick=()=>{if(++steps>LIMITS.steps)throw EXHAUSTED;};
  const add=(bytes,depth)=>{
    if(bytes.length>LIMITS.bytes)throw EXHAUSTED;
    const identity=bytes.toString('base64');
    if(!bytes.length||seen.has(identity))return;
    if(depth>LIMITS.depth||queue.length>=LIMITS.candidates||(total+=bytes.length)>LIMITS.bytes)throw EXHAUSTED;
    seen.add(identity);queue.push({bytes,depth});
  };
  try {
    add(buffer,0);
    for(let index=0;index<queue.length;index++) {
      const {bytes,depth}=queue[index];
      if(derFinding(bytes,tick)||jwkFinding(bytes))return FINDING;
      canonicalize(bytes,candidate=>add(candidate,depth+1),tick);
    }
    return null;
  } catch(error) {
    if(error===EXHAUSTED)return EXHAUSTED;
    return 'private-key-scan-unreadable-use-local';
  }
}
