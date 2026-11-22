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
    expect(keyStructureFinding(Buffer.from(truncated+prose))).toBeNull();
  });
  it('still fails closed on a JWK open past the 64 KiB bound, including template-literal values',()=>{
    for(const pad of [65600,70000]) {
      expect(keyStructureFinding(Buffer.from(truncated+prose+jwk(pad)))).toMatch(/^private-key-(?:structure|scan-budget-exhausted-use-local)$/);
      expect(keyStructureFinding(Buffer.from('an unclosed '+q+' {'+' '.repeat(pad)+q+['k','ty'].join('')+q+':`oct`,'+q+'k'+q+':`YQ`}')))
        .toBe('private-key-scan-budget-exhausted-use-local');
    }
  });
  it('fails closed when an escape could hide the key type in an unclosed tail',()=>{
    expect(keyStructureFinding(Buffer.from(truncated+prose+'{"k\\u0074y":"oct"'))).toBe('private-key-scan-budget-exhausted-use-local');
  });
  it('still blocks a PEM private key inside a large doc',()=>{
    const pem='-----BEGIN '+['PRIVATE','KEY'].join(' ')+'-----\nQUJD\n-----END '+['PRIVATE','KEY'].join(' ')+'-----';
    expect(keyStructureFinding(Buffer.from(truncated+prose+pem))).toBe('private-key-structure');
  });
});
