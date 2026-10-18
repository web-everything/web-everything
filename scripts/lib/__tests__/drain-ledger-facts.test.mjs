import { describe, it, expect } from 'vitest';
import { drainLedgerReadStore, drainReviewGateFact, planDrainLedgerFacts, readDrainLedgerSnapshot,
  recordDrainLedgerFacts } from '../drain-ledger-facts.mjs';
import { decideReviewGate } from '../review-escalation.mjs';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendVerdict, buildLedgerEvent, buildVerdictRecord, probeOrigin, resolveLedgerBoard, resolveLedgerBoardDetail,
  verdictLedgerPath } from '../verdict-ledger.mjs';
import { recordDrainHold } from '../../merge-ai-prs.mjs';
const repo = 'o/r', head = 'a'.repeat(40), old = 'b'.repeat(40), now = '2026-10-13T12:00:00.000Z';
const base = { repo, pr: 1, at: now, source: 'test', declaredActor: 'test' };
const event = (type, extra) => buildLedgerEvent({ ...base, type, ...extra });
const verdict = (v, sha = old) => buildVerdictRecord({ ...base, verdict: v, headSha: sha, reason: 'test' });
const v = { repo, num: 1, listedHeadSha: head, decision: 'merge', reviewGate: { reviewExempt: true } };
const plan = (events = [], overrides = {}) => planDrainLedgerFacts({ verdicts: [{ ...v, ...overrides }], repo, events, now });
describe('drain ledger facts', () => {
  it('recognizes only the real no-review branch', () => {
    expect(drainReviewGateFact(decideReviewGate({ escalate: false, labels: [] })).reviewExempt).toBe(true);
    for (const labels of [['review:accepted'], ['review:changes'], ['review:human'], ['review:pending']]) {
      expect(drainReviewGateFact(decideReviewGate({ escalate: false, labels })).reviewExempt).toBe(false);
    }
    expect(drainReviewGateFact(decideReviewGate({ escalate: true, labels: [] })).reviewExempt).toBe(false);
    expect(drainReviewGateFact({ action: 'merge', reason: 'review:accepted — reviewer accepted, merge' }).acceptedMerge).toBe(true);
    expect(drainReviewGateFact(null)).toEqual({ reviewExempt: false, acceptedMerge: false });
  });
  it('dedupes the latest exempt head and never writes over a bearing verdict', () => {
    const rows = plan();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ type: 'review-exempt', headSha: head });
    expect(plan(rows)).toEqual([]);
    expect(plan(rows, { listedHeadSha: old })).toHaveLength(1);
    for (const kind of ['pending', 'changes', 'human', 'accepted']) expect(plan([verdict(kind)])).toEqual([]);
  });
  it('dedupes against the latest exemption when a head returns', () => {
    const exempt = headSha => event('review-exempt', { headSha, basis: 'test' });
    const events = [exempt(head), exempt(old), verdict('observed')];
    const rows = plan(events);
    expect(rows).toMatchObject([{ type: 'review-exempt', headSha: head }]);
    expect(plan([...events, ...rows, verdict('observed')])).toEqual([]);
    expect(plan([exempt(head),
      buildLedgerEvent({ ...base, pr: 2, type: 'review-exempt', headSha: old, basis: 'test' }),
      buildLedgerEvent({ ...base, repo: 'other/r', type: 'review-exempt', headSha: old, basis: 'test' }),
    ])).toEqual([]);
  });
  it('restamps only a clearing acceptance on a different head', () => {
    const gate = { reviewGate: { acceptedMerge: true } };
    expect(plan([verdict('accepted')], gate)[0]).toMatchObject({ verdict: 'restamped', coverage: { headSha: head } });
    expect(plan([verdict('accepted', head)], gate)).toEqual([]);
    expect(plan([verdict('accepted', null)], gate)).toHaveLength(1);
    for (const kind of ['pending', 'changes', 'human']) expect(plan([verdict(kind)], gate)).toEqual([]);
    expect(plan([], gate)).toEqual([]);
  });
  it('releases only open drain holds, only on merge', () => {
    const hold = (reasonCode, holdSource = 'drain') => event('hold', { reasonCode, holdSource });
    const events = [hold('review'), hold('ci'), event('release', { reasonCode: 'ci', holdSource: 'drain' }), hold('other', 'operator')];
    expect(plan(events, { reviewGate: {} })).toMatchObject([{ type: 'release', reasonCode: 'review', holdSource: 'drain' }]);
    expect(plan(events, { decision: 'skip', reviewGate: {} })).toEqual([]);
  });
  it('writes no fact of any kind for a head the drain did not decide to merge', () => {
    // The review gate runs before the CI, CodeQL, conflict and red-main holds; only the final decision may clear.
    const cases = [
      ['exempt', [], { reviewGate: { reviewExempt: true } }],
      ['restamped', [verdict('accepted')], { reviewGate: { acceptedMerge: true } }],
      ['released', [event('hold', { reasonCode: 'ci', holdSource: 'drain' })], { reviewGate: {} }],
    ];
    for (const [kind, events, gate] of cases) {
      expect(plan(events, { ...gate, decision: 'merge' }), kind).toHaveLength(1);
      for (const decision of ['skip', undefined, null, 'MERGE', 'merge ']) {
        expect(plan(events, { ...gate, decision }), `${kind} on decision ${decision}`).toEqual([]);
      }
    }
    const writes = [];
    const result = recordDrainLedgerFacts({ localSlug: repo, now: () => now, read: () => [verdict('accepted')],
      append: row => { writes.push(row); return { ok: true }; },
      verdicts: [{ ...v, decision: 'skip', reviewGate: { reviewExempt: true, acceptedMerge: true } }] });
    expect(result).toMatchObject({ ok: true, appended: { exempt: 0, restamped: 0, released: 0 } });
    expect(writes).toEqual([]);
  });
  it('rejects foreign repos and invalid heads or PR numbers', () => {
    for (const overrides of [{ repo: 'other/r' }, { num: 'x' }, { num: 0 }, { listedHeadSha: 'abc' }]) expect(plan([], overrides)).toEqual([]);
  });
  it('fails softly on unreadable reads and continues after append failures', () => {
    const writes = [];
    const bad = recordDrainLedgerFacts({ verdicts: [v], read: () => { throw new Error('denied'); }, append: r => writes.push(r) });
    expect(bad.ok).toBe(false); expect(bad.errors.join()).toContain('denied'); expect(writes).toEqual([]);
    const holds = [event('hold', { reasonCode: 'review', holdSource: 'drain' })];
    const result = recordDrainLedgerFacts({ verdicts: [v], now: () => now, read: () => holds, append: r => { writes.push(r); if (r.type === 'review-exempt') throw new Error('append failed'); return { ok: true }; } });
    expect(result).toMatchObject({ ok: false, appended: { exempt: 0, restamped: 0, released: 1 } });
    expect(writes).toHaveLength(2);
    expect(() => recordDrainLedgerFacts(null)).not.toThrow();
    expect(recordDrainLedgerFacts({ verdicts: [v], read: () => null }).ok).toBe(false);
  });
  it('treats a missing file as empty and malformed records as unreadable', () => {
    const writes = [], append = row => { writes.push(row); return { ok: true }; };
    expect(recordDrainLedgerFacts({ verdicts: [v], now: () => now, append,
      read: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } })).toMatchObject({ ok: true, appended: { exempt: 1 } });
    writes.length = 0;
    expect(recordDrainLedgerFacts({ verdicts: [v], append, read: () => [{ repo, pr: 1, type: 'unknown' }] }).ok).toBe(false);
    expect(writes).toEqual([]);
  });
  it('allows non-bearing observations and scopes grouped repos without changing decisions', () => {
    expect(plan([verdict('observed')])).toHaveLength(1);
    const verdicts = [v, { ...v, repo: 'O/R', num: 2 }, { ...v, repo: null, num: 3 }];
    const before = JSON.stringify(verdicts), reads = [], writes = [];
    const result = recordDrainLedgerFacts({ verdicts, localSlug: repo, now: () => now,
      read: r => { reads.push(r); return []; }, append: row => { writes.push(row); return { ok: true }; } });
    expect(result).toMatchObject({ ok: true, appended: { exempt: 3, restamped: 0, released: 0 } });
    expect(reads).toEqual([repo]); expect(writes.map(r => r.pr)).toEqual([1, 2, 3]);
    expect(JSON.stringify(verdicts)).toBe(before);
  });
  it('an exemption uses git-first F4 ordering and never spills on a git miss', () => {
    const calls = [];
    const result = appendVerdict(plan()[0], { store: 'dual', board: '/board', warn: () => {},
      gitAppend: () => { calls.push('git'); throw new Error('push refused'); },
      homeAppend: () => { calls.push('home'); return { ok: true }; } });
    expect(result).toMatchObject({ ok: false, ledgerWriteMiss: true });
    expect(calls).toEqual(['git']);
  });
  it('a release that misses the shared store fails, writes no home row, and is retried next pass', () => {
    const home = [event('hold', { reasonCode: 'review', holdSource: 'drain' })], calls = [];
    const run = gitAppend => recordDrainLedgerFacts({ verdicts: [{ ...v, reviewGate: {} }], now: () => now, read: () => home,
      append: row => appendVerdict(row, { store: 'dual', board: '/board', warn: () => {}, gitAppend,
        homeAppend: r => { calls.push('home'); home.push(r); return { ok: true, record: r }; } }) });
    const missed = run(() => { calls.push('git'); throw new Error('push refused'); });
    expect(missed).toMatchObject({ ok: false, appended: { released: 0 } });
    expect(calls).toEqual(['git']);
    expect(home.map(e => e.type)).toEqual(['hold']);
    calls.length = 0;
    expect(run(() => { calls.push('git'); return { status: 'appended' }; })).toMatchObject({ ok: true, appended: { released: 1 } });
    expect(calls).toEqual(['git', 'home']);
  });
  it('dedupes a live drain hold but records it again after release', () => {
    const hold = event('hold', { reasonCode: 'review', holdSource: 'drain' });
    const writes = [], append = row => { writes.push(row); return { ok: true }; };
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: () => [hold], append }).appended).toBe(false);
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: () => [hold, event('release', { reasonCode: 'review', holdSource: 'drain' })], append }).appended).toBe(true);
    expect(writes).toHaveLength(1);
  });
});

describe('drain ledger facts — the recorders read the store their writes land in', () => {
  const hold = event('hold', { reasonCode: 'review', holdSource: 'drain' });
  const release = event('release', { reasonCode: 'review', holdSource: 'drain' });
  const dual = { WE_VERDICT_LEDGER_STORE: 'dual', WE_VERDICT_LEDGER_BOARD: '/board' };
  const stores = () => {
    const git = [], home = [];
    const append = fail => row => appendVerdict(row, { store: 'dual', board: '/board', warn: () => {},
      gitAppend: a => { if (fail) throw new Error('push refused'); git.push(...a.records); return { status: 'appended' }; },
      homeAppend: r => { home.push(r); return { ok: true, record: r }; } });
    const snapshot = () => readDrainLedgerSnapshot([repo], { env: dual, readStore: async () => ({ status: 'ok', rows: [...git] }) });
    return { git, home, append, snapshot };
  };
  it('resolves the read store as the write path does', () => {
    expect(drainLedgerReadStore(repo, { WE_VERDICT_LEDGER_STORE: 'home' })).toBe('home');
    expect(drainLedgerReadStore(repo, dual)).toBe('git');
    expect(drainLedgerReadStore(repo, { WE_VERDICT_LEDGER_STORE: 'git', WE_VERDICT_LEDGER_BOARD: '/board' })).toBe('git');
    expect(drainLedgerReadStore(repo, { VITEST: 'true' })).toBe('home');
    expect(drainLedgerReadStore(repo, { WE_VERDICT_LEDGER_BOARD: '/board' })).toBe('git');
    // A NAMED store with no board never writes git (holds land in home, releases are refused): home is the store.
    expect(drainLedgerReadStore(repo, { WE_VERDICT_LEDGER_STORE: 'dual' })).toBe('home');
    expect(drainLedgerReadStore(repo, { WE_VERDICT_LEDGER_STORE: 'git' })).toBe('home');
    // A board that is only UNKNOWN (an origin probe failed) is not "no board": read git, so the read fails, not home.
    const unknown = { resolveBoard: () => ({ board: null, certain: false }) };
    expect(drainLedgerReadStore(repo, { WE_VERDICT_LEDGER_STORE: 'dual' }, unknown)).toBe('git');
    expect(drainLedgerReadStore(repo, {}, unknown)).toBe('git');
  });
  it('a failed origin probe leaves the board unknown, never certainly absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drain-facts-board-'));
    try {
      expect(resolveLedgerBoardDetail(repo, { boardRoot: dir, originRepo: () => '' }, {})).toEqual({ board: null, certain: false });
      expect(resolveLedgerBoardDetail(repo, { boardRoot: dir, originRepo: () => 'x/y' }, {})).toEqual({ board: null, certain: true });
      expect(resolveLedgerBoardDetail(repo, { boardRoot: dir, originRepo: () => repo }, {})).toEqual({ board: dir, certain: true });
      expect(resolveLedgerBoard(repo, { boardRoot: dir, originRepo: () => '' }, {})).toBe(null);
      // The real probe: a plain directory and a checkout with no origin are certainly not the board (a lasting
      // answer, so they must not make every pass's read fail); only a timed-out or unstartable probe is unknown.
      expect(resolveLedgerBoardDetail(repo, { boardRoot: dir }, {})).toEqual({ board: null, certain: true });
      execFileSync('git', ['init', '-q', dir]);
      expect(resolveLedgerBoardDetail(repo, { boardRoot: dir }, {})).toEqual({ board: null, certain: true });
      expect(probeOrigin(dir)).toEqual({ slug: '', transient: false });
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@host:not-a-slug']);
      expect(probeOrigin(dir)).toEqual({ slug: '', transient: false });
      const timedOut = () => { throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null }); };
      expect(probeOrigin(dir, timedOut)).toEqual({ slug: '', transient: true });
      const noGit = () => { throw Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT', status: null }); };
      expect(probeOrigin(dir, noGit)).toEqual({ slug: '', transient: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a hold that misses the shared store is reported and recorded again on the next pass', async () => {
    const s = stores();
    const missed = recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(), append: s.append(true) });
    expect(missed).toMatchObject({ ok: false, appended: false });
    expect(s.home.map(e => e.type)).toEqual(['hold']);
    expect(s.git).toEqual([]);
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(), append: s.append(false) }))
      .toMatchObject({ ok: true, appended: true });
    expect(s.git.map(e => e.type)).toEqual(['hold']);
  });
  it('a hold the shared store shows released is recorded again even when home still shows it held', async () => {
    const s = stores();
    s.git.push(hold, release); s.home.push(hold);
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(), append: s.append(false) }).appended).toBe(true);
    expect(s.git.map(e => e.type)).toEqual(['hold', 'release', 'hold']);
  });
  it('plans releases from the shared store, so a hold only home saw cannot hide one git still has', async () => {
    const s = stores(), other = event('hold', { reasonCode: 'other', holdSource: 'drain' });
    s.git.push(hold); s.home.push(hold, other);
    const result = recordDrainLedgerFacts({ verdicts: [{ ...v, reviewGate: {} }], now: () => now, read: await s.snapshot(), append: s.append(false) });
    expect(result).toMatchObject({ ok: true, appended: { released: 1 } });
    expect(s.git.at(-1)).toMatchObject({ type: 'release', reasonCode: 'review' });
  });
  it('an unreadable store writes no release or exemption, but still records a hold (F4); repos are read once by exact name', async () => {
    const calls = [], writes = [];
    const read = await readDrainLedgerSnapshot([repo, ` ${repo} `, 'O/R', 'x/y', null], { env: dual,
      readStore: async r => { calls.push(r); return r === 'x/y' ? { status: 'unreadable', reason: 'no-board', error: 'none' } : { status: 'ok', rows: [] }; } });
    expect(calls).toEqual([repo, 'O/R', 'x/y']);
    expect(read('O/R')).toEqual([]);
    const append = row => { writes.push(row); return { ok: true }; };
    expect(recordDrainLedgerFacts({ verdicts: [{ ...v, repo: 'x/y' }], read, append }).ok).toBe(false);
    expect(writes).toEqual([]);
    expect(recordDrainHold({ repo: 'x/y', pr: 1, reason: 'review', read, append })).toMatchObject({ ok: true, appended: true });
    expect(recordDrainHold({ repo: 'z/w', pr: 1, reason: 'review', read, append })).toMatchObject({ ok: true, appended: true });
    expect(writes.map(r => [r.type, r.repo])).toEqual([['hold', 'x/y'], ['hold', 'z/w']]);
  });
  // Home is a real file here, so a fallback that read the home ledger would see these rows.
  const withHome = async body => {
    const dir = mkdtempSync(join(tmpdir(), 'drain-facts-home-')), prev = process.env.WE_VERDICT_LEDGER_DIR;
    process.env.WE_VERDICT_LEDGER_DIR = dir;
    try {
      const git = [], home = () => readFileSync(verdictLedgerPath(repo), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const append = ({ homeFails = false, gitFails = false } = {}) => row => appendVerdict(row, { store: 'dual', board: '/board', warn: () => {},
        gitAppend: a => { if (gitFails) throw new Error('push refused'); git.push(...a.records); return { status: 'appended' }; },
        homeAppend: r => { if (homeFails) throw new Error('home locked'); appendFileSync(verdictLedgerPath(repo), `${JSON.stringify(r)}\n`); return { ok: true, record: r }; } });
      const snapshot = ok => readDrainLedgerSnapshot([repo], { env: dual,
        readStore: async () => (ok ? { status: 'ok', rows: [...git] } : { status: 'unreadable', reason: 'read-cap', error: 'down' }) });
      await body({ git, home, append, snapshot });
    } finally {
      if (prev === undefined) delete process.env.WE_VERDICT_LEDGER_DIR; else process.env.WE_VERDICT_LEDGER_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it('a partial release (git written, home missed) never lets the home fallback drop a needed shared hold', () => withHome(async s => {
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(true), append: s.append() })).toMatchObject({ ok: true, appended: true });
    // The PR is merge-decided: its release reaches git, then the home write fails.
    const released = recordDrainLedgerFacts({ verdicts: [{ ...v, reviewGate: {} }], now: () => now, read: await s.snapshot(true), append: s.append({ homeFails: true }) });
    expect(released).toMatchObject({ ok: false, appended: { released: 0 } });
    expect(s.git.map(e => e.type)).toEqual(['hold', 'release']);
    expect(s.home().map(e => e.type)).toEqual(['hold']);
    // The merge did not land and the PR is held again while the shared read is down: home still shows the old hold.
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(false), append: s.append() })).toMatchObject({ ok: true, appended: true });
    expect(s.git.map(e => e.type)).toEqual(['hold', 'release', 'hold']);
  }));
  it('a second drain interleaving a hold before another drain\'s partial release still keeps the shared hold', () => withHome(async s => {
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(true), append: s.append() })).toMatchObject({ ok: true, appended: true });
    // Drain B (the fast drain runs beside the resident one) reads first and plans a release from that read.
    const readB = await s.snapshot(true);
    // Drain A, its shared read down, records the hold in between (git and home).
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(false), append: s.append() })).toMatchObject({ ok: true, appended: true });
    // B's release then reaches git and misses home.
    expect(recordDrainLedgerFacts({ verdicts: [{ ...v, reviewGate: {} }], now: () => now, read: readB, append: s.append({ homeFails: true }) }))
      .toMatchObject({ ok: false, appended: { released: 0 } });
    expect(s.git.map(e => e.type)).toEqual(['hold', 'hold', 'release']);
    expect(s.home().map(e => e.type)).toEqual(['hold', 'hold']);
    // A's next pass, read still down: home's newest row is A's own hold, yet git shows the PR released.
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(false), append: s.append() })).toMatchObject({ ok: true, appended: true });
    expect(s.git.map(e => e.type)).toEqual(['hold', 'hold', 'release', 'hold']);
  }));
  it('a lasting read failure records the hold every pass (the price of never dropping one), and a good read dedups again', () => withHome(async s => {
    for (let pass = 0; pass < 3; pass++) {
      expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(false), append: s.append({ gitFails: true }) }))
        .toMatchObject({ ok: false, appended: false });
    }
    expect(s.home().map(e => e.type)).toEqual(['hold', 'hold', 'hold']);
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(true), append: s.append() })).toMatchObject({ ok: true, appended: true });
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(true), append: s.append() })).toMatchObject({ ok: true, appended: false });
    expect(s.git.map(e => e.type)).toEqual(['hold']);
  }));
  it('a named store with no board reads home, so a held PR records its hold once over many passes', () => withHome(async s => {
    const noBoard = { WE_VERDICT_LEDGER_STORE: 'dual' };
    const append = row => appendVerdict(row, { env: noBoard, warn: () => {},
      homeAppend: r => { appendFileSync(verdictLedgerPath(repo), `${JSON.stringify(r)}\n`); return { ok: true, record: r }; } });
    const pass = async () => recordDrainHold({ repo, pr: 1, reason: 'review', append,
      read: await readDrainLedgerSnapshot([repo], { env: noBoard, readStore: async () => { throw new Error('a no-board repo must not read git'); } }) });
    expect(await pass()).toMatchObject({ appended: false, errors: [expect.stringMatching(/ledger-write-miss/)] });
    for (let n = 0; n < 4; n++) expect(await pass()).toMatchObject({ ok: true, appended: false });
    expect(s.home().map(e => e.type)).toEqual(['hold']);
  }));
  it('a flaky origin probe during the read never dedups against a home that lags a git release', () => withHome(async s => {
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: await s.snapshot(true), append: s.append() })).toMatchObject({ ok: true, appended: true });
    expect(recordDrainLedgerFacts({ verdicts: [{ ...v, reviewGate: {} }], now: () => now, read: await s.snapshot(true), append: s.append({ homeFails: true }) }))
      .toMatchObject({ ok: false });
    expect(s.home().map(e => e.type)).toEqual(['hold']);
    // This pass the origin probe fails during the read; the write then finds the board again.
    const noBoardEnv = { WE_VERDICT_LEDGER_STORE: 'dual' };
    const read = await readDrainLedgerSnapshot([repo], { env: noBoardEnv, resolveBoard: () => ({ board: null, certain: false }),
      readStore: async (_r, { store }) => ({ status: 'unreadable', reason: 'no-board', error: `store ${store}` }) });
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read, append: s.append() })).toMatchObject({ ok: true, appended: true });
    expect(s.git.map(e => e.type)).toEqual(['hold', 'release', 'hold']);
  }));
});

describe('drain ledger facts — head prefixes and numeric strings', () => {
  it('does not restamp when the clearing row names an abbreviation of the live head', () => {
    const rows = planDrainLedgerFacts({ verdicts: [{ ...v, reviewGate: { acceptedMerge: true } }], repo, now,
      events: [verdict('accepted', head.slice(0, 12))] });
    expect(rows).toEqual([]);
  });
  it('accepts a numeric-string PR number', () => {
    expect(planDrainLedgerFacts({ verdicts: [{ ...v, num: '1' }], repo, events: [], now })).toHaveLength(1);
  });
});

describe('drain ledger facts — wiring: written only after the cascade confirms the land', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'merge-ai-prs.mjs'), 'utf8');
  it('is never recorded on the pass-start decision, only inside the land cascade', () => {
    expect(src.match(/recordDrainLedgerFacts\(/g)).toHaveLength(1);
    const helper = src.indexOf('const recordLandedLedgerFacts = async (c, headSha) => {');
    expect(helper).toBeGreaterThan(-1);
    expect(src.indexOf('recordDrainLedgerFacts(')).toBeGreaterThan(helper);
    // The only callers: the cascade's two confirmed-land sites, and the pre-stage shortcut's post-enqueue hook
    // (`enqueuePrestage` calls `recordLanded` only after `enqueued: true`; drain-prestage.test.mjs pins that).
    expect(src.match(/await recordLandedLedgerFacts\(c, traceHeadSha\)/g)).toHaveLength(2);
    expect(src.match(/recordLanded: recordLandedLedgerFacts,/g)).toHaveLength(1);
    expect(src.match(/\brecordLandedLedgerFacts\b/g)).toHaveLength(4);
  });
  it('re-reads the ledger at write time, so a verdict appended mid-cascade is seen before a restamp', () => {
    const helper = src.indexOf('const recordLandedLedgerFacts = async (c, headSha) => {');
    const reread = src.indexOf('const read = await readDrainLedgerSnapshot([c.repo || localSlug]);', helper);
    expect(helper).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(helper);
    expect(src.indexOf('recordDrainLedgerFacts(', helper)).toBeGreaterThan(reread);
    expect(src.slice(src.indexOf('recordDrainLedgerFacts(', helper)).split('\n')[0]).toContain('read }');
  });
  it('a restamp planned on a fresh read never follows a newer rejection of the same head', () => {
    const gate = { reviewGate: { acceptedMerge: true } };
    expect(plan([verdict('accepted')], gate)).toHaveLength(1);
    for (const kind of ['changes', 'human', 'pending']) expect(plan([verdict('accepted'), verdict(kind, head)], gate)).toEqual([]);
  });
  it('each call follows every cascade refusal and a confirmed merge or enqueue', () => {
    const refusals = ["if (revalidated.decision !== 'merge') {", 'if (!(await mergeQueueGate(c, revalidated.headSha))) {',
      'if (landLock.ran === false) {', "if (landLock.result && landLock.result.skipped === 'already-merged') {"];
    const enqueued = src.indexOf('if (landLock.result?.enqueued === true) {');
    const merged = src.indexOf('merged.push({ num: c.num, repo: c.repo, headSha: c.headSha ?? null }); progressed = true;');
    const calls = [src.indexOf('recordLandedLedgerFacts(c, traceHeadSha)'), src.lastIndexOf('recordLandedLedgerFacts(c, traceHeadSha)')];
    for (const refusal of refusals) {
      const at = src.indexOf(refusal);
      expect(at, refusal).toBeGreaterThan(-1);
      for (const call of calls) expect(call, refusal).toBeGreaterThan(at);
    }
    expect(calls[0]).toBeGreaterThan(enqueued); expect(calls[0] - enqueued).toBeLessThan(300);
    expect(calls[1]).toBeGreaterThan(merged); expect(calls[1] - merged).toBeLessThan(200);
  });
});
