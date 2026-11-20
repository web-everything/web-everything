/**
 * @file progress-board.test.mjs — the derivation + the CLI behind the operator's published board (item `x9t5i5a`).
 *
 * Two surfaces, both load-bearing and both cheap to get wrong:
 *   • `classifyPr` — the whole "who is holding the ball" reduction. A mis-ranked label puts the ONE pull request
 *     that needs the operator underneath five that do not, which is precisely the failure the board exists to fix.
 *   • The CLI — the only writer of the state file. If a verb is not idempotent, a second identical run silently
 *     rewrites a date or duplicates a row, and the board starts lying about when work moved.
 *
 * The CLI tests SPAWN the real script against a temp state + out path with `--no-gh`, so nothing here touches the
 * network or the repo's own board. `WE_BOARD_NOW` freezes the stamp so renders are comparable byte-for-byte.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PR_STATUS_STATES } from '../conveyor/pr-status-label.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { outputMixRepo } from '../lib/__tests__/helpers/output-mix-repo.mjs';
import {
  classifyPr,
  ciFailed,
  ciPending,
  buildModel,
  renderPage,
  applyVerb,
  slugify,
  loadState,
  assertWritablePath,
  ensureRulingNumbers,
  findDecision,
  verifyPage,
  decisionGaps,
  validateDecisions,
  rulingFloor,
  PR_STATUS,
  STATE_ERROR,
  STATE_UNREADABLE,
  DECISION_FIELDS,
  DECISION_STATUSES,
} from '../progress-board.mjs';

import { ROOT, CLI, NOW, sandbox, statePath, outPath, SEED, cli, state, page, pr } from './helpers/progress-board-world.mjs';

describe('degradation when gh is unavailable', () => {
  it('still renders, with an empty pull-request half and a stale banner', () => {
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain('PR state STALE');
    expect(page()).toContain('class="banner"');
    expect(page()).toContain('Nothing landed yet.'); // no pull-request rows at all…
    expect(page()).toContain('A decision'); // …but the hand-maintained half still renders in full
  });

  it('serves the last good snapshot when one was cached', () => {
    writeFileSync(
      join(sandbox, '.progress-board-cache.json'),
      JSON.stringify({
        fetchedAt: '2026-08-07T09:00:00.000Z',
        rows: [{ number: 1099, title: 'Cached pull request', labels: ['review:human'], status: 'needs-human', detail: '' }],
      }),
    );
    const r = cli();
    expect(r.code).toBe(0);
    expect(page()).toContain('Cached pull request');
    expect(page()).toContain('snapshot from 2026-08-07 09:00 UTC');
    rmSync(join(sandbox, '.progress-board-cache.json'));
  });
});

/**
 * TWO `gh` CALLS MEAN THREE OUTCOMES, NOT TWO. `fetchPrs` only ever checked the open list, so with the
 * merged list failing (a rate limit, a per-endpoint 5xx) the board rendered a confident lie: no stale
 * banner, "pull-request state read live" in the header, "Nothing landed yet" under Landed, exit 0 — and the
 * truncated snapshot then OVERWROTE the cache, destroying the last good landed rows so the NEXT failure fell
 * back to a snapshot that was also missing them. Stripping `gh` from PATH only ever exercised total failure.
 */
describe('degradation when gh answers only half the question', () => {
  const bin = join(sandbox, 'fake-bin');
  const cacheFile = join(sandbox, '.progress-board-cache.json');
  const GOOD_CACHE = {
    fetchedAt: '2026-08-07T09:00:00.000Z',
    rows: [
      { number: 1000, title: 'Landed last week', labels: [], status: 'landed', detail: 'merged 2026-08-01' },
      { number: 1001, title: 'Landed yesterday', labels: [], status: 'landed', detail: 'merged 2026-08-07' },
    ],
  };

  beforeEach(() => {
    // A `gh` that answers --state=open and fails --state=merged. Nothing else about the run changes.
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\nfor a in "$@"; do [ "$a" = "--state=merged" ] && exit 1; done\n' +
        `echo '[{"number":1099,"title":"An open pull request","labels":[],"mergeStateStatus":"CLEAN","statusCheckRollup":[],"state":"OPEN"}]'\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    rmSync(cacheFile, { force: true });
  });
  afterAll(() => rmSync(cacheFile, { force: true }));

  /** The real CLI with the stub on PATH and the live lookup ENABLED — this is the only place gh is exercised. */
  const run = () =>
    spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${outPath}`], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '', PATH: `${bin}:${process.env.PATH}` },
    });

  it('says what it could not read instead of rendering the gap as a fact', () => {
    writeFileSync(cacheFile, JSON.stringify(GOOD_CACHE));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PR state STALE');

    const h = page();
    expect(h).toContain('is <strong>stale</strong>');
    expect(h).toContain('merged-pull-request list could not be read');
    expect(h).not.toContain('pull-request state read live<'); // the header must not claim a full live read
    expect(h).toContain('An open pull request'); // …the half that DID come back is live
  });

  it('keeps the landed rows it could not re-read rather than reporting none', () => {
    writeFileSync(cacheFile, JSON.stringify(GOOD_CACHE));
    run();
    const h = page();
    expect(h).toContain('Landed last week');
    expect(h).toContain('Landed yesterday');
    expect(h).not.toContain('Nothing landed yet.');
  });

  it('never overwrites a more complete cache with the truncated snapshot', () => {
    writeFileSync(cacheFile, JSON.stringify(GOOD_CACHE));
    run();
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual(GOOD_CACHE);
  });

  it('says Landed is MISSING, not empty, when there is no snapshot to fall back on', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(page()).toContain('MISSING, not empty');
    expect(existsSync(cacheFile)).toBe(false); // and still writes no half-cache
  });

  // Same class of lie from the other end: a list capped at the limit under-reports without saying so.
  it('says the open list may be truncated rather than quietly under-reporting', () => {
    const rows = Array.from(
      { length: 30 },
      (_, i) => `{"number":${2000 + i},"title":"PR ${i}","labels":[],"mergeStateStatus":"CLEAN","statusCheckRollup":[],"state":"OPEN"}`,
    );
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--state=merged" ] && { echo '[]'; exit 0; }; done\necho '[${rows.join(',')}]'\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const r = run();
    expect(r.status).toBe(0);
    expect(page()).toContain('may be <strong>truncated</strong>');
    rmSync(cacheFile, { force: true });
  });
});

/**
 * `--out=` and `--state=` are the only paths a caller controls. Nothing in the state file or the GitHub data
 * reaches them, so this is not hostile-content-reachable — but an unguarded primitive that can overwrite a
 * tracked repo file is worth closing. The rule is deliberately narrow, because writing OUTSIDE the repo is
 * legitimate and in active use: the board is published from a scratchpad path.
 */
describe('path containment', () => {
  const REPO = join(ROOT, 'scripts', 'progress-board.mjs'); // any tracked file will do

  it('refuses a path inside the repository but outside reports/', () => {
    expect(() => assertWritablePath('./DECOY_TRACKED.json', '--out')).toThrow(/inside the repository/);
    expect(() => assertWritablePath(join(ROOT, 'package.json'), '--state')).toThrow(/only write/);
    // `..` out of an allowed directory is the same case and must not be a hole.
    expect(() => assertWritablePath(join(ROOT, 'reports', '..', 'package.json'), '--out')).toThrow(/inside the repository/);
  });

  it('allows reports/, where the board actually lives', () => {
    expect(assertWritablePath(join(ROOT, 'reports', 'progress-board.html'), '--out')).toBe(join(ROOT, 'reports', 'progress-board.html'));
    expect(assertWritablePath('reports/nested/deep.html', '--out')).toContain(join('reports', 'nested', 'deep.html'));
  });

  it('allows a path outside the repository entirely — the publish workflow depends on it', () => {
    expect(assertWritablePath(join(sandbox, 'board.html'), '--out')).toContain('board.html');
    expect(() => assertWritablePath(join(sandbox, 'state.json'), '--state')).not.toThrow();
  });

  it('the CLI refuses it too, and writes nothing', () => {
    const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, '--out=./DECOY_TRACKED.json', '--no-gh'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing --out=');
    expect(existsSync(join(ROOT, 'DECOY_TRACKED.json'))).toBe(false);
    expect(readFileSync(REPO, 'utf8').length).toBeGreaterThan(0);
  });
});

/**
 * The `gh` half already degrades rather than dying; the hand-maintained half has to as well. The realistic
 * trigger is not exotic — the state file is git-tracked, so an unresolved merge-conflict marker makes it
 * invalid JSON, and crashing there loses the whole page over a fixable typo.
 */
describe('degradation when the state file is malformed', () => {
  const broken = (text) => {
    writeFileSync(statePath, text);
    return cli();
  };

  it('renders anyway when the file is not valid JSON, and says so on the PAGE, not only on stderr', () => {
    const r = broken('<<<<<<< HEAD\n{ "title": "x" }\n=======\n');
    expect(r.code).toBe(0);
    expect(r.out).toContain('STATE FILE UNREADABLE');
    expect(existsSync(outPath)).toBe(true);
    expect(page()).toContain('class="banner crit"');
    expect(page()).toContain('The plan and decisions could not be read');
    expect(page()).toContain('is not valid JSON');
  });

  it('renders anyway when items or decisions hold the wrong type', () => {
    const r = broken(JSON.stringify({ title: 'T', items: 'not an array', decisions: { a: 1 } }));
    expect(r.code).toBe(0);
    // PARTLY IGNORED, not UNREADABLE: the two words are the difference between "nothing survived" and
    // "one key was dropped and the rest of the plan below is real".
    expect(r.out).toContain('STATE FILE PARTLY IGNORED');
    expect(page()).toContain('wrong type for: items, decisions');
  });

  // The banner used to tell the operator "the plan half is missing, not empty" in BOTH branches. In the
  // wrong-type branch the plan half renders in full, so that sentence was simply false.
  it('does not claim the plan half is missing when it is right there on the page', () => {
    broken(JSON.stringify({ ...SEED, phases: 'not an object' }));
    const h = page();
    expect(h).toContain('class="banner crit"');
    expect(h).toContain('wrong type for: phases');
    expect(h).not.toContain('the plan half is missing, not empty');
    expect(h).toContain('Alpha'); // …because the plan half is, in fact, right there
    // And the fatal branch keeps the sentence, because there it is true.
    broken('{ not json');
    expect(page()).toContain('the plan half is missing, not empty');
  });

  it('a key the file is allowed to omit is not a type error — absent is not wrong', () => {
    // `items` omitted left the `[]` from the defaults and the length compare did `0 !== undefined`, so the
    // banner reported a wrong type for a key nobody had got wrong. One absent optional key then reached the
    // answerability guard, which used to switch itself off on any state error at all.
    writeFileSync(statePath, JSON.stringify({ title: 'T', decisions: [] }));
    const s = loadState(statePath);
    expect(s[STATE_ERROR]).toBeUndefined();
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('STATE FILE');

    writeFileSync(statePath, JSON.stringify({ title: 'T' })); // both optional keys absent
    expect(loadState(statePath)[STATE_ERROR]).toBeUndefined();
  });

  /**
   * THE HOLE THE SUITE USED TO REASON AROUND. The "does NOT swallow the decision contract" case uses a
   * WELL-FORMED file; the "wrong type" case uses a state with NO decisions. Their intersection — a soft type
   * error on one key, with `state.decisions` fully preserved — turned the render guard off entirely: the
   * unanswerable card rendered in "Needs you" and the run exited 0, republishing it on every pass, while
   * every verb was refused so the only way out was the hand edit the design forbids.
   */
  describe('a soft type error is not a licence to publish an unanswerable decision', () => {
    const SOFT = {
      title: 'Board',
      nextRuling: 5,
      phases: 'not an object', // the ONE thing wrong — decisions below survive untouched
      items: [{ id: 'a', title: 'An item', phase: 1, status: 'in-progress' }],
      decisions: [{ id: 'bad', ruling: 'R4', title: 'Should we ship it?', status: 'awaiting' }],
    };

    it('refuses to render, exactly as it would on a clean file', () => {
      writeFileSync(statePath, JSON.stringify(SOFT));
      const r = cli();
      expect(r.code).toBe(1);
      expect(r.err).toContain('cannot be answered from the page');
      expect(r.err).toContain('"bad"');
      expect(r.err).toMatch(/missing question/);
      expect(r.err).toMatch(/at least two/);
    });

    it('never writes the unanswerable card to the page', () => {
      writeFileSync(statePath, JSON.stringify(SOFT));
      cli();
      // Not "rendered without the card" — not rendered at all. Suppressing the decision while still
      // publishing would leave the operator a page that silently lost their ask.
      expect(existsSync(outPath)).toBe(false);
    });

    it('is NOT a deadlock — the verbs still work, because the surviving data is real', () => {
      writeFileSync(statePath, JSON.stringify(SOFT));
      // The whole reason a verb is refused on an unreadable file is that saving would overwrite a plan with
      // an empty one. Here the plan parsed; refusing the verb AND the render is what would strand it.
      const park = cli('--decision-set=bad', '--field=status', '--value=draft');
      expect(park.code).toBe(0);
      expect(state().decisions[0].status).toBe('draft');
      expect(cli().code).toBe(0); // and the board renders again
      expect(page()).toContain('Decisions being prepared');
    });

    it('still refuses every verb when NOTHING parsed — that file must not be overwritten', () => {
      writeFileSync(statePath, '{ not json');
      const r = cli('--decision-set=bad', '--field=status', '--value=draft');
      expect(r.code).toBe(1);
      expect(r.err).toContain('refusing to write');
      expect(readFileSync(statePath, 'utf8')).toBe('{ not json');
    });

    it('an unparseable file has no decisions, so the guard has nothing to wave through', () => {
      writeFileSync(statePath, '{ not json');
      const r = cli();
      expect(r.code).toBe(0); // degrades, as designed
      expect(page()).toContain('Nothing is waiting on you.');
      expect(page()).not.toContain('Should we ship it?');
    });
  });

  it('drops non-object entries rather than choking on them', () => {
    writeFileSync(statePath, JSON.stringify({ title: 'T', items: [{ id: 'a', title: 'A', status: 'todo' }, 'junk', null], decisions: [] }));
    const s = loadState(statePath);
    expect(s.items.map((i) => i.id)).toEqual(['a']);
    expect(s[STATE_ERROR]).toMatch(/entries that were not objects/);
  });

  it('REFUSES to apply a verb to an unreadable file — an empty save would destroy a recoverable plan', () => {
    const text = '{ not json';
    writeFileSync(statePath, text);
    const r = cli('--done=alpha');
    expect(r.code).toBe(1);
    expect(r.err).toContain('refusing to write');
    expect(readFileSync(statePath, 'utf8')).toBe(text); // byte-for-byte untouched
  });

  it('does NOT swallow the decision contract — a well-formed file with a half-decision still exits non-zero', () => {
    // Two different failures that must stay different: unreadable degrades, unanswerable refuses.
    writeFileSync(statePath, JSON.stringify({ ...SEED, decisions: [{ id: '2978', title: 'A decision', status: 'awaiting' }] }));
    const r = cli();
    expect(r.code).toBe(1);
    expect(r.err).toContain('"2978"');
    expect(r.err).toContain('cannot be answered from the page');
    expect(r.err).not.toContain('STATE FILE UNREADABLE');
  });

  it('a missing state file is not an error at all — it is a fresh board', () => {
    rmSync(statePath);
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('STATE FILE UNREADABLE');
    expect(page()).toContain('Nothing is waiting on you.');
  });
});

/**
 * THE WORST BUG THIS TOOL HAS HAD, and the reason the soft branch's own rationale was wrong. That branch
 * argued verbs were safe because "nothing was lost — `state.items` and `state.decisions` are the file as
 * written". That is true for the keys that WERE arrays and false for the one key that triggered the branch:
 * `loadState` empties it, and `saveState` wrote the empty stand-in back over the file.
 *
 * So a single IDEMPOTENT NO-OP verb destroyed the plan. Not a typo'd verb, not a destructive one — a verb
 * that reported "already titled" and changed nothing. That is exactly the destruction the fatal branch
 * refuses every verb to prevent, and the page's banner denied it was happening.
 *
 * The rule these pin: the normalisation is RENDER-ONLY. A key the board could not read comes back out of
 * `saveState` byte-for-byte, and the verbs that would write to it are refused by name.
 */
describe('a key the board could not read is never written back over the file', () => {
  const OBJECT_MAP_ITEMS = {
    title: 'Board',
    nextRuling: 9,
    phases: { 1: 'Phase one' },
    // The shape a hand-authored JSON most naturally takes — and this file WAS hand-authored.
    items: {
      'gate-fix': { id: 'gate-fix', title: 'Fix the gate', phase: 1, status: 'in-progress', pr: 1101 },
      'drain-fix': { id: 'drain-fix', title: 'Fix the drain', phase: 1, status: 'todo' },
    },
    decisions: [{ id: 'd1', ruling: 'R8', title: 'A ruled thing', status: 'queued' }],
  };

  it('A VERB THAT CHANGES NOTHING CANNOT DESTROY ANYTHING — the no-op case, which is the one that bit', () => {
    writeFileSync(statePath, JSON.stringify(OBJECT_MAP_ITEMS));
    const r = cli('--board-title=Board'); // already titled exactly that: a pure no-op
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/already titled/); // …and it says so
    expect(r.out).toContain('STATE FILE PARTLY IGNORED');
    // Before the fix this read `"items": []` — both rows gone, permanently, at exit 0.
    expect(state().items).toEqual(OBJECT_MAP_ITEMS.items);
  });

  it('the same holds for decisions, and for a phases key of the wrong type', () => {
    const map = { d1: { id: 'd1', ruling: 'R1', title: 'one', status: 'queued' } };
    writeFileSync(statePath, JSON.stringify({ title: 'Board', items: [], decisions: map }));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().decisions).toEqual(map);

    writeFileSync(statePath, JSON.stringify({ ...SEED, phases: 'not an object' }));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().phases).toBe('not an object');
  });

  it('an entry that is not an object is unreadable, not disposable — it survives the save too', () => {
    // The array IS an array, so the container is fine; `loadState` drops the string so the page can render.
    // Dropping it on the way out of memory is normalisation; dropping it from the FILE is data loss.
    const decisions = ['R1 should we ship?', { id: 'd2', ruling: 'R2', title: 'two', status: 'queued' }];
    writeFileSync(statePath, JSON.stringify({ title: 'Board', items: [], decisions }));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().decisions).toEqual(decisions);
  });

  it('refuses the verbs that WRITE the unreadable key, by name, and leaves the file byte-identical', () => {
    // The alternative to refusing is worse than it looks: the verb writes onto the emptied stand-in, reports
    // success, and the re-emit then silently drops its work.
    writeFileSync(statePath, JSON.stringify(OBJECT_MAP_ITEMS));
    const before = readFileSync(statePath, 'utf8');
    for (const argv of [['--done=gate-fix'], ['--add=A new row'], ['--remove=gate-fix'], ['--link=gate-fix', '--pr=7'], ['--rephase=gate-fix', '--phase=2']]) {
      const r = cli(...argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).toContain('refusing to write items');
      expect(readFileSync(statePath, 'utf8'), argv.join(' ')).toBe(before);
    }
  });

  it('is NOT a deadlock — every verb that writes somewhere else still applies, and persists', () => {
    writeFileSync(statePath, JSON.stringify(OBJECT_MAP_ITEMS));
    expect(cli('--board-title=Renamed').code).toBe(0);
    expect(state().title).toBe('Renamed');
    expect(state().items).toEqual(OBJECT_MAP_ITEMS.items); // still there, alongside the applied edit
    expect(cli('--decision-set=d1', '--field=why', '--value=because').code).toBe(0);
    expect(state().decisions[0].why).toBe('because');
    expect(state().items).toEqual(OBJECT_MAP_ITEMS.items);
  });

  it('and a decision verb still works when it is ITEMS that are unreadable, and vice versa', () => {
    writeFileSync(statePath, JSON.stringify({ title: 'B', items: 'nope', decisions: [] }));
    expect(cli('--decision-add=Ship it?', '--question=Do we?', '--if-nothing=nothing').code).toBe(0);
    expect(state().items).toBe('nope');
    expect(state().decisions).toHaveLength(1);

    writeFileSync(statePath, JSON.stringify({ title: 'B', items: [{ id: 'a', title: 'A', status: 'todo' }], decisions: 'nope' }));
    expect(cli('--done=a').code).toBe(0);
    expect(state().items[0].status).toBe('done');
    expect(state().decisions).toBe('nope');
  });

  it('a clean file is completely unaffected — nothing is preserved that was read fine', () => {
    expect(cli('--done=alpha').code).toBe(0);
    expect(loadState(statePath)[STATE_UNREADABLE]).toBeUndefined();
    expect(state().items.find((i) => i.id === 'alpha').status).toBe('done');
  });
});

/**
 * The second half of the same root cause. `main` reconciled the ruling counter from the state AS LOADED, so
 * with `decisions` emptied by normalisation `ensureRulingNumbers` saw no numbers, computed a floor of 1, and
 * persisted `nextRuling: 1` into a file whose decisions already held R1, R2 and R3. The next `--decision-add`
 * handed out R1 again — and R-numbers are how the operator answers ("R1 — as recommended"), so a reused one
 * lands a ruling on the wrong decision.
 */
describe('the ruling counter is reconciled from the file as READ, not from what survived normalisation', () => {
  const MAP = {
    title: 'B',
    items: [],
    decisions: {
      d1: { id: 'd1', ruling: 'R1', title: 'one', status: 'queued' },
      d2: { id: 'd2', ruling: 'R2', title: 'two', status: 'queued' },
      d3: { id: 'd3', ruling: 'R3', title: 'three', status: 'queued' },
    },
  };

  it('A NUMBER STILL IN USE IS NEVER REISSUED, even through a key the board could not read', () => {
    writeFileSync(statePath, JSON.stringify(MAP));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().nextRuling).toBe(4); // was 1 — the reissue, written into the file
  });

  it('and the reissue itself is gone: repairing the file by hand then adding gets R4, not R1', () => {
    writeFileSync(statePath, JSON.stringify(MAP));
    cli('--board-title=Board');
    // The hand repair the refusal names — turn the map back into the array it should have been.
    const repaired = { ...state(), decisions: Object.values(MAP.decisions) };
    writeFileSync(statePath, JSON.stringify(repaired));
    expect(cli('--decision-add=A brand new thing', '--question=Q', '--if-nothing=X').code).toBe(0);
    const added = state().decisions.find((d) => d.id === 'a-brand-new-thing');
    expect(added.ruling).toBe('R4');
    expect(new Set(state().decisions.map((d) => d.ruling)).size).toBe(4); // all four distinct
  });

  it('rulingFloor reads a number out of whatever shape the file used', () => {
    expect(rulingFloor([{ ruling: 'R3' }, { ruling: 'R7' }])).toBe(8);
    expect(rulingFloor({ a: { ruling: 'R5' } })).toBe(6); // object-map VALUES
    expect(rulingFloor({ R6: { title: 'keyed by its number' } })).toBe(7); // …and its KEYS
    expect(rulingFloor(['R2 should we ship?'])).toBe(3); // a bare string entry, free text after the number
    expect(rulingFloor(undefined)).toBe(1);
    expect(rulingFloor('not decisions at all')).toBe(1);
    expect(rulingFloor([{ title: 'never numbered' }])).toBe(1);
  });

  it('a string entry that carries a retired number still holds the floor above it', () => {
    writeFileSync(statePath, JSON.stringify({ title: 'B', items: [], decisions: ['R4 was here', { id: 'd', ruling: 'R1', title: 'x', status: 'queued' }] }));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().nextRuling).toBe(5);
  });

  it('the floor only ever raises — a clean file is numbered exactly as before', () => {
    expect(cli('--decision-add=Another', '--question=Q', '--if-nothing=X').code).toBe(0);
    expect(state().decisions.find((d) => d.id === 'another').ruling).toBe('R2'); // the seed's own decision is R1
  });
});

/**
 * `loadState` normalises the CONTAINER keys but never looks inside a decision, so a wrong type one level
 * down reached every reader raw: `options.length < 2` is false for a string (a string has a length), and
 * `options.filter(…)` then threw a raw `TypeError` stack trace out of the validator. It failed CLOSED, which
 * is the right direction — but dying contradicts `loadState`'s own degrade-rather-than-die contract and the
 * one-line-output contract the whole cost design rests on.
 */
describe('a wrong type one level down inside a decision degrades, and never crashes', () => {
  const withOptions = (options, over = {}) => ({
    ...SEED,
    decisions: [{ id: 'bad', title: 'Should we ship?', question: 'Do we ship?', ifNothing: 'nothing moves', status: 'awaiting', options, ...over }],
  });

  it('reports the gap in one line instead of a stack trace, and writes no page', () => {
    writeFileSync(statePath, JSON.stringify(withOptions('Yes, No')));
    const r = cli();
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('TypeError');
    expect(r.err).not.toMatch(/\n\s+at /); // no stack frames
    expect(r.err).toContain('cannot be answered from the page');
    expect(r.err).toContain('at least two, this has 0');
    expect(existsSync(outPath)).toBe(false);
  });

  it('a DRAFT one renders — the page degrades around it and the banner names the field', () => {
    writeFileSync(statePath, JSON.stringify(withOptions({ a: 'Yes' }, { status: 'draft' })));
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain('STATE FILE PARTLY IGNORED');
    expect(page()).toContain('decision &quot;bad&quot;.options');
    expect(page()).toContain('Should we ship?');
  });

  it('the same for a non-list evidence field', () => {
    writeFileSync(statePath, JSON.stringify(withOptions([{ label: 'Yes', recommended: true }, { label: 'No' }], { evidence: 'a single string' })));
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain('decision "bad".evidence');
    expect(page()).toContain('Do we ship?');
  });

  it('the WRITERS refuse cleanly rather than throwing — and never overwrite the field', () => {
    writeFileSync(statePath, JSON.stringify(withOptions('Yes, No', { status: 'draft' })));
    const before = readFileSync(statePath, 'utf8');
    for (const argv of [
      ['--decision-option=bad', '--label=Maybe'],
      ['--decision-option-remove=bad', '--label=Yes'],
    ]) {
      const r = cli(...argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).not.toContain('TypeError');
      expect(r.err).toContain('is not a list');
      expect(r.err).toContain('--decision-remove=bad'); // the route out that IS a verb
      expect(readFileSync(statePath, 'utf8'), argv.join(' ')).toBe(before);
    }
    // …and that route out really works, so this is not a dead end either.
    expect(cli('--decision-remove=bad').code).toBe(0);
    expect(state().decisions).toHaveLength(0);
  });

  it('--decision-evidence refuses the same way when it is EVIDENCE that is not a list', () => {
    // `d.evidence ??= []` does not fire on a string, and a string has `.includes` — so this walked all the
    // way to `.push` before throwing, with the verb already reported as applied.
    writeFileSync(statePath, JSON.stringify(withOptions([{ label: 'Yes', recommended: true }, { label: 'No' }], { status: 'draft', evidence: 'one string' })));
    const before = readFileSync(statePath, 'utf8');
    const r = cli('--decision-evidence=bad', '--text=something');
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('TypeError');
    expect(r.err).toContain('is not a list');
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });
});

describe('--out and --state may not be the same file', () => {
  it('refuses the collision before anything is read or written', () => {
    const before = readFileSync(statePath, 'utf8');
    const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${statePath}`, '--no-gh'], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '1' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('point at');
    expect(readFileSync(statePath, 'utf8')).toBe(before); // still JSON, not a page
  });

  it('and in the FATAL branch too — the one place the design promises never to overwrite a plan', () => {
    writeFileSync(statePath, '{ not json');
    const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${statePath}`, '--no-gh'], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '1' },
    });
    expect(r.status).toBe(1);
    expect(readFileSync(statePath, 'utf8')).toBe('{ not json'); // byte-for-byte
  });
});

/**
 * The last three fields in the file that no verb could reach. All are `??=`-set at the first transition, so
 * a `--done` on an item that was never `--start`ed pinned BOTH dates to the same day with no route back.
 * "Every field has a verb" is now literally true rather than nearly true.
 */
describe('--date corrects the three dates the board sets for you', () => {
  it('--start --date and --done --date write the real dates', () => {
    expect(cli('--start=alpha', '--date=2026-07-01').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').startedAt).toBe('2026-07-01');
    expect(cli('--done=alpha', '--date=2026-07-09').code).toBe(0);
    const it_ = state().items.find((i) => i.id === 'alpha');
    expect(it_.startedAt).toBe('2026-07-01'); // not clobbered by the done
    expect(it_.doneAt).toBe('2026-07-09');
  });

  it('a correction is possible AFTER the date was already stamped — that was the whole gap', () => {
    cli('--done=alpha'); // stamps both to today, the unrecoverable state
    expect(state().items.find((i) => i.id === 'alpha').startedAt).toBe(NOW.slice(0, 10));
    expect(cli('--start=alpha', '--date=2026-06-02').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').startedAt).toBe('2026-06-02');
    expect(cli('--done=alpha', '--date=2026-06-05').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').doneAt).toBe('2026-06-05');
  });

  it('--decide --date writes takenAt, and corrects it later', () => {
    expect(cli('--decide=2978').code).toBe(0);
    expect(state().decisions[0].takenAt).toBe(NOW.slice(0, 10));
    expect(cli('--decide=2978', '--date=2026-05-04').code).toBe(0);
    expect(state().decisions[0].takenAt).toBe('2026-05-04');
  });

  it('a date that is not a date is refused rather than stored', () => {
    for (const bad of ['--date=yesterday', '--date=2026-7-1', '--date']) {
      const r = cli('--start=alpha', bad);
      expect(r.code, bad).toBe(1);
      expect(r.err).toContain('YYYY-MM-DD');
    }
    expect(state().items.find((i) => i.id === 'alpha').startedAt).toBeUndefined();
  });
});

describe('--rephase moves a row by its id', () => {
  it('re-phases an existing item, idempotently', () => {
    expect(cli('--rephase=alpha', '--phase=2').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').phase).toBe(2);
    expect(cli('--rephase=alpha', '--phase=2').out).toMatch(/already in phase 2/);
  });

  it('demands a phase number and a known id', () => {
    expect(cli('--rephase=alpha').code).toBe(1);
    expect(cli('--rephase=alpha', '--phase=x').code).toBe(1);
    expect(cli('--rephase=nope', '--phase=2').code).toBe(1);
    expect(state().items.find((i) => i.id === 'alpha').phase).toBe(1);
  });
});

describe('pure helpers', () => {
  it('slugifies a title into a stable id', () => {
    expect(slugify('Ship the drain rewrite!')).toBe('ship-the-drain-rewrite');
    expect(slugify('  ')).toBe('item');
  });

  it('applyVerb rejects a verb it does not know', () => {
    expect(() => applyVerb({ items: [], decisions: [] }, 'teleport', {})).toThrow(/unknown verb/);
  });
});

// #xg790dh-follow-up (epic #3383/#4075) — LIVE INCIDENT 2026-09-26, PRs #2748/#2749/#2753 (chalbert/web-
// everything): the `ci:failed` label fallback xx6kg3f added (above, "trusts the durable ci:failed label…")
// closed a DEGRADED-rollup gap by trusting the label unconditionally — which also means a STALE label survives
// forever once THIS read's own rollup positively proves the required check green, since nothing ever re-checks
// it. Six ci-heal sessions in a row on PR #2748 correctly found only `review-gate` red (by design, while
// `review:pending` stood) and stood down, yet `classifyPr` kept reading `ci-red` off the stale label alone and
// reconcile-core kept dispatching another one. These pin the fix: the label fallback now defers to a rollup
// that AFFIRMATIVELY reports the required check's latest run as green, while still trusting the label exactly
// as before when the rollup cannot prove that (empty, degraded, or the check simply has not concluded).
describe('classifyPr — a stale ci:failed label must not outrank a rollup that already proves the required check green (xg790dh-follow-up)', () => {
  it('PR #2748\'s real shape: test green, only review-gate red, stale ci:failed label — reads needs-review, not ci-red', () => {
    const rollup = [
      { name: 'review-gate', conclusion: 'FAILURE' },
      { name: 'test-shard (1)', conclusion: 'SUCCESS' },
      { name: 'daemon-soak', conclusion: 'SUCCESS' },
      { name: 'smoke', conclusion: 'SUCCESS' },
      { name: 'test', conclusion: 'SUCCESS' },
    ];
    expect(classifyPr(pr({ labels: ['review:pending', 'ci:failed'], statusCheckRollup: rollup }))).toBe('needs-review');
  });

  it('a stale ci:failed beside a GREEN required check reads through to needs-review even with no review label at all', () => {
    const rollup = [{ name: 'test', conclusion: 'SUCCESS' }];
    expect(classifyPr(pr({ labels: ['ci:failed'], statusCheckRollup: rollup }))).toBe('open');
  });

  // we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — SUPERSEDES the assertion this case used
  // to make. It used to expect `'ci-red'` here, on the theory that "not proven green" is reason enough to trust
  // a stale label. LIVE INCIDENT 2026-09-26/27 (web-everything/web-everything) proved that reasoning wrong: `main`
  // went red then green, the mechanical rebase (`ci-red-recovery-watch.mjs`) rebased each stuck PR onto the new
  // tip and re-ran CI, and every one of them still carried this exact shape — a STALE `ci:failed` label beside
  // a required check that had only just RESTARTED and not concluded yet. Trusting the label there dispatched a
  // wasted ci-heal (of ~10 such sessions inside one hour, 7 — PRs #2782/#2778/#2772/#2779/… — ended "no change
  // needed"). A check that is IN FLIGHT on the current head is evidence, not silence — it says "wait for it",
  // never "trust the old verdict". The genuinely-degraded case (no entry for the check at all) is a SEPARATE
  // population, pinned unchanged in the case right below.
  it('no longer trusts the label once the required check has RESTARTED and not concluded yet — waits instead (heal-wait-for-rerun)', () => {
    const rollup = [{ name: 'test', conclusion: '', state: 'IN_PROGRESS' }];
    expect(classifyPr(pr({ labels: ['review:pending', 'ci:failed'], statusCheckRollup: rollup }))).toBe('needs-review');
  });

  it('still trusts the label when the rollup has no entry for the required check at all (the xx6kg3f degraded-read case, unchanged)', () => {
    expect(classifyPr(pr({ labels: ['review:pending', 'ci:failed'], statusCheckRollup: [] }))).toBe('ci-red');
  });

  // PR #2787 review finding: a required check that CONCLUDED SKIPPED/NEUTRAL/STALE is terminal, not in flight —
  // it will never re-run, so it must not suppress the stale label the way a genuinely in-flight check does.
  // Otherwise the PR silently leaves `ci-red` (no heal, no escalation) and reads `queued` with a check that
  // never passed.
  it.each(['SKIPPED', 'NEUTRAL', 'STALE'])('still trusts the label when the required check concluded %s (terminal, never re-runs)', (conclusion) => {
    const rollup = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion }];
    expect(classifyPr(pr({ labels: ['review:accepted', 'ready-to-merge', 'ci:failed'], mergeStateStatus: 'CLEAN', statusCheckRollup: rollup }))).toBe('ci-red');
  });
});
