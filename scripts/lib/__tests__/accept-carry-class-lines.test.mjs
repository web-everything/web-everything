import { describe, expect, it } from 'vitest';
import { isKnownMachineBody, latestAcceptRecord } from '../accept-carry-forward.mjs';

const OLD = '1c4c86cbf17231dfaba189161ff36e6c8e8dde7d';
const trusted = { author: { login: 'web-everything[bot]' } };

// The shape review-extra-seats.mjs renders for an UNCONFIRMED finding that carries classification lines.
const advisory = (extra = '') => [
  `<!-- we:red-team-advisory pr=6549 rev=${OLD} -->`,
  "### Post-accept red team — 1 possible break(s), 0 confirmed by Claude's re-check",
  '',
  'Advisory only: this comment changes no label itself; the red-team gate (setting `redTeam.confirmedBreaks`) sends a confirmed broken break back to the fixer. '
    + `Head \`${OLD.slice(0, 12)}\` · red team codex/gpt-6.1-sol · re-check ok · recorded verdict \`accept\`.`,
  '',
  '1. [not confirmed] (edge-case, broken) `scripts/lib/x.mjs:192` — a summary',
  '   - Class: live-reproduced → fix-now (basis: executed the module)',
  '   - Also class: theoretical-race',
  ...(extra ? [extra] : []),
  '   - Scenario: a scenario',
  '   - Re-check: insufficient evidence',
  '   - Files read: scripts/lib/x.mjs',
  '',
  "A confirmed break is recorded as a miss for the accepting review and for the builder's model.",
].join('\n');

describe('red-team advisory with Class / Also class lines is a machine note, not a later hold', () => {
  it('treats the rendered Class and Also class sublines as non-blocking for a trusted author', () => {
    expect(isKnownMachineBody(advisory(), trusted)).toBe(true);
  });
  it('still refuses an untrusted author', () => {
    expect(isKnownMachineBody(advisory(), { author: { login: 'mallory' } })).toBe(false);
  });
  it('still refuses an unknown subline', () => {
    expect(isKnownMachineBody(advisory('   - Verdict: ship it'), trusted)).toBe(false);
  });
  it('still refuses a malformed Class line', () => {
    expect(isKnownMachineBody(advisory().replace('live-reproduced → fix-now', 'live-reproduced'), trusted)).toBe(false);
  });
  it('does not make the accept on that head read as superseded', () => {
    const accept = { author: { login: 'web-everything[bot]' }, createdAt: '2026-11-08T22:00:00Z',
      body: `✅ review — accepted\n<!-- reviewed-sha: ${OLD} -->` };
    const rec = latestAcceptRecord([accept, { ...trusted, createdAt: '2026-11-08T22:05:00Z', body: advisory() }]);
    expect(rec?.sha).toBe(OLD);
    expect(rec.laterVerdict).toBe(false);
  });
});
