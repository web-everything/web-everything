import { describe, expect, it } from 'vitest';
import { isUnderTest } from '../under-test.mjs';
import { createRequire } from 'node:module';

const { isUnderTest: cjsIsUnderTest } = createRequire(import.meta.url)('../under-test.cjs');

for (const [name, predicate] of [['ESM', isUnderTest], ['CommonJS', cjsIsUnderTest]]) {
  describe(name, () => {
    it.each([
      [{ VITEST: 'true' }, true],
      [{ WE_UNDER_TEST: '1' }, true],
      [{}, false],
      [{ VITEST: '', WE_UNDER_TEST: '' }, false],
      [{ VITEST: '0' }, true],
      [{ WE_UNDER_TEST: '0' }, true],
    ])('detects the markers in %j', (env, expected) => {
      expect(predicate(env)).toBe(expected);
    });

    it('uses ambient markers only when no explicit bag is supplied', () => {
      const saved = process.env.WE_UNDER_TEST;
      try {
        process.env.WE_UNDER_TEST = '1';
        expect(predicate()).toBe(true);
        expect(predicate({})).toBe(false);
        expect(predicate({ VITEST: '', WE_UNDER_TEST: '' })).toBe(false);
      } finally {
        if (saved === undefined) delete process.env.WE_UNDER_TEST;
        else process.env.WE_UNDER_TEST = saved;
      }
    });
  });
}
