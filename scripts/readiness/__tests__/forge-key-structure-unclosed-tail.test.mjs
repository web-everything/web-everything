// @vitest-environment node
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {keyStructureFinding} from '../forge-key-structure.mjs';

const q='"';
// Computed names keep this fixture out of the tracked source's relaxed JWK scan.
const jwk=(pad)=>'{'+' '.repeat(pad)+q+['k','ty'].join('')+q+':'+q+'oct'+q+','+q+'k'+q+':'+q+'YQ'+q+'}';
// Truncated table cells: JSON-shaped, never closed.
const truncated=Array.from({length:40},(_,i)=>'| row'+i+' | {"a":{"service":"x","account":"y","… | pr |\n').join('');
const prose='plain words about settings and tables. '.repeat(3000);

describe('forge key structure: unclosed object tails stay linear without weakening detection',()=>{
  it('scans the real settings registry within budget (red on main: budget exhausted)',()=>{
    const bytes=readFileSync(new URL('../../../docs/agent/settings-registry.md',import.meta.url));
    const started=Date.now();
    expect(keyStructureFinding(bytes)).toBeNull();
    expect(Date.now()-started).toBeLessThan(5000);
  });
  it('does not exhaust on truncated JSON-shaped cells in a large benign doc',()=>{
    expect(keyStructureFinding(Buffer.from(truncated+prose+'\\|'))).toBeNull();
  });
  it('still blocks a JWK that stays open past the 64 KiB candidate bound inside a large doc',()=>{
    for(const pad of [65600,70000])
      expect(keyStructureFinding(Buffer.from(truncated+prose+jwk(pad)))).toBe('private-key-structure');
  });
  it('still blocks a PEM private key inside a large doc',()=>{
    const pem='-----BEGIN '+['PRIVATE','KEY'].join(' ')+'-----\nQUJD\n-----END '+['PRIVATE','KEY'].join(' ')+'-----';
    expect(keyStructureFinding(Buffer.from(truncated+prose+pem))).toBe('private-key-structure');
  });
});
