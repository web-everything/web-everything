/** @file Hermetic drain classification of unreadable paged listings. */
import { it, expect } from 'vitest';
import { describeGhListError } from '../../merge-ai-prs.mjs';
import { PrListUnreadableError } from '../pr-list-paged.mjs';

it('classifies a paged 504 as unreadable and retryable', () => {
  const error = new PrListUnreadableError({ repo: 'o/r', stage: 'page', page: 2,
    cause: { stderr: 'HTTP 504: 504 Gateway Timeout' } });
  expect(describeGhListError(error)).toMatchObject({ kind: 'unreadable', retryable: true,
    text: error.message, hint: expect.stringContaining('never read as 0 candidates') });
});

it('caps unreadable messages at the first line and 400 characters', () => {
  expect(describeGhListError({ unreadable: true, message: 'x'.repeat(500) + '\nother' }).text)
    .toBe('x'.repeat(400));
});
