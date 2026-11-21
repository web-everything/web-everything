// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeOperatorOverride, clearOperatorOverride, readOperatorOverrides, ENUM_LEAVES } from '../operator-override-store.mjs';
import { readStrictOverride, readEnumOverride } from '../capacity-leaf.mjs';

let dir, file;
const enumKey = 'ciHeal.loop';
const numericKey = 'reviewConcurrency.maxLiveReviewRounds';
const base = { reason: 'enum override test', actor: 'operator' };
const set = (key, value) => writeOperatorOverride({ file: file, key, value, ...base });
const stored = () => JSON.parse(readFileSync(file, 'utf8'));
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'operator-enum-')); file = join(dir, 'operator-overrides.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('operator override enum leaves', () => {
  it('declares ciHeal.loop as an on/off enum', () => {
    expect(ENUM_LEAVES[enumKey]).toEqual(['off', 'on']);
  });

  it('stores an allowed enum value, audits it, and reads it back with the numeric store still valid', () => {
    expect(set(enumKey, 'on')).toMatchObject({ key: enumKey, old: null, new: 'on', source: 'operator-cli' });
    expect(stored()).toEqual({ [enumKey]: 'on' });
    expect(readEnumOverride(enumKey, { file })).toEqual({ ok: true, value: 'on' });
    const row = JSON.parse(readFileSync(join(dir, 'operator-overrides.log.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ key: enumKey, old: null, new: 'on', actor: 'operator' });
  });

  it('keeps numeric capacity leaves readable beside an enum leaf, and keeps enums out of the numeric values', () => {
    set(numericKey, 7);
    set(enumKey, 'off');
    expect(stored()).toEqual({ [numericKey]: 7, [enumKey]: 'off' });
    expect(readStrictOverride(numericKey, { file })).toEqual({ ok: true, value: 7 });
    const read = readOperatorOverrides({ file, log: () => {} });
    expect(read.values).toEqual({ [numericKey]: 7 });
    expect(read.invalidPolicies).toBeUndefined();
  });

  it('refuses a value outside the declared enum (fail closed), leaving no store and no audit', () => {
    for (const bad of ['maybe', 'ON', '', 1, true, null]) expect(() => set(enumKey, bad)).toThrow(/operator-override/);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(dir, 'operator-overrides.log.jsonl'))).toBe(false);
  });

  it('refuses an unknown key even with an on/off value', () => {
    expect(() => set('mergeQueue.refreshOnStaleMergeGate', 'on')).toThrow(/signed-attestation/);
    expect(existsSync(file)).toBe(false);
  });

  it('numeric keys are unchanged: a string is refused, a number in range is stored', () => {
    expect(() => set(numericKey, 'on')).toThrow(/operator-override/);
    expect(() => set(numericKey, 17)).toThrow(/operator-override/);
    expect(existsSync(file)).toBe(false);
    set(numericKey, 5);
    expect(stored()).toEqual({ [numericKey]: 5 });
  });

  it('an enum key cannot hold a number', () => {
    expect(() => set(enumKey, 1)).toThrow(/operator-override/);
  });

  it('a hand-edited store with a bad enum value is wholly refused by readers', () => {
    set(enumKey, 'on');
    writeOperatorOverrideRaw(file, '{"ciHeal.loop":"maybe"}');
    expect(readEnumOverride(enumKey, { file }).ok).toBe(false);
  });

  it('clear removes the enum key', () => {
    set(enumKey, 'on');
    clearOperatorOverride({ file, key: enumKey, ...base });
    expect(stored()).toEqual({});
    expect(readEnumOverride(enumKey, { file })).toMatchObject({ ok: false });
  });
});

import { writeFileSync } from 'node:fs';
function writeOperatorOverrideRaw(path, text) { writeFileSync(path, text); }
