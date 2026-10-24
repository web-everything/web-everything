/**
 * @file breaks/index.mjs — #4075 daemon soak harness (card 4169). THE REGISTRY of real-world daemon breaks,
 * one module per break. Each module exports a default object:
 *
 *   {
 *     id:        'short-kebab-id',
 *     title:     'what broke live, in one line',
 *     card:      'backlog card / PR the fix belongs to',
 *     fixedBy:   { sha: 'abc1234', where: 'main' | 'lane/<branch>' , paths?: ['files the fix changed'] },
 *     fixPresent(root): boolean   — does THIS tree carry the fix? (a source marker the fix added). When false the
 *                                   break's test is EXPECTED-FAIL (it must still fail — see breaks.soak.test.mjs);
 *                                   it flips to a required pass by itself the moment the fix lands.
 *     async run({ log }):  a `runSoak(...)` report — the scenario that reproduces the break,
 *     judge(report): string[]      — the problems that mean "the break happened" ([] = green).
 *   }
 *
 * THE RULE (`we:skills-src/conveyor/SKILL.md`, `we:skills-src/conveyor/fix-agent-brief.md`): every daemon bug fix
 * adds its real-world case here, and shows it RED against the tree before the fix
 * (`node scripts/conveyor/soak/red-green.mjs --break=<id>`) and GREEN with it.
 *
 * DISCOVERED FROM DISK (#3729-style conflict prevention) — every module file in this directory is picked up
 * automatically via `registry-discovery.mjs`; nothing is hand-listed here. That means dropping in a new
 * `<id>.mjs` is the WHOLE registration step (no more index-edit merge conflicts when several PRs add a break in
 * the same window). See `we:scripts/check-standards-rules.mjs#findHandMaintainedRegistryIndex` for the standing
 * guard against this file (or `health-smells/index.mjs`) regressing back to a hand-maintained import list.
 * `codex-unproductive-jumps-to-claude.mjs` is registered through this discovery path as well.
 * `codex-prepare-pr-redispatched-as-unstamped.mjs` uses the same automatic registration.
 * `red-team-finished-result-never-published.mjs` uses the same automatic registration.
 *
 * This file itself stays a thin, EAGER entry point (a top-level `await` builds `BREAKS` once, at import time) —
 * the discovery/validation logic lives in `../registry-discovery.mjs` (generic, no eager directory scan) and
 * `../breaks-shape.mjs` (the break-specific shape check — deliberately kept OUTSIDE this directory so directory
 * discovery never mistakes it for a break module), both importable on their own for tests that need the logic
 * without triggering a real load of every break module in this directory.
 */

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { loadModuleRegistry } from '../../registry-discovery.mjs';
import { validateBreakShape } from '../breaks-shape.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));

export const BREAKS = Object.freeze(await loadModuleRegistry(DIR, validateBreakShape));

export function breakById(id) {
  const b = BREAKS.find((x) => x.id === id);
  if (!b) throw new Error(`soak: no break "${id}" — known: ${BREAKS.map((x) => x.id).join(', ')}`);
  return b;
}
