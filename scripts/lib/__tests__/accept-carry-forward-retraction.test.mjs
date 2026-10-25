import { describe, expect, it } from 'vitest';
import { isKnownMachineBody } from '../accept-carry-forward.mjs';
import { buildClearanceComment } from '../drain-merge-strategy.mjs';
import { buildLandingRetractionComment } from '../../operations/land-prevention-card.mjs';

const body = buildLandingRetractionComment({
  headSha: 'a'.repeat(40), session: 'prevention-card-test',
  result: { step: 'landing', reason: 'job failed' },
});
const trusted = { author: { login: 'web-everything[bot]' } };

describe('approval prevention retraction carry exemption', () => {
  it('uses the notice authorship rule, including body-only callers', () => {
    expect(isKnownMachineBody(body, trusted)).toBe(true);
    expect(isKnownMachineBody(body)).toBe(true);
    expect(isKnownMachineBody(body, {})).toBe(false);
    expect(isKnownMachineBody(body, { author: { login: 'mallory' } })).toBe(false);
  });

  it.each([
    ['oversized reason; fresh review required', 'x'.repeat(301)],
    ['multiline reason', 'landing:\njob failed'],
  ])('refuses a %s', (_name, why) => {
    expect(isKnownMachineBody(body.replace('landing: job failed', why), trusted)).toBe(false);
  });

  it('accepts a reason at the writer cap, including writer truncation', () => {
    expect(isKnownMachineBody(body.replace('landing: job failed', 'x'.repeat(300)), trusted)).toBe(true);
    expect(isKnownMachineBody(buildLandingRetractionComment({
      headSha: 'a'.repeat(40), session: 'prevention-card-test',
      result: { reason: 'x'.repeat(1000) },
    }), trusted)).toBe(true);
  });

  it('refuses a mismatched session or trailing newline', () => {
    expect(isKnownMachineBody(body.replace('`prevention-card-test`', '`other-job`'), trusted)).toBe(false);
    expect(isKnownMachineBody(`${body}\n`, trusted)).toBe(false);
  });
});

describe('drain enqueue clearance envelope', () => {
  const head = 'a'.repeat(40);
  const exact = buildClearanceComment(head);
  it('accepts only the exact builder envelope', () => {
    expect(isKnownMachineBody(exact)).toBe(true);
    expect(isKnownMachineBody(`${exact}\nextra prose`)).toBe(false);
    expect(isKnownMachineBody(`prose\n${exact}`)).toBe(false);
    expect(isKnownMachineBody(`<!-- we-drain-enqueue-clearance head=${head} -->\nDrain enqueue clearance`)).toBe(false);
    expect(isKnownMachineBody(exact.replace(head, 'not-a-sha'))).toBe(false);
  });
});
