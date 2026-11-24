/** @file forge.capabilities: native/emulated/unsupported per interface; unsupported routes to a person. */
import { describe, it, expect } from 'vitest';
import { requireCapability } from '../capabilities.mjs';
import { githubCapabilities } from '../github/capabilities.mjs';

describe('forge.capabilities', () => {
  it('github declares change-events and changes native', () => {
    expect(githubCapabilities()['change-events'].support).toBe('native');
    expect(githubCapabilities().changes.support).toBe('native');
  });
  it('change-events unsupported routes to a person, never a silent skip', () => {
    const r = requireCapability({ 'change-events': { support: 'unsupported' } }, 'change-events');
    expect(r.ok).toBe(false);
    expect(r.route).toBe('person');
    expect(r.event).toMatchObject({ kind: 'capability-unsupported', interface: 'change-events' });
    expect(requireCapability({}, 'change-events').route).toBe('person');
    expect(requireCapability({ 'change-events': { support: 'emulated' } }, 'change-events').ok).toBe(true);
  });
});
