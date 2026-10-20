import { readLivePrContext, readPinnedPrContext } from './lib/review-pr-snapshot.mjs';
/**
 * review-detail.mjs — assemble a PARKED PR's review context as one JSON object (#2470, increment 1 of 2).
 *
 * READ-ONLY. A single `gh pr view` gathers a PR's body/labels/comments/files; the PURE `assembleReviewDetail`
 * distills them into the stable contract the Plateau Loop review console (the plateau dev-panel) shells and
 * renders — the escalation reason the drain stamped, the drain's advisory AI-review comment, any prior human
 * verdict comment, the derived review disposition, the diff stat, and the review-class labels. Single-sourced
 * in WE (Native-First / zero standard-impl here — this is a definition + read tool, not product code) so the
 * console never re-implements how a park is read.
 *
 * Split mirrors the daemon's lib/shell split (and `we:scripts/lane-review.mjs`): a PURE assembler that takes an
 * already-parsed `gh pr view … --json` object and returns the contract, plus a thin impure CLI that does the one
 * `gh` call and prints. The assembler REUSES `we:scripts/lib/review-escalation.mjs`
 * (`ESCALATION_REASON_MARKER`, `REVIEW_LABELS`, `hasReviewLabel`) and `we:scripts/lib/review-core.mjs`
 * (`deriveReviewDisposition`) — it never re-hardcodes those markers/labels/logic.
 *
 * #2447 — the contract also carries `resolutionBasis`: a backlog-only PR that resolves its item via `graduatedTo`
 * (the deliverable already landed earlier) is otherwise indistinguishable from a hollow resolve on a console that
 * shows labels + a diff stat. Derived by `deriveResolutionBasis` (`we:scripts/lib/review-render.mjs`) from the
 * lane manifest in the body, the resolve frontmatter (when a `diff` text rides the view), or the body's own
 * `graduatedTo:` note; the text output prints its banner right under the title.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ESCALATION_REASON_MARKER, REVIEW_LABELS, hasReviewLabel } from './lib/review-escalation.mjs';
import { deriveReviewDisposition, careLevelFromReasons } from './lib/review-core.mjs';
import { deriveResolutionBasis, renderResolutionBasisBanner } from './lib/review-render.mjs';
import { extractManifestFromBody } from './readiness/lane-manifest.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';

/** The drain's advisory AI-review comment marker (the body the drain posts on an agent-review park). */
const ADVISORY_MARKER = '🤖 advisory AI review';
/** A prior human-verdict comment starts with one of these (accept ✅ / bounce-back 🔁). */
const HUMAN_MARKERS = ['✅ human review', '🔁 human review'];

/**
 * Parse the body's `## Escalation reason` block (#2324) — the lines AFTER the `ESCALATION_REASON_MARKER` line
 * up to the first non-bullet line (a `##` heading included — see below) or end-of-body. Each reason is a
 * `- <reason>` bullet (from `we:scripts/lib/review-escalation.mjs`'s `buildEscalationReasonBlock`, which
 * guarantees the block's body is BULLETS ONLY between the marker and whatever follows); the leading bullet
 * marker is stripped so the returned strings are the bare decorated reasons `deriveReviewDisposition`
 * canonicalizes. Pure. Returns `[]` when the body is absent or carries no such block (an unparked PR).
 * Tolerant of a missing body.
 *
 * #3101 — the stop condition matches the block's real GRAMMAR (bullets only): the first non-blank,
 * non-bullet line ends the block. `buildEscalationReasonBlock` unconditionally appends a trailing
 * `<!-- policy-set: … -->` HTML-comment stamp right after the bullets whenever it writes any reasons
 * (`we:scripts/lib/review-escalation.mjs:1565`) — that line is neither blank nor a bullet, so the old loop
 * (which stopped only at the next `##` heading) swallowed it as a bogus extra "reason". Stopping on the
 * first non-blank, non-bullet line generalizes past that ONE known trailing shape (a hardcoded stamp-marker
 * check would only patch this one) and protects against any future trailing content appended after the
 * stamp — this is a load-bearing property, pinned by a dedicated test below (not just the stamp case).
 *
 * A `##` heading is not checked for separately: any line starting with `##` already fails the bullet regex
 * `/^[-*]\s+/`, so it is caught by the bullet check, not an independent condition.
 * @param {string|null|undefined} body
 * @returns {string[]}
 */
export function parseEscalationReason(body) {
  if (typeof body !== 'string') return [];
  const lines = body.split('\n');
  const markerIdx = lines.findIndex((l) => l.trim() === ESCALATION_REASON_MARKER);
  if (markerIdx === -1) return [];
  const out = [];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue; // skip blank lines (incl. the marker's trailing blank)
    if (!/^[-*]\s+/.test(trimmed)) break; // non-bullet content (e.g. a heading or the trailing policy-stamp comment) ends the block
    out.push(trimmed.replace(/^[-*]\s+/, '')); // strip the `- `/`* ` bullet → bare reason
  }
  return out;
}

/** Map a raw `gh` labels array (objects `{name}` or strings) to a plain name array. Pure, tolerant of absent. */
function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean);
}

/**
 * The PURE review-context assembler (#2470). Takes the parsed `gh pr view … --json` object and returns the
 * STABLE contract the Plateau Loop review console depends on. Never throws on a missing field — an unparked PR
 * yields `escalationReason: []`, `disposition: null`, `reviewClass: "none"`.
 * @param {{view: object}} o - `view` is the parsed `gh pr view` JSON (number,title,url,body,labels,comments,files),
 *   optionally with a unified `diff` text (`gh pr diff`) so the resolve frontmatter can source `resolutionBasis`.
 * @returns {{pr:number, repo:string, title:string, url:string, labels:string[], humanRequired:boolean,
 *   reviewClass:('human'|'pending'|'none'), disposition:(object|null), escalationReason:string[],
 *   careLevel:('none'|'low'|'elevated'|'high'), advisoryComment:(string|null), humanComment:(string|null),
 *   advisoryCommentAt:(string|null), humanCommentAt:(string|null),
 *   diffStat:Array<{path:string, additions:number, deletions:number}>, filesChanged:number,
 *   resolutionBasis:({graduatedTo:string, ref:string, isCommit:boolean, source:string}|null)}}
 */
export function assembleReviewDetail({ view } = {}) {
  const v = view || {};
  const labels = labelNames(v.labels);
  const humanRequired = hasReviewLabel(labels, REVIEW_LABELS.human);
  const reviewClass = humanRequired
    ? 'human'
    : hasReviewLabel(labels, REVIEW_LABELS.pending)
      ? 'pending'
      : 'none';

  const escalationReason = parseEscalationReason(v.body);
  // Disposition is derivable ONLY from a non-empty escalation block; deriveReviewDisposition throws on an
  // empty/unknown reason set, so guard both — an unparked PR (or one whose reasons don't canonicalize) → null.
  let disposition = null;
  if (escalationReason.length) {
    try { disposition = deriveReviewDisposition({ reasons: escalationReason }); }
    catch { disposition = null; }
  }

  const comments = Array.isArray(v.comments) ? v.comments : [];
  const bodyOf = (c) => (c && typeof c.body === 'string' ? c.body : '');
  // Returns the matched comment itself (not just its body) so the caller can pull `createdAt` alongside `body`
  // without a second scan — `lastMatchingComment(pred).body`/`.createdAt`, `null` when nothing matches.
  const lastMatchingComment = (pred) => {
    for (let i = comments.length - 1; i >= 0; i--) {
      const b = bodyOf(comments[i]);
      if (pred(b)) return comments[i];
    }
    return null;
  };
  const advisoryMatch = lastMatchingComment((b) => b.includes(ADVISORY_MARKER));
  const humanMatch = lastMatchingComment((b) => HUMAN_MARKERS.some((m) => b.trimStart().startsWith(m)));
  const advisoryComment = advisoryMatch ? bodyOf(advisoryMatch) : null;
  const humanComment = humanMatch ? bodyOf(humanMatch) : null;
  // #2818 — the matched comment's `createdAt` (ISO 8601), so a per-item pipeline timeline can place the
  // escalation/review-verdict comment in time. `null` exactly when the matching comment is absent (mirrors the
  // `advisoryComment`/`humanComment` null case), never a fabricated "now".
  const advisoryCommentAt = advisoryMatch && typeof advisoryMatch.createdAt === 'string' ? advisoryMatch.createdAt : null;
  const humanCommentAt = humanMatch && typeof humanMatch.createdAt === 'string' ? humanMatch.createdAt : null;

  const diffStat = (Array.isArray(v.files) ? v.files : []).map((f) => ({
    path: String(f && f.path != null ? f.path : ''),
    additions: Number(f && f.additions) || 0,
    deletions: Number(f && f.deletions) || 0,
  }));

  return {
    pr: Number(v.number) || 0,
    repo: String(v.repo || ''),
    title: String(v.title || ''),
    url: String(v.url || ''),
    labels,
    humanRequired,
    reviewClass,
    disposition,
    escalationReason,
    // #2818 — `careLevelFromReasons` reused unchanged (#2567's bridge): computed here, never re-derived, so a
    // consumer never re-implements the reasons→care-level mapping.
    careLevel: careLevelFromReasons(escalationReason),
    advisoryComment,
    humanComment,
    advisoryCommentAt,
    humanCommentAt,
    diffStat,
    filesChanged: diffStat.length,
    // #2447 — `null` for every PR that is not a backlog-only graduatedTo resolve (the common case).
    resolutionBasis: deriveResolutionBasis({
      manifest: extractManifestFromBody(typeof v.body === 'string' ? v.body : ''),
      diffText: typeof v.diff === 'string' ? v.diff : null,
      body: typeof v.body === 'string' ? v.body : null,
      changedFiles: diffStat.map((f) => f.path).filter(Boolean),
    }),
  };
}

// Allow importing the pure assembler without running the CLI (the test file imports this module) — the standard
// main check used in `we:scripts/lane-review.mjs`.
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) runCli();

/** Explicit heads opt into contextual sharing; an unpinned console read stays live. */
export function readReviewDetailView({ repo, pr, headSha, exec = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), snapshotOptions = {} }) {
  return headSha
    ? readPinnedPrContext({ ...snapshotOptions, repo, pr, headSha, exec })
    : readLivePrContext({ ...snapshotOptions, repo, pr, exec });
}

function runCli() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const repo = (args.find((a) => a.startsWith('--repo=')) || '').slice('--repo='.length);
  const headSha = args.find(a => a.startsWith('--head='))?.slice('--head='.length);
  const pr = args.find((a) => /^\d+$/.test(a));

  if (!pr || !repo) {
    writeAllSync(1, `${JSON.stringify({ error: 'usage: review-detail.mjs <pr> --repo=<owner/name> [--json]' })}\n`);
    process.exit(2);
  }

  let view;
  try {
    view = readReviewDetailView({ repo, pr, headSha });
  } catch (e) {
    const msg = String((e && (e.stderr || e.message)) || e).split('\n').filter(Boolean).pop() || 'gh pr view failed';
    writeAllSync(1, `${JSON.stringify({ error: msg })}\n`);
    process.exit(1);
  }

  // `gh pr view` does not echo the repo back in its JSON — carry the requested one so the contract is complete.
  view.repo = repo;
  const detail = assembleReviewDetail({ view });

  if (asJson) {
    writeAllSync(1, `${JSON.stringify(detail, null, 2)}\n`);
    process.exit(0);
  }

  const lines = [
    `${detail.repo}#${detail.pr} — ${detail.title}`,
    `  ${detail.url}`,
    // #2447 — the resolution basis goes UP FRONT, before labels/files, so a backlog-only diff reads as documented.
    ...(detail.resolutionBasis ? [`  ${renderResolutionBasisBanner(detail.resolutionBasis)}`] : []),
    `  review: ${detail.reviewClass}${detail.humanRequired ? ' (human required)' : ''}  labels: ${detail.labels.join(', ') || '(none)'}`,
    `  disposition: ${detail.disposition ? `${detail.disposition.mode} (autoLand=${detail.disposition.autoLand})` : '(none)'}`,
    `  escalation reason: ${detail.escalationReason.length ? `\n    - ${detail.escalationReason.join('\n    - ')}` : '(none)'}`,
    `  files changed: ${detail.filesChanged}`,
    `  advisory comment: ${detail.advisoryComment ? 'yes' : 'no'}   human comment: ${detail.humanComment ? 'yes' : 'no'}`,
  ];
  writeAllSync(1, `${lines.join('\n')}\n`);
  process.exit(0);
}
