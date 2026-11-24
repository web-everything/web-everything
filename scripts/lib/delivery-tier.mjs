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

export const NARROWED_NAME_GLOBS = Object.freeze([]);

export const HIGH_MUST_STAY = Object.freeze([
  // Sensitive delivery trees retain broad name protection, regardless of extension.
  'scripts/**/*merge*', 'scripts/**/*review*', 'scripts/**/*drain*',
  'scripts/*merge*', 'scripts/*drain*',
  'prompts/**/*merge*', 'prompts/**/*review*', 'prompts/**/*drain*',
  'skills-src/**/*merge*', 'skills-src/**/*review*', 'skills-src/**/*drain*',
  '.claude/**/*merge*', '.claude/**/*review*', '.claude/**/*drain*',
  '.github/**/*merge*', '.github/**/*review*', '.github/**/*drain*',
  '**/__tests__/*safety*', '**/*safety*.test.*',
  'docs/governance/**', 'docs/**/governance*.md', 'AGENTS.md', 'CLAUDE.md', 'docs/agent/**',
  '**/skills-src/**', 'scripts/conveyor/advisory-label-sweep.mjs', '**/advisory-label-sweep*',
  'scripts/**/*force*', 'scripts/**/*red-main*',
  'scripts/lib/delivery-tier*.mjs', 'scripts/settings/delivery-tiers.json',
  'scripts/lib/__tests__/delivery-tier*',
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

// JSON.parse validates syntax; this tokenizer checks decoded keys in each object
// before last-wins parsing can hide ambiguous policy evidence. Strings are atomic.
function parseSettings(text) {
  if (typeof text !== 'string') throw new Error('Settings must be text');
  const settings = JSON.parse(text);
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}:]/g) ?? [];
  const objects = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token), keys = objects.at(-1);
      if (keys.has(key)) throw new Error('Duplicate settings key');
      keys.add(key);
    }
  }
  return settings;
}

function settingsHigh(opts) {
  try {
    const settings = Object.hasOwn(opts, 'settings')
      ? opts.settings : parseSettings((opts.readSettings ?? readFileSync)(SETTINGS_PATH, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
    const extraHigh = Object.hasOwn(settings, 'extraHigh') ? settings.extraHigh : null;
    if (!Array.isArray(extraHigh)) return null;
    // Materialize holes as undefined before validation; only use the validated copy.
    const rules = Array.from(extraHigh);
    if (rules.some(g => typeof g !== 'string' || !g.length || /[\\\x00-\x1f\x7f]/.test(g)
      || g.includes('***') || g.split('/').some(part => !part || part === '.' || part === '..'))) return null;
    // Only this additive key is read. Removal and lower-tier keys have no effect.
    return rules;
  } catch {
    // Unknown settings evidence cannot license a LOW or MEDIUM classification.
    return null;
  }
}

function validPath(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\\x00-\x1f\x7f]/.test(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..');
}

function quarantineContext(opts) {
  const paths = opts.quarantinedTests;
  if (paths === undefined) return undefined;
  return Array.isArray(paths) && Array.from(paths).every(path => validPath(path) && !path.includes('::'))
    ? new Set(paths) : null;
}

function classifyFile(path, extraHigh, opts, quarantine) {
  if (quarantine === null) return { path, tier: 'HIGH', rule: 'context-invalid' };
  if (!validPath(path)) {
    return { path, tier: 'HIGH', rule: 'invalid-path' };
  }
  if (extraHigh === null) return { path, tier: 'HIGH', rule: 'settings-unavailable' };
  if (quarantine?.has(path)) return { path, tier: 'HIGH', rule: 'quarantined-test' };
  // Ordered from highest to lowest: overlapping LOW rules cannot downgrade HIGH.
  for (const tier of ['HIGH', 'MEDIUM', 'LOW']) {
    const rules = tier === 'HIGH' ? [...TIER_RULES.HIGH, ...extraHigh] : TIER_RULES[tier];
    const rule = rules.find(glob => matches(glob, path));
    if (rule !== undefined) {
      if (tier === 'LOW' && (opts.redMainFix !== false || quarantine === undefined)) {
        return { path, tier: 'MEDIUM', rule: 'red-main-or-unknown-context' };
      }
      return { path, tier, rule };
    }
  }
  return { path, tier: 'HIGH', rule: 'unmatched' };
}

/** opts: additive settings; LOW requires redMainFix:false and a canonical quarantinedTests array. */
export function fileTier(path, opts = {}) {
  return classifyFile(path, settingsHigh(opts), opts, quarantineContext(opts)).tier;
}

/** Rename records contribute both old and new paths to perFile and the maximum. */
export function classifyTier(paths, opts = {}) {
  const extraHigh = settingsHigh(opts), quarantine = quarantineContext(opts);
  if (!Array.isArray(paths) || paths.length === 0) return { tier: 'HIGH', perFile: [] };
  // Array.from turns sparse holes into undefined entries, which classify as invalid-path HIGH.
  const perFile = Array.from(paths).flatMap(item => {
    if (item && typeof item === 'object') {
      return [item.path, ...(Object.hasOwn(item, 'oldPath') ? [item.oldPath] : [])]
        .map(path => classifyFile(path, extraHigh, opts, quarantine));
    }
    return [classifyFile(item, extraHigh, opts, quarantine)];
  });
  const tier = perFile.some(file => file.tier === 'HIGH') ? 'HIGH'
    : perFile.some(file => file.tier === 'MEDIUM') ? 'MEDIUM' : 'LOW';
  return { tier, perFile };
}
