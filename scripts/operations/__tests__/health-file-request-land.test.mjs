import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  nextLandingStage, landingGateReason, landOne, landPending, parseOpenPrResult, REPO_ROOT,
} from '../health-file-request-land.mjs';
import { recordRequested, writeLedger, readLedgerStrict, refFor } from '../../conveyor/health-file-request.mjs';

// A REAL directory standing in for a leased lane clone — `landOne` writes a real PR-body file at
// `<lane>/.git/...`, so the fake lane needs a real `.git` dir on disk (never REPO_ROOT's own `.git`).
let LANE_PATH;

function fakeRunner(script) {
  const calls = [];
  const runFn = (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return script({ cmd, args, cwd }, calls);
  };
  return { runFn, calls };
}

// The REAL `open-pr` `--json` shape (#4079 live-proof review, PR #2877's own catch): the run RECORD's own
// envelope, `verdictFrom: 'plan'`, so the actual pr/url live under `findings.submit.effects[].result` — never
// `{pr, url}` at the top level. Every fake `open-pr` response in this file must match this real shape, or a
// test would keep passing against the exact parsing bug the live proof found.
function fakeOpenPrResult(pr, url) {
  return JSON.stringify({
    runId: 'open-pr-test', op: 'open-pr', stopped: 'complete',
    findings: { submit: { applied: true, effects: [{ type: 'open-pr.submit', status: 'applied', result: { outcome: 'opened', pr, url }, error: null }] } },
  });
}

const baseEntry = () => ({
  key: 's::subj', smell: 's', subject: 'subj', episodeId: 'e1', title: 'T', digest: 'D', scope: ['we:a.mjs'],
  size: '3', ref: refFor('e1'), card: null, cardFile: null, attemptId: 'attempt-1',
});

describe('nextLandingStage', () => {
  it('files-and-lands when no card exists yet', () => { expect(nextLandingStage(baseEntry())).toBe('file-and-land'); });
  it('skips straight to landing an existing card once file-item already succeeded', () => {
    expect(nextLandingStage({ ...baseEntry(), card: 12, cardFile: 'backlog/12-x.md' })).toBe('land-existing-card');
  });
});

// #4079 live-proof review, PR #2877's own catch: `open-pr --json` prints the run RECORD's own envelope
// (`verdictFrom: 'plan'`), not `{pr, url}` at the top level — a naive `JSON.parse(out).pr` always read
// `undefined`. This is what a REAL run against a scratch state root surfaced; no test had driven the real
// shape until then, only a hand-picked flat fixture that happened to match what the code assumed.
describe('parseOpenPrResult', () => {
  it('extracts pr/url from the REAL nested run-record shape', () => {
    const out = fakeOpenPrResult(2877, 'https://github.com/web-everything/web-everything/pull/2877');
    expect(parseOpenPrResult(out)).toEqual({ pr: 2877, url: 'https://github.com/web-everything/web-everything/pull/2877' });
  });

  it('returns null/null for malformed or unexpected output, never throws', () => {
    expect(parseOpenPrResult('not json')).toEqual({ pr: null, url: null });
    expect(parseOpenPrResult(JSON.stringify({ some: 'other shape' }))).toEqual({ pr: null, url: null });
  });

  it('a naive flat {pr, url} shape (the OLD, wrong assumption) does NOT parse — proving this test would have'
    + ' caught the original bug', () => {
    expect(parseOpenPrResult(JSON.stringify({ pr: 555, url: 'u' }))).toEqual({ pr: null, url: null });
  });
});

describe('landingGateReason', () => {
  it('gates on fileDispatch being off', () => {
    expect(landingGateReason({ fileDispatch: false }, {})).toMatch(/fileDispatch/);
  });
  it('gates on an open lane-starvation episode, re-checked independently of the planning-time gate', () => {
    const episodes = { a: { smell: 'lane-starvation', subject: 'we', status: 'open' } };
    expect(landingGateReason({ fileDispatch: true }, episodes)).toMatch(/lane-starvation/);
  });
  it('passes when filing is on and nothing is starved', () => {
    expect(landingGateReason({ fileDispatch: true }, {})).toBeNull();
  });
});

describe('landOne — production path binding (the actual command shapes, no real subprocess)', () => {
  beforeEach(() => {
    LANE_PATH = mkdtempSync(join(tmpdir(), 'fake-lane-'));
    mkdirSync(join(LANE_PATH, '.git'), { recursive: true });
  });
  afterEach(() => { rmSync(LANE_PATH, { recursive: true, force: true }); });

  it('acquires a lane, files the card with --queue=false, commits, verifies and opens a PR — every write happens'
    + ' inside the LEASED LANE PATH, never at REPO_ROOT (the daemon clone never gets a write)', () => {
    const { runFn, calls } = fakeRunner(({ cmd, args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.some((a) => a.includes('file-item'))) return JSON.stringify({ verdict: { num: 4321, rel: 'backlog/4321-x.md' } });
      if (args.includes('release')) return '';
      if (args.some((a) => a.includes('open-pr'))) return fakeOpenPrResult(555, 'https://github.com/x/we/pull/555');
      return '';
    });
    const result = landOne(baseEntry(), { runFn });
    expect(result.status).toBe('landed');
    expect(result.card).toBe(4321);
    expect(result.pr).toBe(555);
    expect(result.prUrl).toBe('https://github.com/x/we/pull/555');

    const fileItemCall = calls.find((c) => c.args.some((a) => a.includes('file-item')));
    expect(fileItemCall.args).toContain('--queue=false');
    expect(fileItemCall.cwd).toBe(LANE_PATH); // NEVER REPO_ROOT — the daemon clone stays clean
    expect(fileItemCall.args[0]).toBe(join(LANE_PATH, 'scripts', 'operations', 'run.mjs')); // lane-local script path, not the resident clone's own run.mjs

    const verifyCall = calls.find((c) => c.args.includes('verify'));
    expect(verifyCall.cwd).toBe(LANE_PATH);
    expect(verifyCall.args[0]).toBe(join(LANE_PATH, 'scripts', 'operations', 'run.mjs'));

    const openPrCall = calls.find((c) => c.args.some((a) => a.includes('open-pr')));
    expect(openPrCall.cwd).toBe(LANE_PATH);
    expect(openPrCall.args.some((a) => a === `--ref=${refFor('e1')}`)).toBe(true);
    // #4079 live-proof review: the un-flagged call defaults to `open-pr`'s OWN default (`mode: park`,
    // parked `review:pending`), which would strand every filed card behind a human forever. Explicit
    // `label-on-green` is what actually lets a clean, capped filing request auto-land.
    expect(openPrCall.args).toContain('--mode=label-on-green');

    const commitCall = calls.find((c) => c.args[0] === 'commit');
    expect(commitCall.cwd).toBe(LANE_PATH);

    // #4079 review round 1, finding 1: the card commit is pushed to the entry's OWN stable ref right after
    // the commit, BEFORE verify/open-pr run — the durable handoff point a retry recovers from.
    const pushCall = calls.find((c) => c.args[0] === 'push');
    expect(pushCall).toBeDefined();
    expect(pushCall.cwd).toBe(LANE_PATH);
    expect(pushCall.args).toContain(`HEAD:refs/heads/${refFor('e1')}`);
    expect(calls.indexOf(pushCall)).toBeLessThan(calls.indexOf(verifyCall));

    // The only two calls legitimately at REPO_ROOT are the lane-pool bookkeeping calls themselves.
    const repoRootCalls = calls.filter((c) => c.cwd === REPO_ROOT);
    expect(repoRootCalls.every((c) => c.args.some((a) => String(a).includes('lane-pool.mjs')))).toBe(true);
  });

  it('does NOT re-run file-item when a card already exists (recovery from a partial previous attempt), and'
    + ' ACQUIRES THE RETRY LANE FROM THE CARD\'S OWN PUSHED REF — never a plain origin/main reset that would'
    + ' lose the commit a released lane no longer remembers (#4079 review round 1, finding 1)', () => {
    const { runFn, calls } = fakeRunner(({ args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.includes('release')) return '';
      if (args.some((a) => a.includes('open-pr'))) return fakeOpenPrResult(9, 'u');
      return '';
    });
    const entry = { ...baseEntry(), card: 4321, cardFile: 'backlog/4321-x.md' };
    const result = landOne(entry, { runFn });
    expect(result.status).toBe('landed');
    expect(calls.some((c) => c.args.some((a) => a.includes('file-item')))).toBe(false);
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(false); // nothing new to commit — the card was already committed
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false); // nothing new to push either
    const acquireCall = calls.find((c) => c.args.includes('acquire'));
    expect(acquireCall.args).toContain(`--base=${entry.ref}`);
  });

  it('a failed PUSH after a successful file-item+commit reports NO card back — the commit is not durable yet,'
    + ' so a retry must re-run file-item rather than trust a card nothing has actually persisted', () => {
    const { runFn } = fakeRunner(({ args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.some((a) => a.includes('file-item'))) return JSON.stringify({ verdict: { num: 55, rel: 'backlog/55-x.md' } });
      if (args.includes('release')) return '';
      if (args[0] === 'push') throw new Error('remote unreachable');
      return '';
    });
    const result = landOne(baseEntry(), { runFn });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/remote unreachable/);
    expect(result.card).toBeNull();
    expect(result.cardFile).toBeNull();
  });

  it('always releases the lane, even when a later step throws — and, once the durable push already'
    + ' succeeded, still reports the card/cardFile back so a retry lands via land-existing-card instead of'
    + ' refiling', () => {
    const { runFn, calls } = fakeRunner(({ args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.some((a) => a.includes('file-item'))) return JSON.stringify({ verdict: { num: 1, rel: 'backlog/1-x.md' } });
      if (args.includes('release')) return '';
      if (args.includes('verify')) throw new Error('gate red');
      return '';
    });
    const result = landOne(baseEntry(), { runFn });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/gate red/);
    expect(result.card).toBe(1); // the push (before verify) already succeeded — durable
    expect(result.cardFile).toBe('backlog/1-x.md');
    expect(calls.some((c) => c.args.includes('release'))).toBe(true);
  });
});

describe('landPending — the whole pass over a real ledger dir', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-file-request-land-'));
    mkdirSync(join(dir, 'filing'), { recursive: true });
    LANE_PATH = mkdtempSync(join(tmpdir(), 'fake-lane-'));
    mkdirSync(join(LANE_PATH, '.git'), { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(LANE_PATH, { recursive: true, force: true }); });

  it('is a no-op (gated) when fileDispatch is off, even with a pending entry on the ledger', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: false }));
    writeLedger(dir, recordRequested([], { key: 'a::b', smell: 'a', subject: 'b', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100));
    const { results } = landPending({ dir, now: 200 });
    expect(results[0].status).toBe('gated');
    expect(readLedgerStrict(dir)[0].status).toBe('pending'); // untouched
  });

  it('lands a pending entry end to end and marks it landed on the ledger', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: {} }));
    writeLedger(dir, recordRequested([], { key: 'a::b', smell: 'a', subject: 'b', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100));
    const { runFn } = fakeRunner(({ args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.some((a) => a.includes('file-item'))) return JSON.stringify({ verdict: { num: 99, rel: 'backlog/99-x.md' } });
      if (args.includes('release')) return '';
      if (args.some((a) => a.includes('open-pr'))) return fakeOpenPrResult(3, 'u');
      return '';
    });
    const { results } = landPending({ dir, now: 200, runFn });
    expect(results[0].status).toBe('landed');
    const ledger = readLedgerStrict(dir);
    expect(ledger[0].status).toBe('landed');
    expect(ledger[0].pr).toBe(3);
  });

  it('a card admitted to the card batch is landed with its batch ref: no per-card push, verify or open-pr', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: {} }));
    writeLedger(dir, recordRequested([], { key: 'a::b', smell: 'a', subject: 'b', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100));
    const { runFn, calls } = fakeRunner(({ args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.some((a) => a.includes('file-item'))) return JSON.stringify({ verdict: { num: 99, rel: 'backlog/99-x.md' } });
      if (args.some((a) => String(a).endsWith('card-batch-file.mjs'))) return `${JSON.stringify({ batched: true, batchRef: 'lane/card-batch-filing-4' })}\n`;
      return '';
    });
    const { results } = landPending({ dir, now: 200, runFn });
    expect(results[0].status).toBe('landed');
    const batchCall = calls.find((c) => c.args.some((a) => String(a).endsWith('card-batch-file.mjs')));
    expect(batchCall.args).toEqual(expect.arrayContaining([`--lane=${LANE_PATH}`, '--card=backlog/99-x.md', '--json']));
    expect(batchCall.args[0]).toBe(join(REPO_ROOT, 'scripts', 'operations', 'card-batch-file.mjs'));
    expect(calls.some((c) => c.args[0] === 'push' || c.args.includes('verify') || c.args.some((a) => a.includes('open-pr')))).toBe(false);
    expect(calls.some((c) => c.args.includes('release'))).toBe(true);
    expect(readLedgerStrict(dir)[0]).toMatchObject({ status: 'landed', card: 99, pr: null, batchRef: 'lane/card-batch-filing-4' });
  });

  it('a card the batch refuses (exit 3) takes the per-card PR path unchanged', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: {} }));
    writeLedger(dir, recordRequested([], { key: 'a::b', smell: 'a', subject: 'b', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100));
    const { runFn, calls } = fakeRunner(({ args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.some((a) => a.includes('file-item'))) return JSON.stringify({ verdict: { num: 99, rel: 'backlog/99-x.md' } });
      if (args.some((a) => String(a).endsWith('card-batch-file.mjs'))) throw Object.assign(new Error('exit 3'), { status: 3 });
      if (args.some((a) => a.includes('open-pr'))) return fakeOpenPrResult(3, 'u');
      return '';
    });
    landPending({ dir, now: 200, runFn });
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
    expect(readLedgerStrict(dir)[0]).toMatchObject({ status: 'landed', pr: 3 });
    expect(readLedgerStrict(dir)[0].batchRef).toBeUndefined();
  });

  it('an already-landed entry (pr set) is never repeated — a fresh pass with no runFn calls stays a no-op', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: {} }));
    writeLedger(dir, [{ key: 'a::b', status: 'landed', pr: 5, requestedAt: 100 }]);
    const { results } = landPending({ dir, now: 200 }); // no runFn given — a real call would throw/hang if ever invoked
    expect(results).toEqual([]);
  });

  // #4079 review round 1, finding 13: the spec rule "no landing while a lane-starvation episode is open" must
  // hold for `landPending` end to end, driven by a REAL state.json — not only via the isolated
  // `landingGateReason` unit tests above.
  it('gates the whole pass on a lane-starvation episode read from a real state.json, even with a landable entry queued', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      episodes: { x: { smell: 'lane-starvation', subject: 'we', status: 'open' } },
    }));
    writeLedger(dir, recordRequested([], { key: 'a::b', smell: 'a', subject: 'b', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100));
    const { results } = landPending({ dir, now: 200 }); // no runFn — must never even try to acquire a lane
    expect(results[0].status).toBe('gated');
    expect(results[0].reason).toMatch(/lane-starvation/);
    expect(readLedgerStrict(dir)[0].status).toBe('pending'); // untouched
  });

  // #4079 review round 1, finding 6/13: an unreadable state.json must fail CLOSED (refuse to land), never
  // silently default to "no episodes, nothing is starved" — the one case landingGateReason's own guarantee
  // ("no landing while a lane-starvation episode is open") would otherwise be satisfied by an empty default
  // rather than a genuine check.
  it('fails closed (refuses to land) when state.json is missing, even though fileDispatch is on', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    // no state.json written at all
    writeLedger(dir, recordRequested([], { key: 'a::b', smell: 'a', subject: 'b', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100));
    const { results } = landPending({ dir, now: 200 });
    expect(results[0].status).toBe('gated');
    expect(results[0].reason).toMatch(/state\.json is missing/);
    expect(readLedgerStrict(dir)[0].status).toBe('pending');
  });

  it('fails closed (refuses to land) when state.json is corrupt JSON', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    writeFileSync(join(dir, 'state.json'), '{ not json');
    writeLedger(dir, recordRequested([], { key: 'a::b', smell: 'a', subject: 'b', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100));
    const { results } = landPending({ dir, now: 200 });
    expect(results[0].status).toBe('gated');
    expect(results[0].reason).toMatch(/state\.json is corrupt/);
  });

  // #4079 review round 1, finding 9: a live in-flight claim must not be re-selected and re-skipped on every
  // remaining iteration of the SAME pass — that starves every entry behind it in the ledger for nothing.
  it('a live in-flight entry is skipped ONCE, never re-selected within the same pass, and does not block a landable entry behind it', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: {} }));
    let ledger = recordRequested([], { key: 'in-flight::x', smell: 'a', subject: 'x', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100);
    ledger = recordRequested(ledger, { key: 'landable::y', smell: 'a', subject: 'y', episodeId: 'e2', title: 'T2', digest: 'D2', scope: [], size: '3' }, 100);
    // Mark the FIRST entry as a live in-flight claim (another attempt's claimedAt is recent, well inside
    // ATTEMPT_TIMEOUT_MS) — claimForLanding must refuse to claim it.
    ledger[0] = { ...ledger[0], status: 'landing', attemptId: 'someone-else', claimedAt: 190 };
    writeLedger(dir, ledger);
    const { runFn } = fakeRunner(({ args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.some((a) => a.includes('file-item'))) return JSON.stringify({ verdict: { num: 77, rel: 'backlog/77-x.md' } });
      if (args.includes('release')) return '';
      if (args.some((a) => a.includes('open-pr'))) return fakeOpenPrResult(8, 'u');
      return '';
    });
    const { results } = landPending({ dir, now: 200, max: 3, runFn });
    // Exactly one skip for the in-flight entry, then the SECOND (landable) entry actually lands — never a
    // repeat 'skipped' for the same key burning the rest of the pass's budget.
    const skips = results.filter((r) => r.status === 'skipped');
    expect(skips).toHaveLength(1);
    expect(skips[0].key).toBe('in-flight::x');
    expect(results.some((r) => r.status === 'landed' && r.key === 'landable::y')).toBe(true);
    expect(readLedgerStrict(dir).find((e) => e.key === 'in-flight::x').status).toBe('landing'); // still untouched
  });

  // #4079 review round 3, standards-conformance finding: the gate must be a FRESH read every iteration, not a
  // snapshot taken once before the loop — a snapshot would let a lane-starvation episode opening (or the
  // operator flipping `fileDispatch` off) mid-pass go unnoticed for every entry after the first.
  it('re-reads config.json/state.json FRESH before each entry — a lane-starvation episode that appears only'
    + ' AFTER the first landing gates every entry after it', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: {} }));
    let ledger = recordRequested([], { key: 'a::first', smell: 'a', subject: 'first', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100);
    ledger = recordRequested(ledger, { key: 'a::second', smell: 'a', subject: 'second', episodeId: 'e2', title: 'T2', digest: 'D2', scope: [], size: '3' }, 100);
    writeLedger(dir, ledger);
    const { runFn } = fakeRunner(({ args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.some((a) => a.includes('file-item'))) {
        // A lane-starvation episode opens DURING the first landing's own work — simulating state changing
        // mid-pass, exactly the scenario the fresh-read fix defends against.
        writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: { s: { smell: 'lane-starvation', subject: 'we', status: 'open' } } }));
        return JSON.stringify({ verdict: { num: 1, rel: 'backlog/1-x.md' } });
      }
      if (args.includes('release')) return '';
      if (args.some((a) => a.includes('open-pr'))) return fakeOpenPrResult(9, 'u');
      return '';
    });
    const { results } = landPending({ dir, now: 200, max: 3, runFn });
    expect(results[0].status).toBe('landed');
    expect(results[0].key).toBe('a::first');
    expect(results[1].status).toBe('gated'); // the SAME pass sees the fresh state on its next iteration
    expect(results[1].reason).toMatch(/lane-starvation/);
    expect(readLedgerStrict(dir).find((e) => e.key === 'a::second').status).toBe('pending'); // never even claimed
  });

  // #4079 review round 2, correctness finding (the head-of-line-blocking `break` this test defends): a
  // permanently-failing entry must be skipped for the REST of the pass, not just once like an in-flight claim,
  // and must never stop a LANDABLE entry behind it in the ledger from landing in the SAME pass.
  it('a failing entry is skipped for the rest of the pass and does not block a landable entry behind it', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fileDispatch: true }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: {} }));
    let ledger = recordRequested([], { key: 'a::failing', smell: 'a', subject: 'failing', episodeId: 'e1', title: 'T', digest: 'D', scope: [], size: '3' }, 100);
    ledger = recordRequested(ledger, { key: 'a::landable', smell: 'a', subject: 'landable', episodeId: 'e2', title: 'T2', digest: 'D2', scope: [], size: '3' }, 100);
    writeLedger(dir, ledger);
    let verifyCalls = 0;
    let cardNum = 0;
    const { runFn } = fakeRunner(({ args }) => {
      if (args.includes('acquire')) return JSON.stringify({ path: LANE_PATH, lane: 41, holder: 'h' });
      if (args.some((a) => a.includes('file-item'))) { cardNum += 1; return JSON.stringify({ verdict: { num: cardNum, rel: `backlog/${cardNum}-x.md` } }); }
      if (args.includes('release')) return '';
      // The FIRST entry's own verify is the one that fails "permanently" — the second entry's verify (a fresh
      // lane, a fresh call) succeeds, exactly as it would for a genuinely different, landable card.
      if (args.includes('verify')) { verifyCalls += 1; if (verifyCalls === 1) throw new Error('gate red — permanent for this entry'); return ''; }
      if (args.some((a) => a.includes('open-pr'))) return fakeOpenPrResult(9, 'u');
      return '';
    });
    const { results } = landPending({ dir, now: 200, max: 3, runFn });
    const failed = results.filter((r) => r.status === 'failed');
    expect(failed).toHaveLength(1); // never retried a second time within this SAME pass
    expect(failed[0].key).toBe('a::failing');
    expect(results.some((r) => r.status === 'landed' && r.key === 'a::landable')).toBe(true);
    expect(readLedgerStrict(dir).find((e) => e.key === 'a::failing').status).toBe('pending'); // untouched — a LATER pass still retries it
  });
});
