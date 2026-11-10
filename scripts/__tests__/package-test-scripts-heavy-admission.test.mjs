/**
 * @file scripts/__tests__/package-test-scripts-heavy-admission.test.mjs
 * @description Every package.json script that launches vitest or playwright directly must route through
 *   heavy-admission (so Codex/agent `npm run …` callers cannot bypass the host heavy queue). Re-entrancy
 *   (WE_HEAVY_ADMISSION_HELD) and CI bypass are handled inside heavy-admission itself. `test` stays bare
 *   on purpose: it is interactive watch mode (guard-bash already denies bare `npm test` for agents).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const scripts = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')).scripts;
const wrapper = 'node scripts/readiness/heavy-admission.mjs run -- ';

describe('package test scripts route through heavy-admission', () => {
  const runners = Object.entries(scripts).filter(([name, cmd]) => name !== 'test' && /(^|&&\s*|\|\|\s*|;\s*)(vitest|playwright)\b/.test(cmd));
  it('has no script starting vitest/playwright outside the wrapper', () => {
    expect(runners.map(([name]) => name)).toEqual([]);
  });
  for (const name of ['test:unit', 'test:e2e', 'check:visual', 'check:visual:update']) {
    it(`${name} is wrapped`, () => expect(scripts[name].startsWith(wrapper)).toBe(true));
  }
});
