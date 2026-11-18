/**
 * @file scripts/operations/gate-health.mjs
 * @description THE `gate-health` DECLARATION — can the merge history answer *"are the review-escalation
 *   criteria selecting the right PRs?"*, and if not, what is blocking it?
 *
 * An OPERATION rather than a script because the question is asked repeatedly, and because the same arithmetic
 * decides whether an A/B variant beat its control. Both steps are `compute`, so `./http-adapter.mjs` derives
 * a `GET`-only surface with no run records — the path `suggest-next` already exercises.
 *
 * Its import graph holds no `node:` specifier and cannot reach `./gate-health-io.mjs`, so the step functions
 * have no writer in scope. `gh` and `git` live in the io module and only read.
 *
 * The statistics are `../lib/gate-health.mjs`. Arithmetic in THIS file is a bug.
 */
import { capableRepoSlugs } from '../lib/constellation-repos.mjs';
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { assessCriteria, classifyFollowUp, SIZE_BANDS } from '../lib/gate-health.mjs';

export const GATE_HEALTH_OP = 'gate-health';

/** The repos this may be asked about — a closed set, refused before a run record exists. */
export const GATE_HEALTH_REPOS = Object.freeze(capableRepoSlugs());

export const DEFAULT_LIMIT = 300;
export const MAX_LIMIT = 1000;

/**
 * Clamp rather than refuse: the declaration vocabulary has `enum` but no numeric range, and refusing inside
 * the first step means refusing after a run record exists. Both values are reported, because here the sample
 * size IS the result's credibility — silently serving 300 to a caller who asked for 1000 would let an
 * underpowered verdict read as a real one.
 */
export function clampLimit(requested) {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 10), MAX_LIMIT);
}

/**
 * Shape the injected read into the `history` finding.
 *
 * Refuses an unknown shape rather than assessing an empty history: otherwise a broken reader and a genuinely
 * empty result produce the same "no signal" verdict, and the first reads as the second.
 */
export function shapeHistoryFinding(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.records)) {
    throw new Error('gate-health.history: the injected reader must return `{ records: [...] }`');
  }
  if (!Number.isFinite(Number(raw.nowSec)) || Number(raw.nowSec) <= 0) {
    // Without a clock the censoring precondition cannot run, and skipping it would silently restore the bias
    // it exists to catch.
    throw new Error('gate-health.history: the injected reader must return `nowSec` — censoring cannot be assessed without it');
  }
  return {
    repo: String(raw.repo ?? 'unknown'),
    nowSec: Number(raw.nowSec),
    records: raw.records,
    measured: raw.records.length,
    // A PR is unmeasurable when its merge commit is outside the log window or every file it touched is
    // high-churn. Reported, never silently dropped — a caller must tell a small sample from a large one that
    // mostly failed to measure.
    unmeasurable: Number(raw.unmeasurable) || 0,
    hotFilesExcluded: Array.isArray(raw.hotFiles) ? raw.hotFiles.length : 0,
  };
}

/**
 * @param {object} deps
 * @param {(o: {limit:number, windowDays:number}) => object} deps.loadHistory - `./gate-health-io.mjs` supplies
 *   the real reader; tests supply fixtures.
 */
export function gateHealthOperation({ loadHistory } = {}) {
  if (typeof loadHistory !== 'function') {
    throw new TypeError('gate-health: needs a `loadHistory()` reader — the io is injected so the declaration stays testable without `gh`');
  }

  return op(GATE_HEALTH_OP, {
    input: {
      repo: { type: 'string', required: false, default: GATE_HEALTH_REPOS[0], enum: [...GATE_HEALTH_REPOS] },
      limit: { type: 'number', required: false, default: DEFAULT_LIMIT },
      windowDays: { type: 'number', required: false, default: 14 },
      // The effect size worth detecting. It drives `requiredNPerGroup`, which is the actionable output when
      // the answer is "not enough data".
      minDetectableDiff: { type: 'number', required: false, default: 0.05 },
    },
    verdictFrom: 'assess',

    history: compute({
      reads: ['input.repo', 'input.limit', 'input.windowDays'],
      // `repo` MUST reach the reader. Validating it in `input` and then not passing it meant a request for
      // another repo was accepted and answered with this one's history.
      fn: (view) => shapeHistoryFinding(loadHistory({
        repo: view.input.repo,
        limit: clampLimit(view.input.limit),
        windowDays: Math.max(1, Math.floor(Number(view.input.windowDays) || 14)),
      })),
    }),

    assess: compute({
      reads: ['input.limit', 'input.windowDays', 'input.minDetectableDiff', 'findings.history'],
      fn: (view) => {
        const h = view.findings.history;
        return {
          repo: h.repo,
          requestedLimit: view.input.limit,
          limit: clampLimit(view.input.limit),
          measured: h.measured,
          unmeasurable: h.unmeasurable,
          hotFilesExcluded: h.hotFilesExcluded,
          bandEdges: SIZE_BANDS.map(([band, minLines]) => ({ band, minLines })),
          ...assessCriteria({
            records: h.records,
            nowSec: h.nowSec,
            windowDays: Math.max(1, Math.floor(Number(view.input.windowDays) || 14)),
            // PASSED THROUGH, NOT SUBSTITUTED (PR #1203 review, finding 3). This line used to read
            // `Number(...) || 0.05`, so a caller's explicit `minDetectableDiff: 0` became 0.05 before
            // `assessCriteria` ever saw it — and the payload then reported `minDetectableDiff: 0.05` and a
            // sample size for a 5-point effect nobody asked for. The library grew a refusal for exactly
            // that input and the refusal was unreachable from here, which made the fix look done while the
            // operator's symptom was unchanged. The schema already supplies the 0.05 default when the field
            // is ABSENT; anything present is the caller's, and `assessCriteria` blocks on it if it cannot
            // be sized.
            mdd: view.input.minDetectableDiff,
            parameterSet: null,
          }),
        };
      },
    }),
  });
}

export { classifyFollowUp };
