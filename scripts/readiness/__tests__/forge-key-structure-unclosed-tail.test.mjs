// @vitest-environment node
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {keyStructureFinding} from '../forge-key-structure.mjs';

const q='"';
const FINDING='private-key-structure';
const EXH='private-key-scan-budget-exhausted-use-local';
const kt=['k','ty'].join('');
const pad=n=>' '.repeat(n);
// Truncated table cells: JSON-shaped, never closed.
const truncated=Array.from({length:40},(_,i)=>'| row'+i+' | {"a":{"service":"x","account":"y","… | pr |\n').join('');
const prose='plain words about settings and tables. '.repeat(3000);
const stray='an unclosed '+q+' ';

describe('forge key structure: unclosed object tails stay linear without weakening detection',()=>{
  it('scans the real settings registry within budget (red on main: budget exhausted)',()=>{
    const bytes=readFileSync(new URL('../../../docs/agent/settings-registry.md',import.meta.url));
    const started=Date.now();
    expect(keyStructureFinding(bytes)).toBeNull();
    expect(Date.now()-started).toBeLessThan(5000);
  });
  it('does not exhaust on truncated cells with no signal after them',()=>{
    expect(keyStructureFinding(Buffer.from(truncated+prose+'a b'))).toBeNull();
  });
  it('differential corpus: small closed objects hidden behind a stray quote stay within budget',()=>{
    const members=['"a":1',"'a':1",'a:1','/* comment */ "a":1','// comment\r\n"a":1','// comment\u2028"a":1'];
    for(const member of members) {
      const body=stray+'\\| '+('{'+member+'}\n').repeat(3000)+pad(400000);
      // Every candidate closes within the bound, regardless of the remaining document length.
      expect(keyStructureFinding(Buffer.from(body)),member).toBeNull();
    }
  });
  it('charges repeated unsignalled unclosed tails even when the last regex search finds no token',()=>{
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
