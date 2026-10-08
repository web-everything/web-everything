/**
 * @file scripts/conveyor/__tests__/lease-reaper.test.mjs
 * @description Unit proof of the conveyor LEASE REAPER's PURE core (WE #2667). Drives {@link classifyReap} /
 *   {@link reapPlan} / {@link itemNumFromSession} / {@link laneRefItemNum} directly with fixtures (NO fs / git /
 *   gh / clock) and pins every reap axis — PR-terminal (merged/closed), session-gone (WE #3466/#2412, found live
 *   2026-09-04/05), TTL-stale, the DORMANT pid axis — plus the reserved-lane never-reap invariant and the
 *   session↔head-ref item-number keys the cross-pool couple relies on. Also pins the two independent-review
 *   findings on PR #1921 that hardened session-gone before it landed: the listing-visibility GRACE WINDOW (a
 *   lease acquired moments ago must never be reaped just because its session isn't listed yet — #3283's
 *   failure shape, reintroduced) and the ALL-EMPTY-LISTING degrade (zero background rows must read as "axis
 *   off", never "everyone's gone").
 *
 *   #3383 (2026-09-14 mechanical-dispatcher incident) — ALSO pins the PHANTOM-LISTING widening: a
 *   `claude agents --json --all` row can be LISTED, in a non-terminal state, with NO backing OS process at all
 *   (confirmed live: 12 of 14 "leased" lanes had no corroborating process anywhere on the box via `ps`/`lsof`,
 *   several sessions silent 4+ hours, none within their 240-minute TTL). `sessionPidAliveByName` (the real
 *   process-liveness reduction, reusing `driver-watchdog.mjs`'s own two-signal probe) and
 *   `sessionGoneForLease`'s new `pidAlive` input are exercised directly, proving a listed-but-dead session now
 *   reaps even while its recorded state is still `working`/`blocked` and its lease is nowhere near TTL.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  classifyReap,
  reapPlan,
  itemNumFromSession,
  prNumFromSession,
  sessionSlugAttemptTag,
  laneRefItemNum,
  laneRefAttemptTag,
  prStatesFromList,
  prStatesByPrNumber,
  prDetailsFromList,
  pidAliveForLease,
  sessionStateByName,
  sessionStatesForReap,
  sessionGoneForLease,
  ownerSessionAliveForLease,
  sessionPidAliveByName,
  AGENT_GONE_STATES,
  repoKeyForPool,
  fetchPrStatesForRepo,
  restPullToPrStateShape,
  detachedWrapperPidsBySession,
  readDetachedWrapperPids,
  laneBranchItemNum,
  laneQuietSincePr,
  DEFAULT_QUIET_MS,
  resolveLeaseItemNum,
  defaultGitIsAncestor,
  fetchSessionSignals,
  buildLeaseSignalsFor,
  prTerminalPredatesLease,
  laneIndicesIn,
} from '../lease-reaper.mjs';
import { DEFAULT_LEASE_TTL_MINUTES } from '../../lib/lane-lease.mjs';
import { DISPATCH_GUARD_LISTING_GRACE_MINUTES } from '../../operations/dispatch-lane.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = Date.parse('2026-07-26T12:00:00Z');
const TTL_MS = DEFAULT_LEASE_TTL_MINUTES * 60_000;
const GRACE_MS = DISPATCH_GUARD_LISTING_GRACE_MINUTES * 60_000;
// A fresh lease acquired 1 minute ago (well within TTL, and well within the listing-visibility grace window) — not stale.
const fresh = (over = {}) => ({ session: 'conveyor-2667', acquiredAt: new Date(NOW - 60_000).toISOString(), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES, host: 'Mac', pid: 111, ...over });
// A lease acquired long past its TTL (and long past the grace window).
const stale = (over = {}) => ({ session: 'conveyor-2500', acquiredAt: new Date(NOW - (DEFAULT_LEASE_TTL_MINUTES + 60) * 60_000).toISOString(), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES, host: 'Mac', pid: 222, ...over });
// A lease past the listing-visibility grace window but nowhere near TTL — the shape session-gone exists for.
const agedPastGrace = (over = {}) => ({ session: 'conveyor-3466', acquiredAt: new Date(NOW - (GRACE_MS + 5 * 60_000)).toISOString(), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES, host: 'Mac', pid: 333, ...over });

describe('itemNumFromSession — the couple key encoded in a lease session (TRUE item-kind sessions ONLY)', () => {
  it('conveyor-/prepare-/prepare-decision- sessions → the trailing item number', () => {
    expect(itemNumFromSession('conveyor-2667')).toBe('2667');
    expect(itemNumFromSession('prepare-2604')).toBe('2604');
    expect(itemNumFromSession('prepare-decision-2647')).toBe('2647');
  });
  // #x5wm9ot — `fix-<N>`'s `N` IS A PR NUMBER (`mintSessionSlug({kind:'fix', id: pr})`, every real call site),
  // a DIFFERENT namespace from a true item number — see `prNumFromSession` for the function that reads it out.
  // This used to return `N` here too, which is exactly bug #1: a `fix-<PR>` session's PR number, fed into a
  // Map keyed by the item number embedded in a PR's own head ref, hit the wrong (or no) entry.
  it('fix-<PR> (and every other PR_KIND) is NOT an item number — null here, use prNumFromSession instead', () => {
    expect(itemNumFromSession('fix-2630')).toBeNull();
    expect(itemNumFromSession('review-2630')).toBeNull();
    expect(itemNumFromSession('ci-heal-2630')).toBeNull();
    expect(itemNumFromSession('inspect-2630')).toBeNull();
  });
  it('a retry suffix (conveyor-2500b) still resolves the base item number', () => {
    expect(itemNumFromSession('conveyor-2500b')).toBe('2500');
  });
  it('a non-item session → null', () => {
    // #3283 — a session that merely ENDS in digits is not an item reference. `Mac:24827`'s trailing run is the
    // shell `ppid` that `defaultSession()` stamps (`we:scripts/lane-pool.mjs:526`), so reading it as item 24827
    // aliased a plain `acquire` onto whatever card that number happens to name. This assertion previously read
    // `.toBe('24827')` inside this very `it` — it now agrees with the title it always had.
    expect(itemNumFromSession('Mac:24827')).toBe(null);
    expect(itemNumFromSession('shell-fix')).toBe(null);
    expect(itemNumFromSession('')).toBe(null);
    expect(itemNumFromSession(null)).toBe(null);
  });

  // ── #3283 — the couple key is a GRAMMAR, not "the trailing digit run of anything" ────────────────────

  it('#3283 — a GENUINE item-encoding slug still resolves', () => {
    expect(itemNumFromSession('conveyor-2500')).toBe('2500');
    expect(itemNumFromSession('prepare-2500')).toBe('2500');
    expect(itemNumFromSession('prepare-decision-2500')).toBe('2500');
    expect(itemNumFromSession('conveyor-2500b')).toBe('2500'); // the retry suffix still collapses
  });

  it('#3283 — an ARBITRARY digit-tailed slug no longer aliases onto a backlog item', () => {
    // Every one of these resolved to a real item number before the fix, and ~4 in 5 backlog ids name a
    // `status: resolved` card — so each was a lease the acquire-native reaper would reclaim on sight.
    expect(itemNumFromSession('probe1')).toBe(null);                     // not item 1
    expect(itemNumFromSession('rv1566j')).toBe(null);                    // a juror for PR 1566, not item 1566
    expect(itemNumFromSession('Mac:24827')).toBe(null);                  // `defaultSession()` — host:ppid
    expect(itemNumFromSession('build-3283-lane-27-df14bb76')).toBe(null); // a minted `holder` slug (hex tail)
    expect(itemNumFromSession('lane-27')).toBe(null);
  });
});

// #x5wm9ot — the PR-number counterpart to itemNumFromSession: EVERY PR_KIND (review/fix/ci-heal/inspect, not
// fix alone — bug #2's own widening) resolves its own PR number here; every item-kind session (and every
// non-dispatcher name) is null. The two functions must never both resolve the SAME session to a non-null
// value — that would mean a lease's number is ambiguous between "a PR" and "a backlog item".
describe('prNumFromSession — the PR number a PR_KIND session slug encodes (a DIFFERENT namespace from itemNumFromSession)', () => {
  it('every PR_KIND resolves its PR number', () => {
    expect(prNumFromSession('fix-2630')).toBe('2630');
    expect(prNumFromSession('review-2630')).toBe('2630');
    expect(prNumFromSession('ci-heal-2630')).toBe('2630');
    expect(prNumFromSession('inspect-2630')).toBe('2630');
  });
  it('a multi-repo tag still resolves the PR number (#xr4ygg7 widening, unaffected by the #x5wm9ot split)', () => {
    expect(prNumFromSession('fix-fui-49')).toBe('49');
    expect(prNumFromSession('review-pa-49')).toBe('49');
  });
  it('item-kind sessions are NOT PR numbers — null here', () => {
    expect(prNumFromSession('conveyor-2667')).toBeNull();
    expect(prNumFromSession('prepare-2604')).toBeNull();
    expect(prNumFromSession('prepare-decision-2647')).toBeNull();
  });
  it('a non-dispatcher name → null', () => {
    expect(prNumFromSession('Mac:24827')).toBeNull();
    expect(prNumFromSession('')).toBeNull();
    expect(prNumFromSession(null)).toBeNull();
  });
  it('itemNumFromSession and prNumFromSession never both resolve the same session — the two namespaces are disjoint', () => {
    for (const s of ['conveyor-2667', 'fix-2630', 'review-49', 'ci-heal-1', 'inspect-9', 'prepare-1', 'Mac:1', 'probe1', '', null]) {
      expect(itemNumFromSession(s) !== null && prNumFromSession(s) !== null).toBe(false);
    }
  });
});

// #3110 — the retry-suffix letter, previously parsed only to be discarded, now read as the entry's own
// attempt identity so `classifyDispatchPr` can tell "my own retry's PR" from "a sibling attempt's PR".
describe('sessionSlugAttemptTag — the attempt identity a conveyor-<id>[a-z] session slug carries', () => {
  it('an unsuffixed slug is a genuine first attempt — empty string, not null', () => {
    expect(sessionSlugAttemptTag('conveyor-2667')).toBe('');
    expect(sessionSlugAttemptTag('fix-2630')).toBe('');
    expect(sessionSlugAttemptTag('prepare-2604')).toBe('');
    expect(sessionSlugAttemptTag('prepare-decision-2647')).toBe('');
  });
  it('a retry-suffixed slug carries its letter', () => {
    expect(sessionSlugAttemptTag('conveyor-2500b')).toBe('b');
    expect(sessionSlugAttemptTag('conveyor-2500c')).toBe('c');
  });
  it('lower-cases a shouty suffix, matching itemNumFromSession\'s own convention', () => {
    expect(sessionSlugAttemptTag('conveyor-2500B')).toBe('b');
  });
  it('not a conveyor session slug at all → null, distinct from the empty-string first-attempt tag', () => {
    expect(sessionSlugAttemptTag('Mac:24827')).toBe(null);
    expect(sessionSlugAttemptTag('shell-fix')).toBe(null);
    expect(sessionSlugAttemptTag('')).toBe(null);
    expect(sessionSlugAttemptTag(null)).toBe(null);
  });
  it('agrees with itemNumFromSession about which ITEM-KIND slugs match (both read the same underlying grammar)', () => {
    for (const s of ['conveyor-2667', 'conveyor-2500b', 'Mac:24827', 'probe1', '', null]) {
      expect(sessionSlugAttemptTag(s) === null).toBe(itemNumFromSession(s) === null);
    }
  });
  // #x5wm9ot — sessionSlugAttemptTag matches EVERY kind matchSessionSlug recognizes (item-kind AND every
  // PR_KIND — it only ever reads the attempt letter, which carries no PR-vs-item ambiguity), so for a PR_KIND
  // slug it now DISAGREES with itemNumFromSession on purpose: itemNumFromSession is item-kind-only (see its own
  // describe block), but a `fix-`/`review-`/`ci-heal-`/`inspect-` slug is still a real, recognized session —
  // just not an item number. `prNumFromSession` is the one that agrees with sessionSlugAttemptTag here.
  it('a PR_KIND slug is recognized (non-null tag) even though itemNumFromSession reads it as null — prNumFromSession is the one that agrees', () => {
    for (const s of ['fix-2630', 'review-49', 'ci-heal-1', 'inspect-9']) {
      expect(sessionSlugAttemptTag(s)).not.toBeNull();
      expect(itemNumFromSession(s)).toBeNull();
      expect(prNumFromSession(s)).not.toBeNull();
    }
  });
});

describe('laneRefItemNum — the couple key encoded in a lane/<num>-<slug> head ref', () => {
  it('a lane/<num>-<slug> head ref → the item number', () => {
    expect(laneRefItemNum('lane/2667-conveyor-auto-release')).toBe('2667');
    expect(laneRefItemNum('lane/2500b-retry-slug')).toBe('2500');
  });
  it('a non-lane ref → null', () => {
    expect(laneRefItemNum('main')).toBe(null);
    expect(laneRefItemNum('feature/x')).toBe(null);
    expect(laneRefItemNum(null)).toBe(null);
  });

  // ── #x9ylkp7 — the grammar is `pr-land`'s, so the reaper and the dispatch observer cannot disagree ─────────

  it('a `bornAs` HASH ref resolves too — `pr-land` accepts `lane/xNNNNNN-*` and this used to read it as no item', () => {
    // `we:scripts/pr-land.mjs` parses `^lane\/(x[a-z0-9]{5,7}|\d+)`, and the delivery-agent brief documents
    // `{{ITEM_NUM}}` as "the backlog item number (or `xNNNNNN` hash)". Only the digit half matched here, so a
    // hash-identified item's PR was invisible to everything keying through this function.
    expect(laneRefItemNum('lane/x9ylkp7-give-the-observer-a-completion-signal')).toBe('x9ylkp7');
    expect(laneRefItemNum('lane/xaibmeu-route-the-conveyor')).toBe('xaibmeu');
    // Case-folded on the way out, matching `normNum`'s convention for a non-numeric id.
    expect(laneRefItemNum('lane/X9YLKP7-shouty')).toBe('x9ylkp7');
  });

  it('still refuses a ref that is neither — the widening is a second alternative, not a wildcard', () => {
    expect(laneRefItemNum('lane/build-3095')).toBe(null); // no leading `x`, not digits
    expect(laneRefItemNum('lane/x9yl-too-short')).toBe(null); // `x` + 3 < the 5-char floor
    expect(laneRefItemNum('lane/2667')).toBe(null); // no `-<slug>` at all
  });

  // #3110
  it('laneRefAttemptTag mirrors sessionSlugAttemptTag\'s null/empty-string distinction', () => {
    expect(laneRefAttemptTag('lane/2667-conveyor-auto-release')).toBe(''); // first attempt
    expect(laneRefAttemptTag('lane/2500b-retry-slug')).toBe('b');
    expect(laneRefAttemptTag('lane/2500B-shouty')).toBe('b');
    expect(laneRefAttemptTag('lane/x9ylkp7-hash-item')).toBe(''); // a hash-id ref is a first attempt too
    expect(laneRefAttemptTag('main')).toBe(null);
    expect(laneRefAttemptTag('lane/build-3095')).toBe(null); // matches no item at all
    expect(laneRefAttemptTag(null)).toBe(null);
  });
  it('never disagrees with laneRefItemNum about which refs match at all', () => {
    for (const r of ['lane/2667-x', 'lane/2500b-x', 'main', 'lane/build-3095', 'lane/2667', null]) {
      expect(laneRefAttemptTag(r) === null).toBe(laneRefItemNum(r) === null);
    }
  });

  it('the REAPER is unaffected by the widening: a hash key is unreachable from a lease session', () => {
    // The claim in `laneRefItemNum`'s docblock, asserted rather than asserted-about. `prStatesFromList` now
    // mints hash keys, but `itemNumFromSession` — the only lookup on the reap path — can only ever produce
    // digits, so no hash key is reachable and none collides with an existing one.
    const states = prStatesFromList([
      { headRefName: 'lane/x9ylkp7-hash-item', state: 'MERGED', mergedAt: '2026-08-13T00:00:00Z' },
      { headRefName: 'lane/2667-digit-item', state: 'OPEN' },
    ]);
    expect(states.get('x9ylkp7')).toBe('merged');
    expect(states.get('2667')).toBe('open');
    // A lease for the hash item is named `conveyor-x9ylkp7`. #3283 — that slug carries no DIGIT item number at
    // all, so it resolves to null; it previously read as item `7`, a DIFFERENT, real, `status: resolved` card,
    // which made every hash-item lease instantly reapable. `:85`'s conclusion is unchanged and now holds for
    // the stronger reason: a hash key is not merely unreachable, the lookup key itself is absent.
    expect(itemNumFromSession('conveyor-x9ylkp7')).toBe(null);
    expect(states.get(itemNumFromSession('conveyor-x9ylkp7'))).toBeUndefined();
  });
});

describe('classifyReap — PR-terminal axis (work done/abandoned → reclaim even pre-TTL)', () => {
  it('a FRESH lease whose item PR MERGED → reap (pr-merged)', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, prState: 'merged' })).toEqual({ reap: true, reason: 'pr-merged' });
  });
  it('a FRESH lease whose item PR CLOSED → reap (pr-closed)', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, prState: 'closed' })).toEqual({ reap: true, reason: 'pr-closed' });
  });
  it('a FRESH lease whose item PR is still OPEN → keep (still in flight)', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, prState: 'open' })).toEqual({ reap: false, reason: null });
  });
  it('unknown PR state (axis off) + fresh lease → keep', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, prState: null })).toEqual({ reap: false, reason: null });
  });
});

describe('classifyReap — session-gone axis (the real fix for the 2026-09-04/05 dead-session incident)', () => {
  it('a FRESH lease whose session is confirmed gone → reap (session-gone), even pre-TTL', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, sessionGone: true })).toEqual({ reap: true, reason: 'session-gone' });
  });
  it('a FRESH lease whose session is still alive (sessionGone=false) → keep', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, sessionGone: false })).toEqual({ reap: false, reason: null });
  });
  it('sessionGone=null (unknown — no dispatcher-minted name, or the listing was unavailable) never reaps a fresh lease', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, sessionGone: null })).toEqual({ reap: false, reason: null });
  });
  it('PR-terminal still wins over session-gone (a merged PR is the stronger, more specific signal)', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, prState: 'merged', sessionGone: true })).toEqual({ reap: true, reason: 'pr-merged' });
  });
  it('session-gone wins over TTL-stale in the reported reason (both true → the more informative axis names it)', () => {
    expect(classifyReap(stale(), { nowMs: NOW, ttlMs: TTL_MS, sessionGone: true })).toEqual({ reap: true, reason: 'session-gone' });
  });
});

describe('classifyReap — TTL-stale axis (the zero-IO dead-agent backstop)', () => {
  it('a TTL-stale lease with no PR signal → reap (ttl-stale)', () => {
    expect(classifyReap(stale(), { nowMs: NOW, ttlMs: TTL_MS })).toEqual({ reap: true, reason: 'ttl-stale' });
  });
  it('a stale lease whose PR merged reports the PR axis (it wins over TTL)', () => {
    expect(classifyReap(stale(), { nowMs: NOW, ttlMs: TTL_MS, prState: 'merged' })).toEqual({ reap: true, reason: 'pr-merged' });
  });
  it('a lease exactly at the TTL edge is stale (>=)', () => {
    const at = { session: 'conveyor-1', acquiredAt: new Date(NOW - TTL_MS).toISOString(), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES };
    expect(classifyReap(at, { nowMs: NOW, ttlMs: TTL_MS }).reap).toBe(true);
  });
});

describe('classifyReap — pid axis (DORMANT under today\'s schema)', () => {
  it('pidAlive=false → reap (pid-dead) — the forward-compat branch when a trustworthy agentPid exists', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, pidAlive: false })).toEqual({ reap: true, reason: 'pid-dead' });
  });
  it('pidAlive=null (unknown — the shell\'s value today) never reaps a fresh lease', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, pidAlive: null })).toEqual({ reap: false, reason: null });
  });
  it('pidAlive=true never reaps a fresh lease', () => {
    expect(classifyReap(fresh(), { nowMs: NOW, ttlMs: TTL_MS, pidAlive: true })).toEqual({ reap: false, reason: null });
  });
});

describe('classifyReap — RESERVED (permanent memory) leases are NEVER reaped on any axis', () => {
  it('reserved + TTL-stale → keep (reason reserved)', () => {
    expect(classifyReap(stale({ reserved: true }), { nowMs: NOW, ttlMs: TTL_MS })).toEqual({ reap: false, reason: 'reserved' });
  });
  it('reserved + PR merged → keep (reserved short-circuits before the PR axis)', () => {
    expect(classifyReap(fresh({ reserved: true }), { nowMs: NOW, ttlMs: TTL_MS, prState: 'merged' })).toEqual({ reap: false, reason: 'reserved' });
  });
  it('reserved + pid dead → keep', () => {
    expect(classifyReap(fresh({ reserved: true }), { nowMs: NOW, ttlMs: TTL_MS, pidAlive: false })).toEqual({ reap: false, reason: 'reserved' });
  });
  it('reserved + session-gone → keep (reserved short-circuits before the session-gone axis too)', () => {
    expect(classifyReap(fresh({ reserved: true }), { nowMs: NOW, ttlMs: TTL_MS, sessionGone: true })).toEqual({ reap: false, reason: 'reserved' });
  });
});

describe('classifyReap — degenerate inputs', () => {
  it('null / non-object lease → keep (never reap what we cannot read)', () => {
    expect(classifyReap(null, { nowMs: NOW, ttlMs: TTL_MS })).toEqual({ reap: false, reason: null });
    expect(classifyReap(undefined, { nowMs: NOW, ttlMs: TTL_MS })).toEqual({ reap: false, reason: null });
  });
});

// #4415 — proves the REST-shape reads (`head.ref`/`merged_at`/`merge_commit_sha`) map to exactly the fields
// `prStatesFromList`/`prDetailsFromList` already read, AND that the pre-existing GraphQL-shaped fixtures every
// other test in this file hand-builds keep resolving unchanged (this mapper is additive, never a breaking reshape).
describe('restPullToPrStateShape — REST list-item → the GraphQL-shaped fields the reducers already read (#4415)', () => {
  it('a REST pull item (head.ref, merged_at, merge_commit_sha) maps to headRefName/mergedAt/mergeCommit.oid', () => {
    const rest = { number: 900, state: 'closed', merged_at: '2026-09-22T00:00:00Z', merge_commit_sha: 'deadbeef', head: { ref: 'lane/181-x' } };
    expect(restPullToPrStateShape(rest)).toEqual({
      number: 900, state: 'closed', headRefName: 'lane/181-x', mergedAt: '2026-09-22T00:00:00Z', closedAt: null, mergeCommit: { oid: 'deadbeef' },
    });
  });
  it('a REST open pull (no merged_at/merge_commit_sha) maps mergeCommit to null, never a bogus {oid: undefined}', () => {
    const rest = { number: 42, state: 'open', merged_at: null, merge_commit_sha: null, head: { ref: 'lane/42-y' } };
    expect(restPullToPrStateShape(rest)).toEqual({ number: 42, state: 'open', headRefName: 'lane/42-y', mergedAt: null, closedAt: null, mergeCommit: null });
  });
  it('tolerant of the pre-existing GraphQL-shaped fixture (headRefName/mergeCommit.oid top-level, no head/merge_commit_sha) — unchanged pass-through', () => {
    const graphqlShaped = { number: 500, state: 'MERGED', headRefName: 'lane/2825-x', mergedAt: '2026-09-01T00:00:00Z', mergeCommit: { oid: 'cafef00d' } };
    expect(restPullToPrStateShape(graphqlShaped)).toEqual({ ...graphqlShaped, closedAt: null });
  });
  it('a malformed/empty item degrades to a safe empty shape, never throws', () => {
    expect(restPullToPrStateShape({})).toEqual({ number: undefined, state: undefined, headRefName: '', mergedAt: null, closedAt: null, mergeCommit: null });
    expect(restPullToPrStateShape(null)).toEqual({ number: undefined, state: undefined, headRefName: '', mergedAt: null, closedAt: null, mergeCommit: null });
  });
});

describe('prStatesFromList — head-ref → num state reduction (OPEN WINS: never reap a live retry lane)', () => {
  it('a single merged PR → merged; a single open PR → open; a single closed PR → closed', () => {
    const m = prStatesFromList([
      { headRefName: 'lane/2667-x', state: 'MERGED', mergedAt: '2026-07-26T10:00:00Z' },
      { headRefName: 'lane/100-y', state: 'OPEN', mergedAt: null },
      { headRefName: 'lane/200-z', state: 'CLOSED', mergedAt: null },
    ]);
    expect(m.get('2667')).toBe('merged');
    expect(m.get('100')).toBe('open');
    expect(m.get('200')).toBe('closed');
  });

  it('CRITICAL — a base num with a terminal PR AND a live open retry PR reads OPEN (never reaps the live lane)', () => {
    // The #2267 hazard: lane/2500-v1 CLOSED (bounced) while retry lane/2500b-v2 is a LIVE open PR — both
    // collapse to base num 2500. Open must WIN so the reaper never releases the live 2500b lane.
    const closedThenOpen = prStatesFromList([
      { headRefName: 'lane/2500-v1', state: 'CLOSED', mergedAt: null },
      { headRefName: 'lane/2500b-v2', state: 'OPEN', mergedAt: null },
    ]);
    expect(closedThenOpen.get('2500')).toBe('open');
    // Same with a MERGED old PR + a live open retry — still open (order-independent).
    const mergedThenOpen = prStatesFromList([
      { headRefName: 'lane/2500b-v2', state: 'OPEN', mergedAt: null },
      { headRefName: 'lane/2500-v1', state: 'MERGED', mergedAt: '2026-07-26T09:00:00Z' },
    ]);
    expect(mergedThenOpen.get('2500')).toBe('open');
  });

  it('among terminal-only PRs of one num, merged wins over closed (the work landed)', () => {
    expect(prStatesFromList([
      { headRefName: 'lane/300-v1', state: 'CLOSED', mergedAt: null },
      { headRefName: 'lane/300-v2', state: 'MERGED', mergedAt: '2026-07-26T09:00:00Z' },
    ]).get('300')).toBe('merged');
  });

  it('non-lane / malformed head refs are ignored; empty input → empty map', () => {
    const m = prStatesFromList([{ headRefName: 'main', state: 'MERGED' }, { headRefName: null }, {}]);
    expect(m.size).toBe(0);
    expect(prStatesFromList([]).size).toBe(0);
    expect(prStatesFromList(null).size).toBe(0);
  });
});

// #x5wm9ot (bug #1) — the PR-NUMBER-keyed counterpart to prStatesFromList's item-number-keyed Map. A PR_KIND
// lease's PR-terminal check must read THIS Map (by the PR's own number), never the head-ref-keyed one.
describe('prStatesByPrNumber — PR-number → state reduction (same open-wins priority as prStatesFromList, different key)', () => {
  it('keys by the PR\'s OWN number, ignoring headRefName entirely', () => {
    const m = prStatesByPrNumber([
      { number: 900, headRefName: 'lane/181-something', state: 'MERGED', mergedAt: '2026-09-22T00:00:00Z' },
      { number: 901, headRefName: 'some-other-branch', state: 'CLOSED' },
      { number: 902, headRefName: null, state: 'OPEN' },
    ]);
    expect(m.get('900')).toBe('merged');
    expect(m.get('901')).toBe('closed');
    expect(m.get('902')).toBe('open');
    // Critically, the ITEM number embedded in PR #900's head ref (181) is NOT a key in this Map at all.
    expect(m.has('181')).toBe(false);
  });
  it('open wins over a terminal state for the SAME PR number (defensive — gh never actually reuses one)', () => {
    const m = prStatesByPrNumber([{ number: 5, state: 'CLOSED' }, { number: 5, state: 'OPEN' }]);
    expect(m.get('5')).toBe('open');
  });
  it('a PR with no usable number is ignored; empty input → empty map', () => {
    expect(prStatesByPrNumber([{ state: 'MERGED' }, null, {}]).size).toBe(0);
    expect(prStatesByPrNumber([]).size).toBe(0);
    expect(prStatesByPrNumber(null).size).toBe(0);
  });
});

describe('pidAliveForLease — DORMANT under today\'s schema (no durable agentPid)', () => {
  it('a lease with no agentPid (today\'s schema — only the acquire-CLI `pid`) → null (axis inert)', () => {
    expect(pidAliveForLease({ session: 'conveyor-2667', pid: 12345, host: 'Mac' })).toBe(null);
    expect(pidAliveForLease({})).toBe(null);
    expect(pidAliveForLease(null)).toBe(null);
  });
  it('an agentPid on a DIFFERENT host → null (cannot check a pid on another host)', () => {
    expect(pidAliveForLease({ agentPid: 999999, host: 'some-other-host-not-mine' })).toBe(null);
  });
});

describe('sessionStateByName — claude agents --json --all listing → background-only name→state Map', () => {
  it('maps background rows by name; a live conveyor build reads its own state', () => {
    const m = sessionStateByName([
      { kind: 'background', name: 'conveyor-3466', state: 'working' },
      { kind: 'background', name: 'conveyor-2412', state: 'done' },
    ]);
    expect(m.get('conveyor-3466')).toBe('working');
    expect(m.get('conveyor-2412')).toBe('done');
  });
  it('excludes interactive rows even if named the same as a dispatcher slug', () => {
    const m = sessionStateByName([{ kind: 'interactive', name: 'conveyor-3466', state: 'working' }]);
    expect(m.has('conveyor-3466')).toBe(false);
  });
  it('a row with no usable name is skipped; malformed/empty input → empty map', () => {
    const m = sessionStateByName([{ kind: 'background', state: 'done' }, null, {}]);
    expect(m.size).toBe(0);
    expect(sessionStateByName([]).size).toBe(0);
    expect(sessionStateByName(null).size).toBe(0);
  });
  it('AGENT_GONE_STATES is exactly done/failed/stopped — the vocabulary session-reaper.mjs already reaps on', () => {
    expect([...AGENT_GONE_STATES].sort()).toEqual(['done', 'failed', 'stopped']);
  });

  // #x2psfwz (bug #5) — review-<PR>/fix-<PR> carry no attempt suffix, so a round-2 dispatch reuses round 1's
  // exact name. `claude agents --json --all` can list BOTH a not-yet-pruned round-1 row and round-2's own live
  // row under that one name, in an order this CLI documents nowhere. This used to be a bare `.set()` per row —
  // whichever came LAST in the array won, so a live round-2 session could be masked as done/failed/stopped by
  // a stale duplicate that merely happened to sort after it.
  describe('duplicate names (round-2 reuse, #x2psfwz) — a terminal row never masks an already-recorded LIVE one', () => {
    it('live-then-terminal (stale duplicate arrives AFTER the live row): the live reading survives', () => {
      const m = sessionStateByName([
        { kind: 'background', name: 'review-1234', state: 'working' },  // round 2, live
        { kind: 'background', name: 'review-1234', state: 'done' },    // stale round-1 duplicate, listed later
      ]);
      expect(m.get('review-1234')).toBe('working');
    });
    it('terminal-then-live (order the OLD code happened to get right) still reads live — order must never matter', () => {
      const m = sessionStateByName([
        { kind: 'background', name: 'review-1234', state: 'done' },
        { kind: 'background', name: 'review-1234', state: 'working' },
      ]);
      expect(m.get('review-1234')).toBe('working');
    });
    it('two terminal duplicates: either is a correct "gone" reading — harmless either way', () => {
      const m = sessionStateByName([
        { kind: 'background', name: 'fix-99', state: 'failed' },
        { kind: 'background', name: 'fix-99', state: 'done' },
      ]);
      expect(AGENT_GONE_STATES.has(m.get('fix-99'))).toBe(true);
    });
    it('two live duplicates: either live reading is correct — harmless either way', () => {
      const m = sessionStateByName([
        { kind: 'background', name: 'fix-99', state: 'blocked' },
        { kind: 'background', name: 'fix-99', state: 'working' },
      ]);
      expect(AGENT_GONE_STATES.has(m.get('fix-99'))).toBe(false);
    });
  });
});

describe('sessionStatesForReap — #1921 review fix: an ALL-EMPTY listing degrades to axis-off, not "everyone gone"', () => {
  it('some background rows present → the same Map sessionStateByName would build', () => {
    const sessions = [{ kind: 'background', name: 'conveyor-9999', state: 'working' }];
    expect(sessionStatesForReap(sessions)).toEqual(sessionStateByName(sessions));
  });
  it('ZERO background rows (empty array, all-interactive, or malformed) → null, never an empty Map', () => {
    // A `claude agents --json --all` call that parses but yields nothing usable is indistinguishable from a
    // bad/incomplete read — treating it as "confirmed nobody is dispatched" would read every dispatcher-named
    // lease's session as gone and mass-reap the fleet on one bad read (the exact review finding on #1921).
    expect(sessionStatesForReap([])).toBe(null);
    expect(sessionStatesForReap([{ kind: 'interactive', name: 'conveyor-1', state: 'working' }])).toBe(null);
    expect(sessionStatesForReap(null)).toBe(null);
    expect(sessionStatesForReap(undefined)).toBe(null);
  });
});

describe('#3903 — a lease held by a detached delivery wrapper (Codex build) is never read as session-gone while the wrapper runs', () => {
  const agedLease = (session) => ({ session, acquiredAt: new Date(NOW - (GRACE_MS + 30 * 60_000)).toISOString() });
  const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);

  it('the wrapper session is never in `claude agents`, so WITHOUT the wrapper signal an hour-old build reads gone', () => {
    expect(sessionGoneForLease(agedLease('conveyor-3622'), states, { nowMs: NOW })).toBe(true);
  });

  it('wrapperAlive: true → NOT gone, whatever the listing says', () => {
    expect(sessionGoneForLease(agedLease('conveyor-3622'), states, { nowMs: NOW, wrapperAlive: true })).toBe(false);
    expect(classifyReap(agedLease('conveyor-3622'), { nowMs: NOW, sessionGone: sessionGoneForLease(agedLease('conveyor-3622'), states, { nowMs: NOW, wrapperAlive: true }) }).reap).toBe(false);
  });

  it('wrapperAlive: false / null change nothing — a dead wrapper\'s lane is reclaimed as before', () => {
    expect(sessionGoneForLease(agedLease('conveyor-3622'), states, { nowMs: NOW, wrapperAlive: false })).toBe(true);
    expect(sessionGoneForLease(agedLease('conveyor-3622'), states, { nowMs: NOW, wrapperAlive: null })).toBe(true);
  });

  it('detachedWrapperPidsBySession maps only in-flight `pid:` handles to their session slug', () => {
    const runs = [
      { effects: [{ status: 'in-flight', handle: 'pid:4242', payload: { sessionSlug: 'conveyor-3622' } }] },
      { effects: [{ status: 'in-flight', handle: 'a1b2c3d4', payload: { sessionSlug: 'conveyor-100' } }] }, // claude --bg
      { effects: [{ status: 'succeeded', handle: 'pid:77', payload: { sessionSlug: 'conveyor-200' } }] }, // finished
      { effects: [{ status: 'in-flight', handle: 'pid:88', payload: {} }] }, // no session
      null,
    ];
    expect([...detachedWrapperPidsBySession(runs)]).toEqual([['conveyor-3622', 4242]]);
    expect(detachedWrapperPidsBySession(undefined).size).toBe(0);
  });
});

describe('sessionGoneForLease — THE FIX: is the lease\'s own delivery-agent session confirmed gone?', () => {
  it('the live 2026-09-04/05 incident shape: session ABSENT + past the listing-visibility grace window → true (gone)', () => {
    // conveyor-3466 (lane-38) and conveyor-2412/2412c (lane-40) died/disappeared entirely from `claude agents
    // --json` — not merely `done`/`failed`, simply not listed at all, confirmed dead via `ps -p <pid>`. Both
    // leases had been held far longer than the listing could plausibly still be "not yet caught up".
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    const agedLease = (session) => ({ session, acquiredAt: new Date(NOW - (GRACE_MS + 5 * 60_000)).toISOString() });
    expect(sessionGoneForLease(agedLease('conveyor-3466'), states, { nowMs: NOW })).toBe(true);
    expect(sessionGoneForLease(agedLease('conveyor-2412'), states, { nowMs: NOW })).toBe(true);
    // The retry variant is an EXACT, separate name — not collapsed — and is checked the same way.
    expect(sessionGoneForLease(agedLease('conveyor-2412c'), states, { nowMs: NOW })).toBe(true);
  });

  // ── #1921 independent review, security/concurrency-race finding (CONFIRMED) — the grace window ─────────────

  it('session ABSENT but the lease is STILL INSIDE the grace window → null (too young to judge, NOT gone)', () => {
    // A lease acquired seconds/minutes ago whose delivery agent has not yet had time to appear in `claude
    // agents --json --all` (dispatch-lane.mjs's own measured listing-visibility lag) must never be reaped just
    // because it isn't listed YET — that force-releases a live lane before its agent has committed anything,
    // reintroducing #3283 ("the lease reaper reclaims a lane seconds after it is acquired") through this axis.
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    expect(sessionGoneForLease(fresh({ session: 'conveyor-3466' }), states, { nowMs: NOW })).toBe(null);
    // Just under the boundary is still too young.
    const almostGrace = { session: 'conveyor-3466', acquiredAt: new Date(NOW - (GRACE_MS - 1000)).toISOString() };
    expect(sessionGoneForLease(almostGrace, states, { nowMs: NOW })).toBe(null);
  });
  it('session ABSENT, exactly at / just past the grace boundary → true (gone)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    const atGrace = { session: 'conveyor-3466', acquiredAt: new Date(NOW - GRACE_MS).toISOString() };
    expect(sessionGoneForLease(atGrace, states, { nowMs: NOW })).toBe(true);
  });
  it('session ABSENT + no nowMs supplied → null (never guess at an unknown age), even past what would be the grace window', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    expect(sessionGoneForLease(agedPastGrace(), states)).toBe(null);
  });
  it('session ABSENT + unparsable/missing acquiredAt → null (never guess at an unknown age)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    expect(sessionGoneForLease({ session: 'conveyor-3466' }, states, { nowMs: NOW })).toBe(null);
    expect(sessionGoneForLease({ session: 'conveyor-3466', acquiredAt: 'not-a-date' }, states, { nowMs: NOW })).toBe(null);
  });
  it('a custom graceMs is honored (forward-compat knob, not asserted elsewhere)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    const lease = { session: 'conveyor-3466', acquiredAt: new Date(NOW - 60_000).toISOString() }; // 1 min old
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, graceMs: 30_000 })).toBe(true); // past a 30s grace
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, graceMs: 5 * 60_000 })).toBe(null); // inside a 5min grace
  });

  it('a session listed in a terminal state (done/failed/stopped) → true (gone), NO grace check needed', () => {
    // A positive, directly-observed row — not an inference from silence — so even a lease acquired seconds ago
    // reaps immediately once its own session reports a terminal state.
    const states = sessionStateByName([
      { kind: 'background', name: 'conveyor-100', state: 'done' },
      { kind: 'background', name: 'conveyor-101', state: 'failed' },
      { kind: 'background', name: 'conveyor-102', state: 'stopped' },
    ]);
    expect(sessionGoneForLease(fresh({ session: 'conveyor-100' }), states, { nowMs: NOW })).toBe(true);
    expect(sessionGoneForLease(fresh({ session: 'conveyor-101' }), states, { nowMs: NOW })).toBe(true);
    expect(sessionGoneForLease(fresh({ session: 'conveyor-102' }), states, { nowMs: NOW })).toBe(true);
    // Even with no nowMs at all — the terminal-state branch never needs an age.
    expect(sessionGoneForLease({ session: 'conveyor-100' }, states)).toBe(true);
  });
  it('a session listed and still working/blocked → false (a slow build, not a dead one)', () => {
    const states = sessionStateByName([
      { kind: 'background', name: 'conveyor-200', state: 'working' },
      { kind: 'background', name: 'conveyor-201', state: 'blocked' },
    ]);
    expect(sessionGoneForLease({ session: 'conveyor-200' }, states)).toBe(false);
    expect(sessionGoneForLease({ session: 'conveyor-201' }, states)).toBe(false);
  });
  it('a session whose name matches no dispatcher grammar → null (never guess about a manual/interactive lane)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9', state: 'working' }]);
    expect(sessionGoneForLease({ session: 'Mac:24827' }, states, { nowMs: NOW })).toBe(null);
    expect(sessionGoneForLease({ session: 'some-adhoc-session' }, states, { nowMs: NOW })).toBe(null);
    expect(sessionGoneForLease({}, states, { nowMs: NOW })).toBe(null);
    expect(sessionGoneForLease(null, states, { nowMs: NOW })).toBe(null);
  });
  it('sessionStates not a Map (listing unavailable/all-empty this pass) → null (axis off), even for a dispatcher name', () => {
    expect(sessionGoneForLease({ session: 'conveyor-3466' }, null, { nowMs: NOW })).toBe(null);
    expect(sessionGoneForLease({ session: 'conveyor-3466' }, undefined, { nowMs: NOW })).toBe(null);
  });

  // #x5wm9ot (bug #2) — review-/ci-heal-/inspect- sessions used to fail the dispatcher-minted gate ABOVE
  // (`matchSessionSlug` matched only itemKind || kind==='fix'), so this whole axis was permanently OFF for
  // them — a dead review/ci-heal/inspect lane was reclaimed only by the 4h TTL backstop, never pre-TTL, no
  // matter how confidently `claude agents` reported it done. Now every PR_KIND is recognized here too.
  it('bug #2 — review-/ci-heal-/inspect- sessions are NOW recognized by this gate (were: always null, TTL-only)', () => {
    const states = sessionStateByName([
      { kind: 'background', name: 'review-1871', state: 'done' },
      { kind: 'background', name: 'ci-heal-1872', state: 'working' },
    ]);
    expect(sessionGoneForLease({ session: 'review-1871' }, states, { nowMs: NOW })).toBe(true);  // listed, terminal → gone
    expect(sessionGoneForLease({ session: 'ci-heal-1872' }, states, { nowMs: NOW })).toBe(false); // listed, still working → not gone
    // Absent + past the grace window → gone, exactly like an item-kind session already worked.
    expect(sessionGoneForLease({ session: 'inspect-1873', acquiredAt: new Date(NOW - (GRACE_MS + 5 * 60_000)).toISOString() }, states, { nowMs: NOW })).toBe(true);
  });

  // ── #3383 (2026-09-14) — THE PHANTOM-LISTING WIDENING: a LISTED, non-terminal session with NO real process ──

  it('LIVE INCIDENT SHAPE: listed as "working" (not terminal) but pidAlive=false → gone, no grace/age needed', () => {
    // This is exactly what made 12 of 14 lane leases un-reapable for hours: the registered session still shows
    // up in the listing with a perfectly ordinary in-progress state, so neither the absence branch nor
    // AGENT_GONE_STATES ever fires — only a REAL liveness read catches it.
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-62', state: 'working' }]);
    expect(sessionGoneForLease({ session: 'conveyor-62' }, states, { pidAlive: false })).toBe(true);
    // No nowMs supplied at all — the pidAlive branch needs no age/clock, unlike the absence branch.
    expect(sessionGoneForLease({ session: 'conveyor-62' }, states, { pidAlive: false })).toBe(true);
  });
  it('listed as "blocked" with pidAlive=false → gone too (any non-terminal state, not just "working")', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-63', state: 'blocked' }]);
    expect(sessionGoneForLease({ session: 'conveyor-63' }, states, { pidAlive: false })).toBe(true);
  });
  it('pidAlive=false wins even for a lease acquired moments ago — it is a direct read, not an inference needing a grace window', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-64', state: 'working' }]);
    const justAcquired = { session: 'conveyor-64', acquiredAt: new Date(NOW - 5_000).toISOString() };
    expect(sessionGoneForLease(justAcquired, states, { nowMs: NOW, pidAlive: false })).toBe(true);
  });
  it('pidAlive=true → unchanged (a listed, non-terminal, REALLY alive session stays kept)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-65', state: 'working' }]);
    expect(sessionGoneForLease({ session: 'conveyor-65' }, states, { pidAlive: true })).toBe(false);
  });
  it('pidAlive=null (unknown/not supplied) → falls through to the pre-#3383 listed-state logic unchanged', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-66', state: 'working' }]);
    expect(sessionGoneForLease({ session: 'conveyor-66' }, states, { pidAlive: null })).toBe(false);
    expect(sessionGoneForLease({ session: 'conveyor-66' }, states)).toBe(false); // default omitted entirely
  });
  it('pidAlive=false on a session absent from the listing altogether → still gone (the stronger signal still fires)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    expect(sessionGoneForLease({ session: 'conveyor-67' }, states, { pidAlive: false })).toBe(true);
  });
});

// ── #xbk2is9 (2026-09-28) — A HAND-BRIEFED (in-process Agent-tool) DELIVERY AGENT'S LEASE IS HELD BY AN ─────────
// INTERACTIVE SESSION, NOT A `claude --bg` ONE — so its `--session=conveyor-<N>` name is NEVER separately
// listed, and the absence branch above wrongly read that as session-gone once the grace window passed (live
// incident: lane-18/lane-5/lane-12/lane-13/lane-14/lane-16/lane-17/lane-20/lane-21/lane-22, this card's own
// Evidence). THE FIX reuses the reclaim `--salvage` gate's own `liveAgentInLane` to check the lease's declared
// occupant, `workerSession` — a REAL `CLAUDE_CODE_SESSION_ID` — against the SAME listing's `kind: 'interactive'`
// rows, which the reclaim gate independently already found live for this exact lease. `ownerSession` (whoever
// ran `acquire`) is deliberately NOT checked — see `ownerSessionAliveForLease`'s own doc for why.
describe('ownerSessionAliveForLease — #xbk2is9 the reclaim salvage gate\'s own liveAgentInLane, reused for the reaper', () => {
  it('workerSession IS listed (interactive, non-terminal) → true (alive)', () => {
    const agents = [{ kind: 'interactive', sessionId: 'bd616854-owner', state: undefined, cwd: '/elsewhere' }];
    const lease = { session: 'conveyor-4294', workerSession: 'bd616854-owner' };
    expect(ownerSessionAliveForLease(lease, agents, '/pool/lane-18')).toBe(true);
  });
  it('the liveAgentInLane cwd fallback: a live row whose cwd IS the lane, with no matching sessionId at all, still reads alive', () => {
    const agents = [{ kind: 'interactive', sessionId: 'some-unrelated-session', state: 'working', cwd: '/pool/lane-18' }];
    const lease = { session: 'conveyor-4294', workerSession: 'bd616854-owner' }; // no sessionId in `agents` matches this
    expect(ownerSessionAliveForLease(lease, agents, '/pool/lane-18')).toBe(true);
    // A sibling cwd (a `.claude/worktrees/<x>` under the lane) also counts — liveAgentInLane's own contract.
    const wtAgents = [{ kind: 'interactive', sessionId: 'some-unrelated-session', cwd: '/pool/lane-18/.claude/worktrees/fix-9' }];
    expect(ownerSessionAliveForLease(lease, wtAgents, '/pool/lane-18')).toBe(true);
    // An UNRELATED cwd with no matching sessionId either → false, never a guess.
    const elsewhereAgents = [{ kind: 'interactive', sessionId: 'some-unrelated-session', cwd: '/pool/lane-99' }];
    expect(ownerSessionAliveForLease(lease, elsewhereAgents, '/pool/lane-18')).toBe(false);
  });
  it('round-4 convergence correctness finding: `ownerSession` is deliberately NOT checked, even alone — a lease never adopted has no reliable "who is the actual worker" signal, so this is null, never a guess off the (possibly ever-alive dispatcher) ownerSession', () => {
    const agents = [{ kind: 'interactive', sessionId: 'bd616854-owner', cwd: '/elsewhere' }];
    const lease = { session: 'conveyor-4294', ownerSession: 'bd616854-owner' }; // no workerSession — never adopted
    expect(ownerSessionAliveForLease(lease, agents, '/pool/lane-18')).toBe(null);
  });
  it('ownerSession being alive does NOT suppress reap when workerSession points to someone else entirely dead — only the declared occupant matters', () => {
    const agents = [{ kind: 'interactive', sessionId: 'long-lived-dispatcher', state: 'busy', cwd: '/dispatcher/root' }];
    const lease = { session: 'conveyor-4294', ownerSession: 'long-lived-dispatcher', workerSession: 'dead-delivery-agent' };
    expect(ownerSessionAliveForLease(lease, agents, '/pool/lane-18')).toBe(false);
  });
  it('workerSession is ALSO absent from the listing → false (liveAgentInLane finds no match)', () => {
    const agents = [{ kind: 'interactive', sessionId: 'some-other-session', cwd: '/elsewhere' }];
    const lease = { session: 'conveyor-4294', workerSession: 'bd616854-owner' };
    expect(ownerSessionAliveForLease(lease, agents, '/pool/lane-18')).toBe(false);
  });
  it('workerSession listed but in a terminal state → false (liveAgentInLane\'s own DONE set)', () => {
    const agents = [{ kind: 'interactive', sessionId: 'bd616854-owner', state: 'done', cwd: '/elsewhere' }];
    const lease = { session: 'conveyor-4294', workerSession: 'bd616854-owner' };
    expect(ownerSessionAliveForLease(lease, agents, '/pool/lane-18')).toBe(false);
  });
  it('the lease\'s own dispatcher-grammar `session` name is NOT checked (deliberately narrower than the reclaim gate — see the function\'s own doc) — a row whose sessionId happens to equal it does NOT count, even when workerSession is present and simply unmatched', () => {
    // A real workerSession IS present (so the early guard doesn't short-circuit this to null) but matches
    // nothing in the listing; the ONLY live row's sessionId equals the lease's own `session` name instead.
    const lease = { session: 'conveyor-4294', workerSession: 'dead-worker' };
    const matchingAgents = [{ kind: 'interactive', sessionId: 'conveyor-4294', cwd: '/elsewhere' }];
    expect(ownerSessionAliveForLease(lease, matchingAgents, '/pool/lane-18')).toBe(false); // not true — `session` is never a checked id
  });
  it('a lease with NO session id at all (degenerate) → null (nothing to check, never guess)', () => {
    const agents = [{ kind: 'interactive', sessionId: 'bd616854-owner', cwd: '/elsewhere' }];
    expect(ownerSessionAliveForLease({}, agents, '/pool/lane-18')).toBe(null);
  });
  it('listing unavailable (not an array) → null (axis off, never guess)', () => {
    const lease = { session: 'conveyor-4294', workerSession: 'bd616854-owner' };
    expect(ownerSessionAliveForLease(lease, null, '/pool/lane-18')).toBe(null);
    expect(ownerSessionAliveForLease(lease, undefined, '/pool/lane-18')).toBe(null);
  });
  it('degenerate lease → null', () => {
    expect(ownerSessionAliveForLease(null, [], '/pool/lane-18')).toBe(null);
    expect(ownerSessionAliveForLease(undefined, [], '/pool/lane-18')).toBe(null);
  });
});

describe('sessionGoneForLease — #xbk2is9 THE FIX end to end: ownerAlive overrides a hand-briefed lease\'s own unlisted `session` name', () => {
  it("Done-when #1 (this card): session absent from the listing, acquired 30 min ago, whose workerSession IS listed and live → NOT true", () => {
    // The exact shape the card names: a lease with `session: conveyor-4294`, acquired well past the grace
    // window, absent from the background listing (never `claude --bg`, so never separately listed) — but its
    // `workerSession` IS a live, listed interactive session.
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    const agents = [{ kind: 'interactive', sessionId: 'bd616854-owner', cwd: '/elsewhere' }];
    const lease = {
      session: 'conveyor-4294',
      workerSession: 'bd616854-owner',
      acquiredAt: new Date(NOW - 30 * 60_000).toISOString(),
    };
    const ownerAlive = ownerSessionAliveForLease(lease, agents, '/pool/lane-18');
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, ownerAlive })).not.toBe(true);
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, ownerAlive })).toBe(false);
    // classifyReap agrees: this lease is NOT reaped on the session-gone axis.
    expect(classifyReap(lease, { nowMs: NOW, sessionGone: sessionGoneForLease(lease, states, { nowMs: NOW, ownerAlive }) }).reap).toBe(false);
  });

  it('Done-when #1 (this card): the SAME lease with its workerSession also absent from the listing → true (gone, as before the fix)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    const agents = [{ kind: 'interactive', sessionId: 'some-unrelated-session', cwd: '/elsewhere' }];
    const lease = {
      session: 'conveyor-4294',
      workerSession: 'bd616854-owner',
      acquiredAt: new Date(NOW - 30 * 60_000).toISOString(),
    };
    const ownerAlive = ownerSessionAliveForLease(lease, agents, '/pool/lane-18');
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, ownerAlive })).toBe(true);
  });

  it('ownerAlive=true wins even for a lease acquired moments ago — no grace window needed (a direct positive read, mirrors wrapperAlive)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    const justAcquired = { session: 'conveyor-5001', workerSession: 'bd616854-owner', acquiredAt: new Date(NOW - 5_000).toISOString() };
    expect(sessionGoneForLease(justAcquired, states, { nowMs: NOW, ownerAlive: true })).toBe(false);
  });

  it('ownerAlive: false / null / omitted change nothing — a genuinely dead hand-briefed lease still reaps as before this fix', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    const lease = { session: 'conveyor-5002', acquiredAt: new Date(NOW - (GRACE_MS + 5 * 60_000)).toISOString() };
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, ownerAlive: false })).toBe(true);
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, ownerAlive: null })).toBe(true);
    expect(sessionGoneForLease(lease, states, { nowMs: NOW })).toBe(true); // default omitted entirely
  });

  // ── PRECEDENCE ────────────────────────────────────────────────────────────────────────────────────────────
  // `ownerAlive` must NEVER override a REAL, direct death signal about this lease's OWN tracked session
  // (`pidAlive === false`, or the session listed in a terminal state) — those are positive evidence about the
  // actual worker, whereas `workerSession` is a proxy that can legitimately outlive the one
  // delivery agent a lease was minted for (a long-lived interactive/dispatcher session routinely acquires MANY
  // leases over its own lifetime). `ownerAlive` is scoped to the ABSENCE branch only.
  it('ownerAlive=true does NOT override pidAlive=false — a real, direct death signal about THIS session wins', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-5100', state: 'working' }]);
    const lease = { session: 'conveyor-5100', workerSession: 'long-lived-owner' };
    expect(sessionGoneForLease(lease, states, { pidAlive: false, ownerAlive: true })).toBe(true);
  });
  it('ownerAlive=true does NOT override a session listed in a terminal state (done/failed/stopped)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-5101', state: 'done' }]);
    const lease = { session: 'conveyor-5101', workerSession: 'long-lived-owner' };
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, ownerAlive: true })).toBe(true);
  });
  it('ownerAlive=true does NOT change a session listed and still working/blocked (already false — this pins it stays false, not accidentally null)', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-5102', state: 'working' }]);
    const lease = { session: 'conveyor-5102', workerSession: 'long-lived-owner' };
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, ownerAlive: true })).toBe(false);
  });
  it('ownerAlive=true DOES apply in the absence branch — the one shape a hand-briefed subagent\'s own row can ever take', () => {
    const states = sessionStateByName([{ kind: 'background', name: 'conveyor-9999', state: 'working' }]);
    const lease = {
      session: 'conveyor-5103',
      workerSession: 'long-lived-owner',
      acquiredAt: new Date(NOW - (GRACE_MS + 5 * 60_000)).toISOString(),
    };
    expect(sessionGoneForLease(lease, states, { nowMs: NOW, ownerAlive: true })).toBe(false);
  });
});

describe('sessionPidAliveByName — #3383 real process-liveness per session, reusing driver-watchdog\'s own probe', () => {
  it('a row with its own pid uses the direct kill(pid,0) probe, never the ps scan', () => {
    const isPidAlive = vi.fn((pid) => pid === 111);
    const m = sessionPidAliveByName(
      [{ kind: 'background', name: 'conveyor-1', pid: 111 }, { kind: 'background', name: 'conveyor-2', pid: 222 }],
      { psOutput: 'irrelevant', isPidAlive },
    );
    expect(m.get('conveyor-1')).toBe(true);
    expect(m.get('conveyor-2')).toBe(false);
  });
  it('a row with only a sessionId falls back to scanning the ps aux capture for its full id', () => {
    const m = sessionPidAliveByName(
      [
        { kind: 'background', name: 'conveyor-live', sessionId: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee' },
        { kind: 'background', name: 'conveyor-dead', sessionId: 'ffff2222-bbbb-cccc-dddd-eeeeeeeeeeee' },
      ],
      { psOutput: 'claude --resume=aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee some-other-flags' },
    );
    expect(m.get('conveyor-live')).toBe(true);
    expect(m.get('conveyor-dead')).toBe(false);
  });
  it('no pid, no sessionId, or psOutput unavailable → null (unknown, never a false death)', () => {
    const m = sessionPidAliveByName([{ kind: 'background', name: 'conveyor-x' }], { psOutput: null });
    expect(m.get('conveyor-x')).toBe(null);
  });
  it('interactive rows are excluded, matching sessionStateByName\'s own guard', () => {
    const m = sessionPidAliveByName([{ kind: 'interactive', name: 'conveyor-1', pid: 111 }], { isPidAlive: () => true });
    expect(m.has('conveyor-1')).toBe(false);
  });
  // xbdixjc — live 2026-10-08 21:17Z/21:25Z: `fix-4461` and `fix-4433` each had older `done` rows (no pid, their
  // session ids gone from ps) next to one live `working` row. When a done row came AFTER the live one, its `false`
  // overwrote the live `true`, so sessionGoneForLease read a fixer mid-edit as gone and the reaper released lane-5
  // and lane-20 with uncommitted work in them. A dead duplicate row must never mask a live (or unknown) reading.
  describe('duplicate names (round-N reuse) — a dead row never masks a live or unknown reading', () => {
    const live = { kind: 'background', name: 'fix-4461', pid: 81159, state: 'working' };
    const done = { kind: 'background', name: 'fix-4461', sessionId: 'c198d004-f67f-4138-9018-63756d0bb8a3', state: 'done' };
    const unknown = { kind: 'background', name: 'fix-4461', state: 'working' };
    const opts = { psOutput: 'nothing matches', isPidAlive: (pid) => pid === 81159 };
    it.each([
      ['live then done', [live, done], true],
      ['done then live', [done, live], true],
      ['done, live, done', [done, live, done], true],
      ['unknown then done', [unknown, done], null],
      ['done then unknown', [done, unknown], null],
      ['only done rows', [done, done], false],
    ])('%s', (_label, rows, expected) => {
      expect(sessionPidAliveByName(rows, opts).get('fix-4461')).toBe(expected);
    });
    it('end to end: a live fixer listed before its stale done row is NOT session-gone', () => {
      const rows = [live, done];
      const states = sessionStateByName(rows);
      const pidAlive = sessionPidAliveByName(rows, opts).get('fix-4461');
      const lease = { session: 'fix-4461', acquiredAt: '2026-10-08T20:00:00.000Z' };
      expect(sessionGoneForLease(lease, states, { nowMs: Date.parse('2026-10-08T21:17:43.000Z'), pidAlive })).toBe(false);
    });
  });
  it('malformed/empty input → empty map', () => {
    expect(sessionPidAliveByName([null, {}, { kind: 'background' }]).size).toBe(0);
    expect(sessionPidAliveByName([]).size).toBe(0);
    expect(sessionPidAliveByName(null).size).toBe(0);
  });
});

describe('fetchSessionSignals — #xbk2is9 the three-way `agents` null contract (round-6 convergence standards-conformance finding: this was previously undefended)', () => {
  it('a failed `claude` call → states/agents both null, pidAlive empty', () => {
    const exec = () => { throw new Error('claude: command not found'); };
    const result = fetchSessionSignals({}, { exec });
    expect(result.states).toBe(null);
    expect(result.agents).toBe(null);
    expect(result.pidAlive.size).toBe(0);
  });
  it('--no-check-sessions disables the axis with no exec call at all — states/agents both null', () => {
    const exec = () => { throw new Error('must not be called'); };
    const result = fetchSessionSignals({ 'no-check-sessions': true }, { exec });
    expect(result.states).toBe(null);
    expect(result.agents).toBe(null);
  });
  it('a valid listing with interactive rows but ZERO background rows → `states` degrades to null (#1921), but `agents` is the REAL array — the whole reason this function returns both', () => {
    const exec = (cmd) => {
      if (cmd === 'claude') return JSON.stringify([{ kind: 'interactive', sessionId: 'owner-1', cwd: '/somewhere' }]);
      if (cmd === 'ps') return ''; // scanPsOutput's own `ps aux` read — irrelevant here, just must not throw
      throw new Error(`unexpected exec: ${cmd}`);
    };
    const result = fetchSessionSignals({}, { exec });
    expect(result.states).toBe(null); // #1921 — indistinguishable from a bad read, for the background-only axis
    expect(Array.isArray(result.agents)).toBe(true); // but the raw listing IS real and IS returned
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].sessionId).toBe('owner-1');
  });
  it('a `claude` call that succeeds but returns non-array JSON → agents null too (never a guess at a malformed read)', () => {
    const exec = (cmd) => (cmd === 'claude' ? JSON.stringify({ not: 'an array' }) : '');
    const result = fetchSessionSignals({}, { exec });
    expect(result.states).toBe(null);
    expect(result.agents).toBe(null);
  });
});

describe('reapPlan — the #3383 phantom-listing shape end to end (classifyReap + sessionGoneForLease + sessionPidAliveByName)', () => {
  it('a fresh, well-within-TTL lease whose session is listed "working" but has NO real process → reaped as session-gone', () => {
    // The exact incident shape: lane-62's lease looked identical to a healthy in-progress build from every axis
    // except real process liveness — acquired recently, session still in the listing, state ordinary, TTL nowhere
    // close. Only the ps-scan-backed pidAlive read tells them apart.
    const lease = fresh({ session: 'conveyor-62' });
    const sessions = [{ kind: 'background', name: 'conveyor-62', sessionId: 'dead0000-0000-0000-0000-000000000000', state: 'working' }];
    const sessionStates = sessionStatesForReap(sessions);
    const pidAliveByName = sessionPidAliveByName(sessions, { psOutput: 'no matching session ids in this ps aux capture' });
    const signalsFor = (c) => ({
      prState: null,
      sessionGone: sessionGoneForLease(c.lease, sessionStates, { nowMs: NOW, pidAlive: pidAliveByName.get(c.lease.session) ?? null }),
      pidAlive: null,
    });
    const { reap, keep } = reapPlan([{ pool: 'web-everything', lane: 62, dir: '/x/lane-62', lease }], { nowMs: NOW, ttlMs: TTL_MS, signalsFor });
    expect(reap).toHaveLength(1);
    expect(reap[0].reason).toBe('session-gone');
    expect(keep).toHaveLength(0);
  });
  it('the SAME shape but the ps aux capture DOES contain the session id (a real live process) → kept', () => {
    const lease = fresh({ session: 'conveyor-63' });
    const sessions = [{ kind: 'background', name: 'conveyor-63', sessionId: 'aliv0000-0000-0000-0000-000000000000', state: 'working' }];
    const sessionStates = sessionStatesForReap(sessions);
    const pidAliveByName = sessionPidAliveByName(sessions, { psOutput: 'claude --resume=aliv0000-0000-0000-0000-000000000000' });
    const signalsFor = (c) => ({
      prState: null,
      sessionGone: sessionGoneForLease(c.lease, sessionStates, { nowMs: NOW, pidAlive: pidAliveByName.get(c.lease.session) ?? null }),
      pidAlive: null,
    });
    const { reap, keep } = reapPlan([{ pool: 'web-everything', lane: 63, dir: '/x/lane-63', lease }], { nowMs: NOW, ttlMs: TTL_MS, signalsFor });
    expect(reap).toHaveLength(0);
    expect(keep).toHaveLength(1);
  });
  it('a RESERVED lease is never reaped even when its session reads phantom-dead (reserved short-circuits first)', () => {
    const lease = fresh({ session: 'mem-lane', reserved: true });
    const sessions = [{ kind: 'background', name: 'mem-lane', sessionId: 'dead0000-0000-0000-0000-000000000000', state: 'working' }];
    const sessionStates = sessionStatesForReap(sessions);
    const pidAliveByName = sessionPidAliveByName(sessions, { psOutput: '' });
    const signalsFor = (c) => ({
      prState: null,
      sessionGone: sessionGoneForLease(c.lease, sessionStates, { nowMs: NOW, pidAlive: pidAliveByName.get(c.lease.session) ?? null }),
      pidAlive: null,
    });
    const { reap, keep } = reapPlan([{ pool: 'web-everything', lane: 7, dir: '/x/lane-7', lease }], { nowMs: NOW, ttlMs: TTL_MS, signalsFor });
    expect(reap).toHaveLength(0);
    expect(keep).toHaveLength(1);
    expect(keep[0].reason).toBe('reserved');
  });
});

describe('reapPlan — maps classifyReap over candidates, splitting reap vs keep', () => {
  const candidates = [
    { pool: 'web-everything', lane: 3, dir: '/x/web-everything/lane-3', lease: fresh({ session: 'conveyor-2667' }) },   // fresh, PR open, session alive → keep
    { pool: 'web-everything', lane: 5, dir: '/x/web-everything/lane-5', lease: stale({ session: 'conveyor-2500' }) },   // TTL-stale (and past grace, absent) → reap
    { pool: 'plateau-app', lane: 6, dir: '/x/plateau-app/lane-6', lease: fresh({ session: 'conveyor-2604' }) },         // fresh, PR merged → reap
    { pool: 'web-everything', lane: 7, dir: '/x/web-everything/lane-7', lease: fresh({ session: 'mem', reserved: true, acquiredAt: new Date(NOW - 10 * TTL_MS).toISOString() }) }, // reserved → keep
    { pool: 'web-everything', lane: 8, dir: '/x/web-everything/lane-8', lease: null },                                  // no lease → skipped
    { pool: 'web-everything', lane: 38, dir: '/x/web-everything/lane-38', lease: agedPastGrace() },                     // past grace, session confirmed gone → reap pre-TTL
    { pool: 'web-everything', lane: 40, dir: '/x/web-everything/lane-40', lease: fresh({ session: 'conveyor-2412' }) }, // JUST acquired, session absent but still inside grace → keep (the #1921 finding this pins)
  ];
  const prStates = new Map([['2667', 'open'], ['2604', 'merged']]);
  const sessionStates = sessionStateByName([{ kind: 'background', name: 'conveyor-2667', state: 'working' }]); // 3466/2604/2500/2412 all absent
  const signalsFor = (c) => ({
    prState: prStates.get(itemNumFromSession(c.lease?.session)) ?? null,
    sessionGone: sessionGoneForLease(c.lease, sessionStates, { nowMs: NOW }),
    pidAlive: null,
  });

  it('reaps the TTL-stale, PR-merged, and session-gone lanes; keeps the fresh-alive-open, reserved, and just-acquired; skips the lease-less', () => {
    const { reap, keep } = reapPlan(candidates, { nowMs: NOW, ttlMs: TTL_MS, signalsFor });
    // lane-5's session ('conveyor-2500') is ALSO absent from the listing AND long past the grace window, so
    // session-gone fires (checked before TTL, per classifyReap's axis order) — the more informative real
    // reason, not merely "old enough". lane-40 is absent too but only 1 minute old — inside grace — so it is
    // NOT reaped on this axis (and its TTL is nowhere close either): the #1921 finding this candidate exists
    // to pin.
    expect(reap.map((c) => `${c.pool}/lane-${c.lane}:${c.reason}`).sort()).toEqual([
      'plateau-app/lane-6:pr-merged',
      'web-everything/lane-38:session-gone',
      'web-everything/lane-5:session-gone',
    ]);
    // keep excludes the lease-less candidate (skipped entirely), includes fresh-alive-open + reserved + just-acquired
    expect(keep.map((c) => `${c.pool}/lane-${c.lane}`).sort()).toEqual(['web-everything/lane-3', 'web-everything/lane-40', 'web-everything/lane-7']);
  });

  it('with no signalsFor, only the TTL axis fires (PR/session/pid unknown)', () => {
    const { reap } = reapPlan(candidates, { nowMs: NOW, ttlMs: TTL_MS });
    expect(reap.map((c) => `${c.pool}/lane-${c.lane}:${c.reason}`)).toEqual(['web-everything/lane-5:ttl-stale']);
  });

  it('empty / non-array candidates → empty plan', () => {
    expect(reapPlan([], { nowMs: NOW })).toEqual({ reap: [], keep: [] });
    expect(reapPlan(null, { nowMs: NOW })).toEqual({ reap: [], keep: [] });
  });
});

// #xr4ygg7 (multi-repo slice 9) + #x5wm9ot (bug #2) — a PR_KIND session (fix/review/ci-heal/inspect) now
// resolves its PR number for ANY constellation repo, via prNumFromSession — never itemNumFromSession, which is
// item-kind-only (bug #1's fix). Before #x5wm9ot, `review-`/`ci-heal-`/`inspect-` sessions matched NEITHER
// function at all (only `fix` did) — bug #2's exact TTL-only fallback.
it('every PR_KIND session (fix/review/ci-heal/inspect) resolves its PR number for ANY constellation repo — never itemNumFromSession', () => {
  for (const kind of ['fix', 'review', 'ci-heal', 'inspect']) {
    expect(prNumFromSession(`${kind}-fui-49`)).toBe('49');
    expect(prNumFromSession(`${kind}-pa-49`)).toBe('49');
    expect(prNumFromSession(`${kind}-49`)).toBe('49');
    expect(itemNumFromSession(`${kind}-49`)).toBeNull();
  }
});

describe('repoKeyForPool — #xr4ygg7 the repo a lane-pool DIRECTORY NAME names (ground truth)', () => {
  it('maps every known pool dir name to its repo key', () => {
    expect(repoKeyForPool('web-everything')).toBe('we');
    expect(repoKeyForPool('webeverything')).toBe('we');
    expect(repoKeyForPool('frontierui')).toBe('frontierui');
    expect(repoKeyForPool('plateau-app')).toBe('plateau-app');
  });
  it('an unrecognized pool dir name → null (a one-off scratch clone, never a real per-repo lane pool)', () => {
    expect(repoKeyForPool('we-drain-daemon')).toBeNull();
    expect(repoKeyForPool('pipeline-2248')).toBeNull();
    expect(repoKeyForPool('')).toBeNull();
  });
});

describe('fetchPrStatesForRepo — #xr4ygg7 ONE gh pr list PER REPO, never one shared always-WE read', () => {
  it('scopes the gh call to the repo\'s own constellation slug via the REST path, and returns BOTH keyspaces from the one fetch (#x5wm9ot)', () => {
    const calls = [];
    // PR #900 has head ref `lane/181-x` (item 181's couple) — its OWN PR number (900) is a DIFFERENT number
    // from that item number, on purpose: this is exactly the fix-<PR>-vs-item-number distinction bug #1 named.
    const exec = (cmd, args) => {
      calls.push({ cmd, args });
      return JSON.stringify([{ number: 900, headRefName: 'lane/181-x', state: 'MERGED', mergedAt: '2026-09-22T00:00:00Z' }]);
    };
    const states = fetchPrStatesForRepo('plateau-app', {}, { exec });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('gh');
    // #4415 — REST, not `pr list`: `['api', '-i', 'repos/<slug>/pulls?state=all&per_page=…&page=1']`.
    expect(calls[0].args[0]).toBe('api');
    expect(calls[0].args).toContain('repos/plateauapp/plateau-app/pulls?state=all&per_page=100&page=1');
    expect(states.byItem.get('181')).toBe('merged');  // an item-kind (conveyor-181) lookup
    expect(states.byPr.get('900')).toBe('merged');    // a PR_KIND (fix-900) lookup — DIFFERENT key, same fetch
    expect(states.byItem.get('900')).toBeUndefined(); // the PR's own number is NOT in the item-keyed map
    expect(states.byPr.get('181')).toBeUndefined();   // the item number is NOT in the PR-keyed map
  });
  it('--pr-repo overrides the slug for we ONLY — a sibling repo always reads its own real slug', () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push(args); return '[]'; };
    fetchPrStatesForRepo('we', { 'pr-repo': 'chalbert/some-fork' }, { exec });
    expect(calls[0]).toContain('repos/chalbert/some-fork/pulls?state=all&per_page=100&page=1');
    fetchPrStatesForRepo('frontierui', { 'pr-repo': 'chalbert/some-fork' }, { exec });
    expect(calls[1]).toContain('repos/frontier-ui/frontierui/pulls?state=all&per_page=100&page=1');
  });
  it('--no-check-prs disables the axis with no exec call at all', () => {
    const exec = () => { throw new Error('must not be called'); };
    expect(fetchPrStatesForRepo('we', { 'no-check-prs': true }, { exec })).toBeNull();
  });
  it('an unrecognized repo key → null, no exec call (no slug to scope the read to)', () => {
    const exec = () => { throw new Error('must not be called'); };
    expect(fetchPrStatesForRepo('not-a-real-repo', {}, { exec })).toBeNull();
  });
  it('a gh failure degrades this repo\'s axis to null (TTL-stale still applies), never throws', () => {
    const exec = () => { throw new Error('gh: not authenticated'); };
    expect(fetchPrStatesForRepo('we', {}, { exec })).toBeNull();
  });
});

describe('#xr4ygg7 — the collision hazard the per-repo split closes: same NUMBER, different repos', () => {
  // Reproduces main()'s own composition (candidates tagged by POOL via repoKeyForPool, one {byItem, byPr} pair
  // per distinct repo, signalsFor scoped by each candidate's own repoKey AND its own itemKind-vs-PR_KIND split)
  // using only the exported pure pieces — no fs/gh touched. Proves the exact hazard `fetchPrStatesForRepo`'s
  // docblock names never actually fires: a WE PR #49 merging must NEVER reap a plateau-app lease for its OWN,
  // unrelated item 49 whose real PR is open.
  it('never reaps a live plateau-app lease just because a same-numbered WE PR merged', () => {
    const candidates = [
      { pool: 'web-everything', lane: 3, dir: '/x/web-everything/lane-3', lease: { session: 'fix-49', acquiredAt: new Date(NOW - 60_000).toISOString(), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES }, repoKey: repoKeyForPool('web-everything') },
      { pool: 'plateau-app', lane: 6, dir: '/x/plateau-app/lane-6', lease: { session: 'fix-pa-49', acquiredAt: new Date(NOW - 60_000).toISOString(), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES }, repoKey: repoKeyForPool('plateau-app') },
    ];
    const prStatesByRepo = new Map([
      ['we', { byItem: new Map(), byPr: new Map([['49', 'merged']]) }],       // WE's own PR #49 merged
      ['plateau-app', { byItem: new Map(), byPr: new Map([['49', 'open']]) }], // plateau-app's own PR #49 is still open — unrelated work
    ]);
    const signalsFor = (c) => {
      const itemNum = itemNumFromSession(c.lease?.session);
      const prNum = prNumFromSession(c.lease?.session);
      const repoStates = c.repoKey ? prStatesByRepo.get(c.repoKey) : null;
      const prState = repoStates ? (itemNum != null ? repoStates.byItem.get(itemNum) : prNum != null ? repoStates.byPr.get(prNum) : null) ?? null : null;
      return { prState, sessionGone: null, pidAlive: null };
    };
    const { reap, keep } = reapPlan(candidates, { nowMs: NOW, ttlMs: TTL_MS, signalsFor });
    expect(reap.map((c) => `${c.pool}/lane-${c.lane}:${c.reason}`)).toEqual(['web-everything/lane-3:pr-merged']);
    expect(keep.map((c) => `${c.pool}/lane-${c.lane}`)).toEqual(['plateau-app/lane-6']);
  });

  // #x5wm9ot — bug #1's OWN reproduction: a fix-<PR> session's PR number must be checked against the PR-keyed
  // Map, never the item-number-keyed one, even when they happen to share a repo. Here the couple's ITEM number
  // (181) and the fix session's PR number (49) are DELIBERATELY DIFFERENT and DELIBERATELY DISAGREE in state
  // (open vs merged) — using the wrong Map for either lookup would flip the verdict.
  it('bug #1 — a fix-<PR> session checks the PR-keyed Map by its OWN PR number, never the item-keyed Map', () => {
    const candidates = [
      { pool: 'web-everything', lane: 9, dir: '/x/web-everything/lane-9', lease: { session: 'fix-49', acquiredAt: new Date(NOW - 60_000).toISOString(), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES }, repoKey: 'we' },
    ];
    // item 181 (an unrelated card, coincidentally open) vs PR #49 (the fix session's OWN target, merged).
    const repoStates = { byItem: new Map([['181', 'open']]), byPr: new Map([['49', 'merged']]) };
    const signalsFor = (c) => {
      const itemNum = itemNumFromSession(c.lease?.session);
      const prNum = prNumFromSession(c.lease?.session);
      const prState = (itemNum != null ? repoStates.byItem.get(itemNum) : prNum != null ? repoStates.byPr.get(prNum) : null) ?? null;
      return { prState, sessionGone: null, pidAlive: null };
    };
    const { reap } = reapPlan(candidates, { nowMs: NOW, ttlMs: TTL_MS, signalsFor });
    // Correctly reaped via the PR-keyed lookup (PR #49 is merged) — the old bug would have looked itemNum (null,
    // since itemNumFromSession('fix-49') is null post-fix) up nowhere, or, pre-fix, have used '49' as an ITEM
    // number and wrongly read item 181's unrelated 'open' state (or nothing at all).
    expect(reap.map((c) => `${c.pool}/lane-${c.lane}:${c.reason}`)).toEqual(['web-everything/lane-9:pr-merged']);
  });
});

// #xkk4lv7 — CAPACITY-CAP ROOT CAUSE: a lease whose `session` names NO dispatcher grammar at all (a bare
// `lane-pool.mjs acquire --purpose=<slug>` with no recognizable `--session=`) is invisible to BOTH
// `itemNumFromSession`/`prNumFromSession`-keyed axes, so it rode the 4-hour TTL backstop even once its PR had
// objectively merged — live evidence: lane-2 (`soak-gate-merge-base`, PR #2825 MERGED) and lane-9
// (`promote-stale-green`, PR #2826 MERGED) both sat leased well past their PR's merge. `laneBranchItemNum` /
// `laneQuietSincePr` / `resolveLeaseItemNum` below close that gap; three light plan review rounds each found a
// prior shape of the fix unsafe (Risks 8-9 in the card), so every regression they surfaced has its own case.
describe('#xkk4lv7 — laneBranchItemNum: the lane\'s own checked-out branch, via the SAME lane/<num>-* grammar matchLaneRef already trusts for a PR head ref', () => {
  it('resolves a digit item id from lane/<num>-<slug>', () => {
    expect(laneBranchItemNum('/x/lane-2', { git: () => 'lane/2825-soak-gate-merge-base' })).toBe('2825');
  });
  it('resolves (and lower-cases) a HASH id from lane/x<hash>-<slug> — matchLaneRef accepts a shape parseSessionSlug deliberately never does (test plan #6)', () => {
    expect(laneBranchItemNum('/x/lane-3', { git: () => 'lane/X9YLKP7-some-slug' })).toBe('x9ylkp7');
  });
  it('a retry suffix still collapses to the base number, same as the PR-headRef grammar', () => {
    expect(laneBranchItemNum('/x/lane-4', { git: () => 'lane/2500b-retry-slug' })).toBe('2500');
  });
  it('null for the lane\'s own integration branch — the byte-for-byte common case for a lane worked through the standard delivery-agent brief, where the item lives only in --session, never the branch', () => {
    expect(laneBranchItemNum('/x/lane-5', { git: () => 'main' })).toBeNull();
  });
  it('null on a detached HEAD / mid-rebase / any git-read failure — never guess, never throw', () => {
    expect(laneBranchItemNum('/x/lane-6', { git: () => null })).toBeNull();
    expect(laneBranchItemNum('/x/lane-7', { git: () => { throw new Error('fatal: not a git repository'); } })).toBeNull();
  });
});

describe('#xkk4lv7 — laneQuietSincePr: Fork 2/Option C\'s safety gate — a branch-derived merged/closed verdict is corroborated, NEVER trusted bare', () => {
  const QUIET = DEFAULT_QUIET_MS;
  const old = (msAgo) => new Date(NOW - msAgo).toISOString();

  it('ALL THREE hold (clean, contained HEAD, both merge AND acquire older than the quiet window) → true — test plan #4, case 4', () => {
    expect(laneQuietSincePr('/x/lane-2', {
      prMergeSha: 'deadbeef', prMergedAt: old(QUIET + 3600_000), leaseAcquiredAt: old(QUIET + 7200_000), nowMs: NOW,
      statusPorcelain: () => '', isAncestor: () => true,
    })).toBe(true);
  });

  it('a dirty tree → false, never reap (a live worker\'s own uncommitted change) — test plan #4, case 1', () => {
    expect(laneQuietSincePr('/x/lane-2', {
      prMergeSha: 'deadbeef', prMergedAt: old(QUIET + 3600_000), leaseAcquiredAt: old(QUIET + 3600_000), nowMs: NOW,
      statusPorcelain: () => ' M scripts/some-file.mjs\n', isAncestor: () => true,
    })).toBe(false);
  });

  it('HEAD carries commits beyond the merge (not an ancestor) → false, never reap — live, un-landed work in the same lane — test plan #4, case 1 (commits variant)', () => {
    expect(laneQuietSincePr('/x/lane-2', {
      prMergeSha: 'deadbeef', prMergedAt: old(QUIET + 3600_000), leaseAcquiredAt: old(QUIET + 3600_000), nowMs: NOW,
      statusPorcelain: () => '', isAncestor: () => false,
    })).toBe(false);
  });

  it('round-2 shape — clean + contained HEAD, but the PR merged only 5 minutes ago (lease acquired long ago) → false: the quiet window hasn\'t elapsed — test plan #4, case 2', () => {
    expect(laneQuietSincePr('/x/lane-2', {
      prMergeSha: 'deadbeef', prMergedAt: old(5 * 60_000), leaseAcquiredAt: old(10 * 24 * 3600_000), nowMs: NOW,
      statusPorcelain: () => '', isAncestor: () => true,
    })).toBe(false);
  });

  it('round-3 shape — the PR merged long ago, but THIS lease was acquired FRESH 5 minutes ago → false: anchored to the LATER of mergedAt/acquiredAt, never mergedAt alone — test plan #4, case 3', () => {
    expect(laneQuietSincePr('/x/lane-2', {
      prMergeSha: 'deadbeef', prMergedAt: old(10 * 24 * 3600_000), leaseAcquiredAt: old(5 * 60_000), nowMs: NOW,
      statusPorcelain: () => '', isAncestor: () => true,
    })).toBe(false);
  });

  it('missing/unparseable prMergeSha, prMergedAt, or leaseAcquiredAt → null, never a guess', () => {
    const base = { prMergedAt: old(QUIET + 3600_000), leaseAcquiredAt: old(QUIET + 3600_000), nowMs: NOW, statusPorcelain: () => '', isAncestor: () => true };
    expect(laneQuietSincePr('/x/lane-2', { ...base, prMergeSha: null })).toBeNull();
    expect(laneQuietSincePr('/x/lane-2', { ...base, prMergeSha: 'deadbeef', prMergedAt: 'not-a-date' })).toBeNull();
    expect(laneQuietSincePr('/x/lane-2', { ...base, prMergeSha: 'deadbeef', leaseAcquiredAt: undefined })).toBeNull();
  });

  it('an unreadable working tree (git status failure) → null, never a guess', () => {
    expect(laneQuietSincePr('/x/lane-2', {
      prMergeSha: 'deadbeef', prMergedAt: old(QUIET + 3600_000), leaseAcquiredAt: old(QUIET + 3600_000), nowMs: NOW,
      statusPorcelain: () => null, isAncestor: () => true,
    })).toBeNull();
  });

  it('an unresolvable ancestry check (git failure, not the ordinary "not an ancestor" exit) → null, never a guess', () => {
    expect(laneQuietSincePr('/x/lane-2', {
      prMergeSha: 'deadbeef', prMergedAt: old(QUIET + 3600_000), leaseAcquiredAt: old(QUIET + 3600_000), nowMs: NOW,
      statusPorcelain: () => '', isAncestor: () => null,
    })).toBeNull();
  });
});

// #4337 — real-git integration coverage of `defaultGitIsAncestor` itself (the `laneQuietSincePr` cases above
// all inject a MOCKED `isAncestor`, so none of them ever exercise the real `git merge-base`/`git cherry`/
// `git rev-list` fallback this function actually runs in production — confirmed absent before this card).
// Each fixture below is a REAL git repo (no mocked readers at all — `laneQuietSincePr` is called with only
// `dir`/`prMergeSha`/`prMergedAt`/`leaseAcquiredAt`/`nowMs`, so it falls through to the real
// `defaultGitIsAncestor` + `defaultGitStatusPorcelain`).
describe('#4337 — defaultGitIsAncestor (via laneQuietSincePr, real git, no mocked readers): the merge-commit blind spot', () => {
  const QUIET = DEFAULT_QUIET_MS;
  const old = (msAgo) => new Date(NOW - msAgo).toISOString();
  // Anchor both `mergedAt` and `acquiredAt` well past the quiet window so the ONLY thing under test is the
  // containment axis itself — a clean tree, quiet long enough, the sole variable is `prMergeSha`'s containment.
  const quietTimestamps = { prMergedAt: old(QUIET + 3600_000), leaseAcquiredAt: old(QUIET + 3600_000), nowMs: NOW };

  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const initRepo = (dir) => {
    mkdirSync(dir, { recursive: true });
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
  };

  let root;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'we-lease-reaper-ancestor-')); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('a literal --no-ff merge landing (sha IS the merge commit, HEAD is its own parent) → true — the common, untouched fast path', () => {
    const dir = join(root, 'literal-ancestor');
    initRepo(dir);
    writeFileSync(join(dir, 'f.txt'), 'v0\n');
    git(['add', 'f.txt'], dir);
    git(['commit', '-q', '-m', 'C0'], dir);
    git(['checkout', '-q', '-b', 'lane'], dir);
    writeFileSync(join(dir, 'lane-only.txt'), 'lane\n');
    git(['add', 'lane-only.txt'], dir);
    git(['commit', '-q', '-m', 'C1: lane work'], dir);
    const laneHead = git(['rev-parse', 'HEAD'], dir).trim();
    // land it: a real merge commit on `main`, --no-ff, whose second parent IS the lane's own HEAD.
    git(['checkout', '-q', 'main'], dir);
    git(['merge', '--no-ff', '-q', '-m', 'land lane', 'lane'], dir);
    const mergeSha = git(['rev-parse', 'HEAD'], dir).trim();
    // re-checkout the lane's OWN tip as the working tree under test (the lane clone never advances past its
    // own HEAD just because `main` landed it) — `laneQuietSincePr` reads THIS dir's HEAD, not `main`'s.
    git(['checkout', '-q', laneHead], dir);
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: mergeSha })).toBe(true);
  });

  it('squash/rebase patch-equivalence (single lane commit, no merge commit anywhere) → true — the existing round-1 finding, unmodified', () => {
    const dir = join(root, 'squash-equivalent');
    initRepo(dir);
    writeFileSync(join(dir, 'f.txt'), 'v0\n');
    git(['add', 'f.txt'], dir);
    git(['commit', '-q', '-m', 'C0'], dir);
    git(['checkout', '-q', '-b', 'lane'], dir);
    writeFileSync(join(dir, 'lane-only.txt'), 'lane\n');
    git(['add', 'lane-only.txt'], dir);
    git(['commit', '-q', '-m', 'C1: lane work'], dir);
    // `sha`: a DIFFERENT commit, same diff (patch-equivalent), reached by an unrelated path — no shared
    // ancestry with `lane` beyond C0, and NO merge commit anywhere in either history.
    git(['checkout', '-q', '-b', 'landed', 'main'], dir);
    writeFileSync(join(dir, 'lane-only.txt'), 'lane\n');
    git(['add', 'lane-only.txt'], dir);
    git(['commit', '-q', '-m', 'squash-landed: same diff, different commit'], dir);
    const landedSha = git(['rev-parse', 'HEAD'], dir).trim();
    git(['checkout', '-q', 'lane'], dir);
    // sanity: NOT a literal ancestor either way (git's own exit-1 contract — merge-base throws on "not an
    // ancestor", so a clean throw here is exactly the fallback-to-cherry path this fixture means to exercise).
    expect(() => git(['merge-base', '--is-ancestor', 'HEAD', landedSha], dir)).toThrow();
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: landedSha })).toBe(true);
  });

  it('THE BUG (#4337, live on PR #2835): a merge commit carrying unique conflict-resolution content, unreachable from `sha`, while every non-merge commit IS patch-equivalent upstream → false, never falsely "contained"', () => {
    const dir = join(root, 'unaccounted-merge');
    initRepo(dir);
    writeFileSync(join(dir, 'conflict.txt'), 'v0\n');
    git(['add', 'conflict.txt'], dir);
    git(['commit', '-q', '-m', 'C0: base'], dir);

    // lane: ONE non-merge commit, touching a file disjoint from the eventual conflict — this is the commit
    // that must end up patch-equivalent upstream (so cherry alone reads "contained").
    git(['checkout', '-q', '-b', 'lane'], dir);
    writeFileSync(join(dir, 'lane-only.txt'), 'lane-only\n');
    git(['add', 'lane-only.txt'], dir);
    git(['commit', '-q', '-m', 'C1: lane-only file'], dir);
    const laneC1 = git(['rev-parse', 'HEAD'], dir).trim();

    // other: represents progress already landed upstream, independent of the lane's own commit.
    git(['checkout', '-q', '-b', 'other', 'main'], dir);
    writeFileSync(join(dir, 'conflict.txt'), 'other-v\n');
    git(['add', 'conflict.txt'], dir);
    git(['commit', '-q', '-m', 'C2: other change (already upstream)'], dir);

    // merge other into lane (clean auto-merge: disjoint files so far), then extend the merge commit itself
    // with unique resolution content — content that exists ONLY in the merge commit's own tree, never as an
    // independently cherry-pickable patch (exactly what a real conflict resolution adds beyond the mechanical
    // union of its two parents).
    git(['checkout', '-q', 'lane'], dir);
    git(['merge', '--no-ff', '-q', '-m', 'M: merge other into lane', 'other'], dir);
    writeFileSync(join(dir, 'conflict.txt'), 'other-v\nresolved-unique-content\n');
    git(['add', 'conflict.txt'], dir);
    git(['commit', '-q', '--amend', '-m', 'M: merge other into lane (unique resolution)'], dir);
    const laneHead = git(['rev-parse', 'HEAD'], dir).trim();
    expect(laneHead).not.toBe(laneC1); // sanity: HEAD really is the merge commit, not C1

    // `sha`: what's "already landed" — other's own change, plus a SEPARATE, patch-equivalent recreation of
    // lane's C1 (a different commit id, same diff) — but NEVER the merge commit or its unique resolution.
    git(['checkout', '-q', '-b', 'landed', 'other'], dir);
    git(['cherry-pick', laneC1], dir);
    const landedSha = git(['rev-parse', 'HEAD'], dir).trim();

    git(['checkout', '-q', 'lane'], dir);
    // Ground the fixture: cherry alone (pre-fix logic) reads this as fully contained — every non-merge commit
    // patch-equivalent, the merge commit invisible to it either way.
    const cherryOut = git(['cherry', '--', landedSha, 'HEAD'], dir);
    const cherryLines = cherryOut.split('\n').filter(Boolean);
    expect(cherryLines.length === 0 || cherryLines.every((l) => l.startsWith('-'))).toBe(true);
    // The merge commit really is reachable from HEAD and NOT from `sha` — the exact condition the fix vetoes on.
    const unaccountedMerges = git(['rev-list', '--merges', '--end-of-options', `${landedSha}..HEAD`, '--'], dir).trim();
    expect(unaccountedMerges.length).toBeGreaterThan(0);

    // BEFORE this card's fix: this returned `true` (falsely "contained", the lease reclaimable — PR #2835).
    // AFTER: `false` — the merge's unique content is never accounted for, so the lane is correctly retained.
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: landedSha })).toBe(false);
  });

  it('a routine, CONTENT-FREE merge (a lane merging `main` into itself to stay fresh, no unique resolution content at all) is STILL vetoed → false, never `true` — the fix is deliberately conservative on EXISTENCE alone, not just on merges carrying unique content (this is the intended, documented tradeoff, not a narrower one)', () => {
    const dir = join(root, 'benign-merge');
    initRepo(dir);
    writeFileSync(join(dir, 'f.txt'), 'v0\n');
    git(['add', 'f.txt'], dir);
    git(['commit', '-q', '-m', 'C0: base'], dir);

    git(['checkout', '-q', '-b', 'lane'], dir);
    writeFileSync(join(dir, 'lane-only.txt'), 'lane-only\n');
    git(['add', 'lane-only.txt'], dir);
    git(['commit', '-q', '-m', 'C1: lane-only file'], dir);
    const laneC1 = git(['rev-parse', 'HEAD'], dir).trim();

    // other: unrelated upstream progress, disjoint file — merging it into lane is a routine "stay fresh" sync,
    // introducing NO unique content of its own (a clean, mechanical union — no amend, no manual resolution).
    git(['checkout', '-q', '-b', 'other', 'main'], dir);
    writeFileSync(join(dir, 'other-only.txt'), 'other-only\n');
    git(['add', 'other-only.txt'], dir);
    git(['commit', '-q', '-m', 'C2: other change (already upstream)'], dir);

    git(['checkout', '-q', 'lane'], dir);
    git(['merge', '--no-ff', '-q', '-m', 'routine sync merge (no unique content)', 'other'], dir);
    const laneHead = git(['rev-parse', 'HEAD'], dir).trim();
    expect(laneHead).not.toBe(laneC1); // sanity: HEAD really is the merge commit

    // `sha`: other's own change, plus a patch-equivalent recreation of lane's C1 — same shape as the bug
    // fixture above, but this merge commit adds NOTHING beyond the trivial union of its two parents.
    git(['checkout', '-q', '-b', 'landed', 'other'], dir);
    git(['cherry-pick', laneC1], dir);
    const landedSha = git(['rev-parse', 'HEAD'], dir).trim();

    git(['checkout', '-q', 'lane'], dir);
    const unaccountedMerges = git(['rev-list', '--merges', '--end-of-options', `${landedSha}..HEAD`, '--'], dir).trim();
    expect(unaccountedMerges.length).toBeGreaterThan(0); // the routine merge commit itself is still unaccounted for

    // Vetoed anyway: the fix disqualifies on the merge commit's mere EXISTENCE in the unaccounted range, not on
    // detecting unique content within it (detecting "this merge's diff really is trivial" would require trusting
    // the same kind of per-commit patch reasoning that caused the original bug) — a deliberate, documented
    // false-negative bias (Risks: "must stay conservative in the SAFE direction only"), pinned here so it reads
    // as an intentional test, not an unnoticed side effect.
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: landedSha })).toBe(false);
  });
});

// #4339 — the multi-commit squash gap (guard 2 owed by #2835's review; guard 1 is already pinned by the
// `THE BUG (#4337 …)` fixture above). A squash of N>1 lane commits is ONE upstream commit whose patch-id equals
// none of the N, so `git cherry` alone reads `+` lines. Real-git fixtures, no mocked readers.
describe('#4339 — defaultGitIsAncestor: multi-commit squash aggregate containment (real git)', () => {
  const QUIET = DEFAULT_QUIET_MS;
  const old = (msAgo) => new Date(NOW - msAgo).toISOString();
  const quietTimestamps = { prMergedAt: old(QUIET + 3600_000), leaseAcquiredAt: old(QUIET + 3600_000), nowMs: NOW };
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commitFile = (dir, name, content, msg) => {
    writeFileSync(join(dir, name), content);
    git(['add', name], dir);
    git(['commit', '-q', '-m', msg], dir);
  };
  const initRepo = (dir) => {
    mkdirSync(dir, { recursive: true });
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    commitFile(dir, 'base.txt', 'v0\n', 'C0');
  };
  const sha = (dir) => git(['rev-parse', 'HEAD'], dir).trim();
  // Lane branch `lane` (left checked out) with commits `a` and `b`.
  const laneWithTwoCommits = (dir) => {
    initRepo(dir);
    git(['checkout', '-q', '-b', 'lane'], dir);
    commitFile(dir, 'a.txt', 'a\n', 'lane a');
    commitFile(dir, 'b.txt', 'b\n', 'lane b');
  };
  // A single upstream commit off `main`'s C0 writing the given files, returns its sha; lane is re-checked out.
  const squashOf = (dir, files, base = 'main') => {
    git(['checkout', '-q', '-b', `landed-${Math.random().toString(36).slice(2)}`, base], dir);
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'squash'], dir);
    const out = sha(dir);
    git(['checkout', '-q', 'lane'], dir);
    return out;
  };

  let root;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'we-lease-reaper-squash-')); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('multi-commit squash: two distinct lane commits landed as ONE squash commit → true (cherry alone reads two `+` lines)', () => {
    const dir = join(root, 'n2-squash');
    laneWithTwoCommits(dir);
    const landed = squashOf(dir, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const cherry = git(['cherry', '--', landed, 'HEAD'], dir).split('\n').filter(Boolean);
    expect(cherry).toHaveLength(2);
    expect(cherry.every((l) => l.startsWith('+'))).toBe(true);
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: landed })).toBe(true);
  });

  it('multi-commit squash: an incomplete squash (only `a`) → false', () => {
    const dir = join(root, 'n2-incomplete');
    laneWithTwoCommits(dir);
    const landed = squashOf(dir, { 'a.txt': 'a\n' });
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: landed })).toBe(false);
  });

  it('multi-commit squash: same two files but different content in `b` → false', () => {
    const dir = join(root, 'n2-different-content');
    laneWithTwoCommits(dir);
    const landed = squashOf(dir, { 'a.txt': 'a\n', 'b.txt': 'DIFFERENT\n' });
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: landed })).toBe(false);
  });

  it('multi-commit squash: the merge veto decides — {a,b} plus a content-free `merge other`, aggregate diff still equals the squash → false', () => {
    const dir = join(root, 'n2-veto');
    initRepo(dir);
    git(['checkout', '-q', '-b', 'other'], dir);
    commitFile(dir, 'other.txt', 'o\n', 'other upstream progress');
    git(['checkout', '-q', '-b', 'lane', 'main'], dir);
    commitFile(dir, 'a.txt', 'a\n', 'lane a');
    commitFile(dir, 'b.txt', 'b\n', 'lane b');
    git(['merge', '--no-ff', '-q', '-m', 'sync other', 'other'], dir);
    const landed = squashOf(dir, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'other');
    // ground: merge-base(HEAD, landed) is `other`'s tip, so the aggregate diff really equals the squash diff
    const base = git(['merge-base', 'HEAD', landed], dir).trim();
    expect(git(['diff', '--name-only', base, 'HEAD'], dir).trim().split('\n').sort()).toEqual(['a.txt', 'b.txt']);
    expect(git(['rev-list', '--merges', '--end-of-options', `${landed}..HEAD`, '--'], dir).trim()).not.toBe('');
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: landed })).toBe(false);
  });

  it('multi-commit squash: a merge-commit `sha` whose first-parent diff matches → false (the single-parent check skips the tier)', () => {
    const dir = join(root, 'n2-merge-sha');
    laneWithTwoCommits(dir);
    git(['checkout', '-q', '-b', 'feat', 'main'], dir);
    commitFile(dir, 'a.txt', 'a\n', 'feat squashed part 1');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], dir);
    git(['commit', '-q', '--amend', '--no-edit'], dir);
    git(['checkout', '-q', '-b', 'landed', 'main'], dir);
    git(['merge', '--no-ff', '-q', '-m', 'land feat', 'feat'], dir);
    const landed = sha(dir);
    git(['checkout', '-q', 'lane'], dir);
    expect(git(['rev-list', '--parents', '-n1', landed], dir).trim().split(' ')).toHaveLength(3);
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: landed })).toBe(false);
  });

  it('multi-commit squash: a net-empty lane diff (commit then revert) vs an empty `sha` → false, two empty patch-ids never compare equal', () => {
    const dir = join(root, 'n2-empty');
    initRepo(dir);
    git(['checkout', '-q', '-b', 'lane'], dir);
    commitFile(dir, 'a.txt', 'a\n', 'lane add');
    git(['revert', '--no-edit', 'HEAD'], dir);
    git(['checkout', '-q', '-b', 'landed', 'main'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'empty squash'], dir);
    const landed = sha(dir);
    git(['checkout', '-q', 'lane'], dir);
    expect(laneQuietSincePr(dir, { ...quietTimestamps, prMergeSha: landed })).toBe(false);
  });

  it('multi-commit squash: an aggregate read failure (patch-id spawn throws) → null, never a guess', () => {
    const exec = (bin, args) => {
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') { const e = new Error('not an ancestor'); e.status = 1; throw e; }
      if (args[0] === 'merge-base') return 'basesha\n';
      if (args[0] === 'cherry') return '+ 1111\n+ 2222\n';
      if (args[0] === 'rev-list' && args.includes('--merges')) return '';
      if (args[0] === 'rev-list' && args.includes('--parents')) return 'deadbeef parentsha\n';
      if (args[0] === 'diff') return 'some diff';
      if (args[0] === 'patch-id') throw new Error('spawn ETIMEDOUT');
      throw new Error(`unexpected git subcommand in test: ${args[0]}`);
    };
    expect(defaultGitIsAncestor('/x/lane-9', 'deadbeef', { exec })).toBeNull();
  });
});

// #4337 — the new `git rev-list --merges` veto's OWN inconclusive-read path, pinned directly (an injected fake
// `exec`, mirroring how every other axis in this file already tests its git-read failure contract) since
// forcing a real `git rev-list` call to fail — while the two calls ahead of it in the SAME function (`git
// merge-base`, `git cherry`) both succeed against the very same `sha` — has no honest real-git construction.
describe('#4337 — defaultGitIsAncestor: the new rev-list veto\'s own catch branch, never a guess on failure', () => {
  it('merge-base "not an ancestor" + cherry "contained" + rev-list THROWS (timeout / unresolvable range) → null, never true or false', () => {
    const calls = [];
    const exec = (bin, args) => {
      calls.push(args[0]);
      if (args[0] === 'merge-base') { const e = new Error('not an ancestor'); e.status = 1; throw e; }
      if (args[0] === 'cherry') return ''; // empty — cherry reads "contained"
      if (args[0] === 'rev-list') throw new Error('spawn ETIMEDOUT'); // the new veto's own read fails
      throw new Error(`unexpected git subcommand in test: ${args[0]}`);
    };
    expect(defaultGitIsAncestor('/x/lane-9', 'deadbeef', { exec })).toBeNull();
    expect(calls).toEqual(['merge-base', 'cherry', 'rev-list']); // proves the veto's OWN call actually ran
  });

  it('merge-base "not an ancestor" + cherry "contained" + rev-list finds a merge → false (the paired success path, same fixture shape)', () => {
    const exec = (bin, args) => {
      if (args[0] === 'merge-base') { const e = new Error('not an ancestor'); e.status = 1; throw e; }
      if (args[0] === 'cherry') return '';
      if (args[0] === 'rev-list') return 'deadbeefcafe\n';
      throw new Error(`unexpected git subcommand in test: ${args[0]}`);
    };
    expect(defaultGitIsAncestor('/x/lane-9', 'deadbeef', { exec })).toBe(false);
  });

  it('a dash-prefixed `sha` (malformed/untrusted API data) is never misread as a flag by the new rev-list call — mirrors the round-5 security property already relied on for merge-base/cherry, now pinned for rev-list too', () => {
    const revListArgs = [];
    const exec = (bin, args) => {
      if (args[0] === 'merge-base') { const e = new Error('not an ancestor'); e.status = 1; throw e; }
      if (args[0] === 'cherry') return '';
      if (args[0] === 'rev-list') { revListArgs.push(args); return ''; }
      throw new Error(`unexpected git subcommand in test: ${args[0]}`);
    };
    defaultGitIsAncestor('/x/lane-9', '-malicious-looking-sha', { exec });
    expect(revListArgs).toHaveLength(1);
    // `--end-of-options` sits immediately before the range, and the range string is passed as ONE argv entry
    // (never shell-interpolated) — so a leading `-` in `sha` can never be parsed as a flag by git.
    expect(revListArgs[0]).toEqual(['rev-list', '--merges', '--max-count=1', '--end-of-options', '-malicious-looking-sha..HEAD', '--']);
  });
});

describe('#xkk4lv7 — resolveLeaseItemNum + reapPlan through the REAL resolution path (fetchPrStatesForRepo + resolveLeaseItemNum + reapPlan) — test plan #1/#2', () => {
  const QUIET = DEFAULT_QUIET_MS;
  const old = (msAgo) => new Date(NOW - msAgo).toISOString();
  // The exact production composition `main()`'s own `signalsFor` drives — reused here so this test exercises
  // the REAL resolution path, never a hand-picked `classifyReap` call (the light plan review's own framing:
  // the original #1/#2 pair was a characterization test against `classifyReap` directly, not a real regression).
  const buildSignalsFor = (repoStates, resolverOpts = {}) => (c) => {
    const { itemNum, prNum } = resolveLeaseItemNum(c.lease, c.dir, { repoStates, nowMs: NOW, ...resolverOpts });
    const prState = repoStates
      ? (itemNum != null ? repoStates.byItem.get(itemNum) : prNum != null ? repoStates.byPr.get(prNum) : null) ?? null
      : null;
    return { prState, sessionGone: null, pidAlive: null };
  };

  it('test plan #1/#2 — the lane-2/lane-9 shape: a non-dispatcher session (`Mac:12345`, the defaultSession() shape) whose lane branch matches a MERGED PR with a matching headRefName → reaped, `reason: pr-merged`, once corroborated', () => {
    const exec = () => JSON.stringify([{
      number: 500, headRefName: 'lane/2825-soak-gate-merge-base', state: 'MERGED',
      mergedAt: old(QUIET + 3600_000), mergeCommit: { oid: 'deadbeef' },
    }]);
    const repoStates = fetchPrStatesForRepo('we', {}, { exec });
    const lease = { session: 'Mac:12345', acquiredAt: old(QUIET + 7200_000), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES };
    const candidates = [{ pool: 'web-everything', lane: 2, dir: '/x/web-everything/lane-2', lease, repoKey: 'we' }];
    const resolverOpts = { git: () => 'lane/2825-soak-gate-merge-base', statusPorcelain: () => '', isAncestor: () => true };
    const { reap, keep } = reapPlan(candidates, { nowMs: NOW, ttlMs: TTL_MS, signalsFor: buildSignalsFor(repoStates, resolverOpts) });
    expect(reap.map((c) => `${c.pool}/lane-${c.lane}:${c.reason}`)).toEqual(['web-everything/lane-2:pr-merged']);
    expect(keep).toHaveLength(0);
  });

  it('the SAME shape but NOT YET corroborated (PR merged 5 minutes ago) → kept, not reaped (the quiet window is the whole point)', () => {
    const exec = () => JSON.stringify([{
      number: 500, headRefName: 'lane/2825-soak-gate-merge-base', state: 'MERGED',
      mergedAt: old(5 * 60_000), mergeCommit: { oid: 'deadbeef' },
    }]);
    const repoStates = fetchPrStatesForRepo('we', {}, { exec });
    const lease = { session: 'Mac:12345', acquiredAt: old(QUIET + 7200_000), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES };
    const candidates = [{ pool: 'web-everything', lane: 9, dir: '/x/web-everything/lane-9', lease, repoKey: 'we' }];
    const resolverOpts = { git: () => 'lane/2825-soak-gate-merge-base', statusPorcelain: () => '', isAncestor: () => true };
    const { reap, keep } = reapPlan(candidates, { nowMs: NOW, ttlMs: TTL_MS, signalsFor: buildSignalsFor(repoStates, resolverOpts) });
    expect(reap).toHaveLength(0);
    expect(keep).toHaveLength(1);
  });

  it('test plan #3 (Fork 1, REQUIRED) — namespace-conflict: a fix-900 session (PR #900 OPEN) whose lane branch happens to be tied to a DIFFERENT, already-merged item — the branch fallback NEVER fires because prNumFromSession already resolved something', () => {
    const exec = () => JSON.stringify([
      { number: 900, headRefName: 'lane/900-fixer-target', state: 'OPEN', mergedAt: null, mergeCommit: null },
      { number: 501, headRefName: 'lane/7777-unrelated-merged-item', state: 'MERGED', mergedAt: old(QUIET + 3600_000), mergeCommit: { oid: 'cafef00d' } },
    ]);
    const repoStates = fetchPrStatesForRepo('we', {}, { exec });
    const lease = { session: 'fix-900', acquiredAt: old(QUIET + 7200_000), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES };
    const candidates = [{ pool: 'web-everything', lane: 12, dir: '/x/web-everything/lane-12', lease, repoKey: 'we' }];
    // Even if the git reader below fired, it would resolve '7777' — proving Fork 1 by showing the reap plan
    // stays 'keep' regardless of what the branch names, because prNumFromSession('fix-900') already answered.
    const resolverOpts = { git: () => 'lane/7777-unrelated-merged-item', statusPorcelain: () => '', isAncestor: () => true };
    const { reap, keep } = reapPlan(candidates, { nowMs: NOW, ttlMs: TTL_MS, signalsFor: buildSignalsFor(repoStates, resolverOpts) });
    expect(reap).toHaveLength(0);
    expect(keep).toHaveLength(1);
    expect(keep[0].reason).toBeNull(); // PR #900 open — no axis fires
  });

  it('test plan #6 — the hash-branch case: a lane/x<hash>-* branch resolves a PR state UNREACHABLE via itemNumFromSession (parseSessionSlug never accepts a hash-shaped item), and reaps once corroborated', () => {
    const exec = () => JSON.stringify([{
      number: 777, headRefName: 'lane/x9ylkp7-some-slug', state: 'MERGED',
      mergedAt: old(QUIET + 3600_000), mergeCommit: { oid: 'ba5eba11' },
    }]);
    const repoStates = fetchPrStatesForRepo('we', {}, { exec });
    const lease = { session: 'Mac:99999', acquiredAt: old(QUIET + 7200_000), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES };
    const candidates = [{ pool: 'web-everything', lane: 21, dir: '/x/web-everything/lane-21', lease, repoKey: 'we' }];
    const resolverOpts = { git: () => 'lane/X9YLKP7-some-slug', statusPorcelain: () => '', isAncestor: () => true };
    const { reap } = reapPlan(candidates, { nowMs: NOW, ttlMs: TTL_MS, signalsFor: buildSignalsFor(repoStates, resolverOpts) });
    expect(reap.map((c) => `${c.pool}/lane-${c.lane}:${c.reason}`)).toEqual(['web-everything/lane-21:pr-merged']);
  });

  it('test plan addendum — the live `build-4306` shape: itemNumFromSession(\'build-4306\') is null (no `build` alternative in the grammar), but the branch fallback resolves item 4306 for as long as its PR is open, then reaps once that PR merges and the quiet window elapses', () => {
    const dispatchedSession = { session: 'build-4306', acquiredAt: old(60_000), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES };
    const candidates = [{ pool: 'web-everything', lane: 10, dir: '/x/web-everything/lane-10', lease: dispatchedSession, repoKey: 'we' }];
    const resolverOpts = { git: () => 'lane/4306-some-slug', statusPorcelain: () => '', isAncestor: () => true };

    // Phase 1 — PR still open: the branch fallback resolves the item (proving it is reachable at all — the
    // "for scope/overlap purposes" half of the addendum), but nothing reaps (open PR, and the lease is fresh).
    const openExec = () => JSON.stringify([{ number: 4306, headRefName: 'lane/4306-some-slug', state: 'OPEN', mergedAt: null, mergeCommit: null }]);
    const openRepoStates = fetchPrStatesForRepo('we', {}, { exec: openExec });
    const { itemNum } = resolveLeaseItemNum(dispatchedSession, '/x/web-everything/lane-10', { repoStates: openRepoStates, nowMs: NOW, ...resolverOpts });
    expect(itemNum).toBe('4306');
    const { reap: reapWhileOpen, keep: keepWhileOpen } = reapPlan(candidates, { nowMs: NOW, ttlMs: TTL_MS, signalsFor: buildSignalsFor(openRepoStates, resolverOpts) });
    expect(reapWhileOpen).toHaveLength(0);
    expect(keepWhileOpen).toHaveLength(1);

    // Phase 2 — the SAME lease, PR now merged long enough ago (and the lease itself old enough) → reaps via
    // the branch-based lookup, proving the fallback generalizes beyond the soak-gate-merge-base/promote-stale-
    // green shape the primary fixture above uses.
    const mergedExec = () => JSON.stringify([{ number: 4306, headRefName: 'lane/4306-some-slug', state: 'MERGED', mergedAt: old(QUIET + 3600_000), mergeCommit: { oid: 'f00dcafe' } }]);
    const mergedRepoStates = fetchPrStatesForRepo('we', {}, { exec: mergedExec });
    const staleLease = { session: 'build-4306', acquiredAt: old(QUIET + 7200_000), ttlMinutes: DEFAULT_LEASE_TTL_MINUTES };
    const staleCandidates = [{ pool: 'web-everything', lane: 10, dir: '/x/web-everything/lane-10', lease: staleLease, repoKey: 'we' }];
    const { reap: reapAfterMerge } = reapPlan(staleCandidates, { nowMs: NOW, ttlMs: TTL_MS, signalsFor: buildSignalsFor(mergedRepoStates, resolverOpts) });
    expect(reapAfterMerge.map((c) => `${c.pool}/lane-${c.lane}:${c.reason}`)).toEqual(['web-everything/lane-10:pr-merged']);
  });

  it('test plan #5 — regression: existing item-kind/PR-kind session fixtures still resolve identically through resolveLeaseItemNum (the branch fallback never fires when the session already resolves)', () => {
    const exec = () => JSON.stringify([{ number: 1, headRefName: 'lane/2667-x', state: 'MERGED', mergedAt: old(QUIET + 3600_000), mergeCommit: { oid: 'abc' } }]);
    const repoStates = fetchPrStatesForRepo('we', {}, { exec });
    // A poisoned `git` that would resolve to a totally different item if it were ever consulted — proving it
    // truly never is, for a session the ordinary namespaces already resolve.
    const resolverOpts = { git: () => { throw new Error('must not be called — session already resolved'); } };
    const itemKind = resolveLeaseItemNum({ session: 'conveyor-2667' }, '/x/lane-a', { repoStates, nowMs: NOW, ...resolverOpts });
    expect(itemKind).toEqual({ itemNum: '2667', prNum: null, itemNumSource: 'session' });
  });

  // #xkk4lv7 — round-2 convergence (correctness + claim-accuracy, independently): a PR CLOSED WITHOUT merging
  // carries no `mergeCommit` at all, so `laneQuietSincePr` can never corroborate it (it requires a merge sha to
  // check containment against) — a DELIBERATE, documented gap (see `resolveLeaseItemNum`'s own doc), not a
  // silent one. This pins the exact end-to-end shape: `itemNumSource` stays `null` (never
  // `'branch-uncorroborated'` — that state is reserved for an OPEN PR or no PR at all, where "open wins"
  // already makes the PR axis harmless; a bare, uncorroborated 'closed' guess earns no trust at all, not even
  // the weaker uncorroborated tier), so neither this axis nor any downstream offline-axis consumer ever acts
  // on it — the lease simply rides the pre-existing TTL backstop, exactly as it did before this fix existed.
  it('round-2 convergence — a branch matching a CLOSED-but-never-merged PR (no mergeCommit) resolves to NO itemNum at all, never a false attribution', () => {
    const exec = () => JSON.stringify([{ number: 42, headRefName: 'lane/8100-abandoned-attempt', state: 'CLOSED', mergedAt: null, mergeCommit: null }]);
    const repoStates = fetchPrStatesForRepo('we', {}, { exec });
    const lease = { session: 'Mac:12345', acquiredAt: old(QUIET + 7200_000) };
    const resolverOpts = { git: () => 'lane/8100-abandoned-attempt' };
    const result = resolveLeaseItemNum(lease, '/x/lane-b', { repoStates, nowMs: NOW, ...resolverOpts });
    expect(result).toEqual({ itemNum: null, prNum: null, itemNumSource: null });
  });
});

// #4332 review:changes repair — the liveness VETO in `resolveLeaseItemNum` and its `buildLeaseSignalsFor` wiring.
describe('resolveLeaseItemNum / buildLeaseSignalsFor — #4332 ownerAlive veto', () => {
  const QUIET = DEFAULT_QUIET_MS;
  const old = (msAgo) => new Date(NOW - msAgo).toISOString();
  const BRANCH = 'lane/2825-soak-gate-merge-base';
  const mergedStates = (state = 'MERGED') => fetchPrStatesForRepo('we', {}, {
    exec: () => JSON.stringify([{
      number: 500, headRefName: BRANCH, state,
      mergedAt: old(QUIET + 3600_000), mergeCommit: { oid: 'deadbeef' },
    }]),
  });
  const resolverOpts = { git: () => BRANCH, statusPorcelain: () => '', isAncestor: () => true };
  const lease = { session: 'Mac:12345', acquiredAt: old(QUIET + 7200_000), workerSession: 'live-owner' };

  it('merged branch PR + quiet window satisfied + ownerAlive=true → vetoed: no itemNum, no reap-grade itemNumSource', () => {
    const r = resolveLeaseItemNum(lease, '/x/lane-2', { repoStates: mergedStates(), nowMs: NOW, ownerAlive: true, ...resolverOpts });
    expect(r.itemNum).toBeNull();
    expect(r.itemNumSource).toBeNull();
  });

  it.each([[false], [null], [undefined]])('preservation twin: ownerAlive=%s → still corroborated (branch-corroborated)', (ownerAlive) => {
    const r = resolveLeaseItemNum(lease, '/x/lane-2', { repoStates: mergedStates(), nowMs: NOW, ownerAlive, ...resolverOpts });
    expect(r.itemNum).toBe('2825');
    expect(r.itemNumSource).toBe('branch-corroborated');
  });

  it('closed branch PR follows the same veto', () => {
    const r = resolveLeaseItemNum(lease, '/x/lane-2', { repoStates: mergedStates('CLOSED'), nowMs: NOW, ownerAlive: true, ...resolverOpts });
    expect(r.itemNumSource).not.toBe('branch-corroborated');
  });

  describe('buildLeaseSignalsFor — production wiring (real git lane, ownerAlive computed before resolution)', () => {
    let dir; let sha;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'lease-reaper-4332-'));
      const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
      g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
      g('checkout', '-q', '-b', BRANCH);
      writeFileSync(join(dir, 'f'), 'x'); g('add', 'f'); g('commit', '-q', '-m', 'c');
      sha = g('rev-parse', 'HEAD');
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const build = (agents) => {
      const repoStates = fetchPrStatesForRepo('we', {}, { exec: () => JSON.stringify([{
        number: 500, headRefName: BRANCH, state: 'MERGED', mergedAt: old(QUIET + 3600_000), mergeCommit: { oid: sha },
      }]) });
      return buildLeaseSignalsFor({
        prStatesByRepo: new Map([['we', repoStates]]),
        sessionStates: new Map(), sessionPidAlive: new Map(), sessionAgents: agents, wrapperPids: new Map(), nowMs: NOW,
      });
    };
    const cand = () => ({ pool: 'web-everything', lane: 2, dir, repoKey: 'we', lease });
    it('live occupant listed → veto: no pr-terminal prState, lease kept', () => {
      const sig = build([{ kind: 'interactive', sessionId: 'live-owner', cwd: dir }])(cand());
      expect(sig.prState).toBeNull();
    });
    it('twin: occupant absent/null listing → same lease reaped on pr-merged', () => {
      expect(build([])(cand()).prState).toBe('merged');
      expect(build(null)(cand()).prState).toBe('merged');
    });
    it('session-kind lease (conveyor-<n>) is untouched by the veto: item resolves from the session name', () => {
      const sessionLease = { session: 'conveyor-2825', acquiredAt: old(QUIET + 7200_000), workerSession: 'live-owner' };
      const sig = build([{ kind: 'interactive', sessionId: 'live-owner', cwd: dir }])({ ...cand(), lease: sessionLease });
      expect(sig.prState).toBe('merged');
    });
  });
});

describe('laneIndicesIn — a plain FILE in the pool root is not a pool (2026-10-04 ENOTDIR outage)', () => {
  it('returns [] for a non-directory entry instead of throwing ENOTDIR', () => {
    const root = mkdtempSync(join(tmpdir(), 'reaper-pool-file-'));
    try {
      writeFileSync(join(root, '.metadata_never_index'), '');
      mkdirSync(join(root, 'web-everything', 'lane-2'), { recursive: true });
      expect(laneIndicesIn(join(root, '.metadata_never_index'))).toEqual([]);
      expect(laneIndicesIn(join(root, 'web-everything'))).toEqual([2]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// #xp4r23a — live: lane-12 `conveyor-4420` acquired 2026-10-08T05:27:22Z, reaped "pr-merged" at 05:27:24Z off
// item 4420's PREPARE PR #4358 (`lane/4420-prepare-*`, merged 00:03:48Z) while the build was still running.
describe('#xp4r23a — a PR that merged BEFORE the lease was acquired never reaps it (fresh build lane vs. the item\'s prepare PR)', () => {
  const ACQUIRED = '2026-10-08T05:27:22.823Z';
  const NOW_MS = Date.parse('2026-10-08T05:27:24.000Z');
  const lease = { session: 'conveyor-4420', purpose: 'probation-test-fix-build', acquiredAt: ACQUIRED, ttlMinutes: 240 };
  const signalsWith = (pulls) => {
    const repoStates = fetchPrStatesForRepo('we', {}, { exec: () => JSON.stringify(pulls) });
    return buildLeaseSignalsFor({
      prStatesByRepo: new Map([['we', repoStates]]),
      sessionStates: null, sessionPidAlive: new Map(), sessionAgents: null, wrapperPids: new Map(), nowMs: NOW_MS,
    });
  };
  const cand = { pool: 'web-everything', lane: 12, dir: join(tmpdir(), 'xp4r23a-no-such-lane'), repoKey: 'we', lease };
  const preparePr = {
    number: 4358, state: 'closed', head: { ref: 'lane/4420-prepare-file-the-prevention-guard' },
    merged_at: '2026-10-08T00:03:48Z', closed_at: '2026-10-08T00:03:48Z', merge_commit_sha: '648d2877dd78429ebbb5a05aafbd21b9705e772c',
  };

  it('the live shape: the item\'s earlier-merged prepare PR leaves the fresh build lease KEPT', () => {
    const sig = signalsWith([preparePr])(cand);
    expect(sig.prState).toBeNull();
    expect(reapPlan([cand], { nowMs: NOW_MS, signalsFor: () => sig }).reap).toEqual([]);
  });

  it('twin: the item\'s PR merging AFTER the acquire is this lease\'s own work — still reaped pr-merged', () => {
    const own = { ...preparePr, number: 4500, head: { ref: 'lane/4420-build' }, merged_at: '2026-10-08T06:00:00Z', closed_at: '2026-10-08T06:00:00Z' };
    const sig = signalsWith([preparePr, own])(cand);
    expect(sig.prState).toBe('merged');
    expect(reapPlan([cand], { nowMs: NOW_MS, signalsFor: () => sig }).reap.map((r) => r.reason)).toEqual(['pr-merged']);
  });

  it('a closed-unmerged PR that closed before the acquire never reaps it either', () => {
    const closed = { number: 4357, state: 'closed', head: { ref: 'lane/4420-attempt' }, merged_at: null, closed_at: '2026-10-08T01:00:00Z' };
    expect(signalsWith([closed])(cand).prState).toBeNull();
  });

  it('prTerminalPredatesLease: unparseable times keep the pre-existing behaviour (false)', () => {
    expect(prTerminalPredatesLease({ state: 'merged', terminalAt: '2026-10-08T00:00:00Z' }, { acquiredAt: ACQUIRED })).toBe(true);
    expect(prTerminalPredatesLease({ state: 'merged', terminalAt: null, mergedAt: null }, { acquiredAt: ACQUIRED })).toBe(false);
    expect(prTerminalPredatesLease({ state: 'merged', terminalAt: '2026-10-08T00:00:00Z' }, { acquiredAt: 'garbage' })).toBe(false);
    expect(prTerminalPredatesLease({ state: 'open', terminalAt: null }, { acquiredAt: ACQUIRED })).toBe(false);
  });
});

// #xp4r23a — the live reaper died of heap exhaustion every tick from 2026-10-08T08:37Z: it held all ~30k parsed
// run records (~4.9 GB) in one array. The reader now reduces one record at a time and never retains it.
describe('#xp4r23a — readDetachedWrapperPids reduces record-by-record (never retains the whole run store)', () => {
  const rec = (id, session, pid) => ({ id, effects: [{ status: 'in-flight', handle: `pid:${pid}`, payload: { sessionSlug: session } }] });
  it('returns the same map as the pure reducer over every record (the OOM itself is proven live, see PR body)', () => {
    const records = { a: rec('a', 'conveyor-1', 101), b: { id: 'b', effects: [] }, c: rec('c', 'conveyor-2', 202) };
    const store = { list: () => Object.keys(records), read: (id) => structuredClone(records[id]) };
    expect([...readDetachedWrapperPids(store)]).toEqual([...detachedWrapperPidsBySession(Object.values(records))]);
  });
  it('a record that throws on read is skipped, never fatal', () => {
    const store = { list: () => ['x', 'y'], read: (id) => { if (id === 'x') throw new Error('bad json'); return rec('y', 'conveyor-9', 9); } };
    expect([...readDetachedWrapperPids(store)]).toEqual([['conveyor-9', 9]]);
  });
});
