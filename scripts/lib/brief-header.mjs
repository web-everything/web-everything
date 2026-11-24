/** @file Dispatch-hook header lines (Kind, Mode, Step, Prep, Slot, merge-path) for the worker brief. */
import { statSync } from 'node:fs';
import { loadDeliveryRoutes, modeForKind } from './delivery-routes.mjs';
import { readSettingsChecked } from './settings-files.mjs';

// Same pattern the dispatch hook (guard-delivery-mode.mjs) uses to demand the merge-path checklist reference.
const MERGE_PATH = /merge[- ]?gate|merge-ai-prs|red[- ]?team|publication hold|review[- ]?gate|clear-human|waiver|quarantine|forge-exec|uid|enqueue|verdict/i;
const STEP_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLOT = /^(plan:\S+|blocker:\S.*|operator:\S.*|waived — \S.*)$/;
const MAX_PREP_BYTES = 128 * 1024;

/** Mode for a Kind through the shared checked loader (fails closed on taint/duplicates); a blocker slot routes to debug (R852), as the hook does. */
export function routeMode(kind, slot = '', { cfg = loadDeliveryRoutes(readSettingsChecked), daemonDegraded = false } = {}) {
  if (typeof kind !== 'string' || !kind) throw new Error('--kind is required with --step (no default Kind: a wrong one routes the build to the wrong mode).');
  const want = modeForKind(cfg, kind, { daemonDegraded });
  const mode = /\bblocker\b/i.test(slot) && want !== 'debug-to-merge' ? 'debug' : want;
  return { mode, text: cfg.modes[mode] };
}

/** True for an existing regular, non-oversized file. */
export function prepFileOk(path) {
  try { const st = statSync(path); return st.isFile() && st.size <= MAX_PREP_BYTES; } catch { return false; }
}

/** Header lines the dispatch hook demands, with the mode's mandatory rules. '' when no step is given. */
export function renderBriefHeader({ step, kind, slot, prepPath, daemonDegraded, cfg } = {}) {
  if (step === undefined) return '';
  if (typeof step !== 'string' || !STEP_TOKEN.test(step)) throw new Error('--step must be a plan step id (letters, digits, . _ -).');
  if (typeof prepPath !== 'string' || !prepFileOk(prepPath)) throw new Error('--step needs an existing regular prep file (--prep-file, max 128 KiB): refusing to invent a Prep path.');
  if (/[\r\n]/.test(prepPath)) throw new Error('--prep-file must be a single line.');
  const slotText = slot || `plan:${step}`;
  if (!SLOT.test(slotText)) throw new Error('--slot must be plan:<item>, blocker:<what>, operator:<quote> or "waived — <reason>".');
  const { mode, text } = routeMode(kind, slotText, { ...(cfg ? { cfg } : {}), daemonDegraded });
  return `Kind: ${kind}\nMode: ${mode}\nStep: ${step}\nPrep: ${prepPath}\nSlot: ${slotText}\n${text}\n`;
}

/** The merge-path line the hook demands when the brief text matches its merge-path pattern. */
export function renderMergePathLine(text) {
  return MERGE_PATH.test(text) ? 'Merge-path: designs/merge-path-checklist.md. Write a negative test per applicable line BEFORE the build.\n' : '';
}
