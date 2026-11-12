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

describe('review-verdict-carried envelope around a non-blocking advisory is a machine note', () => {
  const NEW = '3a35250ae6aadf6fe7dee8b2420c929e3482c00c';
  const PATCH = 'f24d967614721e68a1bb02a2560bff7f83b38cd6';
  const marker = (to = NEW) => `<!-- review-verdict-carried from=${OLD} to=${to} patch-id=${PATCH} -->`;
  const sentence = 'Review verdict carried across an identical contribution.';
  // The carry writer re-binds the advisory marker to the new head but keeps the original "Head" label.
  const carriedAdvisory = (rev = NEW) => advisory().replace(`rev=${OLD}`, `rev=${rev}`);
  const envelope = (inner, to = NEW) => `${marker(to)}\n${sentence}\n${inner}`;

  it('accepts marker + sentence + advisory bound to the carried-to head', () => {
    expect(isKnownMachineBody(envelope(carriedAdvisory()), trusted)).toBe(true);
  });
  it('accepts marker + sentence alone', () => {
    expect(isKnownMachineBody(`${marker()}\n${sentence}`, trusted)).toBe(true);
  });
  it('refuses an untrusted author', () => {
    expect(isKnownMachineBody(envelope(carriedAdvisory()), { author: { login: 'mallory' } })).toBe(false);
  });
  it('refuses when the advisory is bound to a head other than the carried-to head', () => {
    expect(isKnownMachineBody(envelope(carriedAdvisory(OLD)), trusted)).toBe(false);
  });
  it('refuses when the shown Head label is not the carried-from head', () => {
    expect(isKnownMachineBody(envelope(carriedAdvisory().replace(`Head \`${OLD.slice(0, 12)}\``, 'Head `aaaaaaaaaaaa`')), trusted)).toBe(false);
  });
  it('refuses an appended hold in the envelope', () => {
    expect(isKnownMachineBody(`${envelope(carriedAdvisory())}\n\n🔁 review — changes requested`, trusted)).toBe(false);
    expect(isKnownMachineBody(`${marker()}\n${sentence}\nplease do not merge`, trusted)).toBe(false);
  });
  it('refuses a blocking advisory inside the envelope', () => {
    const blocking = carriedAdvisory().replace('[not confirmed]', '[confirmed]').replace('0 confirmed', '1 confirmed');
    expect(isKnownMachineBody(envelope(blocking), trusted)).toBe(false);
  });
});


describe('gate-prefixed carried advisory after acceptance (PR 6584)', () => {
  const sha = 'a'.repeat(40);
  const body = (impact = 'degraded', rev = sha) => [
    `<!-- we:red-team-gate pr=6584 rev=${sha} outcome=card-queued result=${'d'.repeat(16)} -->`,
    `<!-- review-verdict-carried from=${OLD} to=${sha} patch-id=${'b'.repeat(40)} -->`,
    'Review verdict carried across an identical contribution.',
    `<!-- we:red-team-advisory pr=6584 rev=${rev} -->`,
    "### Post-accept red team \u2014 1 possible break(s), 1 confirmed by Claude's re-check",
    '',
    'Advisory only: this comment changes no label itself; the red-team gate (setting `redTeam.confirmedBreaks`) sends a confirmed broken break back to the fixer. '
      + `Head \`${OLD.slice(0, 12)}\` \u00b7 red team codex/gpt-6.1-sol \u00b7 re-check ok \u00b7 recorded verdict \`changes\`.`,
    '',
    `1. [**confirmed**] (edge-case, ${impact}) \`scripts/x.mjs:253\` \u2014 Unreachable later effects can block replay`,
    '   - Class: live-reproduced \u2192 fix-now (basis: probe)',
    '   - Also class: correctness-in-normal-use',
    '   - Scenario: a scenario',
    '   - Re-check: demonstrated break',
    '   - Files read: scripts/x.mjs',
    '',
    "A confirmed break is recorded as a miss for the accepting review and for the builder's model.",
  ].join('\n');
  const later = (text, author = trusted) => latestAcceptRecord([
    { ...trusted, body: `✅ review — accepted\n<!-- reviewed-sha: ${sha} -->` },
    { ...author, body: text },
  ]).laterVerdict;
  it('keeps acceptance for a confirmed degraded finding', () => expect(later(body())).toBe(false));
  it('holds for a confirmed broken finding', () => expect(later(body('broken'))).toBe(true));
  it('holds for appended prose', () => expect(later(body() + '\nPlease hold this change.')).toBe(true));
  it('holds for an untrusted author', () => expect(later(body(), { author: { login: 'mallory' } })).toBe(true));
  it('holds for a mismatched advisory sha', () => expect(later(body('degraded', OLD))).toBe(true));
});
