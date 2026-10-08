import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoRearmDecision, autoRearmUnderLock, rearmInfraBlock, retryDecision, markRetryAttempt, markRefusedAttempt,
  parseInfraStore, serializeInfraStore, readInfraStore, writeInfraStore, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_AUTO_REARMS,
} from '../infra-blocked.mjs';

const NOW = Date.parse('2026-10-08T08:00:00Z');
const capped = (extra = {}) => ({ num: '4381', ref: 'lane/x', cause: 'GitHub outage (transient)', attempt: DEFAULT_MAX_ATTEMPTS,
  refusals: 0, lastAttemptAt: '2026-10-08T07:59:00Z', nextRetryAt: '2026-10-08T08:30:00Z', ...extra });

describe('auto re-arm of attempt-capped entries after a finished GitHub outage', () => {
  it('is capped (surfaced) before the re-arm', () => {
    expect(retryDecision(capped(), { now: NOW })).toEqual({ action: 'surface', reason: 'attempt-cap' });
  });
  it('re-arms once GitHub status is operational again (cause refined to transient)', () => {
    expect(autoRearmDecision(capped(), { now: NOW })).toEqual({ rearm: true, why: 'github-operational' });
  });
  it('re-arms a still-labelled outage only after the cool-off', () => {
    const e = capped({ cause: 'GitHub outage' });
    expect(autoRearmDecision(e, { now: NOW, cooloffMs: 3_600_000 }).rearm).toBe(false);
    expect(autoRearmDecision(e, { now: NOW + 3_600_000, cooloffMs: 3_600_000 })).toEqual({ rearm: true, why: 'cool-off' });
  });
  it('is bounded by the knob and never touches non-outage or refusal-capped entries', () => {
    expect(autoRearmDecision(capped({ autoRearms: 2 }), { now: NOW, maxAutoRearms: 2 }).rearm).toBe(false);
    expect(autoRearmDecision(capped(), { now: NOW, maxAutoRearms: 0 }).rearm).toBe(false);
    expect(autoRearmDecision(capped({ cause: 'GitHub rate limit' }), { now: NOW }).rearm).toBe(false);
    expect(autoRearmDecision(capped({ refusals: 3 }), { now: NOW }).rearm).toBe(false);
    expect(autoRearmDecision(capped({ attempt: 3 }), { now: NOW }).rearm).toBe(false);
  });
  it('rearmInfraBlock auto mode resets the attempt and counts the re-arm', () => {
    const [e] = rearmInfraBlock([capped({ autoRearms: 1 })], '4381', NOW, { auto: true });
    expect(e.attempt).toBe(1);
    expect(e.autoRearms).toBe(2);
    expect(retryDecision(e, { now: NOW }).action).toBe('retry');
    expect(rearmInfraBlock([capped()], '4381', NOW)[0].autoRearms).toBeUndefined();
  });
});

describe('auto re-arm budget survives the sidecar and is rechecked under the store lock', () => {
  let dir;
  const mk = () => { dir = mkdtempSync(join(tmpdir(), 'ib-rearm-')); return join(dir, 'infra-blocked.json'); };
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('default auto-rearm budget rejects the third rearm (omitted knob pins the promised limit of two)', () => {
    expect(DEFAULT_MAX_AUTO_REARMS).toBe(2);
    expect(autoRearmDecision(capped({ autoRearms: 1 }), { now: NOW }).rearm).toBe(true);
    expect(autoRearmDecision(capped({ autoRearms: 2 }), { now: NOW }).rearm).toBe(false);
    expect(autoRearmDecision(capped({ autoRearms: 3 }), { now: NOW }).rearm).toBe(false);
  });

  it('parseInfraStore keeps autoRearms through serialize -> parse (round trip), and drops junk values', () => {
    const [e] = parseInfraStore(serializeInfraStore([capped({ autoRearms: 2 })]));
    expect(e.autoRearms).toBe(2);
    expect(autoRearmDecision(e, { now: NOW }).rearm).toBe(false);
    for (const unspent of [0, null, 0.5]) {
      expect(parseInfraStore(serializeInfraStore([capped({ autoRearms: unspent })]))[0].autoRearms).toBeUndefined();
    }
    // a corrupt counter fails CLOSED (budget treated as spent), never open
    for (const bad of [-1, 'x']) { // (NaN/Infinity cannot survive JSON.stringify; the 1e999 literal below covers them)
      const [c] = parseInfraStore(JSON.stringify([capped({ autoRearms: bad })]));
      expect(c.autoRearms).toBe(Number.MAX_SAFE_INTEGER);
      expect(autoRearmDecision(c, { now: NOW }).rearm).toBe(false);
    }
    expect(parseInfraStore('[{"num":"1","ref":"r","autoRearms":1e999}]')[0].autoRearms).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseInfraStore(serializeInfraStore([capped({ autoRearms: 1.9 })]))[0].autoRearms).toBe(1);
  });

  it('every field a store transform sets survives parse(serialize(.)) — rearm, retry and refusal marks', () => {
    const base = [capped({ cause: 'GitHub outage' })];
    for (const next of [
      rearmInfraBlock(base, '4381', NOW, { auto: true }),
      markRetryAttempt(base, '4381', NOW, { cause: 'GitHub outage (transient)' }),
      markRefusedAttempt(base, '4381', NOW, { reason: 'unverified' }),
    ]) {
      expect(parseInfraStore(serializeInfraStore(next))).toEqual(next.map((e) => ({ ...e, repo: e.repo ?? null, sha: e.sha ?? null, base: e.base ?? 'main', body: e.body ?? null, firstFailedAt: e.firstFailedAt ?? null })));
    }
  });

  it('the on-disk budget is spent: two locked auto re-arms land, the third is refused and the file keeps the count', () => {
    const path = mk();
    writeInfraStore([capped()], path);
    const opts = { now: NOW, path };
    const r1 = autoRearmUnderLock('4381', 'GitHub outage (transient)', opts);
    expect(r1).toEqual({ rearm: true, why: 'github-operational' });
    // the entry is re-capped by a later failed run, as the live loop would do
    writeInfraStore(readInfraStore(path).map((e) => ({ ...e, attempt: DEFAULT_MAX_ATTEMPTS })), path);
    expect(autoRearmUnderLock('4381', 'GitHub outage (transient)', opts).rearm).toBe(true);
    writeInfraStore(readInfraStore(path).map((e) => ({ ...e, attempt: DEFAULT_MAX_ATTEMPTS })), path);
    expect(readInfraStore(path)[0].autoRearms).toBe(2);
    const refused = autoRearmUnderLock('4381', 'GitHub outage (transient)', opts);
    expect(refused).toMatchObject({ rearm: false, reason: 'ineligible' });
    expect(readInfraStore(path)[0].attempt).toBe(DEFAULT_MAX_ATTEMPTS); // refused: untouched
  });

  it('concurrent retry passes recheck rearm eligibility under lock: only one reset occurs', () => {
    const path = mk();
    writeInfraStore([capped({ autoRearms: 1 })], path);
    const snapshotA = readInfraStore(path)[0]; // both passes saw autoRearms=1 (eligible) in their snapshot
    const snapshotB = readInfraStore(path)[0];
    expect(autoRearmDecision(snapshotA, { now: NOW }).rearm).toBe(true);
    expect(autoRearmDecision(snapshotB, { now: NOW }).rearm).toBe(true);
    const opts = { now: NOW, path };
    expect(autoRearmUnderLock('4381', 'GitHub outage (transient)', opts).rearm).toBe(true);
    // the second pass lands on the LIVE (already re-armed: attempt 1, autoRearms 2) entry, not its stale snapshot
    const second = autoRearmUnderLock('4381', 'GitHub outage (transient)', opts);
    expect(second).toMatchObject({ rearm: false, reason: 'ineligible' });
    expect(second.live.attempt).toBe(1); // reports the LIVE (already re-armed) entry, so the pass won't surface it as capped
    expect(retryDecision(second.live, { now: NOW }).action).not.toBe('surface');
    expect(readInfraStore(path)[0].autoRearms).toBe(2);
  });

  it('a refusal recorded between snapshot and mutation survives (no reset of a refused entry)', () => {
    const path = mk();
    writeInfraStore([capped()], path);
    writeInfraStore(readInfraStore(path).map((e) => ({ ...e, refusals: 3 })), path); // concurrent guard refusal
    expect(autoRearmUnderLock('4381', 'GitHub outage (transient)', { now: NOW, path })).toMatchObject({ rearm: false, reason: 'ineligible' });
    expect(readInfraStore(path)[0].refusals).toBe(3);
  });

  it('an entry removed concurrently is not reported as re-armed and is not resurrected', () => {
    const path = mk();
    writeInfraStore([capped()], path);
    writeInfraStore([], path); // concurrent resume-open removed it
    expect(autoRearmUnderLock('4381', 'GitHub outage (transient)', { now: NOW, path })).toEqual({ rearm: false, reason: 'gone' });
    expect(readInfraStore(path)).toEqual([]);
  });

  it('fails closed when the store lock cannot be taken: no re-arm, nothing written', () => {
    const path = mk();
    writeInfraStore([capped()], path);
    writeFileSync(`${path}.lock`, '1'); // a fresh live holder
    const r = autoRearmUnderLock('4381', 'GitHub outage (transient)', { now: NOW, path });
    expect(r).toEqual({ rearm: false, reason: 'lock-unavailable' });
    expect(readInfraStore(path)[0].attempt).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(readInfraStore(path)[0].autoRearms).toBeUndefined();
  }, 15000);

  it('the resolve verb removes under the store lock (no stale read-modify-write that could revert a spent budget)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/conveyor/infra-blocked.mjs'), 'utf8');
    const verb = src.slice(src.indexOf("if (sub === 'resolve'"), src.indexOf("if (sub === 'rearm')"));
    expect(verb).toMatch(/mutateInfraStore\(/);
    expect(verb).not.toMatch(/writeInfraStore\(/);
  });

  it('the retry pass wires the locked re-arm: no unlocked rearmInfraBlock, and reports rearmed only from its result', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/conveyor/infra-blocked.mjs'), 'utf8');
    expect(src).toMatch(/autoRearmUnderLock\(entry\.num, refined,/);
    expect(src).not.toMatch(/mutateInfraStore\(\(s\) => rearmInfraBlock\(s, entry\.num, Date\.now\(\), \{ auto: true \}\)/);
    expect(src).toMatch(/if \(ar\.rearm\) \{\s*rearmed\.push/);
  });
});
