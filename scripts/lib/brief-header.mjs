/** @file Dispatch-hook header lines (Kind, Mode, Step, Prep, Slot, merge-path) for the worker brief. */
import { readFileSync } from 'node:fs';
// Some test runners give import.meta.url a non-file scheme; fall back to the checkout-relative path.
const ROUTES_FILE = (() => { try { return new URL('../settings/delivery-routes.json', import.meta.url); } catch { return null; } })();
const readRoutes = () => {
  try { return JSON.parse(readFileSync(ROUTES_FILE, 'utf8')); }
  catch { return JSON.parse(readFileSync('scripts/settings/delivery-routes.json', 'utf8')); }
};
// Same pattern the dispatch hook (guard-delivery-mode.mjs) uses to demand the merge-path checklist reference.
const MERGE_PATH = /merge[- ]?gate|merge-ai-prs|red[- ]?team|publication hold|review[- ]?gate|clear-human|waiver|quarantine|forge-exec|uid|enqueue|verdict/i;
const STEP_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Kind -> Mode from the routes table; a blocker slot routes to debug (R852), as the hook does. */
export function routeMode(kind, slot = '', routes = readRoutes()) {
  if (typeof kind !== 'string' || !kind) throw new Error('--kind is required with --step (no default Kind: a wrong one routes the build to the wrong mode).');
  const want = routes.routes?.[kind];
  if (!want) throw new Error(`Unknown kind ${JSON.stringify(kind)}; expected one of ${Object.keys(routes.routes || {}).join('|')}.`);
  return /\bblocker\b/i.test(slot) && want !== 'debug-to-merge' ? 'debug' : want;
}

/** Header lines the dispatch hook demands. '' when no step is given. */
export function renderBriefHeader({ step, kind, slot, prepPath, routes } = {}) {
  if (step === undefined) return '';
  if (typeof step !== 'string' || !STEP_TOKEN.test(step)) throw new Error('--step must be a plan step id (letters, digits, . _ -).');
  if (typeof prepPath !== 'string' || !prepPath.trim()) throw new Error('--step needs an existing prep file (--prep-file): refusing to invent a Prep path.');
  const slotText = slot || `plan:${step}`;
  if (/[\r\n]/.test(slotText) || /[\r\n]/.test(prepPath)) throw new Error('--slot and --prep-file must be a single line.');
  const mode = routeMode(kind, slotText, routes);
  return `Kind: ${kind}\nMode: ${mode}\nStep: ${step}\nPrep: ${prepPath}\nSlot: ${slotText}\n`;
}

/** The merge-path line the hook demands when the brief text matches its merge-path pattern. */
export function renderMergePathLine(text) {
  return MERGE_PATH.test(text) ? 'Merge-path: designs/merge-path-checklist.md. Write a negative test per applicable line BEFORE the build.\n' : '';
}

