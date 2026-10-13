/** One cascade-configurable touch-set for human review (operator decision 2026-10-12). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { GATE_PATH_PREFIXES, normalizeGatePath } from './merge-queue-enqueue.mjs';
import { permissionChangeFiles } from './permission-change.mjs';

export const HUMAN_SURFACE_CATEGORIES = Object.freeze([
  'workflow', 'protection', 'permission', 'identity', 'secrets', 'gate-self', 'statute', 'marked-invariant',
]);
const PRESETS = Object.freeze({ narrow: HUMAN_SURFACE_CATEGORIES.slice(0, 5), broad: HUMAN_SURFACE_CATEGORIES });
export const HUMAN_REVIEW_SURFACES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'human-review-surfaces.json');

/** PURE: explicit inputs are programmer-owned; invalid inputs throw. Workflow is an unconditional floor. */
export function normalizeHumanSurfaces(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input.categories : input;
  const categories = typeof value === 'string' && Object.hasOwn(PRESETS, value) ? PRESETS[value] : value;
  if (!Array.isArray(categories) || !categories.length || categories.some(c => !HUMAN_SURFACE_CATEGORIES.includes(c))) {
    throw new TypeError('humanReviewSurfaces must be narrow, broad, or a non-empty array of known categories');
  }
  const ordered = HUMAN_SURFACE_CATEGORIES.filter(c => c === 'workflow' || categories.includes(c));
  const preset = typeof value === 'string' ? value
    : input?.preset === 'narrow' || input?.preset === 'broad'
      ? (JSON.stringify(ordered) === JSON.stringify(PRESETS[input.preset]) ? input.preset : 'custom') : 'custom';
  return { categories: ordered, preset, source: 'explicit' };
}
const valid = value => {
  // Settings accept only presets or arrays, not arbitrary objects / resolved reader results.
  if (typeof value !== 'string' && !Array.isArray(value)) return false;
  try { normalizeHumanSurfaces(value); return true; } catch { return false; }
};

/** IO: standard → platform → tool → env. Missing/unreadable/invalid layers fall through; never throws. */
export function resolveHumanReviewSurfaces({ env = process.env, readFile = readFileSync, platform } = {}) {
  let tool;
  try { tool = JSON.parse(String(readFile(HUMAN_REVIEW_SURFACES_FILE, 'utf8')))?.humanReviewSurfaces; } catch { /* absent layer */ }
  const plat = platform === undefined ? platformPreference('humanReviewSurfaces', { env, readFile }) : platform;
  const raw = env?.WE_HUMAN_REVIEW_SURFACES;
  const envValue = typeof raw === 'string'
    ? (Object.hasOwn(PRESETS, raw.trim()) ? raw.trim() : raw.split(',').map(c => c.trim())) : raw;
  const result = cascadePolicy('humanReviewSurfaces', valid(tool) ? tool : undefined, {
    standard: 'narrow', platform: valid(plat) ? plat : null, envValues: { '': envValue }, valid, env,
  });
  return { ...normalizeHumanSurfaces(result.value), source: result.sources[''] };
}

const isTest = p => /(^|\/)(__tests__|__fixtures__)\/|\.(test|spec)\.[^/]+$/.test(p);
const pathOf = p => normalizeGatePath(p);
export const isWorkflowSurface = file => GATE_PATH_PREFIXES.some(prefix => pathOf(file).startsWith(prefix));
export const PROTECTION_PATHS = Object.freeze([
  /(^|\/)codeowners$/, // Review ownership.
  /^\.github\/rulesets?\//, // GitHub ruleset data.
  /^\.github\/(settings|branch-protection[^/]*)(?:\.|\/|$)/, // Repository protection settings.
  /^scripts\/rulesets\//, // Ruleset management code and data.
  /^scripts\/lib\/(required-status-checks\.mjs|we-only-checks\.json)$/, // Required-check roster.
]);
export const isProtectionSurface = file => {
  const p = pathOf(file);
  return !isTest(p) && PROTECTION_PATHS.some(re => re.test(p));
};
export const IDENTITY_PATHS = Object.freeze([
  /^scripts\/lib\/github-app-[^/]+\.mjs$/, // App identity, installations, and token minting.
  /^scripts\/lib\/gh-app-shim\.mjs$/, // Authenticated gh subprocess boundary.
  /(^|\/)[^/]*gh-shim[^/]*(\/|$)/, // Alternate gh-shim entrypoints.
  /^scripts\/lib\/github-auth-policy\.mjs$/, // Authentication policy reader.
  /^scripts\/settings\/github-auth\.json$/, // Authentication policy settings.
  /^scripts\/settings\/delivery-identity[^/]*$/, // Delivery actor identity settings.
  /^scripts\/conveyor\/credential-inventory\.mjs$/, // Credential ownership and rotation inventory.
  /^scripts\/lib\/secret-scrub\.mjs$/, // Credential redaction boundary.
  /^scripts\/lib\/usage-report-secret-paths\.mjs$/, // Secret path disclosure boundary.
]);
export const isIdentitySurface = file => {
  const p = pathOf(file);
  return !isTest(p) && !/\.md$|(^|\/)(health-smells|soak)\//.test(p) && IDENTITY_PATHS.some(re => re.test(p));
};
export const isSecretsSurface = file => {
  const p = pathOf(file);
  const name = p.split('/').at(-1);
  return /(^|\/)(secrets|\.secrets)\//.test(p)
    || (/^\.env(?:\..+)?$/.test(name) && !/^\.env\.(example|sample|template)$/.test(name))
    || /\.(pem|key|p12|pfx)$/.test(name) || /^id_(rsa|ed25519)/.test(name);
};
export function isHumanSurfaceSetting(file, hunks) {
  const p = pathOf(file);
  if (['scripts/lib/human-review-surfaces.mjs', 'scripts/settings/human-review-surfaces.json'].includes(p)) return true;
  return /^scripts\/lib\/delivery-(platform-preferences|priority-settings)\.json$/.test(p)
    && (typeof hunks !== 'string' || /humanReviewSurfaces/.test(hunks));
}

/** PURE: path/content categories only; principle triggers remain in scoreEscalation. */
export function sensitiveSurfaceHits(files, fileHunksOf, resolved) {
  const active = normalizeHumanSurfaces(resolved).categories;
  const hits = [];
  for (const file of [...new Set(files)]) {
    if (isHumanSurfaceSetting(file, fileHunksOf(file))) hits.push({ file, category: 'human-surface-setting', kind: 'human-surface-setting' });
    for (const [category, classifier, kind] of [
      ['workflow', isWorkflowSurface, 'workflow-edit'], ['protection', isProtectionSurface, 'protection'],
      ['identity', isIdentitySurface, 'identity'], ['secrets', isSecretsSurface, 'secrets'],
    ]) if (active.includes(category) && classifier(file)) hits.push({ file, category, kind });
  }
  if (active.includes('permission')) {
    for (const hit of permissionChangeFiles(files, fileHunksOf)) hits.push({ ...hit, category: 'permission' });
  }
  return hits;
}
