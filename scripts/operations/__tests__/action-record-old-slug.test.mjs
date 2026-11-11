import { describe, it, expect } from 'vitest';
import { normalizeRepo, actionResource } from '../action-record.mjs';

describe('normalizeRepo renamed owner alias', () => {
  it('maps the pre-transfer chalbert owner to the canonical constellation slug', () => {
    expect(normalizeRepo('chalbert/web-everything')).toBe('web-everything/web-everything');
    expect(actionResource('chalbert/web-everything', { type: 'pr', id: 6378 })).toBe('web-everything/web-everything#pr:6378');
  });
  it('fails closed on other unknown owners and on chalbert for unknown repos', () => {
    expect(() => normalizeRepo('evil/web-everything')).toThrow(/Unknown coordination repo/);
    expect(() => normalizeRepo('chalbert/not-a-repo')).toThrow(/Unknown coordination repo/);
  });
});
