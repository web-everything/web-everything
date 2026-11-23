/** Observe-only delivery risk vocabulary. No production caller is enrolled in S1. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GUARD_FLOOR, REVIEW_AUTH_FLOOR, AUDITOR_FLOOR } from './protected-path-floor.mjs';

// TRUST_CHAIN basenames from gate-config.mjs, deliberately listed here rather than
// importing its executable gate machinery. Protect relocated homes as that roster does.
const TRUST_CHAIN_FILES = [
  'lane-git-hardening.mjs', 'drain-red-team-evidence.mjs', 'red-team-check-run.mjs',
  'seat-assessment.mjs', 'seat-ac-rubric.mjs', 'seat-assessment.test.mjs', 'seat-ac-rubric.test.mjs',
  'card-ledger-trust.json', 'card-ledger-legacy-identities.json', 'webeverything.config.json',
  'deliveryPolicyDefaults.ts', 'delivery-policy.mjs', 'review-escalation.mjs', 'review-core.mjs',
  'review-policy.contract.json', 'review-policy.mjs', 'drain-gate-settings.json',
  'drain-workflow-edit-hold.mjs', 'disposition-land-seam.mjs', 'auto-land-seam.mjs',
  'review-policy.conformance.test.mjs', 'merge-ai-prs.mjs', 'daemon.mjs', 'cli.mjs', 'lib.mjs',
  'review-runner-core.mjs', 'review-runner.mjs', 'converge-daemon-pass.mjs', 'converge-daemon-install.mjs',
  'check-standards.contract.json', 'check-standards.conformance.test.mjs', 'check-standards.mjs',
  'check-standards-rules.mjs', 'review-independence.mjs', 'tick-core.mjs', 'dispatch-lane.mjs',
  'dispatch-lane-io.mjs', 'runner.mjs', 'supervisor.mjs', 'gate-config.mjs', 'gate-invariants.test.mjs',
];

export const HIGH_MUST_STAY = Object.freeze([
  'scripts/**/*merge*', 'scripts/**/*review*', 'scripts/**/*drain*',
  'scripts/**/*force*', 'scripts/**/*red-main*',
  'scripts/lib/delivery-tier*.mjs', 'scripts/settings/delivery-tiers.json',
  'scripts/settings/**', 'scripts/lib/*settings*', 'scripts/lib/presets-loader.cjs',
  '**/*preset*',
  '.github/workflows/**', 'vitest*.config.*', '**/vitest*.config.*', 'scripts/ci/**',
  // Fetch-first stale guard, overlay loader and registration/adoption machinery.
  'scripts/lib/main-staleness.mjs', 'scripts/lib/daemon-last-good.mjs',
  'scripts/lib/daemon-load-overlay.mjs', 'scripts/lib/daemon-overlays.mjs',
  'scripts/lib/overlay-adoption.mjs', 'scripts/daemon-overlay.mjs',
  'scripts/operations/prototype-load.mjs', 'scripts/operations/prototype-load-io.mjs',
  ...TRUST_CHAIN_FILES.map(file => `**/${file}`),
  '**/*credential*', '**/.env', '**/.env.*', '.aws/**', '.ssh/**',
  'scripts/**/*launch*', 'scripts/**/*agent*', 'scripts/codex-*', 'scripts/claude-*',
  'scripts/operations/worker-wrapper*', 'scripts/lib/ai-routing.mjs',
  'scripts/hooks/**', 'scripts/**/*hook*', '.githooks/**', '.claude/**', '**/guard-*.mjs',
  ...GUARD_FLOOR, ...REVIEW_AUTH_FLOOR, ...AUDITOR_FLOOR,
  // Some floor entries are directory markers. Keep the originals above for parity
  // and add descendant globs: the draft matcher does not treat a trailing / specially.
  ...[...GUARD_FLOOR, ...REVIEW_AUTH_FLOOR, ...AUDITOR_FLOOR]
    .filter(glob => glob.endsWith('/')).map(glob => `${glob}**`),
]);

export const TIER_RULES = Object.freeze({
  HIGH: HIGH_MUST_STAY,
  MEDIUM: Object.freeze(['scripts/conveyor/**']),
  LOW: Object.freeze(['docs/**', '**/*.md', '**/__tests__/**']),
});

// DPOL-007: rooted glob semantics, including zero directories for **/ and a
// trailing ** matching the entire remainder. No external draft runtime dependency.
function globRe(g) {
  const segs = g.split('/'); let re = '';
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s === '**') { re += last ? '.*' : '(?:[^/]+/)*'; return; }
    re += s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '[^/]*').replace(/\?/g, '[^/]') + (last ? '' : '/');
  });
  return new RegExp(`^${re}$`);
}
const matches = (g, p) => globRe(g).test(p);
const SETTINGS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../settings/delivery-tiers.json');

function settingsHigh(opts) {
  try {
    const settings = Object.hasOwn(opts, 'settings')
      ? opts.settings : JSON.parse((opts.readSettings ?? readFileSync)(SETTINGS_PATH, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
    const extraHigh = settings.extraHigh ?? [];
    if (!Array.isArray(extraHigh) || extraHigh.some(g => typeof g !== 'string' || !g.length)) return null;
    // Only this additive key is read. Removal and lower-tier keys have no effect.
    return extraHigh;
  } catch {
    // Unknown settings evidence cannot license a LOW or MEDIUM classification.
    return null;
  }
}

function classifyFile(path, extraHigh) {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f\x7f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')) {
    return { path, tier: 'HIGH', rule: 'invalid-path' };
  }
  if (extraHigh === null) return { path, tier: 'HIGH', rule: 'settings-unavailable' };
  // Ordered from highest to lowest: overlapping LOW rules cannot downgrade HIGH.
  for (const tier of ['HIGH', 'MEDIUM', 'LOW']) {
    const rules = tier === 'HIGH' ? [...HIGH_MUST_STAY, ...extraHigh] : TIER_RULES[tier];
    const rule = rules.find(glob => matches(glob, path));
    if (rule !== undefined) return { path, tier, rule };
  }
  return { path, tier: 'HIGH', rule: 'unmatched' };
}

/** Return one tier string; opts.settings optionally injects additive settings. */
export function fileTier(path, opts = {}) {
  return classifyFile(path, settingsHigh(opts)).tier;
}

/** Rename records contribute both old and new paths to perFile and the maximum. */
export function classifyTier(paths, opts = {}) {
  const extraHigh = settingsHigh(opts);
  if (!Array.isArray(paths) || paths.length === 0) return { tier: 'HIGH', perFile: [] };
  const perFile = paths.flatMap(item => {
    if (item && typeof item === 'object') {
      return [item.path, ...(Object.hasOwn(item, 'oldPath') ? [item.oldPath] : [])]
        .map(path => classifyFile(path, extraHigh));
    }
    return [classifyFile(item, extraHigh)];
  });
  const tier = perFile.some(file => file.tier === 'HIGH') ? 'HIGH'
    : perFile.some(file => file.tier === 'MEDIUM') ? 'MEDIUM' : 'LOW';
  return { tier, perFile };
}
