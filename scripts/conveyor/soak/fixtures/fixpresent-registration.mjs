// Native Node loads unchanged production descriptors. Replace only Vitest's registration API:
// legacy evidence must be refused before any probe executes, and declared evidence resolves for real.
import { register } from 'node:module';
import assert from 'node:assert/strict';

const vitest = `
  export const registrations = [];
  export const describe = (_title, register) => register();
  export const it = (title, run) => registrations.push({ title, run, fails: false });
  it.fails = (title, run) => registrations.push({ title, run, fails: true });
  export const expect = () => { throw new Error('registration must not execute a scenario'); };
`;
const mockUrl = `data:text/javascript,${encodeURIComponent(vitest)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vitest') return { url: ${JSON.stringify(mockUrl)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const { BREAKS } = await import('../breaks/index.mjs');
const { defineBreakTest } = await import('../define-break-test.mjs');
const { registrations } = await import('vitest');
let legacy = 0;
const refused = [];
for (const b of BREAKS) {
  const before = registrations.length;
  if (typeof b.fixPresent === 'function') {
    legacy++;
    assert.throws(() => defineBreakTest(b), error => {
      assert.ok(error.message.includes(b.id), b.id);
      assert.match(error.message, /fixPresent.*marker.*fixCommit/);
      refused.push({ id: b.id, error: error.message });
      return true;
    }, b.id);
    assert.equal(registrations.length, before, b.id);
  } else {
    defineBreakTest(b);
    assert.equal(registrations.length, before + 1, b.id);
    assert.equal(registrations.at(-1).fails, false, b.id);
  }
}
process.stdout.write(JSON.stringify({ total: BREAKS.length, legacy, refused, registered: registrations.length }));
