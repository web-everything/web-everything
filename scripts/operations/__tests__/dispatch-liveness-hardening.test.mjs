/**
 * @file dispatch-liveness-hardening.test.mjs — the five liveness-reading hardenings (#3353), each pinned
 *   against a REAL `claude agents --json` payload rather than a hand-authored one.
 *
 * WHY THIS FILE EXISTS. `stampLiveness`, `assertHandleNotLive` and `createDispatchObservers` all read the same
 * CLI surface, and until #3353 they all trusted its SHAPE on evidence nobody had gathered — no code path in
 * this repo had ever listed a session back. PR #1211's round-3 review accepted that as a named residual (H1/H2)
 * and reassigned the fix to wherever the payload became real. This is that place, and the fixture next door is
 * that payload.
 *
 * THE FAILURE THESE GUARD AGAINST LOOKS LIKE THE STRONG GUARD, NOT A DEGRADED ONE. If the listing ever comes
 * back in a shape these readers do not understand, the old code read it as "every agent is gone", released the
 * lane and put a SECOND agent into the same clone about two minutes later — while the verdict still said
 * `livenessSource: 'claude-agents'`, the label for "checked against a real listing and found clear".
 *
 * PROVENANCE OF THE FIXTURE — `__fixtures__/claude-agents-payload.json`, captured not authored:
 *
 *   $ claude --version   →  2.1.246 (Claude Code)
 *   $ claude agents --json   →  14 elements, re-indented only
 *
 * `claude agents --json` is a READ-ONLY listing: it starts nothing, dispatches nothing and spends nothing, so
 * this fixture cost no agent and no tokens. It is pinned verbatim because the point is what the CLI actually
 * emits, and a fixture edited to be tidy is a fixture that pins the editor's beliefs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISPATCH_EFFECT,
  DISPATCH_GUARD_LISTING_GRACE_MINUTES,
  DISPATCH_LISTING_GRACE_MINUTES,
  dispatchStillHolds,
} from '../dispatch-lane.mjs';
import {
  createDispatchObservers,
  createDispatchSinks,
  defaultClaudeProvider,
  listedSessionIds,
  normalizeHandle,
  persistLastSeenLive,
  stampLiveness,
} from '../dispatch-lane-io.mjs';
import { assertHandleNotLive } from '../wake.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD_PATH = join(HERE, '..', '__fixtures__', 'claude-agents-payload.json');
/** The real listing, re-read per call so no test can mutate another's copy. */
const payload = () => JSON.parse(readFileSync(PAYLOAD_PATH, 'utf8'));

/** A handle that IS in the real listing — taken from the payload, never typed in. */
const LIVE_HANDLE = payload()[0].sessionId;
/** A well-formed v4 UUID that is NOT in the real listing. */
const GONE_HANDLE = '00000000-0000-4000-8000-000000000000';

const NOW = '2026-08-26T12:00:00.000Z';
const isoPlus = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

// ── HARDENING 1 — the payload is REAL, and all three of its element shapes are pinned ─────────────────────────

describe('hardening 1: the pinned payload is a real `claude agents --json` listing', () => {
  it('carries all THREE element shapes the CLI returns in one response, not one tidy shape', () => {
    // A fixture that pins ONE shape pins the wrong thing. This listing mixes three, and the 7-row minimal one
    // — no `state`, no `status`, no `id` — is the majority. Anything reading `id` or `state` as though it were
    // always there would pass against a one-shape fixture and fail against the CLI.
    const shapes = new Map();
    for (const row of payload()) {
      const key = Object.keys(row).sort().join('+');
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
    }
    expect([...shapes.keys()].sort()).toEqual([
      'cwd+id+kind+name+sessionId+startedAt+state',
      'cwd+id+kind+name+pid+sessionId+startedAt+state+status+waitingFor'.split('+').sort().join('+'),
      'cwd+kind+name+pid+sessionId+startedAt',
    ].sort());
    expect(shapes.size).toBe(3);
  });

  it('`sessionId` is on EVERY row and `id` only on some — so `id` alone could never be the key', () => {
    const rows = payload();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.sessionId === 'string' && r.sessionId)).toBe(true);
    // `id` is absent from half the listing (the `interactive` half). Since #3331 `listedSessionIds` collects
    // it IN ADDITION to `sessionId`, never instead — because a `--bg` handle is the short `id` the CLI printed
    // for that spawn, while the long form is what every other reader stores. An absent `id` costs nothing.
    expect(rows.some((r) => r.id === undefined)).toBe(true);
    expect(rows.some((r) => typeof r.id === 'string' && r.id)).toBe(true);
  });

  it('every id is a lower-case v4 UUID — the measurement hardening 3 is deliberately NOT justified by', () => {
    // Recorded so the drift-defence claim in `normalizeHandle`'s docblock stays honest. No case mismatch has
    // ever been observed; this asserts the observation, not a defect.
    const ids = payload().map((r) => r.sessionId);
    expect(ids.every((i) => i === i.toLowerCase())).toBe(true);
    expect(ids.every((i) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(i))).toBe(true);
  });

  it('the listing includes `kind: "interactive"` rows, so it is NOT only backgrounded agents', () => {
    // `defaultListAgents` deliberately passes no `--all`, and this is what that still returns. A reader that
    // assumed every row was one of its own dispatches would be wrong about most of them.
    expect(payload().some((r) => r.kind === 'interactive')).toBe(true);
  });
});

// ── HARDENING 2 — non-empty-but-unmatchable reads as `unreadable`, in all three readers ───────────────────────

/**
 * The listing that CANNOT HAPPEN AGAINST CLI 2.1.246, and is the whole reason these branches exist.
 *
 * Every row of the real payload carries a usable `sessionId`, so `listed.size === 0` after the filter is
 * unreachable against the observed CLI — **this mutation test is the ONLY possible cover for these branches,
 * and no live dispatch can ever exercise them.** That is not a reason to drop them: they are fail-closed cover
 * for a shape nobody has seen, and the cost of being wrong about it is two agents in one lane clone. A later
 * reader should not go hunting for the real listing that reddens this; there is none.
 *
 * `id` IS STRIPPED TOO, SINCE #3331. `listedSessionIds` now collects `id` alongside `sessionId` (a `--bg`
 * handle is the CLI-assigned SHORT id, not a minted uuid — see that function's own docblock), so a row keeping
 * its `id` is no longer unmatchable and would not reach the branch under test. Stripping both is what "not one
 * row yielded anything comparable" means under the widened contract; the branch itself is unchanged.
 */
const unmatchable = () => payload().map(({ sessionId, id, ...rest }) => rest);

describe('hardening 2: a non-empty listing yielding zero usable ids is UNREADABLE, not "everyone is gone"', () => {
  it('stampLiveness — reddens on revert: the old code stamped `live: false` on every row', () => {
    const rows = [{ runId: 'a', key: '3037', handle: LIVE_HANDLE }, { runId: 'b', key: '3096', handle: GONE_HANDLE }];
    const out = stampLiveness({ runs: rows, unreadable: 0 }, { listAgents: unmatchable });
    expect(out.runs.map((r) => r.live)).toEqual([null, null]);
    // The label matters as much as the answer: a weaker guard must never wear the strong one's name.
    expect(out.livenessSource).toBe('unreadable');
  });

  it('assertHandleNotLive — REFUSES rather than closing out an entry whose agent might be alive', () => {
    // Reverted, `.some()` returns false against an unmatchable listing and `--resolve` un-parks the run; the
    // executor then retries, which for a dispatch means a second agent under the same session slug.
    expect(() => assertHandleNotLive({ handle: GONE_HANDLE }, { listAgents: unmatchable }))
      .toThrow(/not one carried a usable/);
    // Same refusal the not-an-array branch gives, and `--force` is still the way through.
    expect(() => assertHandleNotLive({ handle: GONE_HANDLE }, { listAgents: unmatchable }))
      .toThrow(/refusing to close out an entry whose agent MIGHT be alive/);
  });

  it('createDispatchObservers — raises rather than falling into `unresolved` on a read that told it nothing', async () => {
    const observe = createDispatchObservers({ listAgents: unmatchable, listPrs: () => [] })[DISPATCH_EFFECT];
    await expect(observe({ handle: GONE_HANDLE, startedAt: NOW }, {}))
      .rejects.toThrow(/not one carried a usable/);
  });

  it('an EMPTY listing is still a legitimate "nobody is running" answer — the branch is size-gated', () => {
    // The guard is `sessions.length && !listed.size`. A genuinely empty array is a read that SUCCEEDED and
    // found nothing; conflating it with an unreadable one would wedge every dispatch on an idle machine.
    const out = stampLiveness({ runs: [{ runId: 'a', key: '3037', handle: GONE_HANDLE }], unreadable: 0 }, { listAgents: () => [] });
    expect(out.runs[0].live).toBe(false);
    expect(out.livenessSource).toBe('claude-agents');
    expect(() => assertHandleNotLive({ handle: GONE_HANDLE }, { listAgents: () => [] })).not.toThrow();
  });
});

// ── HARDENING 3 — the compares are case- and whitespace-tolerant, on BOTH sides ───────────────────────────────

describe('hardening 3: session ids compare normalized — drift-defence, not an observed bug', () => {
  it('all three readers match a handle whose case differs from the listing', () => {
    // CLI 2.1.246 emits lower-case (asserted above), so nothing here reproduces a real defect. What it pins is
    // the cost if that ever changed: under an exact match EVERY dispatch would miss its own row, read
    // `live: false`, and the guard would hand the same lane to a second agent.
    const shouted = LIVE_HANDLE.toUpperCase();
    const out = stampLiveness({ runs: [{ runId: 'a', key: '3037', handle: shouted }], unreadable: 0 }, { listAgents: payload });
    expect(out.runs[0].live).toBe(true);
    expect(() => assertHandleNotLive({ handle: shouted }, { listAgents: payload })).toThrow(/is ALIVE/);
  });

  it('and a handle carrying stray whitespace', () => {
    const padded = `  ${LIVE_HANDLE}\n`;
    const out = stampLiveness({ runs: [{ runId: 'a', key: '3037', handle: padded }], unreadable: 0 }, { listAgents: payload });
    expect(out.runs[0].live).toBe(true);
  });

  it('normalizes the LISTING side too — a listing that shouts back still matches a stored handle', () => {
    const shoutingListing = () => payload().map((r) => ({ ...r, sessionId: r.sessionId.toUpperCase() }));
    const out = stampLiveness({ runs: [{ runId: 'a', key: '3037', handle: LIVE_HANDLE }], unreadable: 0 }, { listAgents: shoutingListing });
    expect(out.runs[0].live).toBe(true);
  });

  it('normalizeHandle / listedSessionIds drop what is not comparable rather than inventing a match', () => {
    expect(normalizeHandle(null)).toBe('');
    expect(normalizeHandle(undefined)).toBe('');
    expect(normalizeHandle('  ABC ')).toBe('abc');
    // An empty-string id must never become a Set member, or a handle-less row would "match" it. Both fields
    // are read now (#3331), so both blank forms have to be dropped.
    expect(listedSessionIds([{ sessionId: '' }, { sessionId: '  ' }, { id: '' }, { id: ' ' }, null]).size).toBe(0);
    // Every row's `sessionId` is in the set, and — since #3331 — every row's short `id` as well, which is what
    // a `--bg` handle actually looks like. Rows carrying no `id` (the interactive half of the listing)
    // contribute exactly one entry each, as before.
    const listed = listedSessionIds(payload());
    for (const row of payload()) {
      expect(listed.has(row.sessionId.toLowerCase())).toBe(true);
      if (row.id) expect(listed.has(String(row.id).toLowerCase())).toBe(true);
    }
    const expectedSize = new Set(payload().flatMap((r) => [r.sessionId, r.id]).filter(Boolean).map((v) => String(v).toLowerCase())).size;
    expect(listed.size).toBe(expectedSize);
    expect(expectedSize).toBeGreaterThan(payload().length); // the widening is real, not a no-op
  });
});

// ── HARDENING 4 — `live: false` ages from `lastSeenLiveAt`, not `startedAt` ───────────────────────────────────

describe('hardening 4: a `live: false` reading ages from the last CONFIRMATION, not from the dispatch', () => {
  const gone = (over) => ({ live: false, startedAt: '2026-08-26T06:00:00.000Z', ...over });

  it('reddens on revert: one bad read against a long-running build no longer releases the lane', () => {
    // Six hours since `startedAt`, one minute since a listing said `live: true`. Anchored on `startedAt` this
    // is far past any grace and the item is RELEASED — a second agent into a clone with a live build in it.
    const seenAMinuteAgo = gone({ lastSeenLiveAt: isoPlus(NOW, -1) });
    expect(dispatchStillHolds(seenAMinuteAgo, NOW)).toBe(true);
  });

  it('but two bad reads spaced by the window still let it go — this is not an unbounded hold', () => {
    const stale = gone({ lastSeenLiveAt: isoPlus(NOW, -(DISPATCH_GUARD_LISTING_GRACE_MINUTES + 1)) });
    expect(dispatchStillHolds(stale, NOW)).toBe(false);
  });

  it('falls back to `startedAt` only when it was never set — a dispatch never yet seen alive', () => {
    expect(dispatchStillHolds(gone({ startedAt: isoPlus(NOW, -1) }), NOW)).toBe(true);
    expect(dispatchStillHolds(gone({ startedAt: isoPlus(NOW, -(DISPATCH_GUARD_LISTING_GRACE_MINUTES + 1)) }), NOW)).toBe(false);
    // An unparseable `lastSeenLiveAt` must fall back, not poison the anchor into NaN and hold forever.
    expect(dispatchStillHolds(gone({ lastSeenLiveAt: 'not a date', startedAt: isoPlus(NOW, -60) }), NOW)).toBe(false);
  });

  it('no usable anchor at all still HOLDS — fail-closed, unchanged', () => {
    expect(dispatchStillHolds(gone({ startedAt: null }), NOW)).toBe(true);
  });

  it('persistLastSeenLive writes the confirmation onto the entry — the read site has a write site', () => {
    // Reverted (no write), the field is never set and hardening 4 is a read of something nothing produces.
    const run = {
      id: 'run-1',
      effects: [
        { key: 'k-live', type: DISPATCH_EFFECT, status: 'in-flight', payload: { num: '3037' } },
        { key: 'k-gone', type: DISPATCH_EFFECT, status: 'in-flight', payload: { num: '3096' } },
        { key: 'k-done', type: DISPATCH_EFFECT, status: 'applied', payload: { num: '3110' } },
      ],
    };
    const store = { read: () => run, write: () => run };
    const written = persistLastSeenLive(
      { runs: [{ runId: 'run-1', key: 'k-live', live: true }, { runId: 'run-1', key: 'k-gone', live: false }] },
      { store, now: () => new Date(NOW) },
    );
    expect(written).toBe(1);
    expect(run.effects[0].lastSeenLiveAt).toBe(NOW);
    // ONLY `live === true` is recorded — `false` and `null` are the answers the field exists to survive.
    expect(run.effects[1].lastSeenLiveAt).toBeUndefined();
    // And a settled entry is never touched, whatever a stale row claims about it.
    expect(run.effects[2].lastSeenLiveAt).toBeUndefined();
  });

  it('it is `last`, not `first` — a later confirmation overwrites an earlier one', () => {
    // Stamping once and never again would leave a long-lived agent anchored on its first minute, which is the
    // `startedAt` failure this replaces under a different field name.
    const run = { id: 'r', effects: [{ key: 'k', type: DISPATCH_EFFECT, status: 'in-flight', payload: { num: '1' } }] };
    const store = { read: () => run, write: () => run };
    const stamp = (at) => persistLastSeenLive({ runs: [{ runId: 'r', key: 'k', live: true }] }, { store, now: () => new Date(at) });
    stamp(isoPlus(NOW, -10));
    stamp(NOW);
    expect(run.effects[0].lastSeenLiveAt).toBe(NOW);
  });

  it('a store that will not take the note does NOT take down the dispatch read', () => {
    const throwing = { read: () => { throw new Error('EACCES'); }, write: () => { throw new Error('EACCES'); } };
    expect(() => persistLastSeenLive({ runs: [{ runId: 'r', key: 'k', live: true }] }, { store: throwing })).not.toThrow();
  });
});

// ── HARDENING 5 — the guard's window is its OWN, and larger, at BOTH of its reads ─────────────────────────────

describe('hardening 5: the guard has its own listing grace, larger than the observer’s', () => {
  it('the two constants are distinct and ordered — reddens if they are ever collapsed back into one', () => {
    expect(DISPATCH_GUARD_LISTING_GRACE_MINUTES).toBeGreaterThan(DISPATCH_LISTING_GRACE_MINUTES);
  });

  it('the DEFAULT is the guard’s constant, not the observer’s', () => {
    const gone = { live: false, startedAt: NOW };
    // Just inside the OBSERVER's two minutes it would hold either way; between the two windows it holds only
    // because the guard has its own. That midpoint is the assertion that reddens on revert.
    expect(dispatchStillHolds(gone, isoPlus(NOW, DISPATCH_LISTING_GRACE_MINUTES + 1))).toBe(true);
    expect(dispatchStillHolds(gone, isoPlus(NOW, DISPATCH_GUARD_LISTING_GRACE_MINUTES + 1))).toBe(false);
  });

  it('and so is the IN-BODY FALLBACK — a malformed `listingGraceMinutes` cannot hand back the observer’s', () => {
    // The hole the default alone leaves open: a caller passing `-1` used to silently get the OBSERVER's two
    // minutes back INSIDE the guard, and Done-when 5 as first written would have passed with it open.
    const gone = { live: false, startedAt: NOW };
    // `null` is deliberately NOT in this list: `Number(null)` is 0, which passes the `>= 0` test as an
    // explicit zero-minute window rather than falling to the fallback. That is pre-existing, unchanged
    // behaviour, and it is asserted on its own below so the omission is not mistaken for an oversight.
    for (const bad of [-1, NaN, 'nonsense', undefined]) {
      expect(dispatchStillHolds(gone, isoPlus(NOW, DISPATCH_LISTING_GRACE_MINUTES + 1), { listingGraceMinutes: bad })).toBe(true);
      expect(dispatchStillHolds(gone, isoPlus(NOW, DISPATCH_GUARD_LISTING_GRACE_MINUTES + 1), { listingGraceMinutes: bad })).toBe(false);
    }
  });

  it('an explicit ZERO is still an explicit zero — `null` and `0` mean "no grace", not "use the fallback"', () => {
    // `Number(null) === 0` and `0 >= 0`, so both reach the comparison as a real window. Unchanged by #3353,
    // pinned here because the fallback test above has to exclude them and a reader deserves to know why.
    for (const zero of [0, null]) {
      expect(dispatchStillHolds({ live: false, startedAt: NOW }, isoPlus(NOW, 1), { listingGraceMinutes: zero })).toBe(false);
    }
  });

  it('an explicit, well-formed window is still honoured — this narrows no caller', () => {
    expect(dispatchStillHolds({ live: false, startedAt: NOW }, isoPlus(NOW, 3), { listingGraceMinutes: 5 })).toBe(true);
    expect(dispatchStillHolds({ live: false, startedAt: NOW }, isoPlus(NOW, 6), { listingGraceMinutes: 5 })).toBe(false);
  });
});

// ── 7a — the three readers, exercised against the REAL payload ────────────────────────────────────────────────

describe('7a: all three readers run against the pinned real payload, with no agent started', () => {
  it('stampLiveness finds a handle that IS in the real listing, and misses one that is not', () => {
    const out = stampLiveness(
      { runs: [{ runId: 'a', key: '3037', handle: LIVE_HANDLE }, { runId: 'b', key: '3096', handle: GONE_HANDLE }], unreadable: 0 },
      { listAgents: payload },
    );
    expect(out.runs.map((r) => r.live)).toEqual([true, false]);
    expect(out.livenessSource).toBe('claude-agents');
  });

  it('assertHandleNotLive refuses for a listed handle and passes for an unlisted one', () => {
    expect(() => assertHandleNotLive({ handle: LIVE_HANDLE }, { listAgents: payload })).toThrow(/STILL LISTED/);
    expect(() => assertHandleNotLive({ handle: GONE_HANDLE }, { listAgents: payload })).not.toThrow();
  });

  it('createDispatchObservers reads `running` for a listed handle against the real payload', async () => {
    const observe = createDispatchObservers({ listAgents: payload, listPrs: () => [] })[DISPATCH_EFFECT];
    await expect(observe({ handle: LIVE_HANDLE, startedAt: NOW }, {})).resolves.toEqual({ status: 'running', result: null });
  });

  it('and `unresolved` for an unlisted handle past the observer’s grace', async () => {
    const observe = createDispatchObservers({
      listAgents: payload,
      listPrs: () => [],
      now: () => new Date(isoPlus(NOW, 60)),
    })[DISPATCH_EFFECT];
    const out = await observe({ handle: GONE_HANDLE, startedAt: NOW }, {});
    expect(out.status).toBe('unresolved');
  });

  it('the real listing carries sessions BLOCKED ON A PERMISSION PROMPT — alive, and holding nothing', () => {
    // This is verbatim the G1 failure the liveness axis exists for, present in the captured listing rather
    // than hypothesised: a background session stalled on a prompt is ALIVE, holds no lane lease and has
    // claimed no item, so a clock-only guard would hand its lane to a second agent. `stampLiveness` must read
    // every one of them as `live: true`.
    const stalled = payload().filter((r) => r.waitingFor === 'permission prompt');
    expect(stalled.length).toBeGreaterThan(0);
    const out = stampLiveness(
      { runs: stalled.map((r, i) => ({ runId: `r${i}`, key: '3037', handle: r.sessionId })), unreadable: 0 },
      { listAgents: payload },
    );
    expect(out.runs.every((r) => r.live === true)).toBe(true);
    // And the guard holds every one of them at any age — no clock may overrule a live session.
    expect(out.runs.every((r) => dispatchStillHolds({ ...r, startedAt: '2020-01-01T00:00:00.000Z' }, NOW))).toBe(true);
  });
});

// ── HARDENING 6 (#3331) — the handle is the id the CLI PRINTED, not the one the dispatcher minted ─────────────

/**
 * WHAT WENT WRONG, and why it hid for so long. `buildAgentArgv` used to emit `--session-id <minted uuid>` and
 * `defaultClaudeProvider` used to answer with that same uuid as the durable handle. `claude --bg` DISCARDS
 * `--session-id` — it says so on stderr (`warning: --bg manages the session id; ignoring --session-id`) and
 * assigns its own, measured 3/3 at CLI 2.1.246 by #3331's probe and 2/2 at 2.1.269 against the REAL dispatch
 * argv (review brief, system-prompt file and deny list included).
 *
 * The dispatch still WORKED — a live `review-2129` session ran an independent review to a full accept verdict
 * while this bug was in force — which is exactly why it hid. What broke was ADDRESSABILITY: every operator who
 * ran the dispatcher's own printed `claude agents --json | grep <uuid>` got nothing and concluded no session
 * had started, and `stampLiveness` answered `live: false` for every in-flight dispatch forever, silently
 * degrading the double-dispatch guard to its clock backstop.
 *
 * WHY A FAKE-CLI TEST COULD NOT HAVE CAUGHT IT (`dispatch-spawn-live.test.mjs`): the fake obligingly echoes
 * back whatever id it is handed, so it was green against an assumption the real CLI never honoured. These
 * tests instead pin the two halves of the REAL contract — what the argv must not contain, and where the handle
 * must come from — neither of which a cooperative stand-in can fake away.
 */
describe('hardening 6: a `--bg` handle is read back off stdout (#3331)', () => {
  /** Verbatim the first line CLI 2.1.269 prints on stdout for a `--bg` spawn. */
  const BANNER = (id, name) => `backgrounded · ${id} · ${name}\n  claude agents             list sessions\n`;

  it('defaultClaudeProvider answers with the PRINTED id, never the minted one', () => {
    const handle = defaultClaudeProvider(
      { mode: 'ordinary', launchGuard: null, sessionId: 'minted-1111-2222-3333-444444444444', cwd: '/repo', prompt: '# go', sessionSlug: 'conveyor-3037' },
      { spawnAgent: () => BANNER('fe8b4df8', 'conveyor-3037') },
    );
    expect(handle).toBe('fe8b4df8');
    expect(handle).not.toBe('minted-1111-2222-3333-444444444444');
  });

  it('…and falls back to the minted id only when stdout carries no banner — never a null handle', () => {
    // The fallback is the PRE-#3331 behaviour on purpose: an unparseable spawn must still record something
    // `in-flight`, because a null handle lands in the executor's `unknown` bucket that only a person can close.
    expect(defaultClaudeProvider(
      { mode: 'ordinary', launchGuard: null, sessionId: 'minted-z9', cwd: '/repo', prompt: '# go', sessionSlug: 'conveyor-3037' },
      { spawnAgent: () => '' },
    )).toBe('minted-z9');
  });

  it('the SINK records the printed id as the run entry\'s handle', async () => {
    const sinks = createDispatchSinks({
      root: '/primary/webeverything',
      mintSessionId: () => 'minted-z9',
      spawnAgent: () => BANNER('91035f2f', 'conveyor-3037'),
      now: () => new Date(NOW),
    });
    const entry = await sinks[DISPATCH_EFFECT]({ num: '3037', sessionSlug: 'conveyor-3037', prompt: '# go' });
    expect(entry.handle).toBe('91035f2f');
  });

  it('a printed short id MATCHES its own row in the real listing — the whole point of the change', () => {
    // The listing's `id` field is the short id `--bg` prints; `sessionId` is its long form. Before #3331
    // `listedSessionIds` collected only the long one, so a real handle could never be found.
    const row = payload().find((r) => r.id);
    expect(row).toBeTruthy();
    const out = stampLiveness(
      { runs: [{ runId: 'a', key: '3037', handle: row.id }], unreadable: 0 },
      { listAgents: payload },
    );
    expect(out.runs[0].live).toBe(true);
    expect(out.livenessSource).toBe('claude-agents');
  });

  it('and a MINTED uuid still matches nothing — the old handle is not rescued by the widening', () => {
    const out = stampLiveness(
      { runs: [{ runId: 'a', key: '3037', handle: GONE_HANDLE }], unreadable: 0 },
      { listAgents: payload },
    );
    expect(out.runs[0].live).toBe(false);
  });
});
