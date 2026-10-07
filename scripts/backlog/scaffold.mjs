/**
 * @file scripts/backlog/scaffold.mjs
 * @description Pure helpers for allocating a new backlog id and rendering a check:standards-clean
 * item skeleton — the deterministic half of "capture a leftover as its own item" (close-out / batch
 * spin-off). The agent hand-picks the next `NNN` today (`ls backlog | sort | tail`) and hand-writes
 * frontmatter, which is both a tool round-trip and the immutable-NNN collision race. These functions
 * allocate the next free number and emit a skeleton with every field the validator requires, so the
 * agent only fills the digest + body. PURE — the CLI does the globbing and the write.
 */

import { renderEdgeCasesSkeleton } from './edge-case-classes.mjs';

/**
 * Authoring hint emitted in the `## Done when` skeleton (#4409). Pinned verbatim by a test; the
 * guard-relaxation lint (`findGuardRelaxationGaps`) strips this exact line before scanning so a
 * hint left in place can never trigger or satisfy it.
 */
export const GUARD_RELAXATION_HINT =
  'Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.';

/** Zero-pad a number to the repo's 3-digit `NNN` convention (`7` → `"007"`). */
export const pad3 = (n) => String(n).padStart(3, '0');

/**
 * A free `NNN` for a NEW item, as a padded string. #2292 (interim, under #2289) — allocate a RANDOM free
 * number within the EXISTING range (a gap below the max) instead of deterministic max+1, so two lanes
 * branching off the same main rarely pick the same NNN (a low-probability birthday collision over the free
 * gaps) rather than DETERMINISTICALLY colliding on max+1 (the exact race that double-landed #2316 on
 * 2026-07-06). It fills existing gaps rather than creating big new numbers; only when the range is gap-free
 * does it fall back to max+1. `rng` (a [0,1) source, default Math.random) is injected so the choice is
 * unit-testable. INTERIM — superseded by #2288 JIT numbering, which makes a duplicate NNN unrepresentable.
 * @param {string[]} existingNums  Every current item's `num` (e.g. `['001','002','254']`).
 * @param {() => number} rng  a [0,1) random source (default Math.random)
 */
export function nextNum(existingNums, rng = Math.random) {
  const used = new Set(existingNums.map((n) => Number(n) || 0));
  const max = existingNums.reduce((m, n) => Math.max(m, Number(n) || 0), 0);
  const free = [];
  for (let n = 1; n < max; n++) if (!used.has(n)) free.push(n); // gaps strictly below the max
  if (free.length === 0) return pad3(max + 1);                  // gap-free range → deterministic next
  return pad3(free[Math.floor(rng() * free.length)]);
}

/** kebab-case a free-text title into a slug (lowercase, spaces/punct → single dashes). */
export const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Normalize a predicted touch-set into the coarse, prefix-shaped `scope:` the readiness flow authors (#2619)
 * and the conveyor dispatcher reads (`scripts/readiness/dispatch-plan.mjs`, #2609): trim each entry, drop
 * empties, and dedupe while preserving first-seen order. A LOCAL near-mirror of `normScope` in
 * `scripts/readiness/scope-lease.mjs` (same dedupe + drop-empty contract, the same mirroring pattern
 * `normScope` itself uses over `overlap-chain`'s `normFiles`) — kept local so this pure scaffold helper stays
 * dependency-free. ONE intentional divergence: this helper ALSO trims each entry (author-time
 * canonicalization at the write path), whereas `normScope` does not; the two never disagree downstream
 * because what lands in the frontmatter is already trimmed, so `normScope` reads clean values. It
 * deliberately does NOT sort (scope is an unordered set — author order is preserved) and does NOT invent
 * granularity: coarsening a real path down to a prefix is the probe agent's JUDGMENT, authored upstream at
 * readiness, never a mechanical rewrite here.
 * @param {string[]} list  the predicted touch-set (repo-qualified path prefixes / files)
 * @returns {string[]} deduped, trimmed, non-empty entries in first-seen order
 */
export function normalizeScope(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Render a backlog item skeleton. Emits only the fields the validator needs (`kind`, `status`,
 * `size` when a story, `dateOpened`, optional `blockedBy`/`parent`), an H1 title, and a one-line
 * digest placeholder the caller is expected to replace. `check:standards` passes on the skeleton
 * (non-empty digest, valid sizing), but the digest is intentionally a TODO so it reads as unfinished,
 * not as a real summary. `kind ∈ story|epic|task|decision` (the merged #466/#487 axis).
 *
 * @param {{
 *   kind: string, size?: number, slug: string, title: string,
 *   today: string, blockedBy?: string[], parent?: string, digest?: string,
 *   scope?: string[],
 * }} spec
 * @returns {string} the file content
 */
export function renderItem(spec) {
  const { kind, size, title, today, blockedBy = [], parent, digest, scaffoldedBy, scope = [] } = spec;
  const scopeEntries = normalizeScope(scope);
  const fm = ['---', `kind: ${kind}`];
  if (kind === 'story' || (kind === 'epic' && typeof size === 'number')) fm.push(`size: ${size}`);
  if (parent) fm.push(`parent: "${parent}"`);
  // Born-active when a creating session owns it (#670): scaffold --session stamps `scaffoldedBy`, marking
  // the item owned-until-settled so a concurrent batch can't claim a half-authored spin-off (born-public
  // race). It carries NO `dateStarted` (that is the claim signal) — so a born-active item is
  // distinguishable from a claim-active one for the orphan-recovery check. `settle` later flips it → open.
  if (scaffoldedBy) {
    fm.push('status: active', `scaffoldedBy: "${scaffoldedBy}"`, `dateScaffolded: "${today}"`);
  } else {
    fm.push('status: open');
  }
  if (blockedBy.length) fm.push(`blockedBy: [${blockedBy.map((n) => `"${n}"`).join(', ')}]`);
  // Optional predicted touch-set (#x53zzf9 mechanical support; #2619 readiness-flow authoring) — the conveyor
  // dispatcher reads it to hold overlapping items apart. `normalizeScope` dedupes/trims so a repeated or
  // whitespace-padded entry never lands in the frontmatter.
  if (scopeEntries.length) fm.push(`scope: [${scopeEntries.map((p) => `"${p}"`).join(', ')}]`);
  fm.push(`dateOpened: "${today}"`, 'tags: []', '---', '');
  const lead = digest || 'TODO digest — one ≤100-word paragraph: what this item does and why (replace this line).';
  // `## Done when` skeleton (#2949) — acceptance criteria are authored at file time, not left to the
  // implementing lane to invent at review time (docs/agent/backlog-workflow.md → the determinism
  // ladder). Emits one `**Executable**` TODO line; the author fills in a real tier-1 command, or drops
  // to tier-2/3 (or an explicit "why not" line) when no command applies.
  const doneWhen = '## Done when\n\n1. **Executable** — TODO: a command that fails before this item lands and passes after.\n\n'
    + `${GUARD_RELAXATION_HINT}\n\n`
    + 'Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.\n';
  return `${fm.join('\n')}\n# ${title}\n\n${lead}\n\n${doneWhen}\n${renderEdgeCasesSkeleton()}`;
}
