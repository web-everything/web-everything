/**
 * @file scripts/operations/explore.mjs
 * @description THE `explore` DECLARATION — the multi-agent committee investigation (#3150, under epic #3029).
 *
 * WHAT IT GENERALIZES. On 2026-08-17 a session ran an ad hoc committee by hand: three `Agent()` calls with
 * distinct briefs, each checking an architecture artifact through a different lens, synthesized by the
 * orchestrating session into a report. That pattern existed only as one session's judgment — no durable run
 * record, no CLI/HTTP/MCP callability, no observability, and unreachable by anyone outside that session. This
 * declares it once; every caller is derived, which is clause 1 of
 * [#operations-declared-once-callers-generated](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated)
 * (#3031).
 *
 * NO FIFTH STEP KIND, AND NO NEW MECHANISM. A committee member is NOT a `judge` step — `judge` is one turn,
 * no tools, not an agent loop, and an investigator needs `WebFetch`/`Read`/`Grep`/`Bash` over many turns. It is
 * structurally the SAME thing {@link ./dispatch-lane.mjs} already dispatches: a full spawned agent session. So
 * this operation reuses that machinery whole — `dispatch: true` + `inFlight({handle})` (#3073), the observer
 * contract and the waker (#3084) — and adds none of its own.
 *
 * ── THE SIX STEPS ───────────────────────────────────────────────────────────────────────────────────────────
 *
 *   | step          | kind      | what it does                                                                |
 *   |---------------|-----------|------------------------------------------------------------------------------|
 *   | `plan`        | `compute` | panel size + one lens per panelist + each panelist's investigation brief      |
 *   | `investigate` | `effect`  | ONE `dispatch: true` effect per panelist — a full agent session each          |
 *   | `synthesize`  | `judge`   | text-in (the N reports) / findings-out; no tools, so `judge` fits cleanly     |
 *   | `reduce`      | `compute` | normalizes the juror's answer into THE VERDICT                               |
 *   | `confirm`     | `confirm` | the human gate before anything is written                                    |
 *   | `file`        | `effect`  | the PARAMETERIZED terminal effect — see {@link TERMINAL_MODES}               |
 *
 * ── WHY THE COMMITTEE INVESTIGATES ONE PANELIST AT A TIME TODAY, AND IT IS NOT HIDDEN ────────────────────────
 *
 * The `investigate` step declares N dispatch effects, one per panelist, so each has its OWN run-record entry,
 * its OWN handle and its OWN in-flight/resolved status — which is what makes a committee observable at all.
 * But {@link ./effect-executor.mjs} guarantees *"effect N+1 is never attempted before N is applied"* and HALTS
 * the moment a sink returns an in-flight marker. So the shipped executor starts panelist 2 only after panelist
 * 1 has resolved: a committee of three investigates SERIALLY, at three times the wall clock of the hand-run
 * pattern this generalizes.
 *
 * That is a real cost and it is NOT worked around here. Every alternative reachable from this file is worse:
 * one effect that spawns N agents has one handle for N sessions (so N-1 are unobservable and uncloseable, the
 * exact degradation `inFlightEntries().unknown` exists to make visible), and a sink returning an ordinary value
 * would record `applied` for work that has not finished, which is the confusion `inFlight` was added to end.
 * Parallel fan-out is a property of the EXECUTOR, not of a declaration, and changing it there is its own item —
 * filed as such rather than smuggled in behind a committee. Blindness between panelists is unaffected either
 * way: no panelist ever reads another's report, so the findings are the same, only later.
 *
 * ── THE LENS SET IS OPEN, DELIBERATELY ──────────────────────────────────────────────────────────────────────
 *
 * {@link DEFAULT_LENSES} is a starting roster, not a vocabulary: `--lenses=` takes any well-formed slug, so a
 * caller can convene a panel on a lens nobody has thought of yet. It is expressly NOT a declared `enum` — the
 * registry would then refuse an unlisted lens, and this operation's second mode (a panel of ONE running a
 * `prior-art-survey`, the research pass `prepare-decision-item` does by hand today) is only the first of those.
 * What IS a closed set is {@link TERMINAL_MODES}, because each mode is a registered effect TYPE with a sink
 * behind it: a mode nothing can apply is a run that dies at its last step.
 *
 * ── IO IS INJECTED, AND THIS FILE REACHES NOTHING ───────────────────────────────────────────────────────────
 *
 * Same split as {@link ./dispatch-lane.mjs} / {@link ./dispatch-lane-io.mjs}: the declaration is the WHAT, and
 * {@link ./explore-io.mjs} is the only place it touches the world. This module's whole static import graph is
 * `./registry.mjs`, `./step-kinds.mjs` and the pure fence leaf `../lib/mandate-fence.mjs` — no `node:`
 * specifier at all, so every step fn holds no writer, no spawner and no clock in lexical scope.
 *
 * PURE. No fs, no clock, no process, no network in this file.
 */

import { op } from './registry.mjs';
import { compute, confirm as confirmStep, effect as effectStep, judge as judgeStep } from './step-kinds.mjs';
import { FENCED_DATA_RULE, fenceUntrusted } from '../lib/mandate-fence.mjs';

/** The operation's stable id. Adapters resolve it by this name. */
export const EXPLORE_OP = 'explore';

/**
 * The effect type ONE panelist's investigation is dispatched under. Both halves of the #3084 contract hang off
 * this string: the SINK that starts the agent and the OBSERVER that later asks how it is going are registered
 * under it in {@link ./explore-io.mjs}, exactly as `dispatch-lane`'s are under its own.
 */
export const INVESTIGATE_EFFECT = 'explore.investigate';

/** The terminal effect that files ONE backlog story from ONE finding. */
export const FILE_STORY_EFFECT = 'explore.file-story';

/** The terminal effect that publishes the synthesis as a `/research/` topic. */
export const PUBLISH_RESEARCH_EFFECT = 'explore.publish-research-topic';

/**
 * How long ONE panelist's investigation is expected to take, in minutes, before "still running" becomes "go
 * look at it". It becomes the in-flight entry's `expectedBy`, which is the only thing separating
 * `inFlightEntries().running` from `.overdue`.
 *
 * 45 rather than `dispatch-lane`'s 90: an investigation reads and reports, where a delivery agent claims,
 * builds, gates, converges and opens a PR. It is an ESTIMATE, never a deadline — nothing kills or re-dispatches
 * an overdue entry (`effect-observer.mjs` is explicit that failing work on a clock alone kills slow-but-healthy
 * work).
 */
export const DEFAULT_EXPECTED_WITHIN_MINUTES = 45;

/** Panel size when the caller names neither `--panel` nor `--lenses`. Three is the hand-run pattern's own size. */
export const DEFAULT_PANEL_SIZE = 3;

/**
 * The largest panel this operation will convene.
 *
 * NOT arbitrary politeness: every panelist is a full `claude` session that costs tokens and holds an in-flight
 * entry a person may have to close out by hand, and the executor serializes them (see the header), so panel
 * size multiplies wall clock as well as spend. A caller who genuinely wants twelve investigators wants several
 * runs, each of which is separately observable and separately abandonable.
 */
export const MAX_PANEL_SIZE = 5;

/**
 * The STARTING roster of investigation lenses — a default, never a vocabulary. See the header: `--lenses=`
 * accepts any well-formed slug, and the second mode this operation is built for (a one-panelist
 * `prior-art-survey`) is already outside this list's original motivating case.
 */
export const DEFAULT_LENSES = Object.freeze(['architecture-audit', 'prior-art-survey', 'risk-and-alternatives']);

/**
 * What a lens name may look like: a lowercase kebab slug. Narrow because the lens is interpolated into the
 * panelist's mandate in INSTRUCTION position (it names the job, so it cannot be fenced as data) — an
 * allowlisted slug is what makes that safe without a fence.
 */
export const LENS_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * How much of ONE panelist's report is handed to the synthesizing juror, in characters.
 *
 * A cap rather than the whole file: a `judge` step's `input` is one string and a runaway panelist (a shell
 * transcript pasted into its report) would otherwise blow the juror's context and take the synthesis down with
 * it. Truncation is ANNOUNCED in the rendered input, so the juror knows it is reading a prefix rather than
 * silently reasoning over a report that stops mid-sentence.
 */
export const REPORT_EXCERPT_CHARS = 24_000;

/**
 * THE PLUGGABLE TERMINAL EFFECTS — what an `explore` run does with its findings once a person has seen them.
 *
 * Story-filing is the operation's LAST STEP, not a second operation, and that is the load-bearing choice: two
 * operations would force findings to be hand-carried between two run records, which is exactly the seam
 * friction #3029 exists to remove. It is also not the ONLY terminal effect — `publish-research` is here from
 * day one so the set is demonstrably plural rather than one special case with a flag beside it.
 *
 * Each mode is `describe(verdict) => descriptors[]`, PURE, returning the same `{type, payload, idempotent}`
 * descriptors any `effect` step returns. A mode that declares ZERO effects is a first-class outcome (the engine
 * resolves an empty list in the same `advance` rather than suspending), which is what makes `report-only` a
 * mode rather than a branch.
 *
 * NULL-PROTOTYPE lookup at the one call site below (`Object.hasOwn`), never a bare bracket read — `TERMINAL_MODES['toString']`
 * on a normal-prototype object returns an INHERITED function that a `typeof … === 'function'` test would accept.
 * Same hazard `resolveOperation` (`we:scripts/operations/run.mjs`) guards against.
 */
export const TERMINAL_MODES = Object.freeze({
  /** Write nothing. The run record and the printed verdict ARE the deliverable. */
  'report-only': Object.freeze({
    effectType: null,
    describe: () => [],
  }),
  /** One backlog story per finding that carried a `suggestedItem`, through the existing scaffold primitive. */
  'file-stories': Object.freeze({
    effectType: FILE_STORY_EFFECT,
    describe: (verdict) => (verdict.filings || []).map((f) => ({
      type: FILE_STORY_EFFECT,
      // NOT IDEMPOTENT, and this is the flag that matters most in this file. `scaffold` allocates a fresh id
      // per call, so re-applying an attempt whose outcome is unknown files a SECOND copy of the same story —
      // an invisible duplicate on the board, which is worse than a stalled run an operator can see.
      idempotent: false,
      payload: {
        title: f.title,
        digest: f.digest,
        size: f.size,
        kind: f.kind,
        parent: f.parent,
        scope: f.scope,
      },
    })),
  }),
  /** One `/research/` topic — the terminal effect the prior-art-survey mode ends on. */
  'publish-research': Object.freeze({
    effectType: PUBLISH_RESEARCH_EFFECT,
    describe: (verdict) => [{
      type: PUBLISH_RESEARCH_EFFECT,
      // IDEMPOTENT: the topic id is derived from the question, and the sink writes two files at that id. Writing
      // the same bytes to the same two paths twice is genuinely harmless, so an indeterminate attempt is
      // recoverable rather than a refusal that needs a person.
      idempotent: true,
      payload: {
        topicId: verdict.topicId,
        title: verdict.question,
        summary: verdict.summary,
        findings: verdict.findings,
        lenses: verdict.lenses,
      },
    }],
  }),
});

/** The terminal mode names, in declaration order. The `terminal` input field's declared value set. */
export const TERMINAL_MODE_NAMES = Object.freeze(Object.keys(TERMINAL_MODES));

/** Resolve a terminal mode by name, refusing an inherited property. */
export function terminalMode(name) {
  const key = String(name ?? '');
  return Object.hasOwn(TERMINAL_MODES, key) ? TERMINAL_MODES[key] : null;
}

/**
 * The panel's lenses, one per panelist. PURE.
 *
 * WHO WINS WHEN BOTH ARE GIVEN: an explicit `--lenses` list sets the panel outright, size included. A caller
 * who names four lenses and `--panel=2` has said two contradictory things, and silently dropping two lenses
 * would convene a committee missing the perspectives its operator asked for; silently ignoring `--panel` would
 * hide that the panel is bigger than requested. So it is REFUSED, and the message names both numbers.
 *
 * WITHOUT `--lenses` the default roster is CYCLED to the requested size, so a panel of five gets
 * `architecture-audit, prior-art-survey, risk-and-alternatives, architecture-audit#2, prior-art-survey#2`. The
 * `#n` suffix is on the panelist's LABEL, never on the lens itself — two panelists genuinely share a lens there,
 * and pretending otherwise (minting a fake lens name) would make the run record lie about what was asked.
 *
 * @param {string} raw - the caller's comma-joined `--lenses`, or `''`.
 * @param {number} panel - the requested panel size.
 * @returns {string[]} exactly `panel` lens names.
 */
export function normalizeLenses(raw, panel) {
  const size = Number(panel);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PANEL_SIZE) {
    throw new Error(
      `explore.plan: \`panel\` must be a whole number from 1 to ${MAX_PANEL_SIZE}, got ${JSON.stringify(panel)}. `
      + 'A bigger committee is several runs, each separately observable — see MAX_PANEL_SIZE.',
    );
  }
  const named = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const lens of named) {
    if (!LENS_RE.test(lens)) {
      throw new Error(
        `explore.plan: ${JSON.stringify(lens)} is not a well-formed lens name — a lowercase kebab slug `
        + '(`architecture-audit`, `prior-art-survey`). The lens set is OPEN, but the name goes into the '
        + 'panelist\'s mandate in instruction position, so its shape is not.',
      );
    }
  }
  if (named.length) {
    if (named.length > MAX_PANEL_SIZE) {
      throw new Error(`explore.plan: ${named.length} lenses named, but a panel is at most ${MAX_PANEL_SIZE}`);
    }
    // Only a caller who ALSO moved `--panel` off its default has said two things; the default is not a request.
    //
    // THE ONE RESIDUAL, stated rather than left to be found (PR review, nit 9): an operator who types the
    // default EXPLICITLY (`--panel=3 --lenses=a-lens,b-lens`) gets a two-panelist committee with no message,
    // because a step fn sees only the validated value and the declaration's input schema has no vocabulary for
    // "supplied" versus "defaulted". Closing it would mean a sentinel default (`0` = unset), which prints
    // `[--panel=<number>, default 0]` in the derived `--help` — a worse line for every caller, to catch one
    // spelling. Every other contradiction is refused below.
    if (size !== DEFAULT_PANEL_SIZE && size !== named.length) {
      throw new Error(
        `explore.plan: --panel=${size} and ${named.length} lens(es) named — those are two different panel sizes. `
        + 'Name the lenses you want and drop --panel, or drop --lenses and let the default roster fill the panel.',
      );
    }
    return named;
  }
  return Array.from({ length: size }, (_, i) => DEFAULT_LENSES[i % DEFAULT_LENSES.length]);
}

/**
 * THE #883 LOCUS-PREFIX RULE, said to an agent whose prose ends up in a committed file.
 *
 * WHY IT IS IN BOTH THE BRIEF AND THE MANDATE (PR review, finding 4). A panelist's report is summarized by the
 * juror, and the juror's `evidence` and `suggestedItem.digest` are written into a backlog card or a
 * `/research/` topic — both of which `we:scripts/check-standards.mjs` scans for bare code-path refs. Left
 * unsaid, the two ends fail in opposite and equally unhelpful ways: a filed card is REFUSED by the guarded
 * writer (and refused identically on every retry), while a published research topic writes fine and reddens
 * the gate for whoever lands next. The io shell gates both at write time; this is the cheaper half of the fix,
 * because a path authored correctly never has to be refused.
 */
export const CODE_PATH_PREFIX_RULE =
  'Whenever you name a file in this repo, prefix it with its repo locus — `we:scripts/foo.mjs`, not '
  + '`scripts/foo.mjs` (`fui:` and `plateau:` for the sibling repos). Your words are summarized into files this '
  + 'repo commits, and its gate refuses an unprefixed path.';

/**
 * ONE PANELIST'S INVESTIGATION BRIEF. PURE, and the whole prompt the dispatched agent is started with apart
 * from the one line naming where to write (which is a mechanical function of the run id and is appended by the
 * sink — see {@link ./explore-io.mjs}).
 *
 * THE QUESTION TRAVELS FENCED. It is operator-supplied free text handed to an agent with tools, so it goes
 * inside the #2438 labelled data fence with {@link FENCED_DATA_RULE} beside it, never in instruction position.
 * That caller text reaches a brief at all is a fact about the source; how much a crafted string could actually
 * steer an investigator is UNMEASURED, so this is hygiene, not a patched hole.
 *
 * BLINDNESS IS INSTRUCTED, not merely arranged. Panelists are told the other reports exist and that they must
 * not read them — a committee whose members converge on each other's wording is one investigator with extra
 * steps, and the whole value of the panel is N genuinely independent passes.
 *
 * @param {object} o
 * @param {string} o.question - the operator's investigation question (untrusted).
 * @param {string} o.lens - this panelist's lens (an allowlisted slug — see {@link LENS_RE}).
 * @param {string} o.panelist - this panelist's label, e.g. `p1`.
 * @param {number} o.panelSize
 * @returns {string}
 */
export function buildPanelistBrief({ question, lens, panelist, panelSize } = {}) {
  const q = String(question ?? '').trim();
  if (!q) throw new Error('explore.plan: refusing to brief an investigator with no question');
  if (!LENS_RE.test(String(lens ?? ''))) {
    throw new Error(`explore.plan: refusing to brief panelist ${panelist} with a malformed lens ${JSON.stringify(lens)}`);
  }
  return [
    `You are panelist ${panelist} of ${panelSize} on a blind investigation committee. Your lens is `
    + `\`${lens}\` — investigate the question below THROUGH THAT LENS and no other.`,
    'Work the question for real: read the code, run the commands, fetch the sources. Ground every claim in '
    + 'something a reader can check — a file and line, a command and its output, a URL. An ungrounded claim is '
    + 'worse than a missing one.',
    'You are BLIND to the other panelists on purpose. Other investigators are working this same question '
    + 'through other lenses right now or shortly. Do not look for their reports, do not read them if you '
    + 'stumble on one, and do not try to reach them. A committee that converges on one member\'s wording is one '
    + 'investigator with extra steps.',
    // BOTH DIRECTIONS, and the second half is the one the first draft left out (PR review r2, should-fix 1).
    // Forbidding READING is not enough: the run record naming every seat's report path sits inside the cwd this
    // panelist was started in, and the agent listing shows a sibling starting. A subverted panelist that can
    // find a neighbour's path can WRITE a report there, and a forged report resolves that seat `succeeded` —
    // manufacturing the cross-lens agreement the synthesis leans hardest on. The io shell's path minting raises
    // the cost of that; this is the instruction that names it as out of bounds.
    'WRITE ONLY to the one path named at the end of this brief, and nowhere else. Do not read this operation\'s '
    + 'run records, do not list or inspect other agent sessions, and do not go looking for any other panelist\'s '
    + 'report path. Writing into another panelist\'s report is forging the committee\'s agreement, which is the '
    + 'one thing that would make this whole exercise worthless.',
    'CHANGE NOTHING. You are investigating, not building: no edits, no commits, no PRs, no backlog mutations. '
    + 'Your report is the entire deliverable.',
    'Report: a short summary, then your findings — each with a title, what you found, why it matters through '
    + 'your lens, and the evidence. Say plainly where you looked and found nothing; a negative result is a '
    + 'finding.',
    // #883, and NOT pedantry: this report is summarized by a juror whose output is written into committed
    // files that the repo gate scans for exactly this. A bare `scripts/foo.mjs` in a report becomes a bare
    // path in a filed digest or a published research topic, which is a refused write or a red gate for
    // whoever lands next. Cheapest to fix where the text is authored.
    CODE_PATH_PREFIX_RULE,
    FENCED_DATA_RULE,
    fenceUntrusted('task', q),
  ].join('\n\n');
}

/**
 * THE SYNTHESIS MANDATE — the juror that reduces N independent reports to one findings list. PURE.
 *
 * A `judge` step fits this cleanly and a fifth kind is not needed: synthesis is text-in / findings-out, one
 * turn, no tools. The juror never investigates — it is explicitly told it may not add a finding no panelist
 * reported, because a synthesizer that reasons past its inputs launders its own guesses as committee output.
 *
 * @param {object} o
 * @param {string} o.question - untrusted; fenced.
 * @param {string[]} o.lenses - allowlisted slugs, so they may name the panel in instruction position.
 * @param {boolean} o.filing - whether this run's terminal effect will file items from the findings.
 * @returns {string}
 */
export function buildSynthesisMandate({ question, lenses = [], filing = false } = {}) {
  return [
    `You are synthesizing a ${lenses.length}-panelist blind investigation committee. The panel ran these `
    + `lenses: ${lenses.join(', ')}. Each report below was written independently; no panelist saw another's.`,
    'Reduce them to ONE findings list. Merge findings the panel agrees on into a single entry and name who '
    + 'agreed (`agreedBy`) — agreement across independent lenses is the strongest signal this shape produces. '
    + 'Keep a lone panelist\'s finding when it is real, and mark its confidence accordingly.',
    'CONTRADICTIONS ARE FINDINGS. When two panelists disagree, say so as its own finding of kind '
    + '`contradiction` rather than picking a side — the disagreement is the thing a reader needs.',
    'ADD NOTHING THE PANEL DID NOT REPORT. You have no tools and did not investigate; a finding you reason '
    + 'your way to is your guess wearing the committee\'s name. If the reports do not support a conclusion, the '
    + 'honest answer is a shorter list.',
    filing
      ? 'This run FILES backlog items from your findings. Give a `suggestedItem` to each finding that names '
        + 'real, self-contained work — and to no other. A finding that is an observation, a contradiction to '
        + 'resolve, or a confirmation that nothing is wrong must NOT carry one.'
      : 'This run files nothing; it produces a report. Give a `suggestedItem` only where the work is genuinely '
        + 'self-contained, so a later run can file it without re-deciding.',
    CODE_PATH_PREFIX_RULE,
    FENCED_DATA_RULE,
    fenceUntrusted('task', String(question ?? '')),
  ].join('\n\n');
}

/**
 * The JSON Schema the synthesizing juror's answer is FORCED to satisfy (`--json-schema`, #3028). Its
 * `suggestedItem` fields are the ones `we:scripts/backlog.mjs scaffold` actually takes, so a finding flows into
 * the filing effect with no adapter layer in between.
 */
export const SYNTHESIS_SHAPE = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'kind', 'confidence'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          kind: { type: 'string', enum: ['gap', 'risk', 'opportunity', 'confirmation', 'contradiction'] },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          agreedBy: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'string' } },
          suggestedItem: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'digest', 'size'],
            properties: {
              title: { type: 'string' },
              digest: { type: 'string' },
              size: { type: 'number' },
              kind: { type: 'string', enum: ['story', 'task', 'decision'] },
            },
          },
        },
      },
    },
  },
});

/**
 * Collapse every whitespace run to one space. PURE.
 *
 * NOT COSMETIC. A juror-authored title and digest are spliced into a backlog file by
 * `we:scripts/backlog/scaffold.mjs#renderItem` — the title into a `# ` heading and the digest into the lead
 * paragraph — and a newline inside either would break the file's structure (a heading that ends mid-sentence,
 * a digest whose second line reads as body). Structured output is not free of newlines: a juror asked for a
 * paragraph will write one.
 *
 * @param {*} text
 * @returns {string}
 */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** The finding kinds that may carry a `suggestedItem` at all — see {@link buildSynthesisMandate}. */
export const FILEABLE_KINDS = Object.freeze(['gap', 'risk', 'opportunity']);

/** Backlog sizes a filed story may claim. Outside this, the finding is reported and NOT filed. */
export const FILEABLE_SIZES = Object.freeze([1, 2, 3, 5, 8]);

/**
 * A `/research/` topic id from the question. PURE and deterministic, which is what makes the publish effect
 * idempotent: the same question always names the same two files.
 * @param {string} question
 * @returns {string}
 */
export function topicIdFor(question) {
  const slug = String(question ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  if (!slug) throw new Error('explore: the question yields no research-topic id — it has no alphanumeric content');
  return slug;
}

/**
 * SHAPE the `investigate` step's finding into the panel reports the synthesis judges. PURE.
 *
 * WHERE THE REPORTS COME FROM. An `effect` step's finding (#3082) is `{applied, effects:[{type, status, result,
 * error}]}`, and `result` is what the OBSERVER recorded when it resolved the entry — for this operation, the
 * panelist's report text read off disk (`we:scripts/operations/explore-io.mjs`). So the reports reach the pure
 * half as DATA on the run record, and the judge step needs no io of its own.
 *
 * IT REFUSES A PANEL THAT PRODUCED NOTHING. A synthesis over zero reports is a juror inventing a committee's
 * output, which is the one thing {@link buildSynthesisMandate} forbids; better to fail at the step than to
 * record a confident verdict grounded in nothing.
 *
 * IT DOES NOT REFUSE A PARTIAL PANEL, and says so on the finding. A panelist whose dispatch was closed out by
 * hand (`wake --resolve`) contributes no report, and a two-of-three synthesis is a real, useful answer as long
 * as the reader knows it was two of three. `missing` rides the finding to the verdict for exactly that.
 *
 * @param {object} finding - the `investigate` step's effect finding.
 * @param {Array<{panelist: string, lens: string}>} panel - what `plan` asked for, in declared order.
 * @returns {{reports: object[], missing: object[]}}
 */
export function shapePanelReports(finding, panel = []) {
  const entries = Array.isArray(finding?.effects) ? finding.effects : [];
  const reports = [];
  const missing = [];
  panel.forEach((seat, i) => {
    const entry = entries[i] || null;
    const text = String(entry?.result?.report ?? '').trim();
    if (!text) {
      missing.push({
        panelist: seat.panelist,
        lens: seat.lens,
        status: entry?.status ?? 'never-declared',
        // The observer's own words when it had any — an operator reading a thin synthesis needs to know WHY.
        reason: String(entry?.error ?? entry?.result?.note ?? 'no report was recorded for this panelist'),
      });
      return;
    }
    reports.push({
      panelist: seat.panelist,
      lens: seat.lens,
      reportPath: String(entry?.result?.reportPath ?? ''),
      report: text,
    });
  });
  if (!reports.length) {
    throw new Error(
      'explore.synthesize: not one panelist produced a report, so there is nothing to synthesize. '
      + `Panel: ${missing.map((m) => `${m.panelist}/${m.lens} (${m.status}: ${m.reason})`).join('; ')}. `
      + 'Check the dispatched sessions, then close their entries out — a synthesis over zero reports would be '
      + 'the juror inventing the committee\'s output.',
    );
  }
  return { reports, missing };
}

/**
 * RENDER the panel's reports as the synthesizing juror's `input`. PURE.
 *
 * Every report is FENCED: it is prose written by an agent that just read untrusted material (issues, web pages,
 * third-party code), so it is exactly the "untrusted prose about untrusted material" case #2438 exists for.
 * Truncation is announced inline rather than silent — see {@link REPORT_EXCERPT_CHARS}.
 *
 * @param {{reports: object[], missing: object[]}} panel
 * @returns {string}
 */
export function renderSynthesisInput({ reports = [], missing = [] } = {}) {
  const blocks = reports.map((r) => {
    const full = String(r.report);
    const excerpt = full.length > REPORT_EXCERPT_CHARS
      ? `${full.slice(0, REPORT_EXCERPT_CHARS)}\n\n[…truncated at ${REPORT_EXCERPT_CHARS} characters of ${full.length}]`
      : full;
    return `${r.panelist} — lens \`${r.lens}\`:\n${fenceUntrusted('findings', excerpt)}`;
  });
  const gaps = missing.length
    ? [`${missing.length} panelist(s) filed no report and are NOT represented below: `
      + `${missing.map((m) => `${m.panelist}/${m.lens}`).join(', ')}. Synthesize the reports you have and say `
      + 'in your summary that the panel was partial.']
    : [];
  return [...gaps, ...blocks].join('\n\n');
}

/**
 * BUILD THE DECLARATION. Built per call so nothing leaks between registries.
 *
 * Unlike `review-pr` / `dispatch-lane` / `claim`, this declaration is injected with NO reader: every input it
 * needs is a declared input field, and the panel's reports arrive on the run record as the `investigate` step's
 * own finding. So there is no `read` step and no `deps` — the io in this operation is entirely in its SINKS and
 * its OBSERVER, which is where the work that outlives the run actually lives.
 *
 * @returns {object} the frozen declaration from `op()`.
 */
export function exploreOperation() {
  return op(EXPLORE_OP, {
    input: {
      /** What the committee investigates. Free text; travels fenced into every brief. */
      question: 'string',
      /**
       * Panel size. ITS BOUND IS ENFORCED IN `plan`, NOT HERE, and unlike `terminal` below that is a
       * limitation rather than a choice (PR review r2, nit 4): the registry's input vocabulary has `enum` — a
       * closed set — and no numeric RANGE, so `--panel=99` mints a run record and then fails at the first
       * step, where `--terminal=nonsense` is refused before one exists. Spelling the range as
       * `enum: [1,2,3,4,5]` would buy the early refusal and print `--panel=1|2|3|4|5` in `--help`, at the cost
       * of a schema that has to be re-typed whenever MAX_PANEL_SIZE moves. Left as-is deliberately; a range
       * type on the declaration would fix it properly and is a registry change, not this operation's.
       */
      panel: { type: 'number', required: false, default: DEFAULT_PANEL_SIZE },
      /** Comma-joined lens slugs. Empty → the default roster, cycled to `panel`. An OPEN set — see the header. */
      lenses: { type: 'string', required: false, default: '' },
      /**
       * The terminal effect. A DECLARED value set (#3036's `enum`), so `--help` prints the modes, the registry
       * refuses an unknown one before a run record exists, and the HTTP adapter gets the same for free.
       */
      terminal: { type: 'string', required: false, default: 'report-only', enum: [...TERMINAL_MODE_NAMES] },
      /** The parent epic filed stories hang under, when the caller has one. `''` → no `parent:`. */
      parent: { type: 'string', required: false, default: '' },
      /** The `scope:` filed stories carry, comma-joined and repo-qualified. `''` → none. */
      scope: { type: 'string', required: false, default: '' },
      expectedWithinMinutes: { type: 'number', required: false, default: DEFAULT_EXPECTED_WITHIN_MINUTES },
    },
    verdictFrom: 'reduce',

    // ── 1. plan ─────────────────────────────────────────────────────────────────────────────────────────────
    // PANEL SIZE, ONE LENS PER SEAT, AND EACH SEAT'S BRIEF. A fixed default roster today; the card allows this
    // step to become a `judge` call that picks the panel, and nothing downstream would change — the steps below
    // read `findings.plan.panel` and never how it was chosen.
    plan: compute({
      reads: ['input.question', 'input.panel', 'input.lenses', 'input.terminal', 'input.expectedWithinMinutes'],
      fn: (view) => {
        const question = String(view.input.question ?? '').trim();
        if (!question) throw new Error('explore.plan: `question` is empty — refusing to convene a committee to investigate nothing');
        const lenses = normalizeLenses(view.input.lenses, view.input.panel);
        const panelSize = lenses.length;
        const minutes = Number(view.input.expectedWithinMinutes) > 0
          ? Number(view.input.expectedWithinMinutes)
          : DEFAULT_EXPECTED_WITHIN_MINUTES;
        return {
          question,
          lenses,
          panelSize,
          terminal: view.input.terminal,
          expectedWithinMinutes: minutes,
          // The seats, in dispatch order. `panelist` is the LABEL (`p1`), which is also what the sink derives
          // the report path from — one identity, used by the brief, the sink, the observer and the synthesis.
          panel: lenses.map((lens, i) => {
            const panelist = `p${i + 1}`;
            return {
              panelist,
              lens,
              brief: buildPanelistBrief({ question, lens, panelist, panelSize }),
            };
          }),
        };
      },
    }),

    // ── 2. investigate ──────────────────────────────────────────────────────────────────────────────────────
    // ONE `dispatch: true` EFFECT PER PANELIST. Declares the starts and performs none of them; the sink in
    // `we:scripts/operations/explore-io.mjs` is the only thing that spawns. Read the header for why the shipped
    // executor runs these one after another rather than together, and why that is not papered over here.
    investigate: effectStep({
      reads: ['findings.plan'],
      effects: (view) => view.findings.plan.panel.map((seat) => ({
        type: INVESTIGATE_EFFECT,
        // DISPATCH: TRUE — declared BEFORE the sink runs (#3073), so a process killed between starting the
        // agent and hearing its handle back lands in `inFlightEntries().unknown` (visible, closable) rather
        // than in `pending`, where it would look like an ordinary unknown outcome.
        dispatch: true,
        // IDEMPOTENT: FALSE. Re-applying starts a SECOND investigator for the same seat — two agents writing
        // one report path, and a synthesis over whichever won. An attempt whose outcome is unknown must stop
        // and ask a person.
        idempotent: false,
        payload: {
          panelist: seat.panelist,
          lens: seat.lens,
          // The brief verbatim, so a run record read after a restart says exactly what the panelist was told
          // rather than "a brief was built from code that has since changed".
          brief: seat.brief,
          expectedWithinMinutes: view.findings.plan.expectedWithinMinutes,
        },
      })),
    }),

    // ── 3. synthesize ───────────────────────────────────────────────────────────────────────────────────────
    // DECLARES the juror call and makes none: the engine suspends and the caller spawns between two `advance`
    // calls. TOOL-FREE deliberately — no `allowedTools`, so the synthesizer cannot go and check a panelist's
    // claim for itself. That is the point: a synthesizer with tools becomes a fourth investigator whose findings
    // nobody reviewed, and the mandate's "add nothing the panel did not report" would be unenforceable.
    synthesize: judgeStep({
      reads: ['findings.plan', 'findings.investigate'],
      request: (view) => {
        const plan = view.findings.plan;
        const panel = shapePanelReports(view.findings.investigate, plan.panel);
        return {
          mandate: buildSynthesisMandate({
            question: plan.question,
            lenses: plan.lenses,
            filing: terminalMode(plan.terminal)?.effectType != null,
          }),
          input: renderSynthesisInput(panel),
          shape: SYNTHESIS_SHAPE,
          lens: 'committee-synthesis',
        };
      },
    }),

    // ── 4. reduce ───────────────────────────────────────────────────────────────────────────────────────────
    // THE VERDICT. It decides nothing about the investigation — it normalizes the juror's answer into the one
    // shape the confirm question, the terminal effect and every derived caller read, and it is where a
    // `suggestedItem` becomes (or fails to become) a filing.
    reduce: compute({
      reads: ['findings.plan', 'findings.investigate', 'findings.synthesize', 'input.parent', 'input.scope'],
      fn: (view) => {
        const plan = view.findings.plan;
        const answer = view.findings.synthesize && typeof view.findings.synthesize === 'object' ? view.findings.synthesize : {};
        const panel = shapePanelReports(view.findings.investigate, plan.panel);
        const findings = (Array.isArray(answer.findings) ? answer.findings : []).map((f) => ({
          title: String(f?.title ?? '').trim(),
          detail: String(f?.detail ?? '').trim(),
          kind: String(f?.kind ?? ''),
          confidence: String(f?.confidence ?? ''),
          agreedBy: Array.isArray(f?.agreedBy) ? f.agreedBy.map(String) : [],
          evidence: Array.isArray(f?.evidence) ? f.evidence.map(String) : [],
          suggestedItem: f?.suggestedItem && typeof f.suggestedItem === 'object' ? f.suggestedItem : null,
        })).filter((f) => f.title && f.detail);
        const parent = String(view.input.parent ?? '').trim();
        const scope = String(view.input.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        // WHICH FINDINGS BECOME ITEMS, decided HERE and not in the sink. A `suggestedItem` is the juror's
        // proposal; this is the gate on it, and it is pure so the refusals are testable without a filesystem.
        // Two of them are load-bearing:
        //   - a `confirmation`/`contradiction` finding never files, however confident. It is an observation or
        //     a disagreement to resolve, not work — the mandate says so and this enforces it.
        //   - a size outside the repo's own ladder is dropped rather than rounded. `scaffold` would accept any
        //     number, and a story sized 13 by a juror is a story nobody sliced.
        const filings = [];
        const rejected = [];
        for (const f of findings) {
          if (!f.suggestedItem) continue;
          const size = Number(f.suggestedItem.size);
          if (!FILEABLE_KINDS.includes(f.kind)) {
            rejected.push({ title: f.title, reason: `a \`${f.kind}\` finding is not work — it files nothing` });
            continue;
          }
          if (!FILEABLE_SIZES.includes(size)) {
            rejected.push({ title: f.title, reason: `size ${JSON.stringify(f.suggestedItem.size)} is not on the ladder (${FILEABLE_SIZES.join('/')})` });
            continue;
          }
          const title = oneLine(f.suggestedItem.title);
          const digest = oneLine(f.suggestedItem.digest);
          if (!title || !digest) {
            rejected.push({ title: f.title, reason: 'the suggested item has no title or no digest' });
            continue;
          }
          filings.push({
            title,
            digest,
            size,
            kind: ['story', 'task', 'decision'].includes(f.suggestedItem.kind) ? f.suggestedItem.kind : 'story',
            parent: parent || null,
            scope,
          });
        }
        return {
          question: plan.question,
          lenses: plan.lenses,
          terminal: plan.terminal,
          topicId: topicIdFor(plan.question),
          summary: String(answer.summary ?? '').trim(),
          findings,
          filings,
          // WHY A SUGGESTION DID NOT BECOME AN ITEM. On the verdict, where the decision is read — a silently
          // dropped suggestion looks identical to a juror that proposed nothing.
          rejectedFilings: rejected,
          // HOW COMPLETE THE PANEL WAS. A two-of-three synthesis is a real answer; one that does not say it is
          // two-of-three is a misleading one.
          panelSize: plan.panelSize,
          reportsUsed: panel.reports.length,
          missingPanelists: panel.missing,
        };
      },
    }),

    // ── 5. confirm ──────────────────────────────────────────────────────────────────────────────────────────
    // THE STOP POINT, AS MACHINERY. The engine suspends here and records what is asked and of whom.
    //
    // IT IS DECLARED UNCONDITIONALLY, and the card's "confirm (optional) — only if findings are decision-shaped"
    // is answered by what it ASKS rather than by whether it exists. A step that sometimes suspends and sometimes
    // does not is a fifth kind wearing a hat, which #3031 forbids; and `abstain` already gives the operator the
    // zero-effect exit, exactly as it does in `review-pr`. On a `report-only` run the question therefore says so
    // plainly and both answers write nothing — the stop is then a one-key acknowledgement that the operator has
    // SEEN the synthesis, which is the cheapest honest thing an unconditional step can be.
    confirm: confirmStep({
      reads: ['verdict'],
      asks: (view) => {
        const v = view.verdict || {};
        const mode = terminalMode(v.terminal);
        const panel = `${v.reportsUsed}/${v.panelSize} panelists reported; ${(v.findings || []).length} finding(s).`;
        if (!mode || mode.effectType === null) {
          return `${panel} This run is \`${v.terminal}\` and writes NOTHING either way — answer \`proceed\` to `
            + 'complete the run, or `abstain`; both record the same.';
        }
        if (v.terminal === 'file-stories') {
          const n = (v.filings || []).length;
          return `${panel} Answer \`proceed\` to FILE ${n} backlog item(s): `
            + `${(v.filings || []).map((f) => `${f.kind}/${f.size} "${f.title}"`).join('; ') || '(none — nothing will be written)'}`
            + `${(v.rejectedFilings || []).length ? `. ${v.rejectedFilings.length} suggestion(s) were refused: ${v.rejectedFilings.map((r) => `${r.title} — ${r.reason}`).join('; ')}` : ''}`
            + '. Answer `abstain` to write nothing.';
        }
        return `${panel} Answer \`proceed\` to publish the synthesis as the /research/ topic \`${v.topicId}\`, `
          + 'or `abstain` to write nothing.';
      },
      // `operator`, always. Unlike `review-pr` there is no run in which a lesser actor is owed this: every
      // terminal effect writes into the repo's own board or its research surface.
      of: 'operator',
      options: ['proceed', 'abstain'],
    }),

    // ── 6. file ─────────────────────────────────────────────────────────────────────────────────────────────
    // THE PARAMETERIZED TERMINAL EFFECT. One `describe` call into {@link TERMINAL_MODES}; this step contains no
    // per-mode branching of its own, which is what makes "one of several pluggable terminal effects" true rather
    // than aspirational — a fourth mode is one entry in that table and no edit here.
    file: effectStep({
      reads: ['verdict', 'findings.confirm'],
      effects: (view) => {
        // THE NON-WRITING EXIT. The operator looked and chose not to record: zero effects, which the engine
        // resolves in the same `advance` rather than suspending. Same shape as `review-pr`'s `abstain`.
        if (view.findings.confirm === 'abstain') return [];
        const verdict = view.verdict || {};
        const mode = terminalMode(verdict.terminal);
        if (!mode) {
          // Unreachable through the declared `enum`, which refuses an unknown mode before a run exists. Kept
          // as a refusal rather than a fallthrough so a hand-built run record cannot make this step improvise.
          throw new Error(
            `explore.file: unknown terminal mode ${JSON.stringify(verdict.terminal)} `
            + `(known: ${TERMINAL_MODE_NAMES.join(', ')}) — refusing to guess what this run was supposed to write.`,
          );
        }
        return mode.describe(verdict);
      },
    }),
  });
}
