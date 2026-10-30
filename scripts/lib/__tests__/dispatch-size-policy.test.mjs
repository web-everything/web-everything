import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { defaultReadSizePolicy } from '../dispatch-size-policy.mjs';
import { defaultReadSizePolicy as dispatchReadSizePolicy } from '../../operations/dispatch-lane-io.mjs';

describe('shared dispatch size-policy reader', () => {
  it('preserves the dispatch IO export and injected root/reader contract', () => {
    expect(dispatchReadSizePolicy).toBe(defaultReadSizePolicy);
    const policy = { unsizedCardPolicy: 'default-size', defaultSize: 21 };
    const result = defaultReadSizePolicy({ root: 'fixture', readText(path) {
      expect(path).toBe(join('fixture', 'scripts', 'lib', 'dispatch-size-policy.json'));
      return JSON.stringify(policy);
    } });
    expect(result).toEqual(policy);
  });

  it.each(['{', 'null', '[]', 'true', '13', '"block"'])(
    'retains the validator fallback for invalid setting %s', raw => {
      expect(defaultReadSizePolicy({ readText: () => raw })).toBeNull();
    },
  );

  it('retains the validator fallback when the setting cannot be read', () => {
    expect(defaultReadSizePolicy({ readText() { throw new Error('unreadable'); } })).toBeNull();
  });
});
