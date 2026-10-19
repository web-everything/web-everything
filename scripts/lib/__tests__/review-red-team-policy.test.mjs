import { describe, it, expect } from 'vitest';
import { redTeamOwedForAcceptedPr, redTeamOwedOnHead } from '../review-red-team-policy.mjs';

describe('redTeamOwedForAcceptedPr (caller verified live acceptance)', () => {
  const pinned = { read: { netBasis: { rev: 'a'.repeat(40) } } };
  it.each([
    [{ verdict: { verdict: 'accept' } }, true],
    [{ verdict: { verdict: 'needs-human' }, findings: pinned }, true],
    [{ findings: pinned }, false],
    [{ verdict: { verdict: 'needs-human' }, findings: { read: { netBasis: { rev: 'abc123' } } } }, false],
  ])('payload %j owes %s', (payload, owed) => {
    expect(redTeamOwedForAcceptedPr(payload)).toBe(owed);
  });
});

const card = { netChangedFiles: ['backlog/123-card.md'], netRenameSources: [] };
const code = { netChangedFiles: ['scripts/a.mjs'] };
describe('redTeamOwedOnHead attempt evidence', () => {
  it.each([
    [card, { attempted: true }, true, false],
    [card, { attempted: true, scheduled: true }, true, false],
    [card, { attempted: true, inFlight: true }, true, true],
    [card, { attempted: true, recorded: true }, true, true],
    [card, { attempted: true }, false, true],
    [card, { attempted: true, skipCardOnly: false }, true, true],
    [card, { attempted: true, skipCardOnly: true }, false, false],
    [code, { attempted: true, scheduled: false }, true, true],
    [null, { attempted: true }, true, true],
    [code, { scheduled: true }, true, true],
    [code, {}, true, false],
  ])('read %j evidence %j skip %s owes %s', (read, evidence, skipCardOnly, owed) => {
    expect(redTeamOwedOnHead({ read, evidence, skipCardOnly })).toBe(owed);
  });
});
