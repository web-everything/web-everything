// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decideConflictReassert, resolveConflictReassertSettings,
  CONFLICT_REASSERT_ENV, CONFLICT_REASSERT_OFF,
} from '../conflict-reassert-rule.mjs';
import { watchParkedPrConflicts } from '../parked-pr-conflict-watch.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-round-count.mjs';
import { STAND_DOWN_MARKER, WATCHER_STAND_DOWN_ACTOR } from '../stand-down.mjs';

const labels = ['review:human', 'merge-status:conflicting'];
const fixture = JSON.parse(readFileSync(new URL('./fixtures/conflict-reassert/pr4481-2026-10-09.json', import.meta.url), 'utf8'));
const now = Date.parse(fixture.capturedAt);
const unexpected = () => { throw new Error('Unexpected side effect in conflict replay'); };

function replay(overrides = {}) {
  const findings = [];
  const results = watchParkedPrConflicts({
    listPrs: () => [fixture.pr], listPrComments: () => fixture.comments,
    now, dryRun: false, conflictReassertSettings: { reviewHuman: true },
    provider: { currentRepo: () => 'web-everything/web-everything', setLabels: unexpected, postComment: unexpected, ensureLabel: unexpected },
    postFinding: (call) => findings.push(call),
    postStandDown: unexpected, postRearm: unexpected, postSupersedeComment: unexpected,
    listAgents: () => [], listPrFiles: () => ['docs/agent/platform-decisions.md'],
    listPrPatches: () => null, listMainStatutePatches: () => null,
    computeConflictingPaths: () => ['docs/agent/platform-decisions.md'], computeConflictDisposition: () => 'conflicting',
    labelAgeMs: unexpected, labelRemovedAtMs: unexpected, attemptMechanicalRebase: unexpected,
    ...overrides,
  });
  for (const result of results) expect(result.error).toBeUndefined();
  return { results, findings };
}

describe('decideConflictReassert', () => {
  for (const [shape, encode] of [['strings', (names) => names], ['objects', (names) => names.map((name) => ({ name }))]]) {
    describe(`labels as ${shape}`, () => {
      const decide = (names, extra = {}) => decideConflictReassert({
        labels: encode(names), hasLiveWatcherMarker: false, settings: { reviewHuman: true }, ...extra,
      });
      it('re-asserts an idle review:human conflict', () => {
        expect(decide(labels).reassert).toBe(true);
      });
      const exclusions = [
        ['no human hold', ['merge-status:conflicting'], {}, 'not review:human (the #2793 idle path owns it)'],
        ['no conflict label', ['review:human'], {}, 'no merge-status:conflicting label yet (fresh detection owns it)'],
        ['live bounce', [...labels, 'review:changes'], {}, 'a review:changes bounce is already live'],
        ['live watcher marker', labels, { hasLiveWatcherMarker: true }, "the watch's own stand-down marker stands (statute recheck owns it)"],
        ['any stand-down on the thread', labels, { hasStandDown: true }, 'a stand-down is on the thread (a person owns it)'],
        ['setting off', labels, { settings: CONFLICT_REASSERT_OFF }, 'conflictReassert.reviewHuman is off'],
      ];
      it.each(exclusions)('refuses: %s', (_name, names, extra, why) => {
        expect(decide(names, extra)).toEqual({ reassert: false, why });
      });
      it('gives each exclusion a distinct reason', () => {
        const reasons = exclusions.map(([, names, extra]) => decide(names, extra).why);
        expect(new Set(reasons).size).toBe(exclusions.length);
      });
      it('defaults to the same off policy when settings are omitted', () => {
        expect(decideConflictReassert({ labels: encode(labels), hasLiveWatcherMarker: false }))
          .toEqual({ reassert: false, why: 'conflictReassert.reviewHuman is off' });
      });
    });
  }
});

describe('resolveConflictReassertSettings', () => {
  it.each([
    ['file on', '{"conflictReassert":{"reviewHuman":"on"}}', {}, true],
    ['file off', '{"conflictReassert":{"reviewHuman":"off"}}', {}, false],
    ['malformed JSON', '{', {}, false],
    ['missing key', '{"conflictReassert":{}}', {}, false],
    ['env on beats file off', '{"conflictReassert":{"reviewHuman":"off"}}', { [CONFLICT_REASSERT_ENV.reviewHuman]: 'on' }, true],
    ['env off beats file on', '{"conflictReassert":{"reviewHuman":"on"}}', { [CONFLICT_REASSERT_ENV.reviewHuman]: 'off' }, false],
    // An explicit-but-unparseable override fails OFF (acceptance A2) — it never falls through to the file's 'on'.
    ['garbage env fails off over file on', '{"conflictReassert":{"reviewHuman":"on"}}', { [CONFLICT_REASSERT_ENV.reviewHuman]: 'garbage' }, false],
    ['empty env fails off over file on', '{"conflictReassert":{"reviewHuman":"on"}}', { [CONFLICT_REASSERT_ENV.reviewHuman]: '' }, false],
    ['whitespace env fails off over file on', '{"conflictReassert":{"reviewHuman":"on"}}', { [CONFLICT_REASSERT_ENV.reviewHuman]: '  ' }, false],
    ['near-miss env fails off over file on', '{"conflictReassert":{"reviewHuman":"on"}}', { [CONFLICT_REASSERT_ENV.reviewHuman]: 'onn' }, false],
    ['garbage env with file off stays off', '{"conflictReassert":{"reviewHuman":"off"}}', { [CONFLICT_REASSERT_ENV.reviewHuman]: 'garbage' }, false],
    ['absent env uses file on', '{"conflictReassert":{"reviewHuman":"on"}}', {}, true],
    ['undefined env value uses file on', '{"conflictReassert":{"reviewHuman":"on"}}', { [CONFLICT_REASSERT_ENV.reviewHuman]: undefined }, true],
    ['valid env mixed case on beats file off', '{"conflictReassert":{"reviewHuman":"off"}}', { [CONFLICT_REASSERT_ENV.reviewHuman]: ' TRUE ' }, true],
    ['garbage file value is off', '{"conflictReassert":{"reviewHuman":"garbage"}}', {}, false],
  ])('%s', (_name, contents, env, expected) => {
    const reads = [];
    expect(resolveConflictReassertSettings(env, {
      path: '/injected/settings.json', read: (...args) => { reads.push(args); return contents; },
    })).toEqual({ reviewHuman: expected });
    expect(reads).toEqual([['/injected/settings.json', 'utf8']]);
  });
  it('fails off when the file is missing', () => {
    expect(resolveConflictReassertSettings({}, { read: () => { throw new Error('ENOENT'); } }))
      .toEqual({ reviewHuman: false });
  });
  it('enables the committed setting with an empty env', () => {
    expect(resolveConflictReassertSettings({})).toEqual({ reviewHuman: true });
  });
});

describe('PR #4481 captured conflict replay', () => {
  it('RED: reproduces the live skip with the setting off', () => {
    expect(replay({ conflictReassertSettings: { reviewHuman: false } })).toEqual({ results: [], findings: [] });
  });
  it('GREEN: re-asserts exactly one finding with the setting on', () => {
    const { results, findings } = replay();
    expect(results).toHaveLength(1);
    expect(results[0].num).toBe(4481);
    expect(results[0].routedTo).toMatch(/review-human/);
    expect(results[0].routedTo).toMatch(/re-asserted/);
    expect(findings).toHaveLength(1);
    expect(findings[0].pr.number).toBe(4481);
    expect(findings[0].repo).toBe('web-everything/web-everything');
  });
  it('does not re-assert twice in the same round', () => {
    const finding = fixture.comments.find((comment) => comment.createdAt === '2026-10-08T21:59:11Z');
    expect(finding).toBeDefined();
    const { results, findings } = replay({ listPrComments: () => [
      ...fixture.comments, { ...finding, createdAt: new Date(now - 5 * 60_000).toISOString() },
    ] });
    expect(findings).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0].routedTo).toMatch(/already re-asserted this round/);
  });
  it('honors the three-round cap without posting the direct cap note', () => {
    const comments = [...fixture.comments, ...Array.from({ length: 3 }, (_, i) => ({
      body: CONFLICT_FIX_COMMENT_MARKER, author: { login: 'web-everything' },
      createdAt: new Date(now - (3 - i) * 60_000).toISOString(),
    }))];
    const { results, findings } = replay({ dryRun: true, listPrComments: () => comments });
    expect(findings).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0].routedTo).toMatch(/cap-exhausted/);
  });
  it('keeps a live watcher stand-down on the statute recheck path', () => {
    const { results, findings } = replay({ listPrComments: () => [...fixture.comments, {
      body: `${STAND_DOWN_MARKER}\n\n**Who:** ${WATCHER_STAND_DOWN_ACTOR}`,
      author: { login: 'web-everything' }, createdAt: new Date(now - 60_000).toISOString(),
    }] });
    expect(results).toHaveLength(1);
    expect(results[0].routedTo).toBe('stand-down (unchanged)');
    expect(results[0].routedTo).not.toMatch(/xkugvzd/);
    expect(findings).toEqual([]);
  });
  it("never re-asserts over a fix agent's own judgment stand-down", () => {
    const { results, findings } = replay({ listPrComments: () => [...fixture.comments, {
      body: `${STAND_DOWN_MARKER}\n\n**Who:** fix-4481`,
      author: { login: 'web-everything' }, createdAt: new Date(now - 60_000).toISOString(),
    }] });
    expect(results).toEqual([]);
    expect(findings).toEqual([]);
  });
  it('an in-process caller that passes no setting gets today\'s behaviour (off)', () => {
    const { results, findings } = replay({ conflictReassertSettings: undefined });
    expect(results).toEqual([]);
    expect(findings).toEqual([]);
  });
  describe('an unreadable comment thread fails closed (no guard evidence is not "no guard applies")', () => {
    // A stand-down and a spent round cap are both on the thread; a failed read must not erase them.
    const guarded = () => [...fixture.comments, {
      body: `${STAND_DOWN_MARKER}\n\n**Who:** fix-4481`,
      author: { login: 'web-everything' }, createdAt: new Date(now - 60_000).toISOString(),
    }, ...Array.from({ length: 3 }, (_, i) => ({
      body: CONFLICT_FIX_COMMENT_MARKER, author: { login: 'web-everything' },
      createdAt: new Date(now - (3 - i) * 60_000).toISOString(),
    }))];
    it.each([
      ['listPrComments throws', () => { throw new Error('gh: HTTP 502'); }],
      ['listPrComments returns null', () => null],
      ['listPrComments returns undefined', () => undefined],
      ['listPrComments returns a non-array', () => ({ message: 'rate limited' })],
    ])('refuses review-human reassertion when %s', (_name, listPrComments) => {
      for (const dryRun of [false, true]) {
        const { results, findings } = replay({ listPrComments, dryRun });
        expect(findings).toEqual([]);
        expect(results).toEqual([]);
      }
    });
    it('reasserts again once the same PR becomes readable (not stuck off)', () => {
      let reads = 0;
      const listPrComments = () => { if (reads++ === 0) throw new Error('gh: HTTP 502'); return fixture.comments; };
      expect(replay({ listPrComments }).findings).toEqual([]);
      expect(replay({ listPrComments }).findings).toHaveLength(1);
    });
    it('still honors the guards on a readable thread carrying them', () => {
      const { findings } = replay({ listPrComments: guarded });
      expect(findings).toEqual([]);
    });
  });
  it('reports the re-assert route in dry-run without posting', () => {
    const { results, findings } = replay({ dryRun: true });
    expect(results).toHaveLength(1);
    expect(results[0].num).toBe(4481);
    expect(results[0].routedTo).toMatch(/re-asserted, review-human.*xkugvzd/);
    expect(findings).toEqual([]);
  });
});
