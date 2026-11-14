// @vitest-environment node
const osFixture = vi.hoisted(() => ({ userInfoFails: false }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, userInfo: (...args) => {
    if (osFixture.userInfoFails) throw new Error('uid not found');
    return actual.userInfo(...args);
  } };
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importGraph } from '../../operations/__tests__/import-graph.mjs';
import { CAPACITY_LEAVES, failClosedCapacity, readOperatorOverrides } from '../operator-override-reader.mjs';
import * as reader from '../operator-override-reader.mjs';
import * as store from '../operator-override-store.mjs';

let dir, file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operator-override-reader-'));
  file = join(dir, 'operator-overrides.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('lock-free operator override reader', () => {
  it('has only builtin dependencies and cannot reach the writer or drain lock', () => {
    const entry = resolve('scripts/lib/operator-override-reader.mjs');
    expect(importGraph(entry)).toEqual({
      files: [entry], external: ['node:fs', 'node:os', 'node:path'],
    });
  });

  it('keeps every reader export available through the existing store API', () => {
    for (const [key, value] of Object.entries(reader)) expect(store[key]).toBe(value);
  });

  it('treats a missing store as no override', () => {
    expect(readOperatorOverrides({ file })).toEqual({ readable: true, values: {} });
  });

  it('fails closed on malformed or unreadable evidence and tolerates a broken logger', () => {
    writeFileSync(file, '{');
    const log = () => { throw Error('logger unavailable'); };
    for (const path of [file, dir]) {
      expect(readOperatorOverrides({ file: path, log })).toEqual({ readable: false, values: {} });
    }
  });

  it('rejects oversized capacity values and invalidates their whole policy', () => {
    writeFileSync(file, JSON.stringify({
      'resourceGate.fixCap.floor': 2,
      'resourceGate.fixCap.ceiling': 13,
      'host.maxReviewDispatchPerTick': 3,
    }));
    expect(readOperatorOverrides({ file, log: () => {} })).toEqual({
      readable: true, values: { 'host.maxReviewDispatchPerTick': 3 }, invalidPolicies: ['resourceGate'],
    });
  });

  it('rejects guard leaves and keeps floor at or below ceiling', () => {
    writeFileSync(file, JSON.stringify({
      'reviewConcurrency.guard': false,
      'reviewConcurrency.maxLiveReviewRounds': 2,
      'resourceGate.fixCap.floor': 6,
      'resourceGate.fixCap.ceiling': 3,
    }));
    expect(readOperatorOverrides({ file, log: () => {} })).toEqual({
      readable: true,
      values: { 'resourceGate.fixCap.floor': 3, 'resourceGate.fixCap.ceiling': 3 },
      invalidPolicies: ['reviewConcurrency'],
    });
  });

  it('uses finite stricter fallbacks for every capacity direction', () => {
    for (const [key, { direction, failClosedFallback }] of Object.entries(CAPACITY_LEAVES)) {
      const log = () => {};
      expect(failClosedCapacity(key, NaN, { log })).toBe(failClosedFallback);
      const stricter = direction === 'cap' ? Math.min : Math.max;
      expect(failClosedCapacity(key, 4, { codeDefault: 2, log }))
        .toBe(stricter(4, 2, failClosedFallback));
    }
  });
});

describe('fixed host-wide store path', () => {
  it('ignores the HOME environment variable', async () => {
    const { userInfo } = await import('node:os');
    vi.stubEnv('HOME', join(dir, 'elsewhere'));
    try {
      expect(reader.operatorOverridesPath()).toBe(join(userInfo().homedir, '.claude', 'operator-overrides.json'));
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('unresolvable host account', () => {
  it('reads as unreadable (fail closed) instead of throwing when userInfo fails', () => {
    osFixture.userInfoFails = true;
    try {
      const log = vi.fn();
      expect(readOperatorOverrides({ log })).toEqual({ readable: false, values: {} });
      expect(log.mock.calls.flat().join(' ')).toContain('operator-db-unreadable store path');
    } finally { osFixture.userInfoFails = false; }
  });
});
