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

describe('ruling numbers', () => {
  const st = (decisions, nextRuling) => ({ decisions, ...(nextRuling ? { nextRuling } : {}) });

  it('assigns R1, R2, … from the counter and records where the counter got to', () => {
    const s = st([{ id: 'a' }, { id: 'b' }]);
    expect(ensureRulingNumbers(s)).toBe(2);
    expect(s.decisions.map((d) => d.ruling)).toEqual(['R1', 'R2']);
    expect(s.nextRuling).toBe(3);
  });

  it('assigns ONCE — a second pass moves nothing, and reordering the list moves nothing either', () => {
    const s = st([{ id: 'a' }, { id: 'b' }]);
    ensureRulingNumbers(s);
    expect(ensureRulingNumbers(s)).toBe(0);
    s.decisions.reverse();
    ensureRulingNumbers(s);
    expect(s.decisions.find((d) => d.id === 'a').ruling).toBe('R1');
  });

  it('never reuses a retired number — a taken decision keeps R5 and the next one is R8', () => {
    const s = st([{ id: 'a', ruling: 'R5', status: 'taken' }, { id: 'b', ruling: 'R6' }, { id: 'c', ruling: 'R7' }], 8);
    s.decisions.push({ id: 'd' });
    ensureRulingNumbers(s);
    expect(s.decisions.at(-1).ruling).toBe('R8');
    expect(s.nextRuling).toBe(9);
  });

  // The counter used to be written back UNCONDITIONALLY from a default of 1, so a state file with R1/R2/R3
  // and no `nextRuling` key saved the counter as 1 — and the next three decisions were handed R1, R2, R3
  // again. The floor is the highest number present, always, whatever the counter says.
  it('never regresses the counter below the numbers already handed out', () => {
    const s = st([{ id: 'a', ruling: 'R1' }, { id: 'b', ruling: 'R2' }, { id: 'c', ruling: 'R3' }]); // no nextRuling key
    expect(ensureRulingNumbers(s)).toBe(0);
    expect(s.nextRuling).toBe(4);

    s.decisions.push({ id: 'd' });
    ensureRulingNumbers(s);
    expect(s.decisions.at(-1).ruling).toBe('R4');
  });

  // A hand-lowered counter is the same attack from the other side: the stored value is a FLOOR, never a
  // licence to reissue.
  it('ignores a counter that points below a number already in use', () => {
    const s = st([{ id: 'a', ruling: 'R7' }], 2);
    s.decisions.push({ id: 'b' });
    ensureRulingNumbers(s);
    expect(s.decisions.at(-1).ruling).toBe('R8');
    expect(s.nextRuling).toBe(9);
  });

  it('skips a number that is somehow already in use rather than minting a duplicate', () => {
    const s = st([{ id: 'a', ruling: 'R1' }, { id: 'b' }], 1);
    ensureRulingNumbers(s);
    expect(s.decisions[1].ruling).toBe('R2');
  });

  // Backfill goes ABOVE the highest number in use, in list order — it does not fill the gaps below it. A gap
  // is not free space: the most likely reason R1..R8 are absent while R9 is present is that they were used
  // and their decisions are gone, and handing R1 to something new is precisely the reuse the scheme forbids.
  // Numbers are identity, not a dense sequence, so skipping eight of them costs nothing.
  it('backfills entries that predate the scheme, in list order, above every number in use', () => {
    const s = st([{ id: '2978' }, { id: '2908', ruling: 'R9' }, { id: '2691' }]);
    ensureRulingNumbers(s);
    expect(s.decisions.map((d) => d.ruling)).toEqual(['R10', 'R9', 'R11']);
    expect(s.nextRuling).toBe(12);
  });

  it('resolves a decision by EITHER handle — the ruling number or the id it is filed under', () => {
    const s = st([{ id: '2978', ruling: 'R1' }]);
    expect(findDecision(s, 'R1').id).toBe('2978');
    expect(findDecision(s, 'r1').id).toBe('2978'); // the operator will not shift-key it
    expect(findDecision(s, '2978').ruling).toBe('R1');
    expect(findDecision(s, 'R9')).toBeNull();
  });

  it('renders BOTH handles — the number to answer with, the item number for the record', () => {
    const d = { id: '2691', ruling: 'R3', status: 'awaiting', question: 'Which tier?', options: [{ label: 'A', recommended: true }, { label: 'B' }], ifNothing: 'nothing' };
    const h = renderPage(buildModel({ ...SEED, items: [], decisions: [d] }, { fresh: true, fetchedAt: NOW, reason: null, rows: [] }));
    expect(h).toContain('<span class="rnum">R3</span>Which tier?');
    expect(h).toContain('answer as R3');
    expect(h).toContain('filed as #2691');
  });
});

/**
 * The template lives in exactly ONE place, and the realistic failure is not someone editing the HTML — it is
 * someone in a hurry hand-writing a page and publishing it to the board's URL. The marker makes that
 * detectable instead of merely forbidden.
 */
describe('the generated-page marker', () => {
  const real = () => renderPage(buildModel(SEED, { fresh: true, fetchedAt: NOW, reason: null, rows: [] }));

  it('accepts the script\'s own output', () => {
    const v = verifyPage(real());
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/fingerprint [0-9a-f]{16}/);
  });

  it('rejects a hand-written page outright', () => {
    const v = verifyPage('<title>Progress board</title><p>three clears and three rulings, trust me</p>');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/NOT generated by the board script/);
  });

  it('rejects a page whose marker was copied onto edited content', () => {
    const h = real();
    const v = verifyPage(h.replace('Needs you', 'Needs you (hand-tweaked)'));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not match the marker and body/);
  });

  it('rejects a marker from a different schema, rather than trusting it', () => {
    const v = verifyPage(real().replace('schema=1', 'schema=99'));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/schema 99/);
  });

  it('counts the decisions in the marker, so a thinner page is visible from the marker alone', () => {
    expect(real()).toMatch(/decisions=1 /);
  });

  // The marker's own claims are only worth something if they are BOUND to the page. With the fingerprint
  // covering the body alone, a genuine page could be re-dated to 1999 and re-counted to 999 decisions and
  // still verify — the two fields the check actually prints back at the reader.
  it('binds the marker\'s own at= and decisions= into the fingerprint, not just the body', () => {
    const h = real();
    const redated = verifyPage(h.replace(/ at=\S+ /, ' at=1999-01-01T00:00:00.000Z '));
    expect(redated.ok).toBe(false);
    expect(redated.reason).toMatch(/does not match the marker and body/);

    const recounted = verifyPage(h.replace(/ decisions=\d+ /, ' decisions=999 '));
    expect(recounted.ok).toBe(false);
    expect(recounted.reason).toMatch(/does not match the marker and body/);
  });

  // The honest limit, asserted so nobody later "hardens" the wording back up: an unkeyed digest whose
  // algorithm ships in the same repository cannot distinguish a generated page from a carefully forged one.
  it('states plainly that a pass is not proof of authorship', () => {
    const v = verifyPage(real());
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/UNKEYED/);
    expect(v.reason).toMatch(/NOT a deliberately forged page/);
  });
});

/**
 * The context fields are NOT optional, and that is the point: optional context means the next entry goes in
 * as a bare title and the page slides back into a list of one-liners nobody can act on. The tool enforces it
 * so nobody has to remember it.
 */
describe('the enforced decision contract', () => {
  const complete = () => ({
    id: 'x',
    status: 'awaiting',
    title: 'X',
    question: 'Do we?',
    options: [{ label: 'Yes', recommended: true }, { label: 'No' }],
    ifNothing: 'nothing moves',
  });

  it('names every missing piece, and nothing when the decision is answerable', () => {
    expect(decisionGaps(complete())).toEqual([]);
    expect(decisionGaps({ ...complete(), question: undefined })[0]).toMatch(/^question/);
    expect(decisionGaps({ ...complete(), ifNothing: undefined })[0]).toMatch(/^ifNothing/);
    expect(decisionGaps({})).toHaveLength(3);
  });

  it('demands at least two options — one option is an announcement, not a decision', () => {
    expect(decisionGaps({ ...complete(), options: [{ label: 'Yes', recommended: true }] })[0]).toMatch(/at least two, this has 1/);
    expect(decisionGaps({ ...complete(), options: [] })[0]).toMatch(/at least two, this has 0/);
  });

  it('demands exactly one recommendation — none and two are both wrong', () => {
    expect(decisionGaps({ ...complete(), options: [{ label: 'Yes' }, { label: 'No' }] })[0]).toMatch(/exactly one option marked recommended/);
    expect(
      decisionGaps({ ...complete(), options: [{ label: 'Yes', recommended: true }, { label: 'No', recommended: true }] })[0],
    ).toMatch(/exactly one option marked recommended/);
  });

  it('does not hold `why` or `evidence` hostage — a hard rule there would only train people to type filler', () => {
    expect(decisionGaps({ ...complete(), why: undefined, evidence: undefined })).toEqual([]);
  });

  it('only judges what is being ASKED — draft, queued and taken are exempt', () => {
    const bare = { id: 'bare', title: 'Bare' };
    for (const status of ['draft', 'queued', 'taken']) {
      expect(validateDecisions({ decisions: [{ ...bare, status }] })).toEqual([]);
    }
    expect(validateDecisions({ decisions: [{ ...bare, status: 'awaiting' }] })).toHaveLength(1);
  });
});

// ── The CLI ───────────────────────────────────────────────────────────────────

describe('CLI verbs', () => {
  it('renders with no verb at all', () => {
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^✓ rendered/);
    expect(r.out.split('\n')).toHaveLength(1); // one line, nothing more
    expect(existsSync(outPath)).toBe(true);
  });

  it('--start moves an item to in-progress and re-renders', () => {
    expect(cli('--start=alpha').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha')).toMatchObject({ status: 'in-progress', startedAt: '2026-08-08' });
    expect(page()).toContain('Alpha');
  });

  it('--start clears a blocker (this is how unblocking works)', () => {
    cli('--block=alpha', '--why=waiting on the gate');
    expect(state().items.find((i) => i.id === 'alpha').blocker).toBe('waiting on the gate');
    cli('--start=alpha');
    const it = state().items.find((i) => i.id === 'alpha');
    expect(it.status).toBe('in-progress');
    expect(it.blocker).toBeUndefined();
  });

  it('--done marks it done, and re-running never moves the recorded date', () => {
    cli('--done=alpha');
    const first = state().items.find((i) => i.id === 'alpha').doneAt;
    const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${outPath}`, '--no-gh', '--done=alpha'], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: '2027-01-01T00:00:00.000Z', WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '1' },
    });
    expect(r.status).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').doneAt).toBe(first);
  });

  it('--block requires a reason and records it', () => {
    expect(cli('--block=alpha').code).toBe(1);
    const r = cli('--block=alpha', '--why=blocked on #984');
    expect(r.code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha')).toMatchObject({ status: 'blocked', blocker: 'blocked on #984' });
    expect(page()).toContain('blocked on #984');
  });

  it('--note sets a note and an empty --text clears it', () => {
    cli('--note=alpha', '--text=rebased onto main');
    expect(state().items.find((i) => i.id === 'alpha').note).toBe('rebased onto main');
    cli('--note=alpha', '--text=');
    expect(state().items.find((i) => i.id === 'alpha').note).toBeUndefined();
  });

  it('--add appends once — the same title twice is a no-op, not a duplicate', () => {
    cli('--add=Ship the drain rewrite', '--phase=1');
    expect(state().items.filter((i) => i.id === 'ship-the-drain-rewrite')).toHaveLength(1);
    const r = cli('--add=Ship the drain rewrite', '--phase=1');
    expect(r.out).toMatch(/already on the board/);
    expect(state().items.filter((i) => i.id === 'ship-the-drain-rewrite')).toHaveLength(1);
  });

  it('--decide takes a decision off the operator\'s section', () => {
    expect(cli('--decide=2978').code).toBe(0);
    expect(state().decisions[0]).toMatchObject({ status: 'taken', takenAt: '2026-08-08' });
    expect(page()).not.toContain('A decision');
  });

  it('--url stores the published artifact URL and prints it back on every later run', () => {
    cli('--url=https://claude.ai/public/artifacts/abc');
    expect(state().artifactUrl).toBe('https://claude.ai/public/artifacts/abc');
    expect(cli().out).toContain('https://claude.ai/public/artifacts/abc');
  });

  it('nags for the URL while none is stored', () => {
    expect(cli().out).toMatch(/no artifact URL stored yet/);
  });

  it('refuses an unknown id and names the ones it knows', () => {
    const r = cli('--start=nope');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no item "nope"');
    expect(r.err).toContain('alpha');
  });

  it('renders byte-identically when nothing changed (safe to run on every pass)', () => {
    cli();
    const first = page();
    cli();
    expect(page()).toBe(first);
  });
});

/**
 * A FIELD WITH NO VERB IS A HAND EDIT BY ANOTHER NAME. The PR body, `/board` and SKILL.md all say the state
 * file is never hand-edited *because every field has a verb* — but `items[].pr` (the join between the stored
 * half and the live half, and present on 6 of the 15 shipped rows), `phases`, `title` and `repo` had none,
 * and nothing could remove or retitle a row. The shipped state file therefore HAD to be hand-authored in
 * exactly the field the docs forbid. These are the missing verbs.
 */
describe('CLI verbs for the fields that had none', () => {
  const item = (id) => state().items.find((i) => i.id === id);

  it('--link joins a plan item to its pull request, and --unlink takes it off', () => {
    expect(cli('--link=alpha', '--pr=1234').code).toBe(0);
    expect(item('alpha').pr).toBe(1234);
    expect(page()).toContain('#1234');
    expect(cli('--link=alpha', '--pr=1234').out).toMatch(/already linked/); // idempotent

    expect(cli('--unlink=alpha').code).toBe(0);
    expect(item('alpha').pr).toBeUndefined();
    expect(cli('--unlink=alpha').out).toMatch(/no pull request linked/); // idempotent
  });

  it('--link demands a real pull-request number', () => {
    expect(cli('--link=alpha', '--pr=not-a-number').code).toBe(1);
    expect(cli('--link=alpha').code).toBe(1);
    expect(item('alpha').pr).toBeUndefined();
  });

  it('--retitle fixes a typo WITHOUT moving the id every other verb and the PR join use', () => {
    expect(cli('--retitle=alpha', '--to=Alpha, corrected').code).toBe(0);
    expect(item('alpha')).toMatchObject({ id: 'alpha', title: 'Alpha, corrected' });
    expect(cli('--retitle=alpha', '--to=Alpha, corrected').out).toMatch(/already titled/); // idempotent
    expect(cli('--retitle=alpha').code).toBe(1); // --to is not optional
  });

  it('--remove drops a row, so a typo\'d title stops inflating the plan total forever', () => {
    expect(state().items).toHaveLength(2);
    expect(cli('--remove=alpha').code).toBe(0);
    expect(state().items.map((i) => i.id)).toEqual(['beta']);
    const again = cli('--remove=alpha');
    expect(again.code).toBe(0); // idempotent
    expect(again.out).toMatch(/nothing to remove/);
  });

  it('--phase-title names a phase — the map `--add --phase=n` never writes', () => {
    expect(cli('--phase-title=2', '--to=Merge-gate correctness').code).toBe(0);
    expect(state().phases['2']).toBe('Merge-gate correctness');
    cli('--add=Something in phase two', '--phase=2');
    expect(page()).toContain('Phase 2 — Merge-gate correctness');
    expect(cli('--phase-title=2', '--to=Merge-gate correctness').out).toMatch(/already titled/);
    expect(cli('--phase-title=2', '--to=').out).toMatch(/title cleared/);
    expect(state().phases['2']).toBeUndefined();
    expect(cli('--phase-title=two', '--to=x').code).toBe(1);
  });

  it('--board-title and --repo bootstrap a board without a hand edit', () => {
    expect(cli('--board-title=The plan').code).toBe(0);
    expect(state().title).toBe('The plan');
    expect(page()).toContain('<h1>The plan</h1>');

    expect(cli('--repo=frontier-ui/frontierui').code).toBe(0);
    expect(state().repo).toBe('frontier-ui/frontierui');
    expect(cli('--repo=not a repo').code).toBe(1);
    expect(state().repo).toBe('frontier-ui/frontierui'); // the bad value never landed
    expect(cli('--repo=').out).toMatch(/repository cleared/);
    expect(state().repo).toBeNull();
  });

  it('--decision-remove drops a decision — the other repair that needed a hand edit', () => {
    expect(cli('--decision-remove=2978').code).toBe(0);
    expect(state().decisions).toHaveLength(0);
    const again = cli('--decision-remove=2978');
    expect(again.code).toBe(0); // idempotent
    expect(again.out).toMatch(/nothing to remove/);
  });

  /**
   * THE DEMONSTRATED REUSE. A state file holding R1/R2/R3 with no `nextRuling` key saved the counter back as
   * 1, so the numbers were re-issued; chained with a removal, a brand-new decision was handed R2 — and
   * `--decide=R2` is what the operator types in chat. The counter is reconciled from the file AS READ, before
   * the removal can delete the evidence, and it only ever moves forward.
   */
  it('retires a removed ruling number for good — the next decision never reuses it', () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        ...SEED,
        nextRuling: undefined, // the key is simply absent, as in a hand-authored or older file
        decisions: [
          { id: 'd1', ruling: 'R1', title: 'One', status: 'queued' },
          { id: 'd2', ruling: 'R2', title: 'Two', status: 'queued' },
          { id: 'd3', ruling: 'R3', title: 'Three', status: 'queued' },
        ],
      }),
    );
    expect(cli('--decision-remove=R2').code).toBe(0);
    expect(state().decisions.map((d) => d.ruling)).toEqual(['R1', 'R3']);
    expect(state().nextRuling).toBe(4); // NOT 1, and not 3 — the counter never walks back

    expect(cli('--decision-add=A fourth call', '--question=Q?', '--if-nothing=nothing').code).toBe(0);
    expect(state().decisions.at(-1).ruling).toBe('R4');
  });

  it('a plain re-render never walks the counter back either', () => {
    writeFileSync(statePath, JSON.stringify({ ...SEED, nextRuling: undefined, decisions: [{ id: 'd1', ruling: 'R3', title: 'One', status: 'queued' }] }));
    expect(cli().code).toBe(0);
    expect(state().nextRuling).toBe(4);
  });

  it('--url refuses anything that is not a URL, including no value at all', () => {
    const empty = cli('--url');
    expect(empty.code).toBe(1);
    expect(empty.err).toMatch(/full published URL/);
    expect(state().artifactUrl).toBeNull(); // and NOT the literal string "true"

    expect(cli('--url=probably-a-url').code).toBe(1);
    expect(state().artifactUrl).toBeNull();
  });

  it('--url will not silently replace a stored URL — a minted duplicate cannot be undone', () => {
    cli('--url=https://claude.ai/public/artifacts/abc');
    expect(cli('--url=https://claude.ai/public/artifacts/abc').out).toMatch(/already stored/); // idempotent

    const clash = cli('--url=https://claude.ai/public/artifacts/xyz');
    expect(clash.code).toBe(1);
    expect(clash.err).toContain('already stored');
    expect(state().artifactUrl).toBe('https://claude.ai/public/artifacts/abc');

    expect(cli('--url=https://claude.ai/public/artifacts/xyz', '--force').code).toBe(0);
    expect(state().artifactUrl).toBe('https://claude.ai/public/artifacts/xyz');
  });

  it('does not tell the operator to "answer" a decision in a section that asks nothing', () => {
    cli('--decision-set=2978', '--field=status', '--value=queued');
    const h = page();
    expect(h).toContain('Ruled, queued');
    expect(h).toContain('ruled as R1');
    expect(h).not.toContain('answer as');
  });
});

/**
 * The decision verbs exist so the model NEVER hand-edits the state JSON — which is the only way the board
 * stays mechanical. Each one must be idempotent (a repeat re-states, never duplicates), must re-render, and
 * must print exactly one line.
 */
describe('CLI decision verbs', () => {
  const decision = (id = 'ship-it-or-not') => state().decisions.find((d) => String(d.id) === id);

  const ADD = ['--decision-add=Ship it or not', '--question=Do we ship the thing?', '--if-nothing=it never ships'];

  it('--decision-add lands as a DRAFT, and a repeat is a no-op', () => {
    const r = cli(...ADD);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toHaveLength(1);
    expect(r.out).toMatch(/added decision ship-it-or-not \(draft\)/);
    // Draft, not awaiting: it has no options yet, so it is not answerable and must not reach the operator.
    expect(decision()).toMatchObject({ title: 'Ship it or not', question: 'Do we ship the thing?', ifNothing: 'it never ships', status: 'draft' });
    expect(page()).toContain('Decisions being prepared');

    const again = cli(...ADD);
    expect(again.out).toMatch(/already on the board: decision ship-it-or-not/);
    expect(state().decisions.filter((d) => d.id === 'ship-it-or-not')).toHaveLength(1);
  });

  it('--decision-add refuses a bare title — a title is not a decision', () => {
    const r = cli('--decision-add=Ship it or not');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--question');
    expect(r.err).toContain('--if-nothing');
    expect(state().decisions).toHaveLength(1); // nothing was written
  });

  it('--decision-add --status=queued records an ALREADY-RULED call without demanding a question', () => {
    // Recording an answer is a different act from asking a question, and is not held to the same bar.
    const r = cli('--decision-add=Converge daemon scheduling', '--id=2572', '--status=queued');
    expect(r.code).toBe(0);
    expect(decision('2572')).toMatchObject({ id: '2572', title: 'Converge daemon scheduling', status: 'queued' });
    expect(page()).toContain('#2572');
    expect(page()).toContain('Ruled, queued');
  });

  it('--decision-add --status=awaiting is held to the full contract', () => {
    const r = cli(...ADD, '--status=awaiting');
    expect(r.code).toBe(1);
    expect(r.err).toContain('ship-it-or-not');
    expect(r.err).toMatch(/at least two/);
  });

  it('refuses to flip a half-built decision to awaiting, naming the id and every gap', () => {
    cli(...ADD);
    const r = cli('--decision-set=ship-it-or-not', '--field=status', '--value=awaiting');
    expect(r.code).toBe(1);
    expect(r.err).toContain('"ship-it-or-not"');
    expect(r.err).toMatch(/at least two/);
    expect(decision().status).toBe('draft'); // refused BEFORE anything was written

    cli('--decision-option=ship-it-or-not', '--label=Ship', '--detail=go', '--recommend');
    expect(cli('--decision-set=ship-it-or-not', '--field=status', '--value=awaiting').code).toBe(1); // still one option
    cli('--decision-option=ship-it-or-not', '--label=Hold', '--detail=wait');
    const ok = cli('--decision-set=ship-it-or-not', '--field=status', '--value=awaiting');
    expect(ok.code).toBe(0);
    expect(decision().status).toBe('awaiting');
  });

  it('refuses to RENDER a board carrying an unanswerable awaiting decision, naming the id and the field', () => {
    // The guard the verbs cannot provide: an entry that predates the rule, or one written around the CLI.
    writeFileSync(statePath, JSON.stringify({ ...SEED, decisions: [{ id: '2691', title: 'Legacy', status: 'awaiting', detail: 'one line' }] }));
    const r = cli();
    expect(r.code).toBe(1);
    expect(r.err).toContain('cannot be answered from the page');
    expect(r.err).toContain('"2691"');
    expect(r.err).toMatch(/missing question/);
    expect(r.err).toMatch(/ifNothing/);
    expect(r.err).toMatch(/--value=draft/); // and it says how to get unstuck
  });

  it('still SAVES the verb when the render is refused — otherwise the repair route is a deadlock', () => {
    writeFileSync(statePath, JSON.stringify({ ...SEED, decisions: [{ id: '2691', title: 'Legacy', status: 'awaiting' }] }));
    expect(cli('--decision-set=2691', '--field=question', '--value=What is it?').code).toBe(1); // still incomplete
    expect(state().decisions[0].question).toBe('What is it?'); // …but the edit landed
    expect(cli('--decision-set=2691', '--field=status', '--value=draft').code).toBe(0); // parking it clears the board
  });

  it('--decision-set writes one field, and an empty --value clears it', () => {
    cli('--decision-set=2978', '--field=why', '--value=the two sessions share an id');
    expect(state().decisions[0].why).toBe('the two sessions share an id');
    expect(page()).toContain('the two sessions share an id');
    cli('--decision-set=2978', '--field=why', '--value=');
    expect(state().decisions[0].why).toBeUndefined();
  });

  it('--decision-set is idempotent — setting the same value twice changes nothing', () => {
    cli('--decision-set=2978', '--field=ifNothing', '--value=nothing lands');
    const first = JSON.stringify(state());
    cli('--decision-set=2978', '--field=ifNothing', '--value=nothing lands');
    expect(JSON.stringify(state())).toBe(first);
  });

  it('--decision-set refuses a field with no verb and a status outside the lifecycle', () => {
    const bad = cli('--decision-set=2978', '--field=options', '--value=nope');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('own verbs');
    const worse = cli('--decision-set=2978', '--field=status', '--value=maybe');
    expect(worse.code).toBe(1);
    expect(worse.err).toContain(DECISION_STATUSES.join(', '));
    expect(DECISION_FIELDS).toContain('question');
  });

  it('--decision-set=queued takes a RULED decision out of "needs you" without hiding it', () => {
    cli('--decision-set=2978', '--field=status', '--value=queued');
    const r = cli();
    expect(r.out).toContain('(0 needs you'); // ruled, therefore not an ask
    expect(page()).toContain('Ruled, queued');
    expect(page()).toContain('A decision');
  });

  it('--decision-option appends, and the same label twice updates rather than duplicates', () => {
    const before = state().decisions[0].options.length;
    cli('--decision-option=2978', '--label=Do it', '--detail=costs a session');
    cli('--decision-option=2978', '--label=Drop it', '--detail=costs nothing');
    expect(state().decisions[0].options).toHaveLength(before + 2);
    const r = cli('--decision-option=2978', '--label=Do it', '--detail=costs a session');
    expect(r.out).toMatch(/option updated on 2978: Do it/);
    expect(state().decisions[0].options).toHaveLength(before + 2);
    expect(page()).toContain('costs a session');
  });

  it('--recommend marks exactly one option, and a second --recommend MOVES it', () => {
    cli('--decision-option=2978', '--label=Do it', '--detail=a', '--recommend');
    cli('--decision-option=2978', '--label=Drop it', '--detail=b');
    expect(state().decisions[0].options.filter((o) => o.recommended)).toHaveLength(1);
    cli('--decision-option=2978', '--label=Drop it', '--recommend');
    const recs = state().decisions[0].options.filter((o) => o.recommended);
    expect(recs.map((o) => o.label)).toEqual(['Drop it']);
    expect(page().match(/class="chip ok">recommended</g)).toHaveLength(1);
  });

  it('--decision-option demands a label', () => {
    const r = cli('--decision-option=2978', '--detail=orphaned');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--label');
  });

  // Labels match exactly, so re-wording an option adds a SECOND row and the page offers the operator the
  // same choice twice. Removal is the only mechanical repair — the alternative is hand-editing state.
  it('--decision-option-remove drops the superseded label and leaves the rest', () => {
    cli('--decision-option=2978', '--label=Do it now', '--detail=a re-wording that duplicated an option');
    expect(state().decisions[0].options).toHaveLength(3);
    const r = cli('--decision-option-remove=2978', '--label=Do it now');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/option removed from 2978: Do it now/);
    expect(state().decisions[0].options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(page()).not.toContain('a re-wording that duplicated an option');
  });

  // Idempotent like every other verb — a second removal of the same label is a no-op, not a failure. It still
  // NAMES the options that are there, so a typo'd label is visible in the one line the model reads.
  it('--decision-option-remove is idempotent — a repeat is a no-op that names what is actually there', () => {
    expect(cli('--decision-option=2978', '--label=Maybe', '--detail=c').code).toBe(0);
    expect(cli('--decision-option-remove=2978', '--label=Maybe').code).toBe(0);
    const again = cli('--decision-option-remove=2978', '--label=Maybe');
    expect(again.code).toBe(0);
    expect(again.out).toContain('no option labelled "Maybe"');
    expect(again.out).toContain('options: Yes, No');
    expect(state().decisions[0].options).toHaveLength(2);
  });

  it('--decision-option-remove demands a label', () => {
    const r = cli('--decision-option-remove=2978');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--label');
  });

  // Removal is the one verb that can take a complete decision back to an incomplete one, so the same
  // enforcement that guards --decision-add has to catch it — both ways it can strand the page.
  it('removing down to one option is REFUSED by the answerable-from-the-page enforcement', () => {
    const r = cli('--decision-option-remove=2978', '--label=No');
    expect(r.code).toBe(1);
    expect(r.err).toContain('at least two');
  });

  it('removing the RECOMMENDED option is REFUSED — it leaves the page with no recommendation', () => {
    cli('--decision-option=2978', '--label=Maybe', '--detail=c');
    const r = cli('--decision-option-remove=2978', '--label=Yes');
    expect(r.code).toBe(1);
    expect(r.err).toContain('recommended');
  });

  it('--decision-evidence appends, dedups the same text, and an empty --text clears all of it', () => {
    cli('--decision-evidence=2978', '--text=row 3 currently PASSES');
    const again = cli('--decision-evidence=2978', '--text=row 3 currently PASSES');
    expect(again.out).toMatch(/evidence already on 2978/);
    expect(state().decisions[0].evidence).toEqual(['row 3 currently PASSES']);
    cli('--decision-evidence=2978', '--text=and row 4 does not');
    expect(state().decisions[0].evidence).toHaveLength(2);
    expect(page()).toContain('and row 4 does not');
    cli('--decision-evidence=2978', '--text=');
    expect(state().decisions[0].evidence).toBeUndefined();
  });

  it('names the decisions it knows when the id is wrong', () => {
    const r = cli('--decision-set=nope', '--field=why', '--value=x');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no decision "nope"');
    expect(r.err).toContain('2978');
  });

  it('numbers every decision on the first run and never moves one afterwards', () => {
    cli();
    expect(state().decisions[0].ruling).toBe('R1');
    expect(state().nextRuling).toBe(2);
    cli(...ADD);
    expect(decision().ruling).toBe('R2');
    const before = JSON.stringify(state());
    cli();
    expect(JSON.stringify(state())).toBe(before); // the backfill is a one-time migration, not a per-run write
    expect(page()).toContain('<span class="rnum">R1</span>');
  });

  it('takes a verb by the ruling number the operator would actually type', () => {
    cli();
    expect(cli('--decide=R1').code).toBe(0);
    expect(state().decisions[0].status).toBe('taken');
    expect(cli('--decision-set=r1', '--field=detail', '--value=via the lowercase form').code).toBe(0);
    expect(state().decisions[0].detail).toBe('via the lowercase form');
  });

  it('names both handles when the id is wrong, so either one can be found', () => {
    cli();
    const r = cli('--decide=R99');
    expect(r.code).toBe(1);
    expect(r.err).toContain('R1/2978');
  });

  it('refuses an --id in the R-number namespace — those are the board\'s to hand out', () => {
    const r = cli('--decision-add=Squatter', '--id=R4', '--question=Q?', '--if-nothing=nothing');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/reserved/);
  });

  it('--verify says yes to its own output and no to a hand-written page', () => {
    cli();
    const good = spawnSync(process.execPath, [CLI, `--verify=${outPath}`], { encoding: 'utf8' });
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('marker and body agree');

    const fake = join(sandbox, 'handrolled.html');
    writeFileSync(fake, '<title>Progress board</title><p>trust me</p>');
    const bad = spawnSync(process.execPath, [CLI, `--verify=${fake}`], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('is NOT the generated board');
  });

  // The two directions are not equally strong and the wording must not pretend otherwise: a FAILURE is
  // conclusive, a PASS is only "the marker and the body agree". The digest is unkeyed and its algorithm is in
  // the script the skill tells an agent to read, so a recomputed marker on hand-written content verifies —
  // that is a property of unkeyed digests, not a bug to be patched, and the check has to say so out loud.
  it('--verify does not claim to prove authorship — the unkeyed digest is named in the output', () => {
    cli();
    const good = spawnSync(process.execPath, [CLI, `--verify=${outPath}`], { encoding: 'utf8' });
    expect(good.status).toBe(0);
    expect(good.stdout).not.toContain('is the generated board');
    expect(good.stdout).toMatch(/UNKEYED/);
    expect(good.stdout).toMatch(/NOT a deliberately forged page/);
  });

  it('--decide still means TAKEN — the decision leaves the board entirely', () => {
    cli('--decision-set=2978', '--field=question', '--value=Do we?');
    cli('--decide=2978');
    expect(state().decisions[0]).toMatchObject({ status: 'taken' });
    expect(page()).not.toContain('Do we?');
    expect(page()).not.toContain('Ruled, queued');
  });

  it('re-rendering after the decision verbs is still byte-stable', () => {
    cli();
    const first = page();
    cli();
    expect(page()).toBe(first);
  });
});

