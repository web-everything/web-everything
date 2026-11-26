// Native Node loads unchanged production descriptors. Replace only Vitest's registration API:
// grandfathered probes and declared evidence resolve for real; every descriptor must register.
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
const legacyNames = [];
const refused = [];
for (const b of BREAKS) {
  const before = registrations.length;
  if (typeof b.fixPresent === 'function') legacyNames.push(b.id);
  try {
    defineBreakTest(b);
    assert.equal(registrations.length, before + 1, b.id);
  } catch (error) {
    refused.push({ id: b.id, error: error.message });
  }
}
process.stdout.write(JSON.stringify({ total: BREAKS.length, legacy: legacyNames.length, legacyNames, refused, registered: registrations.length }));
