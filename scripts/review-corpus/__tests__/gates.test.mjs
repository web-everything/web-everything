import { describe, it, expect } from 'vitest';
import {
  doneWhenSection,
  doneWhenCriteria,
  candidateNeedles,
  resolvedWithTodo,
  staleGateCount,
  danglingWikilink,
  danglingHashId,
  grepLiteralMismatch,
  vacuousExecutableCriterion,
  scopeOmitsDoneWhenFile,
  citationLineContent,
  uncitedMechanismClaim,
  unqualifiedCompletenessClaim,
} from '../gates.mjs';
import { GATES, runGates } from '../gates.mjs';
import { covers } from '../replay-gates.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The two files' own source, so a doc claim can be pinned to the code it describes. */
const GATES_SOURCE = readFileSync(resolve(HERE, '..', 'gates.mjs'), 'utf8');
const REPLAY_SOURCE = readFileSync(resolve(HERE, '..', 'replay-gates.mjs'), 'utf8');

const card = (body) => `---\nkind: story\nstatus: open\n---\n\n# A card\n\n${body}\n`;

// #5399 S7 — the acceptance heading comes from the shared task-agreement reader, and `- [A#]` items are criteria.
describe('gates read `## Acceptance` `[A#]` items exactly as `## Done when` numbered items', () => {
  const legacyBody = [
    '## Done when', '',
    '1. **Executable** — grepping `we:skills-src/conveyor/SKILL.md` for `dispatch-lane`',
    '   returns hits. It returns nothing today.',
    '2. no new warnings against the 0-error / 1435-warning baseline.',
    '3. a test in `we:skills-src/conveyor/__tests__/runner.test.mjs` asserts it.', '',
    '## Later', '', 'x',
  ].join('\n');
  const canonicalBody = legacyBody.replace('## Done when', '## Acceptance').replace(/^(\d+)\. /gm, '- [A$1] ');
  const ctx = { path: 'backlog/x.md', read: () => 'no dispatch-lane here', exists: () => false, list: () => [] };
  it('same section, same criteria count and offsets', () => {
    const a = doneWhenSection(card(legacyBody)), b = doneWhenSection(card(canonicalBody));
    expect(b.startLine).toBe(a.startLine);
    expect(doneWhenCriteria(b.body).map((c) => c.line)).toEqual(doneWhenCriteria(a.body).map((c) => c.line));
    expect(doneWhenCriteria(b.body)).toHaveLength(3);
  });
  it('every registered gate fires identically', () => {
    const run = (t) => runGates(t, ctx).map((f) => `${f.gate}@${f.line}:${f.subject}`);
    expect(run(card(canonicalBody))).toEqual(run(card(legacyBody)));
    expect(run(card(legacyBody)).length).toBeGreaterThan(0);
  });
});

describe('doneWhenCriteria — criteria wrap across physical lines', () => {
  it('joins a criterion with its continuation lines', () => {
    const { body } = doneWhenSection(card('## Done when\n\n1. **Executable** — grepping `we:a/b.md`\n   for `needle` returns nothing.\n2. second\n'));
    const crits = doneWhenCriteria(body);
    expect(crits).toHaveLength(2);
    // The regression this pins: the path is on line 1 and the claim on line 2. A per-line scan sees
    // neither half, which is exactly why the first replay of grep-literal-mismatch scored 0.
    expect(crits[0].text).toContain('we:a/b.md');
    expect(crits[0].text).toContain('returns nothing');
  });
});

describe('candidateNeedles — the path being grepped is not the needle', () => {
  it('drops bare paths and path:line loci, keeps the literal', () => {
    const n = candidateNeedles('grepping `we:skills-src/conveyor/SKILL.md` for `dispatch-lane` returns nothing');
    expect(n).toEqual(['dispatch-lane']);
  });
  it('drops a npm run command', () => {
    expect(candidateNeedles('`npm run check:standards` passes')).toEqual([]);
  });
});

describe('staleGateCount', () => {
  it('flags a hyphen-joined count — "1435-warning" is the repo\'s own phrasing', () => {
    const out = staleGateCount(card('## Done when\n\n1. no new warnings against the 0-error / 1435-warning baseline.\n'), { path: 'backlog/x.md' });
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('1435');
  });
  it('does not flag "0 errors", which is a stable target rather than a drifting count', () => {
    expect(staleGateCount(card('## Done when\n\n1. `check:standards` reports 0 errors.\n'), { path: 'backlog/x.md' })).toEqual([]);
  });
});

describe('grepLiteralMismatch', () => {
  const read = (p) => (p === 'skills-src/conveyor/SKILL.md' ? 'line one\nmentions dispatch-lane here\nline three\n' : null);

  it('flags a criterion claiming absence when the literal is present', () => {
    const out = grepLiteralMismatch(
      card('## Done when\n\n1. **Executable** — grepping `we:skills-src/conveyor/SKILL.md` for `dispatch-lane`\n   returns hits. It returns nothing today.\n'),
      { path: 'backlog/x.md', read },
    );
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('dispatch-lane');
    expect(out[0].message).toMatch(/has 1 hit/);
  });

  it('does not read a LINE REFERENCE as an occurrence count', () => {
    // Regression: `/…(\d+)/` matched the 77 in "the line-77 mention" and reported "a count of 77",
    // a confidently wrong message that then matched a real finding by keyword and inflated recall.
    const out = grepLiteralMismatch(
      card('## Done when\n\n1. **Executable** — the line-77 mention of `dispatch-lane` in `we:skills-src/conveyor/SKILL.md` occurs once.\n'),
      { path: 'backlog/x.md', read },
    );
    expect(out.filter((f) => /count of 77/.test(f.message))).toEqual([]);
  });
});

describe('vacuousExecutableCriterion', () => {
  it('flags a criterion that already passes before the work is done', () => {
    const read = () => 'nothing relevant here\n';
    const out = vacuousExecutableCriterion(
      card('## Done when\n\n1. **Executable** — grepping `we:a/b.md` for `Spawn it as one background Agent` returns zero hits.\n'),
      { path: 'backlog/x.md', read },
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).toMatch(/already matches zero times/);
  });
});

// ── #3340: the gate modelled ONE shape of vacuity (absence) and missed the common one ─────────────────
// A criterion whose command is a test-runner invocation under a name filter is green before the work
// exists: `vitest … -t "#NNNN"` on a tree with no matching test is a selection of ZERO, and vitest exits
// 0 on an empty selection. The specimen below is the pre-fix #3319 criterion, quoted VERBATIM from
// `backlog/3340-…md`. It is quoted rather than cited by sha on purpose: the two commits that
// introduced and then fixed it never landed on `main`, so a sha would not resolve for anyone.
describe('vacuousExecutableCriterion — #3340 the empty-selection shape', () => {
  const read = () => 'nothing relevant here\n';
  const fire = (body) => vacuousExecutableCriterion(card(`## Done when\n\n${body}\n`), { path: 'backlog/x.md', read });

  /** The #3319 criterion as it was written before its own fix, verbatim. */
  const PRE_FIX_3319 = '1. **Executable** — `npx vitest run we:scripts/operations/__tests__/review-pr.test.mjs -t "#3319"` (drop the\n'
    + '   `we:` prefix when actually running it). Fails before this item lands — no `judgeSecurity` step exists and\n'
    + '   the run reaches `confirm` after ONE judge suspend — and passes after.';

  it('#3340 flags the pre-fix #3319 criterion exactly once', () => {
    const out = fire(PRE_FIX_3319);
    expect(out.filter((f) => f.gate === 'vacuous-executable-criterion')).toHaveLength(1);
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('-t "#3319"');
    expect(out[0].message).toMatch(/selection of zero/i);
  });

  it('#3340 does NOT flag the fixed form, which asserts the run actually ran tests', () => {
    // This is #3319's own landed fix, and the shape the repo treats as correct. A gate that flags this
    // is a gate people route around, after which it protects nothing.
    expect(fire('1. **Executable** — `npx vitest run we:scripts/operations/__tests__/review-pr.test.mjs -t "#3319" | grep -qE "Tests +[0-9]+ passed"`.\n   Fails before this item lands and passes after.')).toEqual([]);
    // Same assertion stated in prose rather than piped.
    expect(fire('1. **Executable** — `npx vitest run gates -t "#3340"`; the run reports `Tests  2 passed` after, and 0 before.')).toEqual([]);
    // And the runner flag that turns an empty selection into a failure.
    expect(fire('1. **Executable** — `npx vitest run gates -t "#3340" --passWithNoTests=false`.')).toEqual([]);
  });

  it('#3340 does NOT flag an unfiltered run, which fails honestly on an empty tree', () => {
    expect(fire('1. **Executable** — `npx vitest run we:scripts/review-corpus/__tests__/gates.test.mjs` is green.')).toEqual([]);
    expect(fire('1. **Executable** — `npm run check:standards` reports 0 errors.')).toEqual([]);
  });

  it('#3340 keeps the absence predicate beside the new one, not in place of it', () => {
    const out = fire('1. **Executable** — grepping `we:a/b.md` for `Spawn it as one background Agent` returns zero hits.');
    expect(out).toHaveLength(1);
    expect(out[0].message).toMatch(/already matches zero times/);
  });

  it('#3340 catches --testNamePattern, the long spelling of the same filter', () => {
    const out = fire('1. **Executable** — `npx vitest run gates --testNamePattern "#1234"`.');
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('--testNamePattern "#1234"');
  });

  it('#3340 emits a subject the default matcher can score on', () => {
    for (const f of fire(PRE_FIX_3319)) {
      expect(f.subject.trim().length).toBeGreaterThanOrEqual(3);
      expect(covers({ ...f }, { path: f.path, line: f.line, summary: f.subject }, 3, 'content')).toBe(true);
    }
  });

  it('#3340 the gate header states the general rule the shapes are instances of', () => {
    // Naming the rule is what stops the next shape being filed as a third unrelated card.
    expect(GATES_SOURCE).toMatch(/a criterion is vacuous when its success\s+\*?\s*\*?is independent of the work/i);
  });
});

describe('danglingWikilink', () => {
  const list = () => ['agent-memory-src/104-feedback_commit_to_default_branch_ok.md'];
  it('flags a wikilink that resolves to nothing', () => {
    const out = danglingWikilink('see [[104-edit-work-runs-in-a-lane-clone]]\n', { path: 'agent-memory-src/x.md', list });
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('104-edit-work-runs-in-a-lane-clone');
  });
  it('resolves a link that matches an existing slug', () => {
    expect(danglingWikilink('see [[104-feedback_commit_to_default_branch_ok]]\n', { path: 'agent-memory-src/x.md', list })).toEqual([]);
  });
});

describe('danglingHashId', () => {
  it('flags an id that resolves neither by filename nor bornAs', () => {
    const out = danglingHashId(card('body cites #x2sqf62 as the prior instance.'), { path: 'backlog/x.md', knownHashIds: () => new Set(['xabc123']) });
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('x2sqf62');
  });
  it('accepts an id carried by bornAs after JIT-numbering', () => {
    expect(danglingHashId(card('cites #xabc123.'), { path: 'backlog/x.md', knownHashIds: () => new Set(['xabc123']) })).toEqual([]);
  });
});

describe('resolvedWithTodo', () => {
  it('flags a resolved card whose Done-when still holds the scaffold placeholder', () => {
    const t = '---\nstatus: resolved\n---\n\n## Done when\n\nTODO: a command that fails before and passes after.\n';
    expect(resolvedWithTodo(t, { path: 'backlog/x.md' })).toHaveLength(1);
  });
  it('ignores an open card', () => {
    const t = '---\nstatus: open\n---\n\n## Done when\n\nTODO: fill this in.\n';
    expect(resolvedWithTodo(t, { path: 'backlog/x.md' })).toEqual([]);
  });
});

describe('scopeOmitsDoneWhenFile', () => {
  it('flags a Done-when file the scope does not cover', () => {
    const t = '---\nscope:\n  - we:skills-src/conveyor/SKILL.md\n---\n\n## Done when\n\n1. a test in `we:skills-src/conveyor/__tests__/runner.test.mjs` asserts it.\n';
    const out = scopeOmitsDoneWhenFile(t, { path: 'backlog/x.md' });
    expect(out.map((f) => f.subject)).toContain('skills-src/conveyor/__tests__/runner.test.mjs');
  });
});

describe('citationLineContent', () => {
  it('flags a locus whose named symbol is far from the cited line', () => {
    const read = () => `${'x\n'.repeat(20)}function gitPushMain() {}\n${'y\n'.repeat(20)}function realPush() {}\n`;
    const out = citationLineContent('the push it does itself (`we:scripts/pr-land.mjs:5`) calls `realPush` first.', { path: 'backlog/x.md', read });
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('scripts/pr-land.mjs:5');
  });
  it('stays silent when the symbol sits at the cited line', () => {
    const read = () => 'a\nb\nfunction realPush() {}\nd\n';
    expect(citationLineContent('see `we:scripts/pr-land.mjs:3` for `realPush`.', { path: 'backlog/x.md', read })).toEqual([]);
  });
});

// ── #3341: a card's mechanism claim must cite the function or line that backs it ──────────────────────
// The specimen is `backlog/3343-…md`'s ORIGINAL opening sentence, reconstructed here from the verbatim
// quotation in `backlog/3341-…md` and the scope its own retraction section records. It asserted that
// pr-land derives the label from GitHub's three-dot file list; the code scores off a LOCAL computation,
// merge-base-narrowed since #2404 with a named regression test. The symptom was real, the mechanism
// invented, and it cost a build round. The negative half is the SAME CARD after revision, read live off
// disk — the fixed form has to stay silent or the gate punishes the fix.
describe('uncitedMechanismClaim — #3341', () => {
  const ROOT = resolve(HERE, '..', '..', '..');
  /** A reader over the real tree, so "the module resolves to a real file" is a real question. */
  const read = (p) => {
    const f = resolve(ROOT, p);
    return existsSync(f) && !p.includes('..') ? readFileSync(f, 'utf8') : null;
  };

  /** `backlog/3343-…md` as it was first filed, per its own "What this card first claimed" section. */
  const PRE_FIX_3343 = [
    '---', 'kind: story', 'status: open', 'scope:',
    '  - we:scripts/merge-ai-prs.mjs', '  - we:scripts/pr-land.mjs', '---', '',
    '# A producer review label is decided on the inflated three-dot basis', '',
    "pr-land derives the review label from GitHub's three-dot file list, so a branch merely BEHIND main",
    "is labelled from other people's changes.", '',
  ].join('\n');

  it('#3341 reports the pre-fix #3343 opening sentence, through runGates', () => {
    // Through the registry's REAL calling convention, not the bare function — a gate that only works
    // when called directly is a gate that never runs.
    const out = runGates(PRE_FIX_3343, { path: 'backlog/3343-x.md', read });
    const mine = out.filter((f) => f.gate === 'uncited-mechanism-claim');
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe('pr-land');
    expect(mine[0].message).toMatch(/cites nothing/);
  });

  it('#3341 reports nothing on the revised card, which cites we:scripts/pr-land.mjs:839', () => {
    const name = readdirSync(join(ROOT, 'backlog')).find((f) => /^3343-/.test(f));
    expect(name, 'backlog/3343-*.md must exist — it is this gate\'s negative specimen').toBeTruthy();
    const rel = `backlog/${name}`;
    const text = readFileSync(join(ROOT, rel), 'utf8');
    // Pin what makes it the fixed form, so a future edit that strips the citations reddens here too.
    expect(text).toContain('we:scripts/pr-land.mjs:839');
    expect(runGates(text, { path: rel, read }).filter((f) => f.gate === 'uncited-mechanism-claim')).toEqual([]);
  });

  const fire = (body, opts = {}) => uncitedMechanismClaim(
    `---\nkind: story\nstatus: open\nscope:\n  - we:scripts/pr-land.mjs\n---\n\n# A card\n\n${body}\n`,
    { path: 'backlog/x.md', read, ...opts },
  );

  it('#3341 accepts each of the three citation forms', () => {
    expect(fire('`we:scripts/pr-land.mjs:839` derives the review label.')).toEqual([]);      // path:line
    expect(fire('pr-land derives the label in `computeNetDiffSignals`.')).toEqual([]);        // named function
    expect(fire('pr-land derives the label at line 839.')).toEqual([]);                       // a line number
  });

  it('#3341 does not accept a BARE path as its own citation — that is the archetype', () => {
    // `we:scripts/pr-land.mjs` with no line points at 1200 lines. It is a subject, not evidence.
    expect(fire('`we:scripts/pr-land.mjs` derives the review label from the three-dot file list.')).toHaveLength(1);
  });

  it('#3341 stays out of the shapes it deliberately excludes', () => {
    expect(fire('pr-land is slow and its report line is confusing.')).toEqual([]);            // a STATE claim
    expect(fire('pr-land must derive the label from a local diff.')).toEqual([]);             // a PRESCRIPTION
    expect(fire('pr-land should read the merge-base basis instead.')).toEqual([]);
    expect(fire('If pr-land derives the label from a stale basis, the PR is mislabelled.')).toEqual([]);
    // A COMPLETENESS claim is #3362's species, not this one: a citation is not its remedy.
    expect(fire('Every lander declares its verification posture.')).toEqual([]);
  });

  it('#3341 catches the NEGATED form, including the -es and -ies inflections', () => {
    // The archetype's own second half was a negative claim, and the wrong ones are as costly: a builder
    // greps for the absence, finds it present, and hardens a path that was never soft.
    expect(fire('pr-land does not derive the label from a local diff.')).toHaveLength(1);
    expect(fire('pr-land never reads the merge-base basis.')).toHaveLength(1);
    // `passes`/`queries` de-suffix differently from `parses`; spelled out rather than stripped.
    expect(fire('pr-land does not pass the basis down.')).toHaveLength(1);
    expect(fire('pr-land does not query the label endpoint.')).toHaveLength(1);
    // And a non-verb after the auxiliary is still not a mechanism claim.
    expect(fire('pr-land does not exist on this branch.')).toEqual([]);
  });

  it('#3341 does not fire inside a blockquote — the retraction convention quotes the wrong sentence', () => {
    // Firing here would flag every correctly-retracted card, including #3343 itself.
    expect(fire('The first version said:\n\n> pr-land derives the review label from the three-dot list.\n')).toEqual([]);
    expect(fire('```\npr-land derives the review label from the three-dot list.\n```\n')).toEqual([]);
  });

  it('#3341 treats a fenced quotation of the source as the citation it is', () => {
    expect(fire('pr-land derives the label like this:\n\n```js\nconst signals = local(base, rev);\n```\n')).toEqual([]);
  });

  it('#3341 ignores a module name used attributively rather than as a subject', () => {
    // "multiple dispatch-lane calls" counts calls; it does not claim dispatch-lane calls anything.
    expect(fire('The plan showed multiple pr-land calls that never happened.')).toEqual([]);
  });

  it('#3341 stays silent on a card that names no module of its own', () => {
    expect(fire('The board derives its ordering from nothing in particular.')).toEqual([]);
  });

  it('#3341 emits a subject the default matcher can score on', () => {
    for (const f of uncitedMechanismClaim(PRE_FIX_3343, { path: 'backlog/3343-x.md', read })) {
      expect(f.subject.trim().length).toBeGreaterThanOrEqual(3);
      expect(covers({ ...f }, { path: f.path, line: f.line, summary: f.subject }, 3, 'content')).toBe(true);
    }
  });
});

// ── #3362: state a check's predicate and candidate set; never assert completeness ─────────────────────
// The specimens are the three completeness sentences PR #1609 (#3321) shipped across five rounds, quoted
// on `backlog/3362-…md`. Each round found a real missed caller AND shipped a claim larger than its code:
// the guard improved every round, the claim was false every round. Round 4 is the one that fixes the
// rule's shape — the candidate set had been widened to a `git grep` over the tracked set, but the
// predicate still matched the lander's path spelled without a repo prefix, so widening the candidate set
// while the predicate stayed narrow only moved where the blindness sat.
describe('unqualifiedCompletenessClaim — #3362', () => {
  const fire = (body, path = 'backlog/x.md') => unqualifiedCompletenessClaim(
    `---\nkind: story\nstatus: open\n---\n\n# A card\n\n${body}\n`,
    { path },
  );

  it('#3362 flags each of the three sentences PR #1609 shipped, through runGates', () => {
    const r2 = 'The sweep is fixed: every committed landing invocation declares its verification posture.';
    const r3 = 'After this change no emitter ships a landing invocation that says nothing about verification.';
    const r4 = 'The sweep, not this comment, is now authoritative for the check.';
    for (const s of [r2, r3, r4]) {
      // Through the registry's REAL calling convention — a gate that only works when called directly
      // is a gate that never runs.
      const out = runGates(`---\nkind: story\n---\n\n# A card\n\n${s}\n`, { path: 'backlog/3321-x.md', read: () => null })
        .filter((f) => f.gate === 'unqualified-completeness-claim');
      expect(out, s).toHaveLength(1);
      expect(out[0].subject.trim().length).toBeGreaterThanOrEqual(3);
    }
  });

  it('#3362 PASSES the same claim once it states its scan and its predicate', () => {
    // THE NEGATIVE HALF, and the reason it exists: without it the cheapest way to satisfy this gate is to
    // DELETE the sentence rather than qualify it, which loses the information a reader needs.
    expect(fire('Every committed landing invocation declares its verification posture, across the 213 candidates the sweep scans from a `git grep` over the tracked set.')).toEqual([]);
    expect(fire('No emitter under `scripts/` ships a landing invocation that says nothing about verification.')).toEqual([]);
    expect(fire('The sweep is authoritative for the 213 candidates it scans, matching the lander predicate.')).toEqual([]);
  });

  it('#3362 does not let an ordinary English slash idiom stand in for a real candidate set (#1649)', () => {
    // The old bare-slash alternative in NAMES_CANDIDATE_SET_RX was "one word, a slash, more word
    // characters" — indistinguishable from "and/or", "pass/fail", "his/her", "before/after". Any of
    // those silently exempted a genuine unqualified completeness claim from being flagged at all. Each
    // sentence below is the SAME claim ('#3362 flags each of the three sentences...' establishes it
    // fires with no suffix); the only change is a trailing idiom, and it must still fire.
    for (const tail of ['and/or fails silently.', 'pass/fail either way.', "his/her intent does not matter.", 'before/after the change.']) {
      expect(fire(`Every caller declares its verification posture, ${tail}`), tail).toHaveLength(1);
    }
  });

  it('#3362 stays out of the shapes it deliberately excludes', () => {
    expect(fire('Every card carries a `bornAs` in its frontmatter.')).toEqual([]);       // no verification vocabulary
    expect(fire('Every caller must declare its verification posture.')).toEqual([]);     // a PRESCRIPTION
    expect(fire('Every card has to declare a scope before the check passes.')).toEqual([]);
    expect(fire('If every caller declares its posture, the check passes.')).toEqual([]); // a CONDITIONAL
    expect(fire('Not every caller declares its verification posture.')).toEqual([]);     // already hedged
    expect(fire('All gates are pure functions so the harness can score them.')).toEqual([]); // about the CHECKERS
  });

  it('#3362 does not punish an honest disclaimer that a sweep was NOT done', () => {
    // `we:scripts/operations/__tests__/review-pr.test.mjs` reads "they do NOT prove that every caller
    // passes `--careLevel`". That is this rule being followed; flagging it would make deletion cheaper
    // than qualification, which is the failure the card names.
    expect(fire('These fixtures do not prove that every caller passes the flag the check reads.')).toEqual([]);
  });

  it('#3362 does not fire inside a quotation — the retraction convention reproduces the wrong sentence', () => {
    expect(fire('The first version said: "every committed landing invocation declares its verification posture", which was false.')).toEqual([]);
    // And across a line break, which is how a wrapped quotation actually reaches disk.
    expect(fire('The screen affirmed: *"every committed landing invocation declares\nits verification posture"*, which was false.')).toEqual([]);
    expect(fire('> every committed landing invocation declares its verification posture\n')).toEqual([]);
  });

  it('#3362 treats a list under a colon as the candidate set it is', () => {
    // Same exemption, same reason, as the fenced-block intro #3341 honours: the rows below ARE the scan.
    expect(fire('Every upstream item is still open, verified live:\n\n- `#2249` — open\n- `#2250` — open\n')).toEqual([]);
  });

  it('#3362 leaves an Acceptance section alone, as #3341 leaves Done-when alone', () => {
    // A criterion describes the tree AFTER the work, so a present-tense universal there is a target.
    expect(fire('## Acceptance\n\n- No file is read more than once per `check:standards` pass.\n')).toEqual([]);
    // …and the same sentence in ordinary prose is still a claim.
    expect(fire('No file is read more than once per `check:standards` pass.')).toHaveLength(1);
  });

  it('#3362 reads a SCRIPT DOCBLOCK too — round 4 shipped its sentence in a comment', () => {
    const src = [
      '/**', ' * @file scripts/lib/lane-verify.mjs', ' *',
      ' * The sweep, not this comment, is now authoritative for the check.', ' */',
      'export const x = 1;', '',
      '// every committed landing invocation declares its verification posture.',
    ].join('\n');
    const out = unqualifiedCompletenessClaim(src, { path: 'scripts/lib/lane-verify.mjs' });
    expect(out).toHaveLength(2);
    expect(out[0].line).toBe(4);
    expect(out[1].line).toBe(8);
    // Source that is not a comment is not prose: the identical words in a string literal say nothing.
    expect(unqualifiedCompletenessClaim(
      'const msg = "every committed landing invocation declares its verification posture";\n',
      { path: 'scripts/lib/lane-verify.mjs' },
    )).toEqual([]);
  });

  it('#3362 exempts a RETRACTED comment paragraph, which reproduces the sentence it withdraws', () => {
    const src = [
      '/**', ' * RETRACTED — this block used to read "the sweep is now authoritative for the check".',
      ' * every committed landing invocation declares its verification posture, it said.', ' */',
    ].join('\n');
    expect(unqualifiedCompletenessClaim(src, { path: 'scripts/lib/lane-verify.mjs' })).toEqual([]);
  });

  it('#3362 and #3341 partition the sentence space rather than overlapping it', () => {
    const read = () => 'anything\n';
    const card = (body) => `---\nkind: story\nstatus: open\nscope:\n  - we:scripts/pr-land.mjs\n---\n\n# A card\n\n${body}\n`;
    // A MECHANISM claim is #3341's and only #3341's — a citation is its remedy.
    const mech = runGates(card('pr-land derives the review label from the three-dot file list.'), { path: 'backlog/x.md', read });
    expect(mech.map((f) => f.gate)).toEqual(['uncited-mechanism-claim']);
    // A COMPLETENESS claim is #3362's and only #3362's — a citation is NOT its remedy, because a sentence
    // can cite a real predicate and still overstate its reach, which is exactly what round 4 did.
    const comp = runGates(card('Every committed landing invocation declares its verification posture.'), { path: 'backlog/x.md', read });
    expect(comp.map((f) => f.gate)).toEqual(['unqualified-completeness-claim']);
  });

  it('#3362 emits a subject the default matcher can score on', () => {
    for (const f of fire('Every committed landing invocation declares its verification posture.')) {
      expect(f.subject.trim().length).toBeGreaterThanOrEqual(3);
      expect(covers({ ...f }, { path: f.path, line: f.line, summary: f.subject }, 3, 'content')).toBe(true);
    }
  });
});

describe('covers — the scoring matcher', () => {
  const label = { path: 'backlog/x.md', line: 102, summary: 'criterion 1 claims grepping SKILL.md for `dispatch-lane` returns nothing today' };

  it('CONTENT matches when the gate names the same thing the reviewer described', () => {
    expect(covers({ path: 'backlog/x.md', line: 138, subject: 'dispatch-lane' }, label, 3, 'content')).toBe(true);
  });

  it('CONTENT refuses a gate that fired in the same file for an unrelated reason', () => {
    // This is why file-level scoring was rejected: it counted this as a catch.
    expect(covers({ path: 'backlog/x.md', line: 268, subject: 'scripts/pr-land.mjs' }, label, 3, 'content')).toBe(false);
    expect(covers({ path: 'backlog/x.md', line: 268, subject: 'scripts/pr-land.mjs' }, label, 3, 'file')).toBe(true);
  });

  it('LINE scoring misses a correct gate, because the reviewer\'s own line number is wrong', () => {
    // The gate flags line 138; the reviewer recorded the same defect at 102. Proximity says "miss".
    expect(covers({ path: 'backlog/x.md', line: 138, subject: 'dispatch-lane' }, label, 3, 'line')).toBe(false);
  });

  it('LINE fails CLOSED on a label with no line of its own, instead of degrading into FILE', () => {
    // RETRACTED BEHAVIOUR (#1571 review, the juror's non-blocking `correctness` finding). `line` mode used
    // to `return true` for a label whose own line is null or 0, which made it match ANY hit anywhere in the
    // same file — silently becoming the `file` matcher this file's header calls the worse of the two. It is
    // not a corner case: 5 of the corpus's 39 confirmed labels carry a null or 0 line, and one of them was
    // the whole of `stale-gate-count`'s apparent catch under `--match=line`. Unanswerable is now "no".
    const unlocated = { path: 'backlog/x.md', line: null, summary: 'a totally different defect' };
    expect(covers({ path: 'backlog/x.md', line: 999, subject: 'unrelated' }, unlocated, 3, 'line')).toBe(false);
    expect(covers({ path: 'backlog/x.md', line: 999, subject: 'unrelated' }, { ...unlocated, line: 0 }, 3, 'line')).toBe(false);
    // The contrast that makes the point: `file` still says yes, and `content` still says no for its own reason.
    expect(covers({ path: 'backlog/x.md', line: 999, subject: 'unrelated' }, unlocated, 3, 'file')).toBe(true);
    expect(covers({ path: 'backlog/x.md', line: 999, subject: 'unrelated' }, unlocated, 3, 'content')).toBe(false);
    // And an unlocated label is still matchable under the DEFAULT matcher, which never reads a line at all.
    expect(covers({ path: 'backlog/x.md', line: 999, subject: 'different defect' }, unlocated, 3, 'content')).toBe(true);
  });
});

// ── THE DOCS ARE PART OF THE CONTRACT (#1571 review, `claim-accuracy` x2) ──────────────────────────────────
// Two doc blocks in this pair of files described a shape and a default the code does not have: `gates.mjs`'s
// `Finding` typedef omitted `subject`, the one field the default matcher depends on entirely; and
// `replay-gates.mjs` named FILE-LEVEL as the default while the signature has always read `mode = 'content'`.
// Both are retracted in place. These tests pin the corrected claims to the code, so the next drift reddens
// instead of shipping — the same treatment the `#1569` allowlist-count claim already gets.

describe('every gate emits the `subject` the default matcher scores on', () => {
  // WHY THIS MATTERS MORE THAN IT LOOKS. `covers()` in content mode bails at `subject.length < 3` and
  // returns false. A gate that forgets `subject` therefore scores a structural ZERO against every label in
  // the corpus — no error, no warning, just a gate that appears to catch nothing. The typedef used to
  // document exactly that broken shape.
  const SAMPLES = [
    ['resolved-with-todo', () => resolvedWithTodo('---\nstatus: resolved\n---\n\n## Done when\n\nTODO: fill this in.\n', { path: 'backlog/x.md' })],
    ['stale-gate-count', () => staleGateCount(card('## Done when\n\n1. no new warnings against the 0-error / 1435-warning baseline.\n'), { path: 'backlog/x.md' })],
    ['scope-omits-donewhen-file', () => scopeOmitsDoneWhenFile('---\nscope:\n  - we:skills-src/conveyor/SKILL.md\n---\n\n## Done when\n\n1. a test in `we:skills-src/conveyor/__tests__/runner.test.mjs` asserts it.\n', { path: 'backlog/x.md' })],
    ['citation-line-content', () => citationLineContent('the push it does itself (`we:scripts/pr-land.mjs:5`) calls `realPush` first.', { path: 'backlog/x.md', read: () => `${'x\n'.repeat(20)}function gitPushMain() {}\n${'y\n'.repeat(20)}function realPush() {}\n` })],
    ['uncited-mechanism-claim', () => uncitedMechanismClaim('---\nscope:\n  - we:scripts/pr-land.mjs\n---\n\n# A card\n\npr-land derives the review label from the three-dot file list.\n', { path: 'backlog/x.md', read: () => 'anything\n' })],
    ['unqualified-completeness-claim', () => unqualifiedCompletenessClaim('---\nkind: story\n---\n\n# A card\n\nEvery committed landing invocation declares its verification posture.\n', { path: 'backlog/x.md' })],
  ];

  it.each(SAMPLES)('%s emits a subject of at least 3 characters on every finding', (_name, fire) => {
    const out = fire();
    expect(out.length).toBeGreaterThan(0);
    for (const f of out) {
      expect(typeof f.subject).toBe('string');
      expect(f.subject.trim().length).toBeGreaterThanOrEqual(3);
      expect(covers({ ...f }, { path: f.path, line: f.line, summary: f.subject }, 3, 'content')).toBe(true);
    }
  });

  it('every gate in the registry has a sample above, so an eleventh gate cannot skip this check unnoticed', () => {
    // The other four gates are exercised with `subject` assertions in their own describes higher up; this
    // pins the REGISTRY size, so adding a gate without adding coverage for its subject reddens here.
    expect(GATES).toHaveLength(10);
    expect(GATES.map((g) => g.name)).toEqual([
      'resolved-with-todo', 'stale-gate-count', 'dangling-wikilink', 'dangling-hash-id',
      'grep-literal-mismatch', 'vacuous-executable-criterion', 'scope-omits-donewhen-file',
      'citation-line-content', 'uncited-mechanism-claim', 'unqualified-completeness-claim',
    ]);
  });

  it('the `Finding` typedef documents `subject`, and no longer documents the shape without it', () => {
    const live = GATES_SOURCE.replace(/^ \* RETRACTED[\s\S]*?^ \*\//m, '');
    expect(live).toMatch(/@property \{string\} subject/);
    expect(live).not.toMatch(/\{\{gate:string, path:string, line:number, message:string\}\}/);
  });
});

describe('replay-gates documents the matcher it actually defaults to', () => {
  it('`covers` defaults to content when no mode is passed', () => {
    const label = { path: 'backlog/x.md', line: 102, summary: 'grepping for `dispatch-lane` returns nothing' };
    // Same file, unrelated subject: content says no, file says yes. Omitting the mode must behave as content.
    expect(covers({ path: 'backlog/x.md', line: 268, subject: 'scripts/pr-land.mjs' }, label)).toBe(false);
    expect(covers({ path: 'backlog/x.md', line: 138, subject: 'dispatch-lane' }, label)).toBe(true);
  });

  it('the prose says CONTENT, and the retracted "DEFAULT IS FILE-LEVEL" survives only inside its retraction', () => {
    const live = REPLAY_SOURCE.replace(/^ \* RETRACTED[\s\S]*?(?=^ \*$|^ \*\/)/gm, '');
    expect(live).toMatch(/DEFAULT IS CONTENT/);
    expect(live).not.toMatch(/DEFAULT IS FILE-LEVEL/);
    expect(live).not.toMatch(/the only sound recall measure/);
  });

  it('the Usage block documents `--match`, the flag that selects between the three matchers', () => {
    // It listed `--tol` — which qualifies ONE non-default mode — and omitted `--match` entirely.
    expect(REPLAY_SOURCE).toMatch(/--match=content\|file\|line/);
    expect(REPLAY_SOURCE).toMatch(/ONLY read under --match=line/);
  });

  it('the label caveat is in the FILE, not only on the PR page', () => {
    // #1569 r3 f9 asked for provenance on the labels in the code. It reached the description and stopped.
    expect(REPLAY_SOURCE).toMatch(/unadjudicated self-assessment/);
    expect(REPLAY_SOURCE).toMatch(/never as an absolute catch rate/);
  });
});
