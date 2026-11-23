import { it, expect } from 'vitest';
import { redactSecrets } from '../ci-heal-mark.mjs';

it('redacts the entire Digest authorization header value', () => {
  expect(redactSecrets('Authorization: Digest username="alice", response="response-value", nonce="nonce-value"\nnext line'))
    .toBe('Authorization=[redacted]\nnext line');
});

it('consumes adjacent quoted password segments', () => {
  expect(redactSecrets('password="part-one""part-two" next=value'))
    .toBe('password=[redacted] next=value');
});

it.each([
  ...['ghp_', 'gho_', 'ghs_', 'github_pat_'].map(prefix => prefix + 'a'.repeat(24)),
  'Bearer x', 'Basic x',
  'https://user:pw@host',
  'https://x-access-token:ghs_' + 'a'.repeat(24) + '@host',
])('redacts credential shape %s', credential => {
  const result = redactSecrets(credential);
  expect(result).toContain('[redacted]');
  expect(result).not.toContain(credential);
});
