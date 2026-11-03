/**
 * @file scripts/conveyor/health-smells/index.mjs
 * @description #4077 — the smell registry: one file per smell, listed here. A smell is data plus one pure
 * `evaluate(probes, ctx)` returning `[{subject, breach, measure, summary, recommendation}]`:
 *   id, scope (host|repo), cadence (every-tick|gh), probes (the named IO reads the shell must supply — a smell
 *   whose probe did not run this tick is skipped, so its episodes do not move), openAfter/closeAfter
 *   (hysteresis), severity, action (alert|investigate|file), optional `notifyOnOpen: true` (notify even for a
 *   medium opening, still respecting shadow suppression and tracked silences), optional `diagnose` (a read-only command the shell
 *   runs with a hard timeout when an episode opens).
 *
 * DISCOVERED FROM DISK (#3729-style conflict prevention) — every module file in this directory is picked up
 * automatically via `registry-discovery.mjs`; nothing is hand-listed here. Dropping in a new `<id>.mjs` is the
 * whole registration step (no more index-edit merge conflicts when several PRs add a smell in the same window).
 * See `we:scripts/check-standards-rules.mjs#findHandMaintainedRegistryIndex` for the standing guard against this
 * file (or `soak/breaks/index.mjs`) regressing back to a hand-maintained import list.
 *
 * This file itself stays a thin, EAGER entry point (a top-level `await` builds `SMELLS` once, at import time) —
 * the discovery/validation logic lives in `../registry-discovery.mjs` (generic, no eager directory scan) and
 * `../health-smells-shape.mjs` (the smell-specific shape check — deliberately kept OUTSIDE this directory so
 * directory discovery never mistakes it for a smell module), both importable on their own for tests.
 */

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { loadModuleRegistry } from '../registry-discovery.mjs';
import { validateSmellShape } from '../health-smells-shape.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));

export const SMELLS = Object.freeze(await loadModuleRegistry(DIR, validateSmellShape));
