/**
 * @file The PR lifecycle as data (#5052 narrowed; plan slice D of #verdict-ledger-pr-state-store).
 * Pure, no IO. The states ARE the phases of `we:scripts/lib/pr-state-core.mjs` (the evidence-based derivation
 * from #4052), plus ONE added state for the review:human + red-required-check case. This table adds the
 * owner, the allowed next states, the time budget and the label rendering; it never derives anything itself.
 * `derivedFrom` names ledger event kinds and fact fields, never label names (labels are an output).
 */
import { PR_STATE_PHASES } from '../lib/pr-state-core.mjs';

/** The extra state: a human hold plus a red required check. Core reports NEEDS-OPERATOR for it; the lifecycle
 *  gives it its own name and a mechanical owner, because nobody owned this case before 2026-10-04. */
export const HUMAN_HOLD_CI_RED = 'HUMAN-HOLD-CI-RED';

const MIN = 1;
const HOUR = 60 * MIN;
/** @typedef {{state:string, derivedFrom:string[], next:string[], owner:string, maxTimeInState:number|null, renderLabels:string[]}} LifecycleRow */
/** maxTimeInState is minutes, or null for a terminal state. renderLabels is the label set the mirror writes. */
export const LIFECYCLE_STATES = Object.freeze([
  { state: 'WAITING-CI', derivedFrom: ['facts.requiredChecks'], next: ['IN-REVIEW', 'FIXING', 'NEEDS-OPERATOR', 'CLOSED'],
    owner: 'ci-queue-watch', maxTimeInState: 2 * HOUR, renderLabels: [] },
  { state: 'IN-REVIEW', derivedFrom: ['review-run', 'verdict:pending', 'facts.sessions'],
    next: ['READY-TO-MERGE', 'NEEDS-RULING', 'NEEDS-OPERATOR', 'FIXING', 'STUCK', 'CLOSED'],
    owner: 'review-daemon', maxTimeInState: 45 * MIN, renderLabels: ['review:pending'] },
  { state: 'FIXING', derivedFrom: ['verdict:changes', 'send-back', 'facts.sessions'],
    next: ['WAITING-CI', 'IN-REVIEW', 'HANDED-OFF', 'STUCK', 'NEEDS-OPERATOR', 'CLOSED'],
    owner: 'fix-dispatch-daemon', maxTimeInState: 2 * HOUR, renderLabels: ['review:changes'] },
  { state: 'HANDED-OFF', derivedFrom: ['hold', 'facts.handoffs', 'facts.sessions'],
    next: ['WAITING-CI', 'IN-REVIEW', 'FIXING', 'STUCK', 'NEEDS-OPERATOR', 'CLOSED'],
    owner: 'fix-dispatch-daemon', maxTimeInState: 1 * HOUR, renderLabels: ['review:changes'] },
  { state: 'NEEDS-RULING', derivedFrom: ['referral', 'ruling'],
    next: ['FIXING', 'IN-REVIEW', 'READY-TO-MERGE', 'NEEDS-OPERATOR', 'CLOSED'],
    owner: 'operator', maxTimeInState: 24 * HOUR, renderLabels: ['advisory:ruling-needed', 'review:human'] },
  { state: 'NEEDS-OPERATOR', derivedFrom: ['verdict:human', 'hold', 'approval', 'review-run'],
    next: ['READY-TO-MERGE', 'IN-REVIEW', 'FIXING', 'CLOSED'],
    owner: 'operator', maxTimeInState: 24 * HOUR, renderLabels: ['review:human'] },
  { state: HUMAN_HOLD_CI_RED, derivedFrom: ['verdict:human', 'hold', 'facts.requiredChecks'],
    next: ['NEEDS-OPERATOR', 'WAITING-CI', 'FIXING', 'CLOSED'],
    owner: 'ci-red-recovery-watch', maxTimeInState: 2 * HOUR, renderLabels: ['review:human', 'ci:failed'] },
  { state: 'READY-TO-MERGE', derivedFrom: ['verdict:accepted', 'approval', 'facts.requiredChecks'],
    next: ['MERGED', 'IN-REVIEW', 'WAITING-CI', 'NEEDS-OPERATOR', 'CLOSED'],
    owner: 'drain', maxTimeInState: 30 * MIN, renderLabels: ['review:accepted', 'ready-to-merge'] },
  { state: 'STUCK', derivedFrom: ['facts.sessions', 'facts.claim', 'facts.handoffs'],
    next: ['FIXING', 'IN-REVIEW', 'NEEDS-OPERATOR', 'CLOSED'],
    owner: 'stuck-pr-watch', maxTimeInState: 1 * HOUR, renderLabels: ['review:changes'] },
  { state: 'MERGED', derivedFrom: ['facts.state'], next: [], owner: 'drain', maxTimeInState: null, renderLabels: [] },
  { state: 'CLOSED', derivedFrom: ['facts.state'], next: [], owner: 'operator', maxTimeInState: null, renderLabels: [] },
]);

/** Owners that are resident daemons or people, not `pass-daemon` manifest entries. Each resident daemon names its
 *  script, so a test can prove the file exists. A manifest entry is matched by id or by its per-repo family. */
export const RESIDENT_OWNERS = Object.freeze({
  'review-daemon': 'skills-src/conveyor/review-daemon.mjs',
  'fix-dispatch-daemon': 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  drain: 'scripts/merge-ai-prs.mjs',
  operator: null, // a person; nothing to launch
});

const BY_STATE = new Map(LIFECYCLE_STATES.map(row => [row.state, row]));
export const LIFECYCLE_STATE_NAMES = Object.freeze(LIFECYCLE_STATES.map(row => row.state));
/** Core phases that the table must cover (the table is a superset: core plus the one added state). */
export const CORE_PHASES = PR_STATE_PHASES;

/** @returns {LifecycleRow|null} */
export const lifecycleRow = state => BY_STATE.get(state) ?? null;
/** The label set the mirror writes for a state. Pure; unknown state renders nothing. */
export const renderLabels = state => [...(BY_STATE.get(state)?.renderLabels ?? [])];
/** Is `from` -> `to` a declared edge? Staying in place is always allowed. */
export const canTransition = (from, to) => from === to || (BY_STATE.get(from)?.next.includes(to) ?? false);
