// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeOperatorOverride, clearOperatorOverride, readOperatorOverrides, ENUM_LEAVES } from '../operator-override-store.mjs';
import { readStrictOverride, readStrictStore } from '../capacity-leaf.mjs';
import { readEnumOverride, enumOverridesPath } from '../operator-enum-store.mjs';

let dir, file, enumFile;
const enumKey = 'ciHeal.loop';
const numericKey = 'reviewConcurrency.maxLiveReviewRounds';
const base = { reason: 'enum override test', actor: 'operator' };
const set = (key, value) => writeOperatorOverride({ file, key, value, ...base });
const stored = path => JSON.parse(readFileSync(path, 'utf8'));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operator-enum-'));
  file = join(dir, 'operator-overrides.json');
  enumFile = enumOverridesPath(file);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('operator override enum leaves (own store, never the numeric capacity store)', () => {
  it('declares ciHeal.loop as an on/off enum, stored beside the numeric store', () => {
    expect(ENUM_LEAVES[enumKey]).toEqual(['off', 'on']);
    expect(enumFile).toBe(join(dir, 'operator-enum-overrides.json'));
  });

  it('stores an allowed enum value in the enum file, audits it, and reads it back', () => {
    expect(set(enumKey, 'on')).toMatchObject({ key: enumKey, old: null, new: 'on', source: 'operator-cli' });
    expect(stored(enumFile)).toEqual({ [enumKey]: 'on' });
    expect(existsSync(file)).toBe(false);
    expect(readEnumOverride(enumKey, { file })).toEqual({ ok: true, value: 'on' });
    const row = JSON.parse(readFileSync(join(dir, 'operator-overrides.log.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ key: enumKey, old: null, new: 'on', actor: 'operator' });
  });

  it("main's readers stay valid with an enum row present: the numeric store never contains it", () => {
    set(numericKey, 7);
    set(enumKey, 'off');
    expect(stored(file)).toEqual({ [numericKey]: 7 });
    expect(readStrictStore({ file })).toMatchObject({ ok: true, values: { [numericKey]: 7 } });
    expect(readStrictOverride(numericKey, { file })).toEqual({ ok: true, value: 7 });
    const read = readOperatorOverrides({ file, log: () => {} });
    expect(read.values).toEqual({ [numericKey]: 7 });
    expect(read.invalidPolicies).toBeUndefined();
  });

  it('refuses a value outside the declared enum (fail closed), leaving no store and no audit', () => {
    for (const bad of ['maybe', 'ON', '', 1, true, null]) expect(() => set(enumKey, bad)).toThrow(/operator-override/);
    expect(existsSync(enumFile)).toBe(false);
    expect(existsSync(join(dir, 'operator-overrides.log.jsonl'))).toBe(false);
  });

  it('refuses an unknown key even with an on/off value', () => {
    expect(() => set('mergeQueue.refreshOnStaleMergeGate', 'on')).toThrow(/signed-attestation/);
    expect(existsSync(enumFile)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('numeric keys are unchanged: a string is refused, a number in range is stored in the numeric store', () => {
    expect(() => set(numericKey, 'on')).toThrow(/operator-override/);
    expect(() => set(numericKey, 17)).toThrow(/operator-override/);
    expect(existsSync(file)).toBe(false);
    set(numericKey, 5);
    expect(stored(file)).toEqual({ [numericKey]: 5 });
    expect(existsSync(enumFile)).toBe(false);
  });

  it('an enum key cannot hold a number', () => {
    expect(() => set(enumKey, 1)).toThrow(/operator-override/);
  });

  it('a hand-edited enum store with a bad value or a duplicate key is wholly refused', () => {
    set(enumKey, 'on');
    writeFileSync(enumFile, '{"ciHeal.loop":"maybe"}');
    expect(readEnumOverride(enumKey, { file }).ok).toBe(false);
    writeFileSync(enumFile, '{"ciHeal.loop":"on","ciHeal.loop":"off"}');
    expect(readEnumOverride(enumKey, { file }).ok).toBe(false);
    writeFileSync(enumFile, '{"unknown.key":"on"}');
    expect(readEnumOverride(enumKey, { file }).ok).toBe(false);
  });

  it('reports absent and not-set distinctly so callers can tell a lost store from a missing one', () => {
    expect(readEnumOverride(enumKey, { file })).toMatchObject({ ok: false, reason: 'absent' });
    writeFileSync(enumFile, '{}');
    expect(readEnumOverride(enumKey, { file })).toMatchObject({ ok: false, reason: 'not-set' });
  });

  it('clear removes the enum key', () => {
    set(enumKey, 'on');
    clearOperatorOverride({ file, key: enumKey, ...base });
    expect(stored(enumFile)).toEqual({});
    expect(readEnumOverride(enumKey, { file })).toMatchObject({ ok: false, reason: 'not-set' });
  });
});
