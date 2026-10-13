import { isTerminalStatus } from '../lib/backlog-status.cjs';
/**
 * @file scripts/backlog/epic-resolve.mjs
 * @description The PURE core of epic-resolve-on-last-child (#2752) — the drain-side, session-free pass that
 * closes an umbrella epic the moment its LAST open child story lands, mechanizing what the `/resolve` skill
 * does by hand today. This module holds the DECISION only (no fs, no git, no `Date`): given a just-resolved
 * child's parent edge and the parent epic's own frontmatter signals, it returns one verdict —
 * `skip | escalate | resolve`. `backlog.mjs`'s `resolve-parent` verb wires the fs/splice around it, and
 * `conveyor/pr-watch.mjs` lands the splice on-merge via the sanctioned gated transport. Kept pure and in its
 * own file (mirroring `frontmatter.mjs` / `scaffold.mjs` / `id.mjs`) so the deterministic-core /
 * thin-judgment line the card asks for is unit-tested directly, with zero CLI.
 */

import { readField } from './frontmatter.mjs';

/**
 * The `childlessReason` values that mark an epic as intentionally-childless-but-NOT-done — mirrors
 * `check-standards.mjs` CHILDLESS_REASONS. `blocked` / `untriaged` are a HELD tail: a human must judge whether
 * the epic's full scope is truly delivered, so the on-land pass ESCALATEs rather than auto-closing. (`program`
 * is handled separately — a STANDING epic that never resolves, so it is a silent skip, not an escalation.)
 */
export const EPIC_ESCALATE_REASONS = new Set(['blocked', 'untriaged']);

/**
 * A `blockedBy:` list is present and non-empty? `readField` returns the inline-array text (`["2606"]`) or
 * `[]` / undefined; strip the brackets/quotes/commas/whitespace and test for any surviving id char. A
 * multiline YAML list (value on the following lines) reads as empty here — the backlog uses inline arrays
 * throughout, and a false "no block" only makes the pass MORE conservative on the resolve side (it never
 * wrongly escalates a clean epic; at worst it auto-resolves one whose block it couldn't see — acceptable,
 * the operator's `/resolve` is the backstop). Pure — the card's frontmatter text is passed in.
 * @param {string} content
 * @returns {boolean}
 */
export function hasBlockedBy(content) {
  const raw = readField(content, 'blockedBy');
  return !!raw && raw.replace(/[[\]\s"',]/g, '') !== '';
}

/**
 * PURE — the epic-resolve-on-last-child verdict (#2752). Given the just-resolved child's parent edge and the
 * parent epic's own frontmatter signals, decide ONE of three actions with NO fs / git / clock:
 *
 *   - `skip`     — nothing to do, and nothing a human need see: no `parent` edge, the parent isn't an epic,
 *                  it is already resolved, it is a STANDING program (`ongoing: true` / `childlessReason:
 *                  program`, which never resolves), or it still has open `parent:`-edge children (this was
 *                  NOT the last one).
 *   - `escalate` — the epic's LAST tracked child just landed, but the epic carries a JUDGMENT marker: a live
 *                  `blockedBy` edge, or `childlessReason: blocked|untriaged`. Its remaining scope may be a
 *                  gated/untriaged TAIL that no `parent:` child tracks, so closing it here would silently
 *                  swallow undelivered scope. Surface it for an operator `/resolve` instead — NEVER auto-close.
 *   - `resolve`  — the script-decidable clean close: a plain epic, no judgment marker, every `parent:`-edge
 *                  child resolved. Auto-resolve with `graduatedTo: none` (an epic delivered by its children
 *                  spawns no new entity), exactly the splice the `/resolve` skill runs today.
 *
 * `openChildrenCount` is the SAME no-open-slice signal the #658 guard uses (the `parent:`-edge enumeration) —
 * reused, never reimplemented. Order matters: standing-program and open-children are checked BEFORE the
 * judgment markers, so a program / not-yet-last-child epic is a quiet skip even when it also carries a
 * `blockedBy` — we only escalate a genuine last-child close we decline to auto-make.
 *
 * @param {{
 *   hasParent:boolean, parentFound:boolean, kind?:string, status?:string,
 *   hasBlockedBy?:boolean, childlessReason?:string, ongoing?:boolean, openChildrenCount:number,
 * }} s
 * @returns {{ action:'skip'|'escalate'|'resolve', reason:string }}
 */
export function planEpicResolveOnLand(s) {
  if (!s.hasParent) return { action: 'skip', reason: 'no-parent' };
  if (!s.parentFound) return { action: 'skip', reason: 'parent-missing' };
  if (s.kind !== 'epic') return { action: 'skip', reason: 'parent-not-epic' };
  if (isTerminalStatus(s.status)) return { action: 'skip', reason: `already-${s.status}` };
  if (s.ongoing === true || s.childlessReason === 'program') return { action: 'skip', reason: 'standing-program' };
  if (s.openChildrenCount > 0) return { action: 'skip', reason: 'open-children' };
  // Last child has landed. Everything past here is a candidate to close — gate on the judgment markers.
  if (s.hasBlockedBy) return { action: 'escalate', reason: 'blocked-by' };
  if (s.childlessReason && EPIC_ESCALATE_REASONS.has(s.childlessReason)) return { action: 'escalate', reason: `childless-reason:${s.childlessReason}` };
  return { action: 'resolve', reason: 'all-children-resolved' };
}
