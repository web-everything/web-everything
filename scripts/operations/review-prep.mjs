/**
 * @file scripts/operations/review-prep.mjs
 * @description THE `review-prep` DECLARATION — mechanizing the independent-review-of-preparation pattern
 *   (backlog/xzdi27a-*, under epic #3099), the sibling of `we:scripts/operations/review-pr.mjs` (#3035) for a
 *   BACKLOG CARD instead of a PR diff.
 *
 * ONE DECLARATION, DERIVED CALLERS. Per the statute
 * [#operations-declared-once-callers-generated](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated)
 * (#3031), the operation is declared HERE, once; {@link ./run.mjs} registers it in the CLI's operation table
 * and every flag/usage line is DERIVED from the declaration by {@link ./cli-adapter.mjs} — see that file for
 * why a second, hand-written CLI is the exact defect the statute forbids.
 *
 * ── WHY THIS IS A SEPARATE OPERATION, NOT A TARGET-TYPE FLAG ON `review-pr` (the card's decided fork) ────────
 *
 * `review-pr`'s `read` and `record` are PR-shaped all the way down: `read` composes `assembleReviewDetail` +
 * the NET-diff basis (a card has no diff), and `record` composes `decideSetLabel` + a GitHub label swap (a
 * card has no label — its "verdict" is a review NOTE appended to the file and a commit, the pattern all ten
 * hand-rolled reviews that motivated this operation used). Branching those two steps on a target-type flag
 * would put an if/else through the exact place #3031's statute says stays declared-once-per-shape.
 *
 * ── WHAT DOES COMPOSE, AND AT THE RIGHT SEAM (independent review, 2026-08-14, corrected the card's original
 *    text) ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The juror-spawn machinery (`we:scripts/lib/judge-spawn.mjs`) and #3094's mandate INGREDIENTS are
 * target-agnostic; `buildPanelMandate` (`review-pr.mjs`'s import) is NOT — it is a declared member of
 * `PR_DIFF_ADAPTER`, review-core's own doc calls it "the diff-specific mandate framing", and its output states
 * things that are false of a card ("You see ONLY the diff", a PR-vs-main ground-truth block). The seam this
 * repo already built for exactly this (#2656; `DECISION_PROSE_ADAPTER` and `DESIGN_PIXELS_ADAPTER` are shipped
 * precedents) is `buildSubjectMandate` (`we:scripts/lib/jury-core.mjs`) plus the EXPORTED rule constants —
 * `MUTATION_PROBE_RULE` (unconditional, per the #3094 fork ruling) and `FENCED_DATA_RULE`/`fenceUntrusted` for
 * caller-supplied prose (here: the card's own body, quoted verbatim so the juror can re-verify its claims
 * against live code). {@link buildPrepMandate} below is this operation's adapter over that skeleton — built the
 * same way `buildPanelMandate` is built over it (call the skeleton for the base, then push subject-specific
 * parts, checking for an already-present `FENCED_DATA_RULE` before adding a second copy), with the rule
 * constants ASSERTED VERBATIM via import, never paraphrased (`__tests__/review-prep.test.mjs` pins this with
 * `toContain` on the import).
 *
 * ── THE FOUR STEPS, NO `confirm` (deliberately, per the card) ──────────────────────────────────────────────
 *
 *   | step     | kind      | the implementation behind it                                                       |
 *   |----------|-----------|--------------------------------------------------------------------------------------|
 *   | `read`   | `compute` | `readPrep` (`we:scripts/operations/review-prep-io.mjs`) — frontmatter + body + scope |
 *   | `judge`  | `judge`   | `buildPrepMandate` (below), on `buildSubjectMandate` — DECLARED, never spawned here   |
 *   | `reduce` | `compute` | pulls `confidence` + named `risks` + `corrections` DIRECTLY off the juror's answer    |
 *   | `record` | `effect`  | `recordPrepVerdict` (`review-prep-io.mjs`) — append, commit, land or park             |
 *
 * NO `confirm` STEP. A prep review's verdict is a note + a commit, not a GitHub label a human gate-self path
 * cares about — if a human stop turns out to be needed once this is used for real, that is its own item,
 * decided from real use, not guessed in here. Because there is no human to ask, the `record` step's mutating
 * effect carries its OWN deterministic abstention instead (the content-hash race guard — see
 * `review-prep-io.mjs`'s header) rather than a question nobody can answer.
 *
 * PURE apart from the injected `readPrep`: no fs, no clock, no process, no network in this file.
 */

import { op } from './registry.mjs';
import { compute, effect as effectStep, judge as judgeStep } from './step-kinds.mjs';
import {
  buildSubjectMandate,
} from '../lib/jury-core.mjs';
import {
  FENCED_DATA_RULE,
  fenceUntrusted,
  MUTATION_PROBE_RULE,
  normalizeFindings,
} from '../lib/review-core.mjs';

/** The operation's stable id. Adapters resolve it by this name. */
export const REVIEW_PREP_OP = 'review-prep';

/**
 * THE #3103 RISK TAXONOMY, closed and named ONCE here — `we:backlog/3103-*.md`'s enum (that card's own script
 * is not yet built, so there is no code seam to import it from; this operation is the first consumer and
 * transcribes the eight rows verbatim, evidence-cited in the source card, rather than inventing a ninth or
 * paraphrasing one). Frozen so a juror's `risks[].risk` is validated against a closed set, never free text.
 */
export const PREP_RISKS = Object.freeze({
  PREMISE: 'premise',
  BLAST_RADIUS: 'blast-radius',
  CONSUMER: 'consumer',
  INTERFACE: 'interface',
  POPULATION: 'population',
  DECORATIVE_GUARD: 'decorative-guard',
  UNMEASURED_IMPACT: 'unmeasured-impact',
  LEGIBILITY: 'legibility',
});

/** The closed risk set, in `we:backlog/3103-*.md`'s table order. */
export const PREP_RISK_SET = Object.freeze(Object.values(PREP_RISKS));

/** Risk → the strategy that removed it, per `we:backlog/3103-*.md`'s own evidence table — named alongside the
 *  risk in the mandate and in the recorded verdict, because "a risk without its remedy is an anxiety" (the
 *  source card's own words). */
export const PREP_RISK_STRATEGY = Object.freeze({
  [PREP_RISKS.PREMISE]: 'test the premise by mutation or reversion prior to implementation',
  [PREP_RISKS.BLAST_RADIUS]: 'measure against the real corpus before wiring',
  [PREP_RISKS.CONSUMER]: 'find consumers TWO ways: ES imports AND subprocess/hook callers',
  [PREP_RISKS.INTERFACE]: 'round-trip test at the seam, written by whoever owns neither half',
  [PREP_RISKS.POPULATION]: 'name the population each threshold guards',
  [PREP_RISKS.DECORATIVE_GUARD]: 'mutate the guarded line; require a NAMED test to redden',
  [PREP_RISKS.UNMEASURED_IMPACT]: 'measure the constraint before sizing',
  [PREP_RISKS.LEGIBILITY]: 'assert the failure SURFACES, not just that it occurs',
});

/** The confidence levels a review states — High/Medium/Low, the same vocabulary every hand-rolled review this
 *  operation mechanizes already used. */
export const CONFIDENCE_LEVELS = Object.freeze({ HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' });
export const CONFIDENCE_LEVEL_SET = Object.freeze(Object.values(CONFIDENCE_LEVELS));

/** The juror's model / effort / budget for a prep review. LITERALS, never sourced from an input field — same
 *  footgun-closing reasoning as `review-pr.mjs`'s `JUDGE_MODEL`/`JUDGE_EFFORT`/`JUDGE_BUDGET_USD`. A card
 *  review reads a whole file plus live repo state via tools, so it gets the same budget a PR review does. */
export const REVIEW_PREP_JUROR_TOOLS = Object.freeze(['Bash', 'Read', 'Grep', 'Glob']);
export const JUDGE_MODEL = 'sonnet';
export const JUDGE_EFFORT = 'high';
/**
 * NO SPEND CEILING (operator ruling, 2026-08-18 — `#xvkjndx`). `null` omits `--max-budget-usd` entirely.
 *
 * The ceiling was never a cost control here; it was a silent TRUNCATION of the review. A tool-bearing juror
 * that hits it is killed mid-run and reports `stop_reason: "tool_use"`, which reads like a crash — so the
 * failure costs a misdiagnosis on top of the lost review. Four measured runs on 2026-08-18 spent $0.6152,
 * $0.6597, $0.6997 and $0.9042; the old inherited default of 0.5 would have killed all four, and between them
 * they found ten defects a green suite and check:standards both missed. A truncated review is worth less than
 * its own price.
 *
 * The bound that remains is `judgeSpawn`'s 10-minute `timeoutMs` kill, which is a bound on RUNAWAY rather than
 * on thoroughness — the right shape for this. Measured wall times were 167-312s, so it is real headroom, not a
 * fig leaf.
 */
export const JUDGE_BUDGET_USD = null;

/** The two effect types `record` declares — see the header for why there is no label-swap analogue. */
export const REVIEW_PREP_EFFECTS = Object.freeze({
  RECORD: 'review-prep.record',
  NOTICE: 'review-prep.notice',
});

/**
 * The JSON Schema the juror's answer is FORCED to satisfy (`--json-schema`, #3028). `confidence` and `risks`
 * are REQUIRED — the corrected card's Task 2 / Done-when 3: the reduction must pull confidence + named risks
 * DIRECTLY off the answer shape, not derive them from a generic findings list (a finding has category/impact,
 * not a 3103 risk name, so deriving one from the other is underdetermined).
 */
export const REVIEW_PREP_JUDGE_SHAPE = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['confidence', 'risks'],
  properties: {
    summary: { type: 'string', description: 'One sentence verdict on the preparation as a whole.' },
    confidence: { type: 'string', enum: [...CONFIDENCE_LEVEL_SET] },
    risks: {
      type: 'array',
      description: 'One entry per we:backlog/3103-*.md risk that APPLIES to this card — omit a risk that does not apply.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['risk', 'addressed'],
        properties: {
          risk: { type: 'string', enum: [...PREP_RISK_SET] },
          addressed: { type: 'boolean', description: 'Does the card already address this risk (true), or is it outstanding (false)?' },
          note: { type: 'string' },
        },
      },
    },
    corrections: {
      type: 'array',
      description: "Concrete corrections this review found the card's own text needs — a short sentence each.",
      items: { type: 'string' },
    },
    findings: {
      type: 'array',
      description: 'Any additional concrete findings outside the risk taxonomy (rare — most defects ARE a named risk).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['summary'],
        properties: {
          summary: { type: 'string' },
          file: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
      },
    },
  },
});

/** @param {*} v @returns {boolean} */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * SHAPE-CHECK one `readPrep` result and turn it into the `read` finding. PURE — separated from the injected
 * read so it is testable without touching `fs`.
 * @param {object} raw - what {@link ./review-prep-io.mjs}'s `readPrep` returns.
 * @param {{item: string, repo: string}} asked - what the run asked for.
 * @returns {object} the `read` finding.
 */
export function shapeReadFinding(raw, { item, repo } = {}) {
  if (!raw || typeof raw !== 'object' || !raw.card || typeof raw.card !== 'object') {
    throw new Error(`review-prep.read: the injected reader returned ${typeof raw}, not a card context object`);
  }
  const { card } = raw;
  const title = String(card.frontmatter?.title || firstHeading(card.body) || '');
  return {
    item: String(item ?? ''),
    repo: String(repo ?? ''),
    path: String(card.path || ''),
    frontmatter: card.frontmatter && typeof card.frontmatter === 'object' ? card.frontmatter : {},
    body: String(card.body || ''),
    title,
    contentHash: String(card.contentHash || ''),
    scopeFiles: Array.isArray(raw.scopeFiles) ? raw.scopeFiles.map(String) : [],
  };
}

/** The card's own H1, used as the mandate's `goal` (what the card is proposing) when frontmatter carries no
 *  `title` field — every backlog card in this repo opens its body with `# <title>`. */
function firstHeading(body) {
  const m = String(body || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

/** The material a juror sees: the card's frontmatter (rendered plainly, not fenced — closed-vocabulary
 *  metadata, not narrative prose) and a pointer to the fenced card body inside the mandate itself. PURE. */
export function renderJudgeInput(read) {
  const fm = read.frontmatter || {};
  const lines = [
    `Backlog item ${read.item} — ${read.title || '(untitled)'}`,
    '',
    '## Frontmatter',
    '',
    `- kind: ${fm.kind ?? '(none)'}`,
    `- size: ${fm.size ?? '(none)'}`,
    `- status: ${fm.status ?? '(none)'}`,
    `- tags: ${Array.isArray(fm.tags) ? fm.tags.join(', ') : '(none)'}`,
    '',
    `## Declared scope (${read.scopeFiles.length})`,
    '',
    read.scopeFiles.length ? read.scopeFiles.map((p) => `- ${p}`).join('\n') : '_(none declared)_',
    '',
    'The full card body is quoted in the mandate, inside its own fenced block.',
  ];
  return lines.join('\n');
}

/**
 * Build the prep-card review mandate — this operation's `buildMandate`, built on `buildSubjectMandate` the
 * SAME way `buildPanelMandate` (`review-core.mjs`) is built over it: call the skeleton for the SUBJECT-NEUTRAL
 * base (subject noun, isolation line, the goal block), then push the subject-specific parts, checking for an
 * already-present `FENCED_DATA_RULE` before adding a second copy of the sentence.
 *
 * THE TWO IMPORTED CONSTANTS ASSERTED VERBATIM (never paraphrased — `__tests__/review-prep.test.mjs` pins
 * this with `toContain` on the import itself):
 *   - `FENCED_DATA_RULE` / `fenceUntrusted` — the card's OWN body is caller-authored prose making claims about
 *     the repo, exactly the shape the fence exists for (the same treatment `review-pr.mjs` gives a PR title,
 *     and `buildPanelMandate` gives the caller's `aim`).
 *   - `MUTATION_PROBE_RULE` — UNCONDITIONAL, per the #3094 fork ruling `buildPanelMandate` already applies: a
 *     preparation's design claims are exactly "break this and see if a test catches it" material when the
 *     claim is about existing code behavior (the card's own account of what motivated this operation: most of
 *     the ten hand-rolled reviews' real defects were exactly that shape).
 *
 * @param {{item: string, title?: string, cardBody: string, scopeFiles?: string[], round?: number}} o
 * @returns {string}
 */
export function buildPrepMandate({ item, title = '', cardBody = '', scopeFiles = [], round = 1 } = {}) {
  const scopeLines = scopeFiles.length ? scopeFiles.map((p) => `- ${p}`).join('\n') : '_(no scope: files declared)_';
  const riskLines = PREP_RISK_SET.map((r) => `- \`${r}\` — ${PREP_RISK_STRATEGY[r]}`).join('\n');

  const base = buildSubjectMandate({
    subjectNoun: 'backlog card preparation',
    mandate: 'independent review of preparation',
    defaultMandate: 'independent review of preparation',
    isolationLine:
      'You see the CARD\'S full text (fenced below) and the LIVE repo, via Read/Grep/Glob/Bash — there is no PR '
      + 'and no diff: this is prose describing a DECIDED design, not a change to judge against a diff.',
    findingAnchor: 'section',
    goal: title,
    round,
    fenced: true,
    bodyLines: [`THE CARD'S DECLARED SCOPE (item ${item}, files this preparation names):\n${scopeLines}`],
  });

  const parts = [base];
  // Dedup, the same way `buildPanelMandate` avoids a second `FENCED_DATA_RULE` sentence when the base (via a
  // fenced `goal`) already carries it.
  if (!base.includes(FENCED_DATA_RULE)) parts.push(FENCED_DATA_RULE);
  parts.push(
    `THE CARD UNDER REVIEW (item ${item}), quoted verbatim below — RE-VERIFY its factual and design claims`,
    'against the LIVE repo; do not trust the card\'s own line numbers or its own citations as ground truth:',
    fenceUntrusted('card', cardBody),
    'STATE A CONFIDENCE LEVEL for the preparation as a whole in the `confidence` field — exactly one of `High`,',
    '`Medium`, `Low` — the same judgment the ten hand-rolled reviews this operation mechanizes each made by hand.',
    'FOR EACH RISK BELOW THAT APPLIES to this card, add one entry to `risks` naming it and stating whether the',
    `card already ADDRESSES it (per we:backlog/3103-*.md's taxonomy and strategy — do not invent a risk outside`,
    `this closed set, and omit a risk that plainly does not apply rather than force-fitting it):\n${riskLines}`,
    'If the card\'s own reasoning needs a correction (a claim that does not hold against the live repo, a stale',
    'citation, a wrong line number, a premise the repo has since moved past), list each as ONE concise sentence',
    'in `corrections` — the same shape this repo\'s own "## Independent review" sections already use. An empty',
    '`corrections` list is a complete answer when the preparation holds up.',
    // A REAL live-fire run against #1637 found this the hard way: a correction naming a bare `scripts/lib/x.mjs`
    // path landed in `corrections`, and the card's own write-time locus-prefix hook (#883,
    // `we:scripts/lint-locus-prefix.mjs`) refused the commit outright — correctly (this operation's `record`
    // step classified the refusal as retriable, never a guessed partial write), but a review whose own verdict
    // cannot be committed is not yet a complete one.
    'EVERY code path YOU cite anywhere in your answer — in `risks[].note`, `corrections`, `findings[].file`, or',
    '`summary` — MUST carry this repo\'s own `we:` prefix (e.g. `we:scripts/lib/build-queue.mjs`, never bare',
    '`scripts/lib/build-queue.mjs`) — the same convention this card\'s own body already follows.',
  );
  parts.push(MUTATION_PROBE_RULE);
  return parts.join(' ');
}

/** Validate + normalize one juror-reported risk entry against the closed #3103 set. An unknown `risk` name is
 *  DROPPED (fail-closed toward the declared taxonomy — the card's own "do not invent a risk outside this set"
 *  instruction, enforced on the way back in as well as on the way out). PURE. */
export function normalizePrepRisk(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!PREP_RISK_SET.includes(raw.risk)) return null;
  return Object.freeze({
    risk: raw.risk,
    addressed: raw.addressed === true,
    note: typeof raw.note === 'string' ? raw.note : '',
  });
}

/** Normalize a whole `risks` array off a juror's answer. PURE. */
export function normalizePrepRisks(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map(normalizePrepRisk).filter(Boolean);
}

/**
 * Render the appended card section — the concrete post-#3103 format markers the Done-when names: a
 * `## Independent review — <date>` heading, a stated `Confidence:` level, named risks per the #3103 enum, and
 * a corrections list. Modeled on this operation's OWN card's "## Independent review — 2026-08-14" section (the
 * shape #3103's and #3108's review notes also carry). PURE.
 * @param {{date: string, confidence: string, risks?: Array<{risk: string, addressed: boolean, note?: string}>,
 *   corrections?: string[], fixApplied?: boolean, note?: string}} o
 * @returns {string}
 */
export function renderPrepReviewSection({
  date, confidence, risks = [], corrections = [], fixApplied = false, note = '',
} = {}) {
  const lines = [`## Independent review — ${date}`, '', `Confidence: **${confidence}**`, ''];
  if (risks.length) {
    lines.push("**Risks assessed** (per we:backlog/3103-*.md's taxonomy):", '');
    for (const r of risks) {
      const strategy = PREP_RISK_STRATEGY[r.risk] || '';
      const status = r.addressed ? 'addressed' : 'NOT addressed';
      const detail = r.note ? ` — ${r.note}` : '';
      lines.push(`- **${r.risk}** (${status}${strategy ? `; strategy: ${strategy}` : ''})${detail}`);
    }
    lines.push('');
  } else {
    lines.push('**Risks assessed:** none of the we:backlog/3103-*.md risks were flagged as applying.', '');
  }
  lines.push(fixApplied ? '**Corrections applied by this review:**' : '**Corrections recommended:**', '');
  if (corrections.length) {
    for (const c of corrections) lines.push(`- ${c}`);
  } else {
    lines.push('- none — the preparation held up as written.');
  }
  if (isNonEmptyString(note)) lines.push('', note.trim());
  lines.push('', `_Recorded through the declared \`${REVIEW_PREP_OP}\` operation._`);
  return lines.join('\n');
}

/**
 * Was this review CLEAN — no risk left unaddressed, no correction owed, confidence not `Low`? The land/park
 * split mirrors `review-pr`'s label guard in SPIRIT (a clean pass lands itself; anything else is left for a
 * person) without pretending to BE `decideSetLabel` — a card has no `review:human` gate-self concept to
 * import an invariant from, only a policy this operation states plainly. Declared HERE (not in the io shell)
 * so both the `record` step's notice text and `review-prep-io.mjs`'s land/park sink read the SAME decision —
 * io imports this rather than recomputing it, the same one-directional import `review-prep-io.mjs` already
 * has on this module (never the reverse, so the injected-io split stays acyclic). PURE.
 * @param {{confidence: string, risks: Array<{risk: string, addressed: boolean}>, fixApplied: boolean}} o
 */
export function isCleanPrepReview({ confidence, risks = [], fixApplied = false } = {}) {
  if (fixApplied) return false; // a correction was written into the note — a person should see what changed.
  if (confidence === CONFIDENCE_LEVELS.LOW) return false;
  return risks.every((r) => r && r.addressed !== false);
}

/**
 * The operator-facing notice. `we:scripts/lib/review-core.mjs#renderReviewNotice` is PR-shaped (fixed "PR …
 * human review accepted/requested changes" wording, which would misdescribe a mechanized card review as a
 * human one), so this is a small subject-appropriate renderer instead of a forced reuse — the same "compose
 * what genuinely transfers, do not force-fit what doesn't" call the operation's own design fork makes at the
 * mandate seam. PURE.
 */
export function renderPrepNotice({ item, repo, confidence, clean }) {
  const tag = repo ? `${repo}#${item}` : `#${item}`;
  const verb = clean ? 'landed' : 'parked for a person (review:pending)';
  return `Card ${tag} — independent review recorded (confidence ${confidence}), ${verb}.`;
}

/**
 * BUILD THE DECLARATION. `readPrep` is the injected reader (see the header); {@link ./review-prep-io.mjs}
 * supplies the real one and tests supply a stub. Built per call so nothing leaks between registries.
 *
 * @param {{readPrep: (o: {item: string, repo: string}) => object}} deps
 * @returns {object} the frozen declaration from `op()`.
 */
export function reviewPrepOperation({ readPrep } = {}) {
  if (typeof readPrep !== 'function') {
    throw new TypeError(
      'review-prep: needs a `readPrep({item, repo})` reader — the io is INJECTED so the declaration stays '
      + 'testable without `fs`; the real binding is `we:scripts/operations/review-prep-io.mjs`.',
    );
  }

  return op(REVIEW_PREP_OP, {
    input: {
      item: 'string',
      repo: 'string',
      actor: { type: 'string', required: false, default: 'operator' },
      // #3233 — whether `record` may reach `we:scripts/pr-land.mjs`'s GitHub-API leg at all. `record` always
      // commits AND PUSHES regardless of this flag; `land` only gates the PR-open, which is downgraded to
      // push-only on a host with no GitHub credential even when this defaults true (see `review-prep-io.mjs`).
      land: { type: 'boolean', required: false, default: true },
    },
    verdictFrom: 'reduce',

    // ── 1. read ─────────────────────────────────────────────────────────────────────────────────────────────
    read: compute({
      reads: ['input.item', 'input.repo'],
      fn: (view) => shapeReadFinding(
        readPrep({ item: view.input.item, repo: view.input.repo }),
        { item: view.input.item, repo: view.input.repo },
      ),
    }),

    // ── 2. judge ────────────────────────────────────────────────────────────────────────────────────────────
    // DECLARES the tool-bearing juror call; spawns NOTHING (the engine suspends and the caller does the spawn
    // between two `advance` calls). Tool-bearing for the same reason `review-pr.mjs`'s juror is: re-verifying a
    // card's claims against the live repo needs Read/Grep/Glob and the mutation probe needs Bash.
    judge: judgeStep({
      reads: ['findings.read'],
      request: (view) => {
        const read = view.findings.read;
        return {
          mandate: buildPrepMandate({
            item: read.item, title: read.title, cardBody: read.body, scopeFiles: read.scopeFiles,
          }),
          input: renderJudgeInput(read),
          shape: REVIEW_PREP_JUDGE_SHAPE,
          model: JUDGE_MODEL,
          effort: JUDGE_EFFORT,
          budget: JUDGE_BUDGET_USD,
          allowedTools: REVIEW_PREP_JUROR_TOOLS,
        };
      },
    }),

    // ── 3. reduce ───────────────────────────────────────────────────────────────────────────────────────────
    // Pulls `confidence` + named `risks` DIRECTLY off the juror's answer shape — never derived from a generic
    // findings list (the corrected card's Task 2 / Done-when 3).
    reduce: compute({
      reads: ['findings.read', 'findings.judge'],
      fn: (view) => {
        const read = view.findings.read;
        const answer = view.findings.judge && typeof view.findings.judge === 'object' ? view.findings.judge : {};
        const confidence = CONFIDENCE_LEVEL_SET.includes(answer.confidence) ? answer.confidence : CONFIDENCE_LEVELS.LOW;
        const risks = normalizePrepRisks(answer.risks);
        const corrections = Array.isArray(answer.corrections)
          ? answer.corrections.map(String).map((s) => s.trim()).filter(Boolean)
          : [];
        const findings = normalizeFindings(answer.findings);
        return {
          item: read.item,
          repo: read.repo,
          contentHash: read.contentHash,
          confidence,
          risks,
          corrections,
          fixApplied: corrections.length > 0,
          findings,
          summary: String(answer.summary || ''),
        };
      },
    }),

    // ── 4. record ───────────────────────────────────────────────────────────────────────────────────────────
    // DECLARES two effects and applies neither. The race guard against a concurrently-edited card lives in the
    // IO SINK (`recordPrepVerdict`, `review-prep-io.mjs`), which re-reads the live file at apply time and
    // compares against `expectedContentHash` captured here at `read` time — see that file's header for why the
    // guard cannot live in this pure declaration (it needs a live re-read, which is io).
    record: effectStep({
      // 'input.land' MUST be here (#3233) — `projectReads` (`we:scripts/operations/engine.mjs`) projects only
      // DECLARED reads, so without this entry `view.input.land` below is `undefined` for every run, new ones
      // included, and the `?? true` coalesce could never observe a real `false`.
      reads: ['input.item', 'input.repo', 'input.actor', 'input.land', 'verdict', 'findings.read'],
      effects: (view) => {
        const v = view.verdict || {};
        const read = view.findings.read;
        const item = view.input.item;
        const repo = view.input.repo;
        const actor = view.input.actor;
        // `?? true`, not a bare read (#3233): a run record suspended before this change stored a payload with
        // no `land` key at all — `validateInput` (where the declared default applies) runs only at `startRun`
        // and is never re-applied on resume, so an old record's `view.input.land` is `undefined`, not `true`.
        const land = view.input.land ?? true;
        const clean = isCleanPrepReview({ confidence: v.confidence, risks: v.risks, fixApplied: v.fixApplied });
        return [
          // 0 — THE REVIEW ITSELF: append, commit, always push, land or push-only. NON-idempotent: a replay
          //     must not append a SECOND "## Independent review" section for one verdict — the same "the
          //     remote write is the one that matters" classification `review-pr.mjs`'s LABEL effect carries.
          {
            type: REVIEW_PREP_EFFECTS.RECORD,
            payload: {
              item,
              repo,
              confidence: v.confidence,
              risks: v.risks,
              corrections: v.corrections,
              fixApplied: v.fixApplied,
              note: v.summary,
              actor,
              land,
              expectedContentHash: read.contentHash,
            },
            idempotent: false,
          },
          // 1 — THE EVENT: the operator-facing notice, reported unconditionally (TRUE — a duplicate line on
          //     replay costs nothing and nothing reads it back).
          {
            type: REVIEW_PREP_EFFECTS.NOTICE,
            payload: { notice: renderPrepNotice({ item, repo, confidence: v.confidence, clean }) },
            idempotent: true,
          },
        ];
      },
    }),
  });
}
