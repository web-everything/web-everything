import { describe, it, expect } from 'vitest';
import { cloneDispatchBlock, decideRecloneBlock } from '../daemon-self-sync.mjs';

const marker = value => ({ read: () => value });
const base = { root: '/clone', knownIdentity: 'id-1', cloneIdentity: () => 'id-1', readState: () => ({}), marker: marker(null) };

describe('cloneDispatchBlock (shared gate for the ci-heal child)', () => {
  it('passes a healthy, unchanged clone', () => expect(cloneDispatchBlock(base)).toBeNull());
  it('blocks a quarantined clone', () => expect(cloneDispatchBlock({ ...base, readState: () => ({ quarantine: { at: 1 } }) })).toBe('quarantine'));
  it('blocks a replaced checkout with no concluded rebuild', () => {
    expect(cloneDispatchBlock({ ...base, cloneIdentity: () => 'id-2' })).toBe('reclone');
  });
  it('blocks an unconcluded re-clone marker', () => {
    expect(cloneDispatchBlock({ ...base, marker: marker({ identity: 'id-1', concluded: false }) })).toBe('reclone');
  });
  it('fails closed when state cannot be read', () => {
    expect(cloneDispatchBlock({ ...base, readState: () => { throw new Error('x'); } })).toBe('unreadable');
  });
  it('allows a replaced checkout whose rebuild concluded', () => {
    expect(decideRecloneBlock({ marker: { identity: 'id-2', concluded: true }, idNow: 'id-2', knownIdentity: 'id-1' }))
      .toEqual({ blocked: false, adopt: 'id-2' });
  });
});
