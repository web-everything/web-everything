// Forge manifest scan, Layer A: recognise STRUCTURED private-key material by decoding, with no label needed.
// Private bytes must never ship to Forge, so this is additive only and never allowlistable (S1 of
// plan:forge-key-structure). It sits beside, never instead of, the pem-header and PRIVATE KEY rules.
//
// How: build linear "squeezed" views of the text (base64, base64url, hex, decimal byte arrays), decode each to
// bytes at every alignment, then do fixed-string (Buffer.includes) signature search plus a bounded JWK check.
// There is no variable-gap regex, so the cost is linear in the input (inputs are capped upstream at 3 MiB a blob).
//
// The signatures are stored reversed, as hex, and re-assembled at runtime. Stored forward they would be a
// private-key structure themselves and this very file would block its own shipment to Forge.
export const KEY_STRUCTURE_FINDING='private-key-structure';
const unreverse=hex=>Buffer.from([...hex].reverse().join(''),'hex');
const SIGNATURES=[
  // PKCS#8: version 0 + AlgorithmIdentifier (ed25519, x25519, rsaEncryption, EC P-256 and P-384/P-521)
  '0756b230605003001020','e656b230605003001020','101010d07f688468a29060d003001020',
  '1020d3ec8468a270603103001020','1020d3ec8468a270600103001020',
  // PKCS#1 RSAPrivateKey: version 0 + modulus header
  '102820001020','202820001020','00181820001020','081820001020',
  // SEC1 ECPrivateKey: version 1 + OCTET STRING of 32, 48, 66 bytes
  '0240101020','0340101020','2440101020',
  // OpenSSH key-v1 magic (with NUL) and the PuTTY private key header
  '001367d29756b6d2863737e65607f6','d256c69664d29756b4d227563755d29545455705',
].map(unreverse);
const JWK_TYPE=/["']?kty["']?:["']?(?:RSA|EC|OKP|oct)["']?/;
const JWK_SECRET=/["']?(?:d|p|q|dp|dq|qi|k)["']?:["'][A-Za-z0-9_-]{22,}/;

const hasSignature=bytes=>SIGNATURES.some(signature=>bytes.includes(signature));
// A JWK private member (d/p/q/dp/dq/qi/k) of 16+ bytes next to a known key type. Whitespace-free, so pretty
// printing never matters; both patterns are anchored on a literal and have no variable gap between them.
function hasJwkSecret(bytes) {
  if(!bytes.includes('kty'))return false;
  const compact=bytes.toString('latin1').replace(/\s+/g,'');
  return JWK_TYPE.test(compact)&&JWK_SECRET.test(compact);
}
const hasKey=bytes=>hasSignature(bytes)||hasJwkSecret(bytes);

// Drop whole-line and trailing comments (a marker followed by whitespace) so a comment inside a wrapped body
// cannot split it. Returns the text unchanged when there is none.
function stripComments(text) {
  return text.replace(/^[ \t]*(?:#|\/\/|;|\*)[ \t].*$/gm,'').replace(/[ \t](?:#|\/\/)[ \t].*$/gm,'');
}
const decodeAligned=(view,encoding,alignments)=>{
  const out=[];
  for(let skip=0;skip<alignments;skip++)out.push(Buffer.from(view.slice(skip),encoding));
  return out;
};
function decodedBuffers(text) {
  const out=[];
  const b64=text.replace(/[^A-Za-z0-9+/]+/g,'');
  if(b64.length>=16)out.push(...decodeAligned(b64,'base64',4));
  const b64url=text.replace(/[^A-Za-z0-9_-]+/g,'');
  if(b64url.length>=16)out.push(...decodeAligned(b64url,'base64url',4));
  const hex=text.replace(/0x/gi,'').replace(/[^0-9a-fA-F]+/g,'');
  if(hex.length>=16)for(let skip=0;skip<2;skip++)out.push(Buffer.from(hex.slice(skip),'hex'));
  const bytes=[];
  for(const match of text.matchAll(/(?<![\w.])\d{1,3}(?![\w.])/g)) {
    const value=Number(match[0]);
    if(value<=255)bytes.push(value);
  }
  if(bytes.length>=8)out.push(Buffer.from(bytes));
  return out;
}
function scanText(text) {
  if(text.length<8)return false;
  if(hasJwkSecret(Buffer.from(text,'latin1')))return true;
  const stripped=stripComments(text);
  for(const variant of stripped===text?[text]:[text,stripped])
    for(const bytes of decodedBuffers(variant))if(hasKey(bytes))return true;
  return false;
}
// content: Buffer. True when a structured private key hides in the raw bytes or in any decoded text view.
export function privateKeyStructureFinding(content) {
  if(!Buffer.isBuffer(content))return null;
  if(hasKey(content))return KEY_STRUCTURE_FINDING;
  const texts=new Set([content.toString('latin1'),content.toString('utf8'),content.toString('utf16le')]);
  const swapped=Buffer.from(content.subarray(0,content.length-content.length%2)).swap16();
  texts.add(swapped.toString('utf16le'));
  for(const text of texts)if(scanText(text))return KEY_STRUCTURE_FINDING;
  return null;
}
