/**
 * @file scripts/lib/locus-prefix-text.mjs
 * Locus-prefixing and title building for operator-filed ruling cards. PURE.
 *
 * A bare code-path ref in a card is refused at file time (#883), so a finding summary that quotes one is
 * locus-prefixed here. The detector below is a local copy of the gate's unmarked-locus detector: it is
 * inlined (not imported from check-standards-rules.mjs) because the frequently edited rules file must not enter
 * the review-authorization surface. A parity test (record-referral-ruling-locus-parity.test.mjs) pins this copy to the
 * gate's own `findUnmarkedLocusRefs`.
 *
 * Shared by the ruling-card builder (`record-referral-ruling.mjs`) and by the partial-dedupe retitle
 * (`land-prevention-card.mjs#retitle`) so the title of a reduced card is built by the SAME code as the original.
 */
import { IN_REPO_LOCUS } from './citation-check.mjs';

// Longer/prefix-conflicting extensions first + a no-trailing-letter guard so `blocks.json` matches
// `json` (not `js` + leftover `on`).
const PATHLIKE_RE = /[\w./-]+\.(?:tsx|ts|json|mjs|cjs|js|md|njk|css|html|yaml|yml)(?![a-z])(?::\d+(?:-\d+)?)?/g;
const LOCUS_MARKER_RE = /(?:we|fui|plateau|webeverything|frontierui|plateau-app):$/;
const EXEMPT_FIELD_RE = /^\s*(?:relatedReport|graduatedTo|crossRef|codifiedIn)\s*:/;
// #885 false-positive carve-outs (these are NOT repo code-path references): JS-ecosystem product
// names (`Node.js`/`Next.js`/`Three.js` — a single Capitalized word + `.js`) and bare type-suffix
// fragments (`.d.ts`/`.spec.ts` — an extension chain with no name segment). Glob masks (`*.test.ts`)
// are caught separately by a `*` immediately before the token.
const PRODUCT_JS_RE = /^[A-Z][a-z]+\.js$/;
const TYPE_FRAGMENT_RE = /^\.(?:d|test|spec|stories|sw\.spec)\.[a-z]+$/;

/**
 * PURE CORE, single document. Every unmarked pathlike token in `content`, IN ORDER, WITH duplicates —
 * exactly what the gate's `scanRepoLocusPrefixes` counts.
 */
function scanUnmarkedLocusRefs(content) {
  const noFenced = String(content ?? '').replace(/```[\s\S]*?```/g, '');
  const unmarked = [];
  for (const line of noFenced.split('\n')) {
    if (EXEMPT_FIELD_RE.test(line)) continue;
    for (const m of line.matchAll(PATHLIKE_RE)) {
      const before = line.slice(0, m.index);
      if (LOCUS_MARKER_RE.test(before)) continue;        // already marked (we:/fui:/… or full name)
      if (/\]\($/.test(before)) continue;                // markdown link target — text carries the locus
      if (/@$/.test(before)) continue;                   // @scope/pkg npm specifier (scope sits in the token)
      if (/https?:\/*$/.test(before)) continue;          // URL (the `//…` is consumed into the token)
      if (/\*$/.test(before)) continue;                  // glob mask (`*.test.ts`) — a file-type pattern, not a path
      if (PRODUCT_JS_RE.test(m[0])) continue;            // JS-ecosystem product name (`Node.js`), not a repo file
      if (TYPE_FRAGMENT_RE.test(m[0])) continue;         // bare type-suffix fragment (`.d.ts`), not a path
      unmarked.push(m[0]);
    }
  }
  return unmarked;
}

/** Every DISTINCT unmarked pathlike token the gate would flag in ONE document's content. */
export function findUnmarkedLocusRefs(content) {
  return [...new Set(scanUnmarkedLocusRefs(content))];
}

// The summary is never the start of a line in the final card (it follows `N. \`we:file\` — ` in the digest and
// `we:file:line ` in the title), so scan it behind a neutral lead-in: a summary that itself opens with a
// metadata-field word (`relatedReport: reports/x.md …`) would otherwise be exempt in isolation yet flagged in place.
const EMBED_LEAD = '- ';

/**
 * The refs to prefix come from the gate's OWN detector, never a second approximation of its extensions/delimiters; a
 * ref is prefixed only where it starts a token and is not already `<repo>:`-marked. Position by position: an
 * occurrence is prefixed only if the gate flags THAT occurrence (every other occurrence of the ref is masked first), so
 * link targets, `@scope/pkg`, globs, URLs, fenced code and exempt frontmatter lines stay as written. Idempotent.
 */
export const locusPrefixRefs = (text) => {
  const src = `${EMBED_LEAD}${String(text)}`;
  const at = new Set();
  for (const ref of findUnmarkedLocusRefs(src)) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hits = [...src.matchAll(new RegExp(`(?<!(?:we|fui|plateau|webeverything|frontierui|plateau-app):)(?<![\\w./-])${escaped}(?![a-z])`, 'g'))].map(m => m.index);
    for (const hit of hits) {
      const probe = hits.reduce((s, h) => (h === hit ? s : `${s.slice(0, h)}${'x'.repeat(ref.length)}${s.slice(h + ref.length)}`), src);
      if (findUnmarkedLocusRefs(probe).includes(ref)) at.add(hit);
    }
  }
  return [...at].sort((a, b) => b - a).reduce((s, i) => `${s.slice(0, i)}${IN_REPO_LOCUS}${s.slice(i)}`, src).slice(EMBED_LEAD.length);
};

/**
 * The title of an operator ruling card: `we:<file>[:line] <first finding, ≤90 chars> [(+N more)] (<repo>#<pr>)`.
 * The title is plain text: code-span/fence delimiters are dropped BEFORE the 90-char cut, so the cut can never leave an
 * unmatched fence that pairs with the digest's own fences when the gate scans title + digest together. `claim` may
 * already be locus-prefixed (a digest claim): prefixing is idempotent.
 */
export function rulingCardTitle({ file, line, claim, more = 0, tag, pr }) {
  const where = `${IN_REPO_LOCUS}${String(file ?? '').split('/').pop() || 'no file'}${line == null ? '' : `:${line}`}`;
  const what = locusPrefixRefs(String(claim ?? '').replace(/[`~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90).trim());
  return `${where} ${what}${more > 0 ? ` (+${more} more)` : ''} (${tag}#${pr})`;
}
