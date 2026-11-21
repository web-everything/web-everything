import { describe, expect, it } from 'vitest';
import { assertHotPatchSingleton } from '../../hot-patch.mjs';
import { urgentLoadIdentity } from '../urgent-verify-marker.mjs';

const sha = '82f6986f81788f9234797e356f82a661703e637a';
const load = { type: 'prototype-load.urgent', at: '2026-11-20T17:55:30-05:00', trackingId: 'track-7239', ref: `hotpatch/${sha}`, sha,
  clone: '/clone/review', registration: { clone: '/clone/review', ref: `hotpatch/${sha}`, sha }, hotPatch: { pr: 7239 } };
const receipt = (status, extra = {}) => ({ id: urgentLoadIdentity(load), ref: load.ref, sha, status, at: '2026-11-20T18:09:07-05:00', ...extra });

describe('hot-patch singleton', () => {
  it('does not block on a legacy load settled unloaded-adopted without a registration-completion record', () => {
    expect(() => assertHotPatchSingleton([load], [receipt('unloaded-adopted')])).not.toThrow();
  });
  it('still blocks a registered load that has no terminal settlement receipt', () => {
    expect(() => assertHotPatchSingleton([load], [])).toThrow('unsettled hot-patch load exists');
    expect(() => assertHotPatchSingleton([load], [receipt('unload-decision')])).toThrow('unsettled hot-patch load exists');
    expect(() => assertHotPatchSingleton([load], [receipt('unloaded-pending-adoption')])).toThrow('unsettled hot-patch load exists');
  });
  it('keeps settled-unregistered strict: it needs verified ancestry and a completion record', () => {
    expect(() => assertHotPatchSingleton([load], [receipt('settled-unregistered', { ancestryVerified: true, registrationComplete: true })])).toThrow('unsettled hot-patch load exists');
  });
});
