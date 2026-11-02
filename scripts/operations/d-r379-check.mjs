#!/usr/bin/env node
/** Read-only D-R379 eligibility decision. All evidence readers are injected. */
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import yaml from 'js-yaml';
import { findAudit, QUESTION_HASH } from './codex-audit.mjs';
import { ledgerView, derivePrState } from '../lib/pr-state.mjs';
import { REVIEW_LABELS } from '../lib/review-labels.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { globToRegExp } from '../lib/standards-sections.mjs';

const SHA = /^[a-f\d]{40}$/i;
const MAX_PATHS = 10_000;
const MAX_AUDITS = 100_000;
// Safety-critical seed policy is code-owned; checkout settings may only add protection.
const HARMLESS_PATHS = Object.freeze([
  'docs/examples/**/*.md',
  // Backlog Markdown renders raw HTML, frontmatter details and related reports
  // into the website. Require operator review until that rendering is sanitized.
  'docs/*.md',
  'docs/topics/**/*.md',
  'README*.md',
  '**/*.png',
  '**/*.jpg',
  '**/*.webp',
]);
const PROTECTED_PATHS = Object.freeze([
  'tests/**',
  '**/*.spec.*',
  '**/*.test.*',
  '**/__tests__/**',
  '**/playwright*.config.*',
  'tests/a11y/**',
  'blocks/__tests__/e2e/**',
  'scripts/**/*gate*',
  'scripts/**/*guard*',
  'scripts/**/*verdict*',
  'scripts/**/*ledger*',
  'scripts/**/*codeql*',
  'scripts/**/*secret*',
  'scripts/**/*policy*',
  'scripts/**/*permission*',
  'scripts/**/*approval*',
  'scripts/**/*label*',
  '.github/**/*gate*',
  '.github/**/*guard*',
  '.github/**/*verdict*',
  '.github/**/*ledger*',
  '.github/**/*codeql*',
  '.github/**/*secret*',
  '.github/**/*policy*',
  '.github/**/*permission*',
  '.github/**/*approval*',
  '.github/**/*label*',
  '**/guard-*.mjs',
  '.claude/hooks/**',
  '.githooks/**',
  'scripts/hooks/**',
  '**/settings.json',
  'scripts/review-set-label*',
  'scripts/conveyor/review-referral-hold.mjs',
  'scripts/lib/pr-state/holds/**',
  'scripts/lib/pr-state/referrals.mjs',
  'scripts/lib/*referral*.mjs',
  'scripts/lib/*red-team*.mjs',
  'scripts/conveyor/*red-team*.mjs',
  'scripts/settings/*referral*.json',
  'scripts/settings/*red-team*.json',
  'scripts/lib/jury-core.mjs',
  'scripts/lib/secret-scrub.mjs',
  'scripts/lib/github-app-token.mjs',
  'scripts/readiness/forge-setup.sh',
  'scripts/readiness/forge-exec-limits.mjs',
  '**/forge-exec/limits.json',
  '**/migrations/**',
  'scripts/settings/d-r379-protected-paths.json',
  'scripts/operations/d-r379-check*.mjs',
  'scripts/operations/codex-audit*.mjs',
  'scripts/check-*.mjs',
  'scripts/lib/policy-cascade.mjs',
  'scripts/lib/review-*.mjs',
  'scripts/lib/verdict-ledger*.mjs',
  'scripts/review-ledger*.mjs',
  'scripts/lib/pr-state*.mjs',
  'scripts/lib/pr-state/**',
  'scripts/operations/pr-limit.mjs',
  'scripts/lib/pr-limit.mjs',
  'scripts/settings/pr-limit.json',
  'scripts/settings/review*.json',
  'scripts/settings/human-review-surfaces.json',
  'scripts/settings/prototype-load.json',
  'scripts/drain-gate-settings.json',
  'scripts/lib/review-policy.contract.json',
  'scripts/check-standards.contract.json',
  'webeverything.config.json',
  'scripts/lib/standards-sections.mjs',
  'scripts/lib/utc-day-slice-scan.mjs',
  'scripts/lib/invisible-source-scan.mjs',
  'scripts/lib/stdout-flush-scan.mjs',
  'scripts/lib/rust-scan-bridge.mjs',
  'scripts/check-standards-rules.mjs',
  'scripts/lib/validate-rules-anchors.cjs',
  'scripts/lib/memory-freshness.cjs',
  'scripts/lib/verdict-totality.mjs',
  'scripts/lib/review-skill-guard.mjs',
  'scripts/lib/mandate-fence-scan.mjs',
  'scripts/lib/backlog-status.cjs',
  'scripts/lib/related-report.cjs',
  'scripts/guard-lane.mjs',
  'scripts/gen-inventory.mjs',
  'scripts/ci/shard-assign.mjs',
  'scripts/readiness/claimScope.mjs',
  'scripts/check-demos.mjs',
  'scripts/lib/buildReport.mjs',
  'scripts/lib/blocks-loader.cjs',
  'scripts/lib/intents-loader.cjs',
  'scripts/lib/research-loader.cjs',
  'scripts/lib/protocols-loader.cjs',
  'scripts/lib/demos-loader.cjs',
  'scripts/lib/semantics-loader.cjs',
  'scripts/lib/presets-loader.cjs',
  'scripts/lib/registry-loader.cjs',
  'scripts/lib/adapters-loader.cjs',
  'scripts/lib/local-date.mjs',
  'scripts/lib/git-grep-gate.mjs',
  'scripts/lib/standards-cache.mjs',
  'scripts/lib/poc-branches.mjs',
  'scripts/lib/skill-operation-wiring.mjs',
  'scripts/lib/operation-io-fidelity.mjs',
  'scripts/operations/declared-homes.mjs',
  'scripts/operations/registry.mjs',
  'scripts/operations/run.mjs',
  'scripts/operations/cli-adapter.mjs',
  'scripts/lib/citation-check.mjs',
  'scripts/lib/gate-config.mjs',
  'scripts/lib/review-escalation.mjs',
  'scripts/lib/transient-paths.mjs',
  'scripts/lib/verify-lane-gate.mjs',
  'scripts/lib/diff-branch-coverage.mjs',
  'scripts/backlog/id.mjs',
  'scripts/lib/queue-branch-numbering.mjs',
  '**/__tests__/*standards-sections*',
  '**/__tests__/*utc-day-slice-scan*',
  '**/__tests__/*invisible-source-scan*',
  '**/__tests__/*stdout-flush-scan*',
  '**/__tests__/*rust-scan-bridge*',
  '**/__tests__/*check-standards-rules*',
  '**/__tests__/*validate-rules-anchors*',
  '**/__tests__/*memory-freshness*',
  '**/__tests__/*verdict-totality*',
  '**/__tests__/*jury-core*',
  '**/__tests__/*review-skill-guard*',
  '**/__tests__/*mandate-fence-scan*',
  '**/__tests__/*backlog-status*',
  '**/__tests__/*related-report*',
  '**/__tests__/*guard-lane*',
  '**/__tests__/*gen-inventory*',
  '**/__tests__/*shard-assign*',
  '**/__tests__/*claimScope*',
  '**/__tests__/*check-demos*',
  '**/__tests__/*buildReport*',
  '**/__tests__/*blocks-loader*',
  '**/__tests__/*intents-loader*',
  '**/__tests__/*research-loader*',
  '**/__tests__/*protocols-loader*',
  '**/__tests__/*demos-loader*',
  '**/__tests__/*semantics-loader*',
  '**/__tests__/*presets-loader*',
  '**/__tests__/*registry-loader*',
  '**/__tests__/*adapters-loader*',
  '**/__tests__/*local-date*',
  '**/__tests__/*git-grep-gate*',
  '**/__tests__/*standards-cache*',
  '**/__tests__/*poc-branches*',
  '**/__tests__/*skill-operation-wiring*',
  '**/__tests__/*operation-io-fidelity*',
  '**/__tests__/*declared-homes*',
  '**/__tests__/*cli-adapter*',
  '**/__tests__/*citation-check*',
  '**/__tests__/*gate-config*',
  '**/__tests__/*review-escalation*',
  '**/__tests__/*transient-paths*',
  '**/__tests__/*verify-lane-gate*',
  '**/__tests__/*diff-branch-coverage*',
  '**/__tests__/*queue-branch-numbering*',
  '**/__tests__/*guard*',
  '**/__tests__/*review-set-label*',
  '**/__tests__/*d-r379-check*',
  '**/__tests__/*codex-audit*',
  '**/__tests__/*policy-cascade*',
  '**/__tests__/*review*',
  '**/__tests__/*verdict-ledger*',
  '**/__tests__/*pr-state*',
  '**/__tests__/*pr-limit*',
  '**/__tests__/id.test.*',
  '**/__tests__/run.test.*',
  '**/__tests__/registry.test.*',
  '**/__tests__/check-*.mjs',
  'scripts/lib/constellation-repos.mjs',
  'scripts/lib/gh-throttle.mjs',
  'scripts/lib/delivery-platform-preferences.json',
  'scripts/lib/delivery-priority-settings.json',
  '**/__tests__/*constellation-repos*',
  '**/__tests__/*gh-throttle*',
  '**/__tests__/*secret-scrub*',
  '**/__tests__/*github-app-token*',
  '**/__tests__/*forge-exec*',
  'package.json',
  'package-lock.json',
  'vitest.config.ts',
  'vitest.*.config.ts',
  'vitest.shared.ts',
  'vitest.setup.ts',
  'vitest.globalSetup.mjs',
  'playwright.config.ts',
  'bun-test.preload.ts',
  '.github/workflows/**',
  'scripts/merge-coverage.mjs',
  'scripts/ci-card-only.mjs',
  'scripts/ci/**',
  'scripts/conveyor/soak/run-shard.mjs',
  'scripts/dev/regression.mjs',
  'scripts/hermetic-tests.settings.json',
  'scripts/hermetic-test-baseline.json',
  'scripts/lib/hermetic-tests.mjs',
  'scripts/lib/hermetic-tests-vitest.mjs',
  'scripts/lib/hermetic-git-overlay.mjs',
  'scripts/lib/trust-chain-tier.mjs',
  'scripts/lib/test-result-cache.mjs',
  'scripts/lib/test-cache-trace.mjs',
  'scripts/lib/test-result-store.mjs',
  'scripts/lib/related-test-selection.mjs',
  'scripts/test-cache/**',
  'scripts/lib/workflow-invariants.cjs',
  'scripts/readiness/heavy-admission.mjs',
  'scripts/operations/__tests__/d-r379-check*',
  'scripts/operations/__fixtures__/d-r379/**',
]);
const ENFORCEMENT_TREES = Object.freeze([
  'scripts/**',
  '.github/**',
  '.claude/**',
  'skills-src/**',
  '**/SKILL.md',
  '**/CLAUDE.md',
  'agent-memory-src/**',
  '.claude-plugin/**',
  '**/prompts/**',
  '**/skills/**',
  'docs/agent/**',
  '**/*.js',
  '**/*.ts',
  '**/*.mjs',
  '**/*.cjs',
  '**/*.py',
  '**/*.json',
  '**/*.rs',
  '**/*.sh',
  '**/*.bash',
  '**/*.zsh',
  '**/*.ksh',
  '**/*.csh',
  '**/*.fish',
]);
const DIRECTION_PATHS = Object.freeze([
  '**/AGENTS.md',
  'docs/agent/platform-decisions.md',
  'standards/**',
  'contracts/**',
  'schemas/**',
  'conformance-vectors/**',
  'conformance-evidence/**',
  'wrapper-conformance/**',
  'src/_data/**',
  'src/_includes/*-descriptions/**',
]);
const TRUSTED_MINIMUM = Object.freeze({
  enforcementCanaries: Object.freeze([
    'scripts/guard-bash.mjs', 'scripts/lib/jury-core.mjs',
    'scripts/review-set-label.mjs', '.github/workflows/ci.yml', 'package.json',
  ]),
  harmlessExclusions: Object.freeze([
    'tests/a/b.test.mjs', 'docs/agent/platform-decisions.md', 'AGENTS.md',
  ]),
  harmlessExample: 'docs/examples/x.md',
});
const USAGE = 'usage: node scripts/operations/d-r379-check.mjs --pr=N [--json]\n';
const DIRECTION = /\bD-R\d+\b|\bR\d{2,4}\b|#\d+\b|\b(?:card|story|item|focus(?:\s+item)?)\s*#?\d+\b/i;
const RULING = /\b(?:D-)?R\d+\b/i;
const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
const result = (id, name, status, evidence) => ({ id, name, status, evidence });
const unknown = (id, name, detail) => result(id, name, 'UNKNOWN', [`${detail}; request human review of the full diff or repair evidence and retry`]);
const validPr = pr => Number.isSafeInteger(pr) && pr > 0;
const validPath = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !path.startsWith('/') && !path.includes('\\')
  && !/[\x00-\x1f\x7f-\x9f]/.test(path) && Buffer.from(path, 'utf8').toString('utf8') === path
  && !path.split('/').some(part => !part || part === '.' || part === '..');

/** Shared anchored matcher: ** crosses directories, * and ? stay within a segment. */
export function matchesGlob(path, glob) {
  return typeof path === 'string' && typeof glob === 'string'
    && new RegExp(globToRegExp(glob).source, 's').test(path);
}

function validateSettings(settings) {
  if (settings?.reviewedSafePaths !== undefined
    && (!Array.isArray(settings.reviewedSafePaths) || settings.reviewedSafePaths.length !== 0)) {
    throw new Error('reviewedSafePaths is no longer supported; human review required');
  }
  if (settings && Object.hasOwn(settings, 'harmlessPaths')) {
    throw new Error('harmlessPaths is code-owned; human review required');
  }
  for (const key of ['directionPaths', 'protectedPaths', 'enforcementTrees']) {
    const patterns = settings?.[key] === undefined ? [] : settings[key];
    if (!Array.isArray(patterns) || patterns.length > 1000
      || patterns.some(p => typeof p !== 'string' || !p.trim() || p.length > 4096)) {
      throw new Error('incomplete path policy');
    }
  }
  const records = settings.rulingRecordPaths;
  if (!Array.isArray(records) || !records.length || records.length > 1000
    || records.some(path => !validPath(path) || /[*?\[\]]/.test(path))
    || new Set(records).size !== records.length) throw new Error('invalid ruling record paths');
  settings = { ...settings,
    harmlessPaths: HARMLESS_PATHS,
    protectedPaths: [...new Set([...PROTECTED_PATHS, ...(settings.protectedPaths ?? [])])],
    enforcementTrees: [...new Set([...ENFORCEMENT_TREES, ...(settings.enforcementTrees ?? [])])],
    directionPaths: [...new Set([...DIRECTION_PATHS, ...(settings.directionPaths ?? [])])],
  };
  const canaries = [...TRUSTED_MINIMUM.enforcementCanaries, ...TRUSTED_MINIMUM.harmlessExclusions];
  if (settings.harmlessPaths.some(glob => ['**', '*', '**/*'].includes(glob)
    || canaries.some(path => matchesGlob(path, glob)))
    || !settings.harmlessPaths.some(glob => matchesGlob(TRUSTED_MINIMUM.harmlessExample, glob))
    || TRUSTED_MINIMUM.enforcementCanaries.some(path =>
      ![...settings.protectedPaths, ...settings.enforcementTrees].some(glob => matchesGlob(path, glob)))) {
    throw new Error('path policy fails trusted minimum canary probes');
  }
  return settings;
}

function labelNames(labels) {
  if (!Array.isArray(labels) || labels.length > 1000) throw new Error('invalid labels');
  return labels.map(label => {
    const name = typeof label === 'string' ? label : label?.name;
    if (typeof name !== 'string' || !name.trim()) throw new Error('invalid label');
    return name;
  });
}

/** Validate every head record, retaining cross-base weakened evidence newer than the bound clear. */
function latestAudit(records, head, base) {
  if (!Array.isArray(records) || records.length > MAX_AUDITS) throw new Error('invalid or oversized audit ledger');
  const valid = [];
  for (const record of records) {
    if (record?.head !== head) continue;
    // Only evidence for this head and question participates. Malformed canonical
    // evidence must never silently revive an older clearance.
    if (typeof record.questionHash === 'string' && record.questionHash.trim()
      && record.questionHash !== QUESTION_HASH) continue;
    if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))
      || typeof record.base !== 'string' || record.base.length !== 40 || !SHA.test(record.base)
      || !['NOT WEAKENED', 'WEAKENED'].includes(record.verdict)
      || !Array.isArray(record.findings) || !record.findings.every(line => typeof line === 'string')
      || typeof record.questionHash !== 'string' || !record.questionHash.trim()) {
      throw new Error('malformed audit record for this head');
    }
    if (!findAudit([record], { head, base: record.base, questionHash: QUESTION_HASH })) {
      throw new Error('rejected canonical audit record for this head');
    }
    valid.push(record);
  }
  const newer = (record, previous) => !previous || Date.parse(record.at) >= Date.parse(previous.at);
  let latest = null, accepting = null;
  for (const record of valid) {
    if (newer(record, latest)) latest = record;
    if (record.base === base && newer(record, accepting)) accepting = record;
  }
  if (accepting?.verdict === 'NOT WEAKENED') {
    const acceptedAt = Date.parse(accepting.at), acceptedIndex = valid.indexOf(accepting);
    for (let i = 0; i < valid.length; i++) {
      const record = valid[i], at = Date.parse(record.at);
      if (record.verdict === 'WEAKENED' && (at > acceptedAt || (at === acceptedAt && i > acceptedIndex))) {
        return record;
      }
    }
  }
  return latest;
}

async function reviewed(pr, head, base, deps) {
  const name = 'Reviewed';
  let labels, audit;
  try { labels = labelNames(await deps.readLabels(pr, head)); }
  catch { return unknown(2, name, 'labels unavailable'); }
  // Unknown review:* and advisory:* labels fail closed: only these review labels may coexist with delegated approval.
  const ALLOWED_REVIEW = [REVIEW_LABELS.accepted, 'review:pending', REVIEW_LABELS.human];
  const blocked = labels.filter(l => (l.startsWith('red-team:') && l !== 'red-team:clear')
    || (l.startsWith('review:') && !ALLOWED_REVIEW.includes(l)) || l.startsWith('advisory:')
    || [REVIEW_LABELS.changes, REVIEW_LABELS.heldMechanical].includes(l));
  const missing = ['red-team:clear'].filter(l => !labels.includes(l));
  if (![REVIEW_LABELS.accepted, 'review:pending', REVIEW_LABELS.human].some(l => labels.includes(l))) {
    missing.push(REVIEW_LABELS.accepted);
  }
  if (blocked.length || missing.length) return result(2, name, 'FAIL', [
    ...blocked.map(l => `blocking label: ${l}`), ...missing.map(l => `missing label: ${l}`),
  ]);
  try { audit = latestAudit(await deps.readAudits(), head, base); }
  catch { return unknown(2, name, 'audits unavailable or oversized'); }
  if (!audit) return result(2, name, 'FAIL', ['no audit for head']);
  if (audit.verdict !== 'NOT WEAKENED') return result(2, name, 'FAIL', [`latest audit: ${audit.verdict}`]);
  if (!base) return unknown(2, name, 'net diff merge-base unavailable');
  if (audit.base === head || audit.base !== base) return result(2, name, 'FAIL', ['audit base does not match the classified net diff merge-base']);
  let state, current;
  try {
    const events = await deps.readReviewLedger(pr);
    if (!Array.isArray(events) || events.length > MAX_AUDITS) throw new Error('invalid or oversized verdict ledger');
    // The shared derive owns validation, stale acceptance, human holds and open findings.
    // These ledger-only facts need no unrelated live agents/checks/comment probes.
    const facts = { repo: CONSTELLATION_REPOS.we.slug, pr,
      head: { sha: head }, now: new Date().toISOString() };
    current = ledgerView(events, facts).folded?.current;
    state = derivePrState(events, facts);
  } catch { return unknown(2, name, 'verdict ledger unavailable or oversized'); }
  if (state.holds.some(h => ['ledger-unreadable', 'scope-unknown', 'derive-crashed'].includes(h.code)
    || h.code.startsWith('rule-crashed:'))) return unknown(2, name, 'verdict ledger could not be derived');
  if (!current?.clears || current.coverage?.headSha?.toLowerCase() !== head.toLowerCase()) {
    return result(2, name, 'FAIL', ['acceptance not in ledger']);
  }
  if (state.verdict === 'clear-human' || current?.verdict === 'clear-human') return result(2, name, 'FAIL',
    ['ledger acceptance is a clear-human ceremony; it needs a companion approval, not delegated approval']);
  if (!state.clears || state.reviewExempt || !state.verdict) return result(2, name, 'FAIL',
    ['verdict ledger does not accept the current head', ...state.holds.map(h => `${h.code}: ${h.reason}`)]);
  const liveHolds = labels.filter(label => ['review:pending', REVIEW_LABELS.human].includes(label));
  if (liveHolds.length) {
    let applications;
    try {
      const events = await deps.readLabelEvents(pr);
      if (!Array.isArray(events) || events.length > 1000) throw new Error('invalid or oversized label timeline');
      applications = new Map();
      for (const event of events) {
        if (!['labeled', 'unlabeled'].includes(event?.event) || typeof event.label?.name !== 'string'
          || typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at))) {
          throw new Error('invalid label event');
        }
        if (event.event !== 'labeled' || !liveHolds.includes(event.label.name)) continue;
        const at = Date.parse(event.created_at);
        applications.set(event.label.name, Math.max(applications.get(event.label.name) ?? -Infinity, at));
      }
      if (!Number.isFinite(Date.parse(current.at)) || liveHolds.some(label => !applications.has(label))) {
        throw new Error('missing hold application or acceptance time');
      }
    } catch { return unknown(2, name, 'hold label timeline unavailable, incomplete or oversized'); }
    const later = liveHolds.filter(label => applications.get(label) >= Date.parse(current.at));
    if (later.length) return result(2, name, 'FAIL', later.map(label => `hold applied after acceptance: ${label}`));
  }
  return result(2, name, 'PASS', [REVIEW_LABELS.accepted, 'red-team:clear',
    `canonical audit NOT WEAKENED for head ${head}, base ${audit.base}, at ${audit.at}`,
    'verdict ledger accepts the current head with no holds']);
}

function isRulingPath(path) {
  return /rulings?/i.test(path.split('/').at(-1));
}

/** Parse actual YAML, including quoted scalars; malformed/missing frontmatter is unknown. */
function decisionState(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('missing or oversized card');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('missing frontmatter');
  const data = yaml.safeLoad(match[1]);
  if (!data || typeof (data.kind ?? data.type) !== 'string' || typeof data.status !== 'string') throw new Error('incomplete frontmatter');
  return { decision: data.kind === 'decision' || data.type === 'decision' };
}

/** Zero-context, append-only patch; counts and exact appended bytes prove completeness. */
function rulingAddedLines(patch, appended, expectedCount) {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > 8 * 1024 * 1024
    || !patch.endsWith('\n')) throw new Error('missing or oversized ruling diff');
  const added = [];
  let remaining = 0, hunks = 0, files = 0, noNewline = false;
  for (const line of patch.slice(0, -1).split('\n')) {
    if (remaining) {
      if (!line.startsWith('+')) throw new Error('incomplete append hunk');
      added.push(line.slice(1));
      remaining--;
    } else if (line.startsWith('diff --git ')) {
      files++;
    } else if (line.startsWith('@@')) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!hunk || Number(hunk[1] ?? 1) !== 0) throw new Error('not an append hunk');
      remaining = Number(hunk[2] ?? 1);
      if (!Number.isSafeInteger(remaining) || remaining < 1 || noNewline) throw new Error('invalid hunk');
      hunks++;
    } else if (line === '\\ No newline at end of file' && hunks && !noNewline) {
      noNewline = true;
    } else if (hunks) {
      throw new Error('unexpected append diff line');
    }
  }
  if (files !== 1 || !hunks || remaining || added.length !== expectedCount
    || added.join('\n') + (noNewline ? '' : '\n') !== appended) throw new Error('incomplete ruling additions');
  return added;
}

function isCitedRulingEntry(lines, metadata) {
  const cited = new Set([...`${metadata.title}\n${metadata.body}`.matchAll(/\b(?:D-)?R(\d+)\b/gi)]
    .map(match => match[1]));
  let inEntry = false, entries = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = /^- \*\*(?:D-)?R(\d+)\*\*(?:[ \t]|$)/.exec(line);
    if (entry) {
      if (!cited.has(entry[1])) return false;
      inEntry = true;
      entries++;
    } else if (!inEntry || !/^(?: {2,}|\t)/.test(line)) {
      return false;
    }
  }
  return entries > 0;
}

async function directionPaths(paths, settings, metadata, head, base, deps) {
  const matches = [], unreadable = [];
  let touchesDecision = false;
  for (const path of paths) {
    if (settings.rulingRecordPaths.includes(path) || isRulingPath(path) || settings.directionPaths.some(glob => matchesGlob(path, glob))) matches.push(path);
    if (/^backlog\/[^/]+\.md$/.test(path)) {
      try {
        const current = decisionState(await deps.readHeadFile(head, path));
        // null is verified absence; every other unreadable historical value is UNKNOWN.
        const historicalText = await deps.readBaseFile(base, path);
        const historical = historicalText === null ? null : decisionState(historicalText);
        // Any net-diff touch can reverse a ruling, even with a resolved status at both ends.
        if (current.decision || historical?.decision) {
          touchesDecision = true;
          matches.push(path);
        }
      } catch { unreadable.push(path); }
    }
  }
  const hits = [...new Set(matches)];
  const recording = hits.length && !touchesDecision
    && paths.every(path => settings.rulingRecordPaths.includes(path))
    && RULING.test(`${metadata.title}\n${metadata.body}`)
    && /(?:^\s*>|\bverbatim\b)/im.test(metadata.body);
  if (hits.length && !recording) return result(3, 'Sets no direction', 'FAIL', hits.map(path => `direction path: ${path}`));
  if (unreadable.length) return unknown(3, 'Sets no direction', `unreadable decision evidence: ${unreadable.join(', ')}`);
  if (recording) {
    let rows;
    try {
      const text = await deps.readRulingNumstat(base, head, hits);
      if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024
        || !text.endsWith('\0')) throw new Error('missing or oversized numstat');
      rows = text.slice(0, -1).split('\0').map(row => {
        const match = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(row);
        if (!match || !hits.includes(match[3]) || !Number.isSafeInteger(Number(match[1]))
          || !Number.isSafeInteger(Number(match[2]))) throw new Error('invalid numstat');
        return { added: Number(match[1]), deleted: Number(match[2]), path: match[3] };
      });
      if (rows.length !== hits.length || new Set(rows.map(row => row.path)).size !== hits.length) {
        throw new Error('incomplete numstat');
      }
    } catch { return unknown(3, 'Sets no direction', 'ruling numstat unavailable, invalid or oversized'); }
    if (rows.some(row => row.deleted !== 0 || row.added === 0)) {
      return result(3, 'Sets no direction', 'FAIL', hits.map(path => `direction path (not append-only): ${path}`));
    }
    // Counts alone admit prepends and interior insertions. Preserve the entire
    // base blob as a prefix of the head blob to prove additions occur only at EOF.
    for (const path of hits) {
      let before, after;
      try {
        before = await deps.readRulingFile(base, path);
        after = await deps.readRulingFile(head, path);
        if ([before, after].some(text => typeof text !== 'string'
          || Buffer.byteLength(text) > 8 * 1024 * 1024)) throw new Error('invalid ruling blob');
      } catch { return unknown(3, 'Sets no direction', `ruling EOF evidence unavailable, invalid or oversized: ${path}`); }
      if (after.length <= before.length || !after.startsWith(before)) {
        return result(3, 'Sets no direction', 'FAIL', [`direction path (not EOF-only append): ${path}`]);
      }
      let added;
      try {
        added = rulingAddedLines(await deps.readRulingDiff(base, head, [path]),
          after.slice(before.length), rows.find(row => row.path === path).added);
      } catch { return unknown(3, 'Sets no direction', `ruling added-line evidence unavailable, invalid or oversized: ${path}`); }
      if ((before && !before.endsWith('\n')) || !isCitedRulingEntry(added, metadata)) {
        return result(3, 'Sets no direction', 'FAIL', [`direction path (not a cited ruling entry): ${path}`,
          'provenance claimed by PR, not verified']);
      }
    }
  }
  return result(3, 'Sets no direction', 'PASS', recording ? ['R391 ruling-record', 'provenance claimed by PR, not verified', ...hits] : ['no direction paths or touched decision cards']);
}

function protectedPaths(paths, settings) {
  const patterns = settings.protectedPaths;
  const hits = paths.filter(path => patterns.some(glob => matchesGlob(path, glob)));
  if (hits.length) return result(4, 'Not guard-loosening / hard to undo', 'FAIL',
    hits.map(path => `protected path: ${path}`));
  const unclassified = paths.filter(path => !settings.harmlessPaths.some(glob => matchesGlob(path, glob))
    || settings.enforcementTrees.some(glob => matchesGlob(path, glob)));
  return result(4, 'Not guard-loosening / hard to undo', unclassified.length ? 'UNKNOWN' : 'PASS',
    unclassified.length ? unclassified.map(path => `unclassified path: ${path}; operator review`)
      : ['all paths harmless; no protected paths']);
}

/** Return all five conditions; seats are informational and never authorize approval. */
export async function checkPr(pr, deps) {
  if (!validPr(pr)) throw new Error('invalid PR number');
  const metadata = await deps.readPr(pr);
  if (!SHA.test(metadata?.headRefOid ?? '') || typeof metadata.title !== 'string' || typeof metadata.body !== 'string') {
    throw new Error('incomplete PR metadata');
  }
  const head = metadata.headRefOid;
  const citation = DIRECTION.exec(`${metadata.title}\n${metadata.body}`)?.[0];
  const conditions = [result(1, 'Direction source', citation ? 'PASS' : 'FAIL', [citation ?? 'no direction citation'])];
  let settings, netDiffPaths = [], base, failure;
  try { settings = validateSettings(await deps.readSettings()); }
  catch { failure = 'path policy unavailable or incomplete'; }
  // The adapter classifies against origin/main; another target needs human review
  // because this diff and its audit can omit changes inherited from main.
  if (metadata.baseRefName !== 'main') failure = 'PR target is not main or is unavailable; human review required';
  else try {
    const diff = await deps.fetchNetDiff(pr, head);
    const paths = diff?.paths;
    if (!SHA.test(diff?.base ?? '')) throw new Error('missing merge-base');
    if (!Array.isArray(paths) || paths.length > MAX_PATHS || paths.some(p => !validPath(p))) {
      throw new Error('invalid or oversized net diff');
    }
    base = diff.base;
    netDiffPaths = [...new Set(paths)];
    if (!netDiffPaths.length) failure = 'empty net diff: cannot judge';
  } catch { failure = 'net diff unavailable, invalid or exceeds 10000 paths'; }
  conditions.push(await reviewed(pr, head, base, deps));
  if (failure) {
    conditions.push(unknown(3, 'Sets no direction', failure), unknown(4, 'Not guard-loosening / hard to undo', failure));
  } else {
    conditions.push(await directionPaths(netDiffPaths, settings, metadata, head, base, deps), protectedPaths(netDiffPaths, settings));
  }
  const seats = { sat: null, earned: null };
  conditions.push(result(5, 'Seats sat vs earned', 'UNKNOWN', ['not determinable: labels and canonical audit do not establish seats sat or earned']));
  return { pr, head, eligible: conditions.slice(0, 4).every(c => c.status === 'PASS'), conditions, netDiffPaths, seats };
}

function parseArgs(argv) {
  let pr, json = false;
  for (const arg of argv) {
    if (arg === '--json' && !json) { json = true; continue; }
    if (/^--pr=[1-9]\d*$/.test(arg) && pr === undefined) { pr = Number(arg.slice(5)); continue; }
    return null;
  }
  return validPr(pr) ? { pr, json } : null;
}

export async function main(argv, deps) {
  const stderr = text => (deps?.stderr ?? (s => process.stderr.write(s)))(text);
  const flags = parseArgs(argv);
  if (!flags) { stderr(USAGE); return 2; }
  try {
    deps ??= (await import('./d-r379-check-io.mjs')).createCheckDeps();
    const checked = await checkPr(flags.pr, deps);
    const human = [`PR #${checked.pr} @ ${checked.head}: ${checked.eligible ? 'eligible' : 'not eligible'}`,
      ...checked.conditions.map(c => `${c.id}. ${c.name}: ${c.status}\n   ${c.evidence.map(clean).join('; ')}`)].join('\n');
    deps.stdout(flags.json ? `${JSON.stringify(checked)}\n` : `${human}\n`);
    return checked.eligible ? 0 : 1;
  } catch {
    stderr('D-R379 check failed: incomplete evidence; request human review of the full diff or repair evidence and retry.\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
