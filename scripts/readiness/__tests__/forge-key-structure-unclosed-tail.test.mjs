// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {buildRegistry,renderMarkdown} from '../../lib/settings-registry.mjs';
import {keyStructureFinding} from '../forge-key-structure.mjs';
import {credentialBufferFinding} from '../forge-exec-manifest.mjs';

const q='"';
const FINDING='private-key-structure';
const EXH='private-key-scan-budget-exhausted-use-local';
const kt=['k','ty'].join('');
const pad=n=>' '.repeat(n);
// Truncated table cells: JSON-shaped, never closed.
const truncated=Array.from({length:40},(_,i)=>'| row'+i+' | {"a":{"service":"x","account":"y","… | pr |\n').join('');
const prose='plain words about settings and tables. '.repeat(3000);
const stray='an unclosed '+q+' ';

describe('forge key structure: bounded unclosed object scans fail closed',()=>{
  it('refuses the real settings registry promptly when an oversized candidate cannot be closed',()=>{
    // The registry doc is generated locally and gitignored, so scan a fresh render of it instead of a tracked file.
    const bytes=Buffer.from(renderMarkdown(buildRegistry()));
    const started=Date.now();
    // Operator ruling (round 2) supersedes the original "registry scans to null" acceptance: the registry has
    // truncated table cells (`{"a":{"service":…`) and the any-case `kty` gate matches `byTaskType`, so an
    // oversized unclosed candidate must refuse remote admission. This pins the refusal and that it is prompt.
    expect(keyStructureFinding(bytes)).toBe(EXH);
    expect(Date.now()-started).toBeLessThan(5000);
  });
  it('still finds a key object holding a lone quote when the candidate ends with the document',()=>{
    const members=[
      '"kty":"oct","k":"YQ",note:it\'s',
      '"kty":"oct","k":"YQ",x:\'',
      '"kty":"oct","k":"YQ",x:'+q,
      'note:it\'s,"kty":"oct","k":"YQ"',
    ];
    for(const member of members) {
      for(const prefix of [stray,stray+'\\| ']) {
        const bytes=Buffer.from(prefix+'{'+member+'} tail text');
        expect(keyStructureFinding(bytes),member).toBe(FINDING);
        expect(credentialBufferFinding(bytes),member).toBe(FINDING);
      }
    }
  });
  it('fails closed, never open, on a lone quote inside an object whose window is cut',()=>{
    for(const lone of ["'",q]) {
      const bytes=Buffer.from(kt+' '+q+' {"a":1,x:'+lone+'}'+pad(66000)+lone);
      expect(keyStructureFinding(bytes)).toBe(EXH);
    }
  });
  it('does not exhaust on truncated cells without any recognized signal',()=>{
    expect(keyStructureFinding(Buffer.from(truncated+prose+'a b'))).toBeNull();
  });
  it('fails closed on an oversized unclosed candidate even when every signal precedes its brace',()=>{
    for(const prefix of [kt+' '+q+' ', '\\| '+stray]) {
      const bytes=Buffer.from(prefix+'{a:1 '+pad(66000));
      expect(keyStructureFinding(bytes)).toBe(EXH);
      expect(credentialBufferFinding(bytes)).toBe(EXH);
    }
  });
  it('does not mistake braces inside a string cut by the scan window for a closing candidate',()=>{
    for(const quote of [q,"'"]) {
      for(const ending of ['', '\\']) {
        const member='{a:'+quote+'}'+pad(66000);
        // Put the escape, when present, exactly at the end of the independent scan window.
        const open=member.slice(0,65536-ending.length)+ending;
        expect(keyStructureFinding(Buffer.from(kt+' '+q+' '+open+pad(1000)+quote))).toBe(EXH);
      }
    }
  });
  it('bounds independent candidate traversal before a long final search or repeated tail scans',()=>{
    const exec=RegExp.prototype.exec;
    const lengths=[];
    const spy=vi.spyOn(RegExp.prototype,'exec').mockImplementation(function(text) {
      // Only the independent brace scanner ends in this token alternative.
      if(this.source.endsWith('|[{}]'))lengths.push(text.length);
      return exec.call(this,text);
    });
    try {
      // Close the prose quote around repeated braces so the primary pass skips them instead of reaching
      // its nesting limit before the independent scanner can exercise its own window bound.
      for(const tail of [pad(400000),q+pad(400000)+q,'/*'+pad(400000)+'*/','{a:1 '.repeat(1000)+pad(400000)+q]) {
        lengths.length=0;
        const finding=keyStructureFinding(Buffer.from(kt+' '+q+' {a:1 '+tail));
        expect(lengths.length).toBeGreaterThan(0);
        expect(Math.max(...lengths)).toBeLessThanOrEqual(65536);
        expect(finding).toBe(EXH);
      }
    } finally {spy.mockRestore();}
  });
  it('differential corpus: small closed objects hidden behind a stray quote stay within budget',()=>{
    const members=['"a":1',"'a':1",'a:1','/* comment */ "a":1','// comment\r\n"a":1','// comment\u2028"a":1'];
    for(const member of members) {
      const body=stray+'\\| '+('{'+member+'}\n').repeat(3000)+pad(400000);
      // Every candidate closes within the bound, regardless of the remaining document length.
      expect(keyStructureFinding(Buffer.from(body)),member).toBeNull();
    }
  });
  it('refuses repeated unsignalled unclosed tails even when the last regex search finds no token',()=>{
    const body='\\| '+stray+('{"a":1\n').repeat(1000)+pad(400000);
    expect(keyStructureFinding(Buffer.from(body))).toBe(EXH);
  });
  it('fails closed on an overflowing brace when kty, an escape, a computed or spread member or concatenation follows',()=>{
    const tails=[
      '{'+pad(66000)+q+kt+q+':`oct`,'+q+'k'+q+':`YQ`}',
      '{note:'+q+'x'+q+','+pad(66000)+'['+q+'k'+q+'+'+q+'ty'+q+']:'+q+'oct'+q+',k:'+q+'YQ'+q+'}',
      '{note:'+q+'x'+q+','+pad(66000)+'...type,k:'+q+'YQ'+q+'}',
      '{note:'+q+'x'+q+','+pad(66000)+'get ['+q+'x'+q+'](){}}',
      '{note:'+q+'\\|'+q+','+pad(66000)+'[a]:1}',
      '{note:'+q+'x'+q+','+pad(66000)+q+'k'+q+'+'+q+'ty'+q+'}',
      '{note:'+q+'x'+q+','+pad(66000)+'/* c */ [a]:1}',
    ];
    for(const tail of tails) {
      expect(keyStructureFinding(Buffer.from(stray+tail))).toMatch(/^private-key-(?:structure|scan-budget-exhausted-use-local)$/);
      expect(keyStructureFinding(Buffer.from(stray+tail.slice(0,-1)))).toBe(EXH);
    }
  });
  it('fails closed when a signal follows an unclosed brace and a closed object is found past the bound',()=>{
    const closed='{'+pad(66000)+q+kt+q+':'+q+'oct'+q+','+q+'k'+q+':'+q+'YQ'+q+'}';
    expect(keyStructureFinding(Buffer.from(truncated+prose+closed))).toMatch(/^private-key-(?:structure|scan-budget-exhausted-use-local)$/);
    expect(keyStructureFinding(Buffer.from(truncated+prose+'{"k\\u0074y":"oct"'))).toBe(EXH);
  });
  it('differential corpus: a signal-free unclosed tail may go null, any signal keeps main behaviour',()=>{
    const bodies=[truncated+prose,truncated+prose+'\\|',truncated+prose+'x '+kt,truncated+prose+'[1,2]',truncated+prose+'{a,[b]:1'];
    const expected=[null,EXH,EXH,null,EXH];
    bodies.forEach((body,i)=>expect(keyStructureFinding(Buffer.from(body))).toBe(expected[i]));
  });
  it('treats comments between member tokens, any-case kty and repeated unclosed tails conservatively',()=>{
    const open='{note:'+q+'x'+q+','+pad(66000);
    for(const tail of ['// c\n...s','// c\n[kn]:'+q+'oct'+q,q+'k'+q+'/* c */+/* c */'+q+'ty'+q])
      expect(keyStructureFinding(Buffer.from(stray+open+tail))).toBe(EXH);
    const many=kt+' '+stray+'{a:'.repeat(6000)+pad(66000)+q;
    const started=Date.now();
    expect(keyStructureFinding(Buffer.from(many))).toBe(EXH);
    expect(Date.now()-started).toBeLessThan(2000);
  });
  it('keeps the signal scan linear on bracket-heavy input',()=>{
    const started=Date.now();
    expect(keyStructureFinding(Buffer.from('[a]'.repeat(40000)))).toBeNull();
    expect(Date.now()-started).toBeLessThan(500);
  });
  it('still blocks a PEM private key inside a large doc',()=>{
    const pem='-----BEGIN '+['PRIVATE','KEY'].join(' ')+'-----\nQUJD\n-----END '+['PRIVATE','KEY'].join(' ')+'-----';
    expect(keyStructureFinding(Buffer.from(truncated+prose+pem))).toBe(FINDING);
  });
});
