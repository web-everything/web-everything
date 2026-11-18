// One bounded decoding pipeline feeds byte-only DER and parsed-JSON detectors.
// Exhaustion refuses remote admission; the operator can inspect the file and run locally.
const LIMITS={bytes:32*1024*1024,candidates:16384,depth:8,steps:4*1024*1024,derDepth:64,jsonDepth:64};
// Reserve the initial candidate and conservatively allow one counted unit per
// input byte. This bounds bytes, candidates and ticks by their smallest budget.
// Depth budgets require a separate proof: a negative precheck below permits NO
// emitted candidates, DER entry or JSON opening container, so all depths stay 0.
const PRECHECK_SAFE_BYTES=Math.min(LIMITS.bytes,LIMITS.candidates-1,LIMITS.steps);
const EXHAUSTED='private-key-scan-budget-exhausted-use-local';
const FINDING='private-key-structure';

function derFinding(bytes,tick) {
  const cache=new Map();
  const tlv=(offset,end,depth=0)=>{
    tick();
    if(depth>LIMITS.derDepth)throw EXHAUSTED;
    const cached=cache.get(offset);
    if(cached)return cached.next<=end?cached:null;
    if(offset+2>end)return null;
    const tag=bytes[offset++];
    let length=bytes[offset++];
    const header=offset-2,start=offset;
    if(length===128) {
      if(!(tag&32))return null; // BER indefinite lengths require a constructed tag.
      while(offset+2<=end) {
        if(bytes[offset]===0&&bytes[offset+1]===0) {
          const node={tag,start,end:offset,next:offset+2};
          cache.set(header,node);return node;
        }
        const child=tlv(offset,end,depth+1);
        if(!child||child.tag===0)return null;
        offset=child.next;
      }
      return null; // An unfinished BER container is not a complete key.
    }
    if(length&128) {
      const count=length&127;
      if(!count||count>4||offset+count>end)return null;
      length=0;
      for(let i=0;i<count;i++)length=length*256+bytes[offset++];
    }
    if(offset+length>end||tag===0)return null;
    const node={tag,start:offset,end:offset+length,next:offset+length};
    cache.set(header,node);return node;
  };
  const children=node=>{
    const result=[];
    for(let offset=node.start;offset<node.end;) {
      const child=tlv(offset,node.end);
      if(!child)return null;
      result.push(child);offset=child.next;
    }
    return result;
  };
  const nonempty=(node,tag)=>node?.tag===tag&&node.end>node.start;
  const octets=(node,depth=0)=>{
    tick();
    if(depth>LIMITS.derDepth)throw EXHAUSTED;
    if(node?.tag===4)return node.end-node.start;
    if(node?.tag!==36)return -1;
    const parts=children(node);
    if(!parts)return -1;
    let size=0;
    for(const part of parts) {
      const length=octets(part,depth+1);
      if(length<0)return -1;
      size+=length;
    }
    return size;
  };
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
    if(value===1&&octets(fields[1])>0&&fields.slice(2).every(node=>[160,161].includes(node.tag)))return true;
    // PKCS#8 v0/v1: AlgorithmIdentifier and privateKey OCTET STRING.
    if(fields[1].tag===48&&octets(fields[2])>0
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

// Syntax that can yield another supported representation; byte detection precedes this filter.
function encodedText(text) {
  return (text.includes('{')&&text.includes('}')&&text.includes('"'))
    ||(text.includes('[')&&text.includes(']'))
    ||(text.includes('"')&&text.includes('\\'))
    ||(text.match(/[\[{]/g)?.length??0)>=64
    ||/\\x[\da-f]{2}|%[\da-f]{2}|[\da-f]{2}:[\da-f]{2}/i.test(text)
    ||/[A-Za-z0-9+/_=-]{11}/.test(text.replace(/\s/g,''));
}

// All representations (including mixed base64 alphabets) converge here, before detection.
function canonicalize(bytes,emit,tick,{comments=true,utf16=true}={}) {
  const text=bytes.toString('utf8');
  // JSON token boundaries preserve object scope and decode JSON string escapes once.
  const stack=[];
  const tokens=comments?/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[{}\[\]\ufffd]/g
    :/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]\ufffd]/g;
  for(const match of text.matchAll(tokens)) {
    tick();
    const token=match[0];
    // A comment body is already unwrapped. URLs inside it are not more comment layers.
    if(token[0]==='/')emit(Buffer.from(token.replace(/^\/\/|^\/\*|\*\/$/g,'')),{comments:false,utf16,layer:false});
    else if(token[0]==='"') {
      if(token.includes('\\')) {
        try {emit(Buffer.from(JSON.parse(token)));} catch(error) {if(error===EXHAUSTED||error===FINDING)throw error;}
      }
    // Broken UTF-8 outside strings cannot extend a JSON container's scope.
    } else if(token==='\ufffd')stack.length=0;
    else if(token==='{'||token==='[') {
      // Template delimiters and prose brackets are not nested JSON containers.
      // Incomplete JSON-shaped nesting still reaches the fail-closed bound.
      let next=match.index+1;
      while(next<text.length&&/\s/.test(text[next]))next++;
      if(!(token==='{'?/^["}/]/:/^[\[\]{"/\d-]|^(?:true|false|null)\b/).test(text.slice(next,next+5))) {
        stack.length=0;continue;
      }
      if(stack.length>=64)throw EXHAUSTED;
      stack.push({token,start:match.index});
    } else if(token==='}'||token===']') {
      const open=stack.pop();
      // This pass already visits everything inside the container; only detect its members.
      if(open&&open.token===(token==='}'?'{':'['))emit(Buffer.from(text.slice(open.start,match.index+1)),{expand:false});
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
    // Four phases of the whole whitespace run also cover every individual token.
    if(end>=0&&/^\s+$/.test(text.slice(end,match.index)))run+=match[0];
    else {if(run)decode(run);run=match[0];}
    end=match.index+match[0].length;
  }
  if(run)decode(run);
  // Preserve the existing scanner's UTF-16 reach for structured material, too.
  if(utf16&&bytes.includes(0)&&bytes.length>=2) {
    // Random binary can expand into much larger Unicode views. Continue only
    // with progress or evidence of another UTF-16 representation, including
    // encoded material after a non-ASCII prefix and Unicode whitespace.
    const continues=view=>{
      if(view.length<bytes.length)return true;
      if(/(?:[\x01-\x7f]\0){4}|(?:\0[\x01-\x7f]){4}/.test(view.toString('latin1')))return true;
      if(encodedText(view.toString('utf16le')))return true;
      const other=Buffer.from(view.subarray(0,view.length-view.length%2)).swap16();
      return encodedText(other.toString('utf16le'));
    };
    // Embedded UTF-16 can begin at either byte alignment after binary prefixes.
    for(const offset of [0,1]) {
      const aligned=bytes.subarray(offset,offset+Math.floor((bytes.length-offset)/2)*2);
      const decoded=Buffer.from(aligned.toString('utf16le'));
      emit(decoded,{utf16:continues(decoded)});
      const swapped=Buffer.from(Buffer.from(aligned).swap16().toString('utf16le'));
      emit(swapped,{utf16:continues(swapped)});
    }
  }
}

// A negative result proves none of the pipeline's entry representations are present,
// including non-key candidates that could consume the shared scan budgets.
// In particular, base64 chunks of ONE character may join across whitespace. Do not
// require a long individual token or a particular alphabet/prefix. High bytes go
// to the full scan (they may be Unicode whitespace); NUL covers UTF-16 decoding.
// Colon admits the canonicalizer's (?:[\da-f]{2}:)+[\da-f]{2} hex entry pattern.
export function keyStructurePrecheck(buffer) {
  if(!Buffer.isBuffer(buffer)||buffer.length>PRECHECK_SAFE_BYTES)return true;
  let run=0,hexRun=0;
  for(const byte of buffer) {
    // Slash covers comment emissions; even a two-character hex token can emit
    // a candidate. Reject non-ASCII here so byte and token bounds coincide.
    if(byte>=128||[0,34,37,47,48,58,91,92,123].includes(byte))return true;
    if((byte>=48&&byte<=57)||(byte>=65&&byte<=70)||(byte>=97&&byte<=102)) {
      if(++hexRun>=2)return true;
    } else hexRun=0;
    if((byte>=65&&byte<=90)||(byte>=97&&byte<=122)||(byte>=48&&byte<=57)
      ||[43,45,47,61,95].includes(byte)) {
      if(++run>=8)return true;
    } else if(byte<128&&![9,10,11,12,13,32].includes(byte))run=0;
  }
  // No emissions means only the root candidate's bytes are charged, candidate
  // and decode depths cannot grow, and only disjoint closing-container/base64
  // tokens can tick (at most once per ASCII byte). DER/JSON recursion never starts.
  return false;
}

// The bypass lets differential tests compare the optimization with the full scan.
export function keyStructureFinding(buffer,{precheck=true}={}) {
  if(!Buffer.isBuffer(buffer))return 'private-key-scan-unreadable-use-local';
  if(buffer.length>LIMITS.bytes)return EXHAUSTED;
  if(precheck&&!keyStructurePrecheck(buffer))return null;
  const queue=[],seen=new Set();
  let total=0,steps=0;
  const tick=()=>{if(++steps>LIMITS.steps)throw EXHAUSTED;};
  const add=(bytes,depth,options={})=>{
    tick();
    if(bytes.length>LIMITS.bytes)throw EXHAUSTED;
    const identity=bytes.toString('base64')+':'+(options.comments!==false)+':'+(options.utf16!==false);
    if(!bytes.length||seen.has(identity))return;
    if((total+=bytes.length)>LIMITS.bytes)throw EXHAUSTED;
    // Every decoded view reaches the byte detectors, including views with no more encodings.
    if(derFinding(bytes,tick)||jwkFinding(bytes))throw FINDING;
    if(options.expand===false)return;
    // The shortest DER structure is eight bytes (already detected above); its
    // shortest supported text encoding is eleven base64 characters. This bounds
    // further decoding, never the size of a private member or detected structure.
    if(bytes.length<11)return;
    const text=bytes.toString('utf8');
    // Terminal binary fragments cannot produce another supported representation. Do not
    // retain/redecode them as candidates, but still scan them above for embedded DER/JWKs.
    if(!encodedText(text)&&!(options.utf16!==false&&bytes.includes(0)))return;
    if(depth>LIMITS.depth||queue.length>=LIMITS.candidates)throw EXHAUSTED;
    seen.add(identity);queue.push({bytes,depth,options});
  };
  try {
    add(buffer,0);
    for(let index=0;index<queue.length;index++) {
      const {bytes,depth,options}=queue[index];
      canonicalize(bytes,(candidate,next={})=>add(candidate,depth+(next.layer===false?0:1),next),tick,options);
    }
    return null;
  } catch(error) {
    if(error===FINDING)return FINDING;
    if(error===EXHAUSTED)return EXHAUSTED;
    return 'private-key-scan-unreadable-use-local';
  }
}
