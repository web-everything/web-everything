/**
 * @file scripts/lib/__tests__/marker-authorship.test.mjs
 * @description Pins the shared trusted-author gate (#3383) every durable conveyor marker counter now runs a PR
 *   comment through before matching its leading line: {@link isAutomationAuthored}, {@link isOperatorAuthored},
 *   {@link isTrustedMarkerAuthor}. See `we:scripts/lib/marker-authorship.mjs`'s own header for the full incident
 *   (an adversarial coverage review, 2026-09-24, found every marker counter had NO author check at all).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isAutomationAuthored, isOperatorAuthored, isTrustedMarkerAuthor,
  countTrustedLeadingMarker, AUTOMATION_LOGINS, OPERATOR_LOGINS,
} from '../marker-authorship.mjs';

describe('isAutomationAuthored — author.login against AUTOMATION_LOGINS, or GitHub\'s viewerDidAuthor', () => {
  it('recognizes the real production login shape observed live (author.login, no viewerDidAuthor)', () => {
    expect(isAutomationAuthored({ author: { login: 'web-everything' } })).toBe(true);
  });

  it('is case-insensitive on the login', () => {
    expect(isAutomationAuthored({ author: { login: 'WEB-EVERYTHING' } })).toBe(true);
  });

  it('also recognizes the REST/App-bot login shape (web-everything[bot])', () => {
    expect(isAutomationAuthored({ author: { login: 'web-everything[bot]' } })).toBe(true);
  });

  it('reads REST user.login with the same exact trust list and case normalization', () => {
    expect(isAutomationAuthored({ user: { login: 'WEB-EVERYTHING[BOT]' } })).toBe(true);
    expect(isTrustedMarkerAuthor({ user: { login: 'chalbert' } })).toBe(true);
    expect(isTrustedMarkerAuthor({ user: { login: 'mallory[bot]' } })).toBe(false);
    expect(isTrustedMarkerAuthor({ author: { login: 'mallory' }, user: { login: 'web-everything[bot]' } })).toBe(false);
    expect(isTrustedMarkerAuthor({ user: { login: 123 } })).toBe(false);
  });

  it('accepts viewerDidAuthor:true as an ADDITIONAL path, even with a different login', () => {
    expect(isAutomationAuthored({ viewerDidAuthor: true, author: { login: 'someone-else' } })).toBe(true);
  });

  it('a human (the repo operator) is not automation-authored', () => {
    expect(isAutomationAuthored({ author: { login: 'chalbert' } })).toBe(false);
  });

  it('a random commenter is not automation-authored', () => {
    expect(isAutomationAuthored({ author: { login: 'mallory' } })).toBe(false);
  });

  it('fails closed on malformed / missing shapes', () => {
    expect(isAutomationAuthored(null)).toBe(false);
    expect(isAutomationAuthored(undefined)).toBe(false);
    expect(isAutomationAuthored('a bare string')).toBe(false);
    expect(isAutomationAuthored({})).toBe(false);
    expect(isAutomationAuthored({ author: {} })).toBe(false);
    expect(isAutomationAuthored({ viewerDidAuthor: false, author: { login: 'chalbert' } })).toBe(false);
  });
});

describe('isOperatorAuthored — author.login against OPERATOR_LOGINS only', () => {
  it('recognizes the repo operator (default: chalbert)', () => {
    expect(isOperatorAuthored({ author: { login: 'chalbert' } })).toBe(true);
    expect(isOperatorAuthored({ author: { login: 'CHALBERT' } })).toBe(true);
  });

  it('does NOT accept viewerDidAuthor alone — that path is automation-only', () => {
    expect(isOperatorAuthored({ viewerDidAuthor: true, author: { login: 'someone-else' } })).toBe(false);
  });

  it('a random commenter, or automation itself, is not operator-authored', () => {
    expect(isOperatorAuthored({ author: { login: 'mallory' } })).toBe(false);
    expect(isOperatorAuthored({ author: { login: 'web-everything' } })).toBe(false);
  });

  it('fails closed on malformed / missing shapes', () => {
    expect(isOperatorAuthored(null)).toBe(false);
    expect(isOperatorAuthored('a bare string')).toBe(false);
    expect(isOperatorAuthored({})).toBe(false);
  });
});

describe('isTrustedMarkerAuthor — automation OR operator, nothing else (the transition-case rule)', () => {
  it('trusts automation', () => {
    expect(isTrustedMarkerAuthor({ author: { login: 'web-everything' } })).toBe(true);
  });

  it('trusts the operator — INCLUDING a daemon that fell back to the operator\'s own personal credential', () => {
    // 2026-09-24: this repo's own automation posted several hours of comments under the operator's personal
    // login while its own credential was unavailable. Ratified rule: operator logins are trusted for EVERY
    // marker (not narrowed by which script happened to be posting), exactly as they already are trusted for
    // every write these scripts make. A random commenter is never trusted, however sympathetic the text reads.
    expect(isTrustedMarkerAuthor({ author: { login: 'chalbert' } })).toBe(true);
  });

  it('never trusts a random commenter — the vulnerability this item closes', () => {
    expect(isTrustedMarkerAuthor({ author: { login: 'mallory' } })).toBe(false);
  });

  it('never trusts a comment with no author information at all (fail closed)', () => {
    expect(isTrustedMarkerAuthor({ body: 'x' })).toBe(false);
    expect(isTrustedMarkerAuthor('a bare string')).toBe(false);
    expect(isTrustedMarkerAuthor(null)).toBe(false);
  });
});

describe('countTrustedLeadingMarker — the ONE shared leading-line + trusted-author count', () => {
  const MARKER = '🔧 test marker';

  it('counts only leading-line matches from a trusted author', () => {
    const comments = [
      { body: `${MARKER}\nreal`, author: { login: 'web-everything' } },
      { body: `${MARKER}\nforged`, author: { login: 'mallory' } },
      { body: `> ${MARKER}\nquoted`, author: { login: 'web-everything' } },
      { body: 'unrelated', author: { login: 'web-everything' } },
    ];
    expect(countTrustedLeadingMarker(comments, MARKER)).toBe(1);
  });

  it('tolerates non-array / empty input', () => {
    expect(countTrustedLeadingMarker(null, MARKER)).toBe(0);
    expect(countTrustedLeadingMarker(undefined, MARKER)).toBe(0);
    expect(countTrustedLeadingMarker([], MARKER)).toBe(0);
  });
});

describe('env overrides (WE_AUTOMATION_LOGINS / WE_OPERATOR_LOGINS) — module-load-time only, documented here', () => {
  // AUTOMATION_LOGINS / OPERATOR_LOGINS are frozen at import time (matching
  // `we:scripts/conveyor/stand-down.mjs#AUTOMATION_LOGINS`'s own discipline), so this pins the DEFAULTS observed
  // live rather than re-importing under a mutated env (which would require an isolated module registry).
  it('the default automation logins are the ones observed live, 2026-09-24', () => {
    expect(AUTOMATION_LOGINS).toContain('web-everything');
  });

  it('the default operator login is the repo owner observed live, 2026-09-24', () => {
    expect(OPERATOR_LOGINS).toContain('chalbert');
  });
});

describe('judge may card a pre-existing break with evidence (judge path v2)', async () => {
  const { assertJudgeAuthority, JUDGE_ACTOR } = await import('../marker-authorship.mjs');
  const policy = { value: { enabled: true, actor: JUDGE_ACTOR } };
  const sha = 'a'.repeat(40);
  const evidence = { mainSha: sha, probe: 'node probe.mjs', mainResult: 'null', prResult: 'null' };
  const read = (over = {}) => ({ judgeActorPolicy: policy, isMainAncestor: (s) => s === sha, ...over });
  const card = (over = {}) => ({ actor: JUDGE_ACTOR, ruling: 'card', preExisting: evidence, ...over });

  it('judge may card a pre-existing break with evidence', () => {
    expect(() => assertJudgeAuthority(read(), card())).not.toThrow();
  });
  it('refuses a judge card without evidence', () => {
    expect(() => assertJudgeAuthority(read(), card({ preExisting: undefined }))).toThrow(/operator-only|pre-existing/);
  });
  it.each(['not-real', 'accepted', 'clear-human'])('still refuses judge %s even with evidence', (ruling) => {
    expect(() => assertJudgeAuthority(read(), card({ ruling }))).toThrow(/operator-only/);
  });
  it('refuses when main and PR results differ', () => {
    expect(() => assertJudgeAuthority(read(), card({ preExisting: { ...evidence, prResult: 'key' } }))).toThrow(/pre-existing/);
  });
  it('refuses incomplete evidence', () => {
    expect(() => assertJudgeAuthority(read(), card({ preExisting: { ...evidence, probe: '' } }))).toThrow(/pre-existing/);
  });
  it('refuses a mainSha that is not an ancestor of origin/main', () => {
    expect(() => assertJudgeAuthority(read({ isMainAncestor: () => false }), card())).toThrow(/ancestor/);
  });
  it('fails closed when no ancestor check is supplied', () => {
    expect(() => assertJudgeAuthority({ judgeActorPolicy: policy }, card())).toThrow(/ancestor/);
  });
  it('refuses a disabled judge or supersession even with evidence', () => {
    expect(() => assertJudgeAuthority(read({ judgeActorPolicy: { value: { enabled: false, actor: JUDGE_ACTOR } } }), card())).toThrow(/disabled/);
    expect(() => assertJudgeAuthority(read(), card({ supersedes: 'x' }))).toThrow(/supersede/);
  });
});
