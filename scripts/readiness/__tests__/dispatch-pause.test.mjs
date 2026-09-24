/**
 * @file scripts/readiness/__tests__/dispatch-pause.test.mjs
 * @description Unit proof of the manual/emergency dispatch-pause lever (#3609, epic #3383). Pins the pure
 *   state transitions (set / clear / parse) and the durable marker round-trip (write / read / status) that
 *   `dispatch-plan.mjs` and `tick-core.mjs` both consult before computing any launch/spawn list.
 *
 *   Also pins the KIND-SCOPED pause (epic #3383): the optional `pausedKinds` scope, the shared
 *   `resolvePausedKinds` predicate both dispatch cores import, the CLI's `--kinds` write-time validation, and —
 *   the load-bearing one — the BACKWARD-COMPAT guarantee that an OLD-FORMAT marker (`paused:true` with no
 *   `pausedKinds`) and every boolean-only caller still hold EVERY kind, exactly as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
import {
  emptyPauseState,
  parsePauseState,
  setPause,
  clearPause,
  serializePauseState,
  readPauseState,
  writePauseState,
  isDispatchPaused,
  PAUSABLE_KINDS,
  normalizePausedKinds,
  resolvePausedKinds,
  isKindPaused,
  isScopedPause,
  readPausedKinds,
  parseKindsFlag,
  describeHeldKinds,
} from '../dispatch-pause.mjs';
import { LAUNCH_KINDS } from '../../operations/dispatch-lane.mjs';

const tmpDirs = [];
function tmpMarker() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-pause-'));
  tmpDirs.push(dir);
  return join(dir, 'dispatch-pause.json');
}
afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('dispatch-pause — emptyPauseState / parsePauseState (pure, fail-open)', () => {
  it('empty state is not paused', () => {
    expect(emptyPauseState()).toEqual({ paused: false, pausedKinds: null, reason: null, by: null, at: null });
  });
  it('parses a well-formed pause', () => {
    const s = parsePauseState(JSON.stringify({ paused: true, reason: 'high load', by: 'nic', at: '2026-09-08T00:00:00.000Z' }));
    expect(s).toEqual({ paused: true, pausedKinds: null, reason: 'high load', by: 'nic', at: '2026-09-08T00:00:00.000Z' });
  });
  it('blank/whitespace text reads as empty', () => {
    expect(parsePauseState('')).toEqual(emptyPauseState());
    expect(parsePauseState('   ')).toEqual(emptyPauseState());
    expect(parsePauseState(null)).toEqual(emptyPauseState());
    expect(parsePauseState(undefined)).toEqual(emptyPauseState());
  });
  it('unparseable JSON fails open to empty, never throws', () => {
    expect(() => parsePauseState('{not json')).not.toThrow();
    expect(parsePauseState('{not json')).toEqual(emptyPauseState());
  });
  it('a non-object JSON value fails open to empty', () => {
    expect(parsePauseState('42')).toEqual(emptyPauseState());
    expect(parsePauseState('"paused"')).toEqual(emptyPauseState());
    expect(parsePauseState('[1,2,3]')).toEqual(emptyPauseState());
  });
  it('a missing paused:true (e.g. paused:"yes") reads as false — only the boolean literal counts', () => {
    expect(parsePauseState(JSON.stringify({ paused: 'yes' }))).toEqual(emptyPauseState());
  });
});

describe('dispatch-pause — setPause / clearPause (pure transitions)', () => {
  it('setPause stamps a default reason when none given', () => {
    const s = setPause({}, 1_000);
    expect(s.paused).toBe(true);
    expect(s.reason).toBe('operator emergency pause');
    expect(s.by).toBeNull();
    expect(s.at).toBe(new Date(1_000).toISOString());
  });
  it('setPause carries a given reason + by, trimmed', () => {
    const s = setPause({ reason: '  machine already loaded  ', by: 'nic' }, 2_000);
    expect(s.reason).toBe('machine already loaded');
    expect(s.by).toBe('nic');
  });
  it('clearPause returns the empty (not-paused) state', () => {
    expect(clearPause()).toEqual(emptyPauseState());
  });
  it('serializePauseState round-trips through parsePauseState', () => {
    const s = setPause({ reason: 'x', by: 'y' }, 3_000);
    expect(parsePauseState(serializePauseState(s))).toEqual(s);
  });
});

describe('dispatch-pause — the durable marker (write / read / status, fail-open on a missing or corrupt file)', () => {
  it('absent marker ⇒ not paused', () => {
    const p = tmpMarker();
    expect(isDispatchPaused(p)).toBe(false);
    expect(readPauseState(p)).toEqual(emptyPauseState());
  });
  it('writePauseState → readPauseState round-trips, and isDispatchPaused reads true', () => {
    const p = tmpMarker();
    const s = setPause({ reason: 'incident', by: 'operator' }, 4_000);
    writePauseState(s, p);
    expect(readPauseState(p)).toEqual(s);
    expect(isDispatchPaused(p)).toBe(true);
  });
  it('clearing (writing the empty state) resumes dispatch', () => {
    const p = tmpMarker();
    writePauseState(setPause({}, 5_000), p);
    expect(isDispatchPaused(p)).toBe(true);
    writePauseState(clearPause(), p);
    expect(isDispatchPaused(p)).toBe(false);
  });
  it('re-setting is idempotent — overwrites with the latest reason/by', () => {
    const p = tmpMarker();
    writePauseState(setPause({ reason: 'first' }, 1), p);
    writePauseState(setPause({ reason: 'second' }, 2), p);
    expect(readPauseState(p).reason).toBe('second');
  });
  it('a corrupt marker fails OPEN — reads as not paused, never throws', () => {
    const p = tmpMarker();
    writeFileSync(p, '{ this is not valid json');
    expect(() => readPauseState(p)).not.toThrow();
    expect(readPauseState(p)).toEqual(emptyPauseState());
    expect(isDispatchPaused(p)).toBe(false);
  });
  it('the write is atomic — no stray .tmp file left behind after a write', () => {
    const p = tmpMarker();
    writePauseState(setPause({ reason: 'x' }, 1), p);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toContain('"paused": true');
  });
});

// ── KIND-SCOPED PAUSE (epic #3383) ────────────────────────────────────────────────────────────────────────────

describe('dispatch-pause — PAUSABLE_KINDS is the CANONICAL dispatch kind set, not a parallel vocabulary', () => {
  it('is exactly `dispatch-lane.mjs`\'s own LAUNCH_KINDS, in the same order (drift guard for the hand-kept copy)', () => {
    expect([...PAUSABLE_KINDS]).toEqual([...LAUNCH_KINDS]);
  });
  it('uses the real kind name `investigate` — never the prose word "investigation"', () => {
    expect(PAUSABLE_KINDS).toContain('investigate');
    expect(PAUSABLE_KINDS).not.toContain('investigation');
  });
  it('does NOT include review-dispatch — that pass was never gated by this lever and stays exempt', () => {
    expect(PAUSABLE_KINDS).not.toContain('review-dispatch');
    expect(PAUSABLE_KINDS).not.toContain('review');
  });
});

describe('dispatch-pause — normalizePausedKinds (pure, tolerant)', () => {
  it('a non-array (absent, null, string, object) is "no scope declared" → null', () => {
    for (const v of [undefined, null, 'build', 42, {}, true]) expect(normalizePausedKinds(v)).toBeNull();
  });
  it('trims, drops blanks/non-strings, and dedups while PRESERVING the operator\'s order', () => {
    expect(normalizePausedKinds([' fix ', 'build', '', null, 7, 'fix'])).toEqual(['fix', 'build']);
  });
  it('a list that empties out entirely degrades to null (blanket), never to an empty scope', () => {
    expect(normalizePausedKinds([])).toBeNull();
    expect(normalizePausedKinds(['', '   ', null])).toBeNull();
  });
  it('keeps an UNRECOGNIZED name verbatim — it matches no kind, so a typo holds nothing (fails OPEN)', () => {
    expect(normalizePausedKinds(['investigation'])).toEqual(['investigation']);
    expect(isKindPaused({ paused: true, pausedKinds: ['investigation'] }, 'investigate')).toBe(false);
  });
});

describe('dispatch-pause — resolvePausedKinds / isKindPaused / isScopedPause (the shared predicate)', () => {
  it('NOT paused ⇒ no kind is held', () => {
    expect(resolvePausedKinds(emptyPauseState())).toEqual([]);
    expect(resolvePausedKinds(null)).toEqual([]);
    expect(resolvePausedKinds({ paused: 'yes' })).toEqual([]);
    for (const k of PAUSABLE_KINDS) expect(isKindPaused(emptyPauseState(), k)).toBe(false);
  });
  it('BACKWARD COMPAT: an OLD-FORMAT paused marker (no pausedKinds at all) holds EVERY kind', () => {
    const old = { paused: true, reason: 'incident', by: 'nic', at: '2026-09-08T00:00:00.000Z' };
    expect(resolvePausedKinds(old)).toEqual([...PAUSABLE_KINDS]);
    for (const k of PAUSABLE_KINDS) expect(isKindPaused(old, k)).toBe(true);
    expect(isScopedPause(old)).toBe(false);
  });
  it('an explicitly NULL or EMPTY pausedKinds is blanket too — never a pause that holds nothing', () => {
    expect(resolvePausedKinds({ paused: true, pausedKinds: null })).toEqual([...PAUSABLE_KINDS]);
    expect(resolvePausedKinds({ paused: true, pausedKinds: [] })).toEqual([...PAUSABLE_KINDS]);
  });
  it('a SCOPED pause holds only the named kinds and lets every other kind through', () => {
    const scoped = { paused: true, pausedKinds: ['build', 'prepare', 'prepare-decision', 'investigate'] };
    expect(resolvePausedKinds(scoped)).toEqual(['build', 'prepare', 'prepare-decision', 'investigate']);
    expect(isKindPaused(scoped, 'build')).toBe(true);
    expect(isKindPaused(scoped, 'prepare')).toBe(true);
    expect(isKindPaused(scoped, 'prepare-decision')).toBe(true);
    expect(isKindPaused(scoped, 'investigate')).toBe(true);
    expect(isKindPaused(scoped, 'fix')).toBe(false);
    expect(isKindPaused(scoped, 'ci-heal')).toBe(false);
    expect(isScopedPause(scoped)).toBe(true);
  });
  it('a scope naming ALL kinds reads as blanket (same hold, same wording)', () => {
    expect(isScopedPause({ paused: true, pausedKinds: [...PAUSABLE_KINDS] })).toBe(false);
  });
});

describe('dispatch-pause — setPause / parse / serialize carry the scope', () => {
  it('setPause with no kinds stays BLANKET — every pre-scope caller sets exactly what it always did', () => {
    const s = setPause({ reason: 'incident' }, 1_000);
    expect(s.pausedKinds).toBeNull();
    expect(resolvePausedKinds(s)).toEqual([...PAUSABLE_KINDS]);
  });
  it('setPause with kinds records the scope, normalized', () => {
    const s = setPause({ reason: 'conserve tokens', kinds: [' build ', 'fix', 'fix'] }, 1_000);
    expect(s.pausedKinds).toEqual(['build', 'fix']);
  });
  it('a SCOPED marker round-trips through serialize → parse unchanged', () => {
    const s = setPause({ reason: 'r', by: 'b', kinds: ['build', 'prepare', 'prepare-decision', 'investigate'] }, 2_000);
    expect(parsePauseState(serializePauseState(s))).toEqual(s);
    expect(serializePauseState(s)).toContain('"pausedKinds"');
  });
  it('parses a scoped marker straight off disk text', () => {
    const s = parsePauseState(JSON.stringify({ paused: true, pausedKinds: ['fix'], reason: 'r' }));
    expect(s.pausedKinds).toEqual(['fix']);
    expect(isKindPaused(s, 'fix')).toBe(true);
    expect(isKindPaused(s, 'build')).toBe(false);
  });
  it('a scope on a NOT-paused marker normalizes away — a cleared state is canonical whatever preceded it', () => {
    expect(parsePauseState(JSON.stringify({ paused: false, pausedKinds: ['fix'] }))).toEqual(emptyPauseState());
    expect(clearPause()).toEqual(emptyPauseState());
  });
});

describe('dispatch-pause — the durable marker, scoped (readPausedKinds / isDispatchPaused)', () => {
  it('isDispatchPaused stays "is ANY pause set" — a SCOPED pause still reads true for boolean-only callers', () => {
    const p = tmpMarker();
    writePauseState(setPause({ reason: 'scoped', kinds: ['fix'] }, 1), p);
    expect(isDispatchPaused(p)).toBe(true);
    expect(readPausedKinds(p)).toEqual(['fix']);
  });
  it('readPausedKinds expands an OLD-FORMAT file on disk to every kind', () => {
    const p = tmpMarker();
    writeFileSync(p, JSON.stringify({ paused: true, reason: 'old format', by: 'nic', at: 'x' }));
    expect(readPausedKinds(p)).toEqual([...PAUSABLE_KINDS]);
  });
  it('an absent or corrupt marker holds NO kind — fails open on the per-kind read too', () => {
    const p = tmpMarker();
    expect(readPausedKinds(p)).toEqual([]);
    writeFileSync(p, '{ not json');
    expect(readPausedKinds(p)).toEqual([]);
  });
  it('CLEAR fully unpauses regardless of prior scoping', () => {
    const p = tmpMarker();
    writePausedScoped(p);
    expect(readPausedKinds(p)).toEqual(['build', 'prepare']);
    writePauseState(clearPause(), p);
    expect(isDispatchPaused(p)).toBe(false);
    expect(readPausedKinds(p)).toEqual([]);
    expect(readPauseState(p)).toEqual(emptyPauseState());
  });
  function writePausedScoped(p) { writePauseState(setPause({ reason: 'r', kinds: ['build', 'prepare'] }, 1), p); }
});

describe('dispatch-pause — parseKindsFlag (WRITE-time validation of --kinds)', () => {
  it('an ABSENT flag is a blanket pause, no error', () => {
    expect(parseKindsFlag(undefined)).toEqual({ kinds: null, error: null });
  });
  it('a valid comma list parses, trimmed and deduped', () => {
    expect(parseKindsFlag('build, prepare,prepare-decision,investigate')).toEqual({
      kinds: ['build', 'prepare', 'prepare-decision', 'investigate'], error: null,
    });
  });
  it('a BARE --kinds (no value) is REFUSED — never a silent fall-back that WIDENS the pause', () => {
    const r = parseKindsFlag(true);
    expect(r.kinds).toBeNull();
    expect(r.error).toMatch(/needs at least one kind/);
  });
  it('a value of nothing but separators is refused the same way', () => {
    expect(parseKindsFlag(',, ,').error).toMatch(/needs at least one kind/);
  });
  it('an UNKNOWN kind is refused loudly, naming the offender and the valid set', () => {
    const r = parseKindsFlag('build,investigation');
    expect(r.kinds).toBeNull();
    expect(r.error).toContain('investigation');
    expect(r.error).toContain('investigate');
  });
});

describe('dispatch-pause — describeHeldKinds (the operator gloss `set` and `status` print)', () => {
  it('not paused', () => { expect(describeHeldKinds(emptyPauseState())).toMatch(/dispatch is running/); });
  it('blanket says ALL kinds', () => {
    expect(describeHeldKinds({ paused: true })).toContain('ALL kinds');
  });
  it('scoped names the held kinds AND says the rest still dispatch', () => {
    const d = describeHeldKinds({ paused: true, pausedKinds: ['build', 'prepare'] });
    expect(d).toContain('build, prepare');
    expect(d).toContain('other kinds still dispatch');
    expect(d).not.toContain('ALL kinds');
  });
});

describe('dispatch-pause — the CLI end to end (set --kinds / status / clear)', () => {
  const CLI = resolve(HERE, '..', 'dispatch-pause.mjs');
  const run = (args, path) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', env: { ...process.env, WE_DISPATCH_PAUSE_FILE: path },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('`set --kinds=...` writes a SCOPED marker and reports what it holds', () => {
    const p = tmpMarker();
    const r = run(['set', '--reason=conserve tokens', '--by=nic', '--kinds=build,prepare,prepare-decision,investigate'], p);
    expect(r.code).toBe(0);
    const state = JSON.parse(r.out);
    expect(state.paused).toBe(true);
    expect(state.pausedKinds).toEqual(['build', 'prepare', 'prepare-decision', 'investigate']);
    expect(state.reason).toBe('conserve tokens');
    expect(r.err).toContain('build, prepare, prepare-decision, investigate');
    expect(readPausedKinds(p)).toEqual(['build', 'prepare', 'prepare-decision', 'investigate']);
  });
  it('`status` echoes the scope AND the derived heldKinds, and says the rest still dispatch', () => {
    const p = tmpMarker();
    run(['set', '--reason=r', '--kinds=build,prepare'], p);
    const r = run(['status'], p);
    expect(r.code).toBe(0);
    const st = JSON.parse(r.out);
    expect(st.pausedKinds).toEqual(['build', 'prepare']);
    expect(st.heldKinds).toEqual(['build', 'prepare']);
    expect(r.err).toContain('other kinds still dispatch');
  });
  it('`status` on an OLD-FORMAT marker reports ALL kinds held', () => {
    const p = tmpMarker();
    writeFileSync(p, JSON.stringify({ paused: true, reason: 'old', by: 'nic', at: 'x' }));
    const r = run(['status'], p);
    const st = JSON.parse(r.out);
    expect(st.pausedKinds).toBeNull();
    expect(st.heldKinds).toEqual([...PAUSABLE_KINDS]);
    expect(r.err).toContain('ALL kinds');
  });
  it('`set` with NO --kinds still writes the blanket pause it always did', () => {
    const p = tmpMarker();
    const r = run(['set', '--reason=incident'], p);
    expect(JSON.parse(r.out).pausedKinds).toBeNull();
    expect(readPausedKinds(p)).toEqual([...PAUSABLE_KINDS]);
  });
  it('`set --kinds=<typo>` EXITS NON-ZERO and writes nothing', () => {
    const p = tmpMarker();
    const r = run(['set', '--kinds=investigation'], p);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown dispatch kind');
    expect(existsSync(p)).toBe(false);
  });
  it('`clear` fully unpauses after a SCOPED pause', () => {
    const p = tmpMarker();
    run(['set', '--kinds=build,fix'], p);
    const r = run(['clear'], p);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ paused: false, pausedKinds: null });
    expect(readPauseState(p)).toEqual(emptyPauseState());
    expect(readPausedKinds(p)).toEqual([]);
  });
});
