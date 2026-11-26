// Native Node loads the real registry without vite-node's pool restrictions. Replace only Vitest's
// registration API; no behavioural scenario runs, and legacy probes use deterministic doubles so this
// collection regression cannot dispatch the hundreds of independent probes in the production registry.
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
for (const b of BREAKS) {
  if (typeof b.fixPresent === 'function') {
    legacy++;
    for (const present of [true, false]) {
      defineBreakTest({ ...b, fixPresent: () => present });
      assert.equal(registrations.at(-1).fails, !present, b.id);
    }
  } else {
    defineBreakTest(b);
  }
}
process.stdout.write(JSON.stringify({ total: BREAKS.length, legacy, registered: registrations.length }));
