/**
 * @file scripts/__tests__/learnings-harvest.test.mjs
 * @description Unit proof of the PERIODIC cross-session learnings harvest core (#x2j0l3t) — the successor to
 *   the single-session close sweep. Proves the properties the collect/adjudicate split depends on: entries
 *   from MANY session files pool together; recurrence across DISTINCT sessions outranks one session repeating
 *   itself; one malformed line never costs the rest of the pool; the SCHEMA is re-validated (the content
 *   scrub moved to the publish seam in #3015, so a secret is no longer dropped here); an empty
 *   pool is a clean no-op; there is NO recurrence floor (#3016 — every cluster is a candidate, one-offs sort
 *   lower); each note's quoted turn is VERIFIED against its harness transcript, which is what admits a note
 *   to memory; and archiving is an explicit, collision-safe acknowledgement — never a side effect of reading.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolvePoolDir, poolFiles, readPool, ageStats, harvest, harvestPool, poolStatus, archivePool, ARCHIVE_DIR,
  partitionGated, EVIDENCE_EXCERPT_CHARS,
} from '../conveyor/learnings-harvest.mjs';
import { poolDir as dropPoolDir, resolveDropboxPath } from '../conveyor/learnings-drop.mjs';
import { approveEntry, approvalsPath } from '../conveyor/hiccup-approve.mjs';

const e = (kind, area, summary, suggestion = 'fix it', ts = '2026-08-01T00:00:00.000Z') =>
  JSON.stringify({ kind, area, summary, suggestion, ts });

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-harvest-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Write one session's pool file. */
const session = (name, ...lines) => writeFileSync(join(dir, `${name}.jsonl`), lines.join('\n') + '\n', 'utf8');

describe('pool discovery', () => {
  it('reads every *.jsonl in the pool and ignores the harvested/ archive', () => {
    session('sess-a', e('friction', 'lane gating', 'lane gate reruns full suite for docs only diffs'));
    session('sess-b', e('doc-gap', 'memory docs', 'the memory doc omits the sub index budget rule'));
    mkdirSync(join(dir, ARCHIVE_DIR, '2026-07-01'), { recursive: true });
    writeFileSync(join(dir, ARCHIVE_DIR, '2026-07-01', 'old.jsonl'), e('friction', 'x', 'already harvested') + '\n');
    expect(poolFiles(dir).map((p) => p.split('/').pop())).toEqual(['sess-a.jsonl', 'sess-b.jsonl']);
  });

  it('an absent pool directory is the empty case, never an error', () => {
    expect(poolFiles(join(dir, 'nope'))).toEqual([]);
    const r = harvestPool({ dir: join(dir, 'nope') });
    expect(r.candidates).toEqual([]);
    expect(r.stats.received).toBe(0);
  });

  it('resolvePoolDir honours --dir, then $LEARNINGS_POOL, then the MACHINE-fixed home pool', () => {
    expect(resolvePoolDir({ dir: '/abs/pool' })).toBe('/abs/pool');
    expect(resolvePoolDir({ env: { LEARNINGS_POOL: '/env/pool' } })).toBe('/env/pool');
    expect(resolvePoolDir({ env: {}, home: '/home/u' })).toBe('/home/u/.claude/conveyor/learnings');
    // an explicit --dir wins over the env var
    expect(resolvePoolDir({ dir: '/abs/pool', env: { LEARNINGS_POOL: '/env/pool' } })).toBe('/abs/pool');
  });

  it('the pool the HARVEST reads is the same one the EMIT seam writes — not the cwd repo root', () => {
    // The blocker this pins (PR #1068 #1): both ends used to derive the dir from `git rev-parse
    // --show-toplevel`, so an agent emitting in a lane clone and a harvest run from the primary checkout
    // silently used two different pools. One resolver ⇒ they cannot drift apart again.
    const env = {}; const home = '/home/u';
    expect(resolvePoolDir({ env, home })).toBe(dropPoolDir({ env, home }));
    expect(resolveDropboxPath({ session: 's1', env, home }))
      .toBe(join(resolvePoolDir({ env, home }), 's1.jsonl'));
  });
});

describe('readPool — line tolerance + schema re-validation + session tagging', () => {
  it('pools entries across session files and tags each with its source session', () => {
    session('sess-a', e('friction', 'lane gating', 'lane gate reruns full suite for docs only diffs'));
    session('sess-b', e('friction', 'lane gating', 'the lane gate reruns the full suite even for docs only diffs'));
    const { entries, stats } = readPool(poolFiles(dir));
    expect(stats.files).toBe(2);
    expect(stats.valid).toBe(2);
    expect(entries.map((x) => x.session).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('one malformed line never costs the rest of the pool', () => {
    writeFileSync(join(dir, 'sess-a.jsonl'),
      [e('friction', 'gating', 'the gate reruns everything'), '{"kind":"friction"', e('doc-gap', 'docs', 'the doc omits a rule')].join('\n') + '\n');
    const { entries, stats } = readPool(poolFiles(dir));
    expect(stats.malformed).toBe(1);
    expect(entries).toHaveLength(2);
  });

  it('NO LONGER drops a secret-carrying line — the scrub moved to the publish seam (#3015)', () => {
    // This test used to assert the opposite, and the inversion is the point: `readPool` re-runs
    // `validateEntry`, which since #3015 checks the SCHEMA only. A pool line carrying a credential now
    // reaches the candidate list, the red-team step, and an LLM's context. It is stopped on the way INTO a
    // committed backlog/memory file (`scrubPublish`), not on the way out of the pool. Blocked from
    // LANDING, not blocked from being READ — the honest statement of what the move bought and cost.
    session('sess-a', e('friction', 'leak', 'saw the key gh\x70_ABCDEFabcdef0123456789ABCDEF01234567 in a log'));
    const { entries, stats } = readPool(poolFiles(dir));
    expect(stats.rejected).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain('ghp_');
  });

  it('`ts` goes through the validator too — a hostile stamp never reaches stats.oldest', () => {
    // Blocker #4: `ts` used to be re-attached RAW off the pool line, so the one field that skipped the
    // privacy boundary was also the one `--json` is guaranteed to print (stats.oldest sorts stamps as
    // strings, and a payload starting below '2' sorts first).
    writeFileSync(join(dir, 'sess-a.jsonl'), JSON.stringify({
      kind: 'friction', area: 'gating', summary: 'the gate reruns everything every time',
      suggestion: 'scope it', ts: '!!! /Users/someone/secret <script>',
    }) + '\n');
    const { entries, stats } = readPool(poolFiles(dir));
    expect(stats.rejected).toBe(0);          // the ENTRY is fine — only its stamp is unusable
    expect(entries[0].ts).toBeNull();
    expect(ageStats(entries).oldest).toBeNull();
  });

  it('one non-ISO stamp costs only its own entry, not the whole pool age signal', () => {
    session('sess-a', JSON.stringify({ kind: 'friction', area: 'gating', summary: 'the gate reruns everything every time', suggestion: 'scope it', ts: '2026-08-01' }));
    session('sess-b', e('doc-gap', 'docs', 'the doc omits a rule about budgets'));
    const { entries } = readPool(poolFiles(dir));
    expect(ageStats(entries, { now: '2026-08-06T00:00:00.000Z' }).ageDays).toBe(5);
  });

  it('an unreadable pool file is counted, not thrown', () => {
    const { stats } = readPool(['/does/not/exist.jsonl'], { read: () => { throw new Error('ENOENT'); } });
    expect(stats.malformed).toBe(1);
    expect(stats.received).toBe(0);
  });
});

describe('harvest — recurrence is the ranking signal', () => {
  it('three DISTINCT sessions outrank one session repeating itself', () => {
    const spread = ['s1', 's2', 's3'].map((s) => ({ kind: 'friction', area: 'lane gating', summary: 'the lane gate reruns the full suite for docs only diffs', suggestion: 'scope the gate', session: s, ts: '2026-08-01T00:00:00.000Z' }));
    const repeated = [1, 2, 3, 4].map(() => ({ kind: 'doc-gap', area: 'memory docs', summary: 'the memory doc omits the sub index budget rule', suggestion: 'document it', session: 's9', ts: '2026-08-01T00:00:00.000Z' }));
    const { candidates } = harvest([...repeated, ...spread]);
    expect(candidates[0].kind).toBe('friction');       // 3 sessions beats…
    expect(candidates[0].sessions).toBe(3);
    expect(candidates[1].kind).toBe('doc-gap');        // …4 entries from 1 session
    expect(candidates[1].count).toBe(4);
    expect(candidates[1].sessions).toBe(1);
  });

  it('there is NO recurrence floor — a one-session cluster is returned, it just sorts lower (#3016)', () => {
    // This test used to pin `minSessions: 2` filtering the one-off out into `stats.belowFloor`. The floor is
    // deleted (ratified #2978 Fork 2): a count is emitter-written and authenticates nothing, and a floor hides
    // exactly the one-off operator directive memory most needs. Passing the old option changes nothing.
    const entries = [
      { kind: 'friction', area: 'gating', summary: 'the lane gate reruns the full suite for docs only diffs', suggestion: 'scope it', session: 's1' },
      { kind: 'friction', area: 'gating', summary: 'the lane gate reruns the full suite on docs only diffs', suggestion: 'scope it', session: 's2' },
      { kind: 'improvement', area: 'naming', summary: 'a one off idea nobody else hit', suggestion: 'maybe', session: 's1' },
    ];
    const { candidates, stats } = harvest(entries, { minSessions: 2 });
    expect(candidates.map((c) => [c.kind, c.sessions])).toEqual([['friction', 2], ['improvement', 1]]);
    expect(stats).not.toHaveProperty('belowFloor');
    expect(stats).not.toHaveProperty('minSessions');
  });

  it('distinct DAYS break a sessions tie before raw count does', () => {
    const at = (session, ts) => ({ kind: 'friction', area: 'gating', summary: 'the lane gate reruns the full suite for docs only diffs', suggestion: 'scope it', session, ts });
    const sameDay = [1, 2, 3].map(() => ({ kind: 'doc-gap', area: 'docs', summary: 'the memory doc omits the sub index budget rule', suggestion: 'document it', session: 's9', ts: '2026-08-01T01:00:00.000Z' }));
    const twoDays = [at('s1', '2026-08-01T01:00:00.000Z'), at('s1', '2026-08-03T01:00:00.000Z')];
    const { candidates } = harvest([...sameDay, ...twoDays]);
    expect(candidates.map((c) => [c.kind, c.sessions, c.days, c.count])).toEqual([['friction', 1, 2, 2], ['doc-gap', 1, 1, 3]]);
  });

  it('collapses near-dupes across sessions into one candidate carrying both suggestions', () => {
    session('sess-a', e('friction', 'lane gating', 'lane gate reruns full suite for docs only diffs', 'scope the gate'));
    session('sess-b', e('friction', 'lane gating', 'the lane gate reruns the full suite even for docs only diffs', 'skip on docs only'));
    const { candidates } = harvestPool({ dir });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].count).toBe(2);
    expect(candidates[0].sessions).toBe(2);
    expect(candidates[0].suggestions.sort()).toEqual(['scope the gate', 'skip on docs only']);
  });
});

describe('ageStats / poolStatus — depth and age are DATA, not judgment', () => {
  it('reports how long the oldest unharvested observation has waited', () => {
    const entries = [{ ts: '2026-08-01T00:00:00.000Z' }, { ts: '2026-08-05T00:00:00.000Z' }];
    const { oldest, newest, ageDays } = ageStats(entries, { now: '2026-08-06T00:00:00.000Z' });
    expect(oldest).toBe('2026-08-01T00:00:00.000Z');
    expect(newest).toBe('2026-08-05T00:00:00.000Z');
    expect(ageDays).toBe(5);
  });

  it('is null-safe when nothing carries a stamp', () => {
    expect(ageStats([{ summary: 'x' }])).toEqual({ oldest: null, newest: null, ageDays: null });
  });

  it('poolStatus counts entries + session files without consuming anything', () => {
    session('sess-a', e('friction', 'gating', 'the gate reruns everything every time'));
    session('sess-b', e('doc-gap', 'docs', 'the doc omits a rule about budgets'));
    const s = poolStatus({ dir, now: '2026-08-06T00:00:00.000Z' });
    expect(s.entries).toBe(2);
    expect(s.sessions).toBe(2);
    expect(s.ageDays).toBe(5);
    expect(poolFiles(dir)).toHaveLength(2);   // reading is NOT consuming
  });

  it('an empty pool reports zero rather than failing', () => {
    expect(poolStatus({ dir })).toMatchObject({ entries: 0, sessions: 0, ageDays: null });
  });
});

describe('archivePool — an explicit acknowledgement, bounded to what was actually read', () => {
  it('moves the files it was given under harvested/<stamp>/ and leaves the pool empty', () => {
    session('sess-a', e('friction', 'gating', 'the gate reruns everything every time'));
    session('sess-b', e('doc-gap', 'docs', 'the doc omits a rule about budgets'));
    const { files } = harvestPool({ dir });
    const { moved, to } = archivePool({ dir, stamp: '2026-08-06', files });
    expect(moved).toHaveLength(2);
    expect(to).toBe(join(dir, ARCHIVE_DIR, '2026-08-06'));
    expect(poolFiles(dir)).toEqual([]);
    expect(readdirSync(to).sort()).toEqual(['sess-a.jsonl', 'sess-b.jsonl']);
  });

  it('NEVER consumes an entry appended after the harvest read the pool', () => {
    // The blocker this pins (PR #1068 #5a): the red-team → route → lane → PR window is minutes long and the
    // red-team subagents themselves emit into the pool. Re-enumerating at archive time swallowed those
    // unadjudicated drops into harvested/, where no future harvest can ever see them again.
    session('sess-a', e('friction', 'gating', 'the gate reruns everything every time'));
    const { files } = harvestPool({ dir });
    session('sess-late', e('improvement', 'naming', 'a drop that landed during the red team window'));
    const { moved } = archivePool({ dir, stamp: '2026-08-06', files });
    expect(moved).toHaveLength(1);
    expect(poolFiles(dir).map((p) => p.split('/').pop())).toEqual(['sess-late.jsonl']);
  });

  it('REFUSES an unbounded archive rather than re-enumerating the pool', () => {
    session('sess-a', e('friction', 'gating', 'the gate reruns everything every time'));
    expect(() => archivePool({ dir, stamp: '2026-08-06' })).toThrow(/needs an explicit bound/);
    expect(poolFiles(dir)).toHaveLength(1);   // nothing consumed by the refusal
  });

  it('accepts an mtime cutoff as the bound', () => {
    session('sess-old', e('friction', 'gating', 'the gate reruns everything every time'));
    session('sess-new', e('improvement', 'naming', 'a drop that landed during the red team window'));
    const cutoff = Date.now();
    utimesSync(join(dir, 'sess-old.jsonl'), new Date(cutoff - 60_000), new Date(cutoff - 60_000));
    utimesSync(join(dir, 'sess-new.jsonl'), new Date(cutoff + 60_000), new Date(cutoff + 60_000));
    const { moved } = archivePool({ dir, stamp: '2026-08-06', before: new Date(cutoff).toISOString() });
    expect(moved).toHaveLength(1);
    expect(poolFiles(dir).map((p) => p.split('/').pop())).toEqual(['sess-new.jsonl']);
  });

  it('a second archive under the same stamp suffixes instead of clobbering', () => {
    session('sess-a', e('friction', 'gating', 'first round of observations here'));
    archivePool({ dir, stamp: '2026-08-06', files: poolFiles(dir) });
    session('sess-a', e('friction', 'gating', 'second round of observations here'));
    const { moved } = archivePool({ dir, stamp: '2026-08-06', files: poolFiles(dir) });
    expect(moved[0].endsWith('sess-a.1.jsonl')).toBe(true);
    expect(readdirSync(join(dir, ARCHIVE_DIR, '2026-08-06')).sort()).toEqual(['sess-a.1.jsonl', 'sess-a.jsonl']);
  });

  it('archiving an empty file list is a no-op', () => {
    expect(archivePool({ dir, stamp: 'x', files: [] })).toEqual({ moved: [], to: null, missing: [] });
    expect(existsSync(join(dir, ARCHIVE_DIR))).toBe(false);
  });

  it('a requested file that has since vanished is reported, not fatal', () => {
    session('sess-a', e('friction', 'gating', 'the gate reruns everything every time'));
    const r = archivePool({ dir, stamp: 'x', files: [join(dir, 'sess-a.jsonl'), join(dir, 'gone.jsonl')] });
    expect(r.moved).toHaveLength(1);
    expect(r.missing).toEqual([join(dir, 'gone.jsonl')]);
  });

  it('THROWS when the resolved pool dir does not exist — a mutator must not treat that as "nothing to do"', () => {
    // Blocker #5b: inheriting the reader's "missing dir is the empty case" meant an archive run from the
    // wrong cwd printed "nothing to archive", exited 0, and left the real pool undrained.
    expect(() => archivePool({ dir: join(dir, 'nope'), stamp: 'x', files: [] })).toThrow(/does not exist/);
  });

  it('a harvest read alone never archives — only an explicit archive does', () => {
    session('sess-a', e('friction', 'gating', 'the gate reruns everything every time'));
    harvestPool({ dir });
    expect(poolFiles(dir)).toHaveLength(1);
  });
});

describe('the #3421 gate — a blocking, approval-pending entry is held OUT of candidates', () => {
  const blockingLine = ({ num, ts = '2026-08-31T00:00:00.000Z' }) => JSON.stringify({
    kind: 'friction',
    area: 'conveyor dispatch guard',
    summary: `Dispatch for #${num} suppressed by the live in-flight guard (num) — tick did not proceed.`,
    suggestion: 'investigate before approving',
    blocking: true,
    proposedFix: 'confirm the guard is still legitimate',
    approvalPending: true,
    ts,
  });

  it('partitionGated separates an unapproved blocking entry from an eligible one', () => {
    const gatedEntry = { session: 'runner', ts: '2026-08-31T00:00:00.000Z', blocking: true, approvalPending: true };
    const plainEntry = { session: 'runner', ts: '2026-08-31T00:00:00.000Z', kind: 'friction' };
    const { gated, eligible } = partitionGated([gatedEntry, plainEntry], { approvals: {} });
    expect(gated).toEqual([gatedEntry]);
    expect(eligible).toEqual([plainEntry]);
  });

  it('an approved blocking entry moves to eligible', () => {
    const entry = { session: 'runner', ts: '2026-08-31T00:00:00.000Z', blocking: true, approvalPending: true };
    const approvals = { 'runner#2026-08-31T00:00:00.000Z': { approvedAt: '2026-09-01T00:00:00.000Z' } };
    const { gated, eligible } = partitionGated([entry], { approvals });
    expect(gated).toEqual([]);
    expect(eligible).toEqual([entry]);
  });

  it('harvestPool never surfaces an unapproved blocking entry as a candidate — it reports it as gated instead', () => {
    session('runner', blockingLine({ num: 3416 }));
    const r = harvestPool({ dir });
    expect(r.candidates).toEqual([]);
    expect(r.gated).toHaveLength(1);
    expect(r.gated[0]).toMatchObject({ blocking: true, approvalPending: true, session: 'runner' });
    expect(r.stats.gated).toBe(1);
  });

  it('approving the entry lets a LATER harvestPool run surface it as a normal candidate', () => {
    session('runner', blockingLine({ num: 3416 }));
    const first = harvestPool({ dir });
    expect(first.candidates).toEqual([]);

    approveEntry({ session: 'runner', ts: '2026-08-31T00:00:00.000Z' }, { dir });
    const second = harvestPool({ dir });
    expect(second.gated).toEqual([]);
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0].kind).toBe('friction');
  });

  it('#3421 review fix: an approved entry\'s proposedFix SURVIVES into the candidate — not silently dropped', () => {
    // Pins the bug the adversarial review caught: dedup()'s cluster shaping used to emit only
    // {kind,area,summary,suggestion,...}, so the whole point of "propose a fix" was lost the moment an
    // entry left the gated list. The candidate must still carry blocking:true + proposedFixes.
    session('runner', blockingLine({ num: 3416 }));
    approveEntry({ session: 'runner', ts: '2026-08-31T00:00:00.000Z' }, { dir });
    const { candidates } = harvestPool({ dir });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].blocking).toBe(true);
    expect(candidates[0].proposedFixes).toEqual(['confirm the guard is still legitimate']);
  });

  it('a non-blocking entry (no blocking field) is never gated — files straight through as before', () => {
    session('runner', e('doc-gap', 'memory docs', 'the memory doc omits the sub-index budget rule'));
    const r = harvestPool({ dir });
    expect(r.gated).toEqual([]);
    expect(r.candidates).toHaveLength(1);
  });

  it('the approvals store lives inside the SAME resolved pool dir, not the machine-fixed default', () => {
    expect(approvalsPath({ dir })).toBe(join(dir, 'approvals.json'));
  });
});

describe('grounding verification — what admits a note to memory (#3016, ratified #2978 Fork 1)', () => {
  let transcripts;
  beforeEach(() => { transcripts = mkdtempSync(join(tmpdir(), 'we-harvest-transcripts-')); });
  afterEach(() => { rmSync(transcripts, { recursive: true, force: true }); });

  const QUOTE = 'never rerun the full suite for a docs only change again';
  const writeTranscript = (name, text) => {
    const p = join(transcripts, name);
    writeFileSync(p, JSON.stringify({ type: 'user', uuid: 'turn-1', message: { role: 'user', content: text } }) + '\n');
    return p;
  };
  const grounded = (summary, quotedTurn, transcript, ts = '2026-08-01T00:00:00.000Z') =>
    JSON.stringify({ kind: 'friction', area: 'lane gating', summary, suggestion: 'scope the gate', quotedTurn, transcript, ts });

  it('harvestPool verifies each note against its transcript and reports it per candidate and per run', () => {
    const real = writeTranscript('s1.jsonl', `ok — ${QUOTE}, it costs minutes`);
    const lying = writeTranscript('s2.jsonl', 'we talked about something unrelated');
    session('sess-a', grounded('lane gate reruns full suite for docs only diffs', QUOTE, real));
    session('sess-b', grounded('the lane gate reruns the full suite even for docs only diffs', QUOTE, lying));
    session('sess-c', e('doc-gap', 'memory docs', 'the memory doc omits the sub index budget rule'));

    const { candidates, stats } = harvestPool({ dir, transcriptRoot: transcripts });
    const gate = candidates.find((c) => c.kind === 'friction');
    expect(gate.grounding).toEqual({ verified: 1, failed: 1, ungrounded: 0 });
    expect(gate.evidence.map((r) => [r.session, r.grounding.status, r.grounding.reason ?? r.grounding.role]))
      .toEqual([['sess-a', 'verified', 'human'], ['sess-b', 'failed', 'quote-not-found']]);
    expect(gate.evidence[0].grounding.turn).toBe('turn-1');
    // The ungrounded cluster is still a candidate — grounding decides memory admission, never candidacy.
    const docs = candidates.find((c) => c.kind === 'doc-gap');
    expect(docs.grounding).toEqual({ verified: 0, failed: 0, ungrounded: 1 });
    expect(docs).not.toHaveProperty('evidence');
    expect(stats.verification).toEqual({ verified: 1, failed: 1, ungrounded: 1 });
  });

  it('a pointer outside the transcript root fails even when the quote is really in that file', () => {
    const forgedDir = mkdtempSync(join(tmpdir(), 'we-forged-'));
    try {
      const forged = join(forgedDir, 'forged.jsonl');
      writeFileSync(forged, JSON.stringify({ type: 'user', message: { content: QUOTE } }) + '\n');
      session('sess-a', grounded('lane gate reruns full suite for docs only diffs', QUOTE, forged));
      const { candidates } = harvestPool({ dir, transcriptRoot: transcripts });
      expect(candidates[0].evidence[0].grounding).toEqual({ status: 'failed', reason: 'outside-transcript-root' });
    } finally {
      rmSync(forgedDir, { recursive: true, force: true });
    }
  });

  it('the pool stores the whole quote; the candidate carries an excerpt within the context budget', () => {
    const long = `${QUOTE} ${'and here is a great deal more context from the same turn '.repeat(40)}`;
    const p = writeTranscript('s1.jsonl', long);
    session('sess-a', grounded('lane gate reruns full suite for docs only diffs', long, p));
    const { candidates } = harvestPool({ dir, transcriptRoot: transcripts });
    const row = candidates[0].evidence[0];
    expect(row.grounding.status).toBe('verified');
    expect(row.truncated).toBe(true);
    expect(row.quoteChars).toBe(long.trim().length);
    expect(row.quotedTurn.length).toBe(EVIDENCE_EXCERPT_CHARS + 1);   // excerpt + the ellipsis
    expect(row.transcript).toBe(p);                                    // the full turn is one open away
  });

  it('a quoted note that was never verified is NOT verified (pure harvest, fail-safe)', () => {
    const { candidates, stats } = harvest([{ kind: 'friction', area: 'a', summary: 'the gate reruns everything', suggestion: 's', quotedTurn: QUOTE, transcript: '/x.jsonl' }]);
    expect(candidates[0].evidence[0].grounding).toEqual({ status: 'failed', reason: 'not-verified' });
    expect(stats.verification).toEqual({ verified: 0, failed: 1, ungrounded: 0 });
  });

  it('the CLI refuses the deleted --min-sessions flag instead of silently ignoring it', () => {
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'conveyor', 'learnings-harvest.mjs');
    const r = spawnSync(process.execPath, [cli, `--dir=${dir}`, '--min-sessions=2'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--min-sessions was removed/);
  });

  it('the CLI prints each note\'s grounding verdict (real call path)', () => {
    const real = writeTranscript('s1.jsonl', QUOTE);
    session('sess-a', grounded('lane gate reruns full suite for docs only diffs', QUOTE, real));
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'conveyor', 'learnings-harvest.mjs');
    const r = spawnSync(process.execPath, [cli, `--dir=${dir}`], { encoding: 'utf8', env: { ...process.env, LEARNINGS_TRANSCRIPT_ROOT: transcripts } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/grounding 1 verified \/ 0 failed \/ 0 ungrounded/);
    expect(r.stdout).toMatch(/grounding ✓ verified \(human turn turn-1\)/);
  });
});
